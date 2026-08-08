import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { makeFileRepo, hasLocalTimeline, type FileRepoDirs } from './file-repo.ts';
import { ConflictError, NotFoundError, NotSupportedError, ValidationError } from '../db/repo.ts';
import type { TimelineFile } from '../../src/types.ts';

let dirs: FileRepoDirs;

const BASE: TimelineFile = {
  name: 'Testplan',
  items: [
    { id: 'a', content: 'Erstes', start: '2026-01-01', end: '2026-02-01', group: 'g1' },
    { id: 'b', content: 'Zweites', start: '2026-03-01' },
  ],
  groups: [{ id: 'g1', content: 'Phase 1' }],
};

async function seed(id: string, file: TimelineFile = BASE): Promise<void> {
  const path = join(dirs.root, `${id}.json`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), 'utf8');
}

async function raw(id: string): Promise<TimelineFile> {
  return JSON.parse(await readFile(join(dirs.root, `${id}.json`), 'utf8'));
}

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'ganttry-file-repo-'));
  dirs = { root, scope: root };
});

describe('makeFileRepo: reads', () => {
  test('getTimeline stamps every item with the file version', async () => {
    await seed('read-1');
    const repo = makeFileRepo(dirs);
    const file = await repo.getTimeline('read-1');
    assert.ok(file);
    assert.equal(file!.items.length, 2);
    const versions = new Set(file!.items.map((i) => i.version));
    assert.equal(versions.size, 1, 'one file, one version');
    assert.ok([...versions][0]! > 0);
  });

  test('getTimeline returns null for an unknown id instead of throwing', async () => {
    assert.equal(await makeFileRepo(dirs).getTimeline('nope'), null);
  });

  test('listTimelines finds files and skips malformed ones', async () => {
    await seed('list-a');
    await seed('list-b');
    await writeFile(join(dirs.root, 'broken.json'), '{ not json', 'utf8');
    const ids = (await makeFileRepo(dirs).listTimelines()).map((t) => t.id);
    assert.ok(ids.includes('list-a'));
    assert.ok(ids.includes('list-b'));
    assert.ok(!ids.includes('broken'), 'a malformed file must not appear');
  });

  test('a malformed file reports as invalid, not as a server fault', async () => {
    await writeFile(join(dirs.root, 'bad.json'), '{ nope', 'utf8');
    await assert.rejects(() => makeFileRepo(dirs).getWatermark('bad'), ValidationError);
  });

  test('getWatermark reports the version and the item count', async () => {
    await seed('wm');
    const wm = await makeFileRepo(dirs).getWatermark('wm');
    assert.equal(wm.n, 2);
    assert.ok(wm.v > 0);
  });
});

describe('makeFileRepo: writes', () => {
  test('addItem mints an id, persists, and returns the new version', async () => {
    await seed('add-1');
    const repo = makeFileRepo(dirs);
    const before = await repo.getTimeline('add-1');
    const added = await repo.addItem('add-1', { content: 'Drittes', start: '2026-04-01' });
    assert.ok(added.id, 'an id is minted');
    assert.ok(
      added.version! > before!.items[0].version!,
      'the version moves strictly forward, even inside one millisecond',
    );
    const onDisk = await raw('add-1');
    assert.equal(onDisk.items.length, 3);
    assert.equal(onDisk.items[2].content, 'Drittes');
  });

  test('the server-managed version is never written into the user file', async () => {
    await seed('clean-1');
    const repo = makeFileRepo(dirs);
    await repo.updateItem('clean-1', 'a', { content: 'Umbenannt' });
    const onDisk = await raw('clean-1');
    assert.ok(
      onDisk.items.every((i) => !('version' in i)),
      'version is derived from mtime; persisting it would bake in a stale number',
    );
  });

  test('updateItem merges a partial patch and leaves the rest alone', async () => {
    await seed('patch-1');
    const repo = makeFileRepo(dirs);
    await repo.updateItem('patch-1', 'a', { content: 'Neu' });
    const item = (await raw('patch-1')).items.find((i) => i.id === 'a')!;
    assert.equal(item.content, 'Neu');
    assert.equal(item.start, '2026-01-01', 'untouched fields survive');
    assert.equal(item.group, 'g1');
  });

  test('updateItem on an unknown item is a 404, not a silent no-op', async () => {
    await seed('patch-2');
    await assert.rejects(() => makeFileRepo(dirs).updateItem('patch-2', 'ghost', { content: 'x' }), NotFoundError);
  });

  test('deleteItem removes it, and a second delete reports not-found', async () => {
    await seed('del-1');
    const repo = makeFileRepo(dirs);
    await repo.deleteItem('del-1', 'b');
    assert.equal((await raw('del-1')).items.length, 1);
    await assert.rejects(() => repo.deleteItem('del-1', 'b'), NotFoundError);
  });

  test('upsertGroup adds then updates in place', async () => {
    await seed('grp-1');
    const repo = makeFileRepo(dirs);
    await repo.upsertGroup('grp-1', { id: 'g2', content: 'Phase 2' });
    assert.equal((await raw('grp-1')).groups!.length, 2);
    await repo.upsertGroup('grp-1', { id: 'g2', content: 'Phase zwei' });
    const groups = (await raw('grp-1')).groups!;
    assert.equal(groups.length, 2, 'an upsert does not duplicate');
    assert.equal(groups.find((g) => g.id === 'g2')!.content, 'Phase zwei');
  });

  test('updateMeta applies only the keys the patch carries', async () => {
    await seed('meta-1', { ...BASE, description: 'bleibt' });
    const repo = makeFileRepo(dirs);
    await repo.updateMeta('meta-1', { name: 'Anders' });
    const file = await raw('meta-1');
    assert.equal(file.name, 'Anders');
    assert.equal(file.description, 'bleibt', 'a name-only patch must not blank the description');
  });
});

describe('makeFileRepo: the shared validations apply', () => {
  test('an item whose end precedes its start is refused', async () => {
    await seed('val-1');
    const repo = makeFileRepo(dirs);
    await assert.rejects(
      () => repo.addItem('val-1', { content: 'Rückwärts', start: '2026-05-01', end: '2026-04-01' }),
      ValidationError,
    );
  });

  test('a partial patch that reverses the extent is refused against the STORED counterpart', async () => {
    await seed('val-2');
    const repo = makeFileRepo(dirs);
    // Carries only `end`; the stored `start` is 2026-01-01, so this reverses it.
    await assert.rejects(() => repo.updateItem('val-2', 'a', { end: '2025-01-01' }), ValidationError);
  });

  test('overlapping phases are refused', async () => {
    await seed('val-3');
    const repo = makeFileRepo(dirs);
    await assert.rejects(
      () =>
        repo.updatePhases('val-3', [
          { id: 'p1', label: 'Eins', start: '2026-01-01', end: '2026-03-01' },
          { id: 'p2', label: 'Zwei', start: '2026-02-01', end: '2026-04-01' },
        ]),
      ValidationError,
    );
  });

  test('touching phase boundaries are allowed', async () => {
    await seed('val-4');
    const repo = makeFileRepo(dirs);
    await repo.updatePhases('val-4', [
      { id: 'p1', label: 'Eins', start: '2026-01-01', end: '2026-03-01' },
      { id: 'p2', label: 'Zwei', start: '2026-03-01', end: '2026-04-01' },
    ]);
    assert.equal((await raw('val-4')).phases!.length, 2);
  });
});

describe('makeFileRepo: optimistic locking', () => {
  test('a stale version is a conflict', async () => {
    await seed('lock-1');
    const repo = makeFileRepo(dirs);
    const current = (await repo.getTimeline('lock-1'))!.items[0].version!;
    await assert.rejects(
      () => repo.updateItem('lock-1', 'a', { content: 'x' }, current - 1000),
      ConflictError,
    );
  });

  test('the current version is accepted', async () => {
    await seed('lock-2');
    const repo = makeFileRepo(dirs);
    const current = (await repo.getTimeline('lock-2'))!.items[0].version!;
    const updated = await repo.updateItem('lock-2', 'a', { content: 'ok' }, current);
    assert.equal(updated.content, 'ok');
  });

  test('two writes in immediate succession get distinct, increasing versions', async () => {
    await seed('lock-4');
    const repo = makeFileRepo(dirs);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push((await repo.updateItem('lock-4', 'a', { content: `v${i}` })).version!);
    }
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] > seen[i - 1], `version ${seen[i]} must exceed ${seen[i - 1]}`);
    }
  });

  test('a version from before a rapid write is still rejected', async () => {
    await seed('lock-5');
    const repo = makeFileRepo(dirs);
    const stale = (await repo.getTimeline('lock-5'))!.items[0].version!;
    await repo.updateItem('lock-5', 'a', { content: 'jemand anderes' });
    // The second caller still holds the version from before that write. Without
    // a monotonic version this passes whenever both land in the same tick.
    await assert.rejects(() => repo.updateItem('lock-5', 'a', { content: 'ich' }, stale), ConflictError);
  });

  test('no version supplied means no check (the MCP/direct-API shape)', async () => {
    await seed('lock-3');
    const repo = makeFileRepo(dirs);
    const updated = await repo.updateItem('lock-3', 'a', { content: 'ok' });
    assert.equal(updated.content, 'ok');
  });
});

describe('makeFileRepo: containment', () => {
  test('an id escaping the data directory is refused', async () => {
    const repo = makeFileRepo(dirs);
    for (const id of ['../escape', '../../etc/passwd', 'a/../../escape']) {
      await assert.rejects(() => repo.getWatermark(id), ValidationError, `must refuse "${id}"`);
    }
  });

  test('hasLocalTimeline reports false for a traversing id rather than throwing', () => {
    assert.equal(hasLocalTimeline(dirs, '../escape'), false);
  });

  test('a nested id inside the data directory is fine', async () => {
    await seed('nested/deep');
    assert.equal(hasLocalTimeline(dirs, 'nested/deep'), true);
    assert.ok(await makeFileRepo(dirs).getTimeline('nested/deep'));
  });
});

describe('makeFileRepo: the plugin surface says so instead of pretending', () => {
  test('a pricing write reports not-supported', async () => {
    await seed('plug-1');
    const repo = makeFileRepo(dirs);
    await assert.rejects(
      () => repo.addFeature('plug-1', { id: 'f1', name: 'Feature' } as any),
      NotSupportedError,
    );
  });

  test('a pricing model in the file is still readable', async () => {
    await seed('plug-2', {
      ...BASE,
      pricing: { features: [{ id: 'f1', name: 'Feature' }], tiers: [{ id: 't1', name: 'Basis' }] },
    } as TimelineFile);
    const pub = await makeFileRepo(dirs).getPublicPricing('plug-2');
    assert.ok(pub);
    assert.equal(pub!.pricing.features.length, 1);
  });
});

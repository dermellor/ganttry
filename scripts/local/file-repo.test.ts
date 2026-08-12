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
  const root = await mkdtemp(join(tmpdir(), 'zeitlines-file-repo-'));
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

  test('a full patch does not litter the file with nulls', async () => {
    await seed('null-1');
    const repo = makeFileRepo(dirs);
    // The shape the viewer actually sends: every field, unset ones as null.
    await repo.updateItem('null-1', 'a', {
      content: 'Erstes',
      start: '2026-01-01',
      end: '2026-03-15',
      duration: null,
      type: null,
      className: null,
      metadata: null,
    } as any);
    const item = (await raw('null-1')).items.find((i) => i.id === 'a')!;
    assert.equal(item.end, '2026-03-15');
    for (const key of ['duration', 'type', 'className', 'metadata']) {
      assert.ok(!(key in item), `„${key}" must be absent, not null — a null fails the JSON Schema`);
    }
  });

  test('a null clears a field that had a value', async () => {
    await seed('null-2', { items: [{ id: 'a', content: 'X', start: '2026-01-01', duration: '3w' }] });
    const repo = makeFileRepo(dirs);
    await repo.updateItem('null-2', 'a', { duration: null } as any);
    const item = (await raw('null-2')).items.find((i) => i.id === 'a')!;
    assert.ok(!('duration' in item), 'clearing a field removes its key');
    assert.equal(item.content, 'X', 'the rest survives');
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

  test('a cleared field loses its key rather than being written as null', async () => {
    // In a file „cleared" is an absent key: `TimelineFile` types these as optional
    // strings, so a written `null` would make the file invalid against its own
    // schema — the app would hand the user a file their editor then flags.
    await seed('meta-2', { ...BASE, description: 'weg damit', groupBy: 'tag' });
    const repo = makeFileRepo(dirs);
    await repo.updateMeta('meta-2', { description: null, groupBy: null });
    const file = await raw('meta-2');
    assert.equal('description' in file, false);
    assert.equal('groupBy' in file, false);
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

describe('makeFileRepo: a plugin writes to a file the user owns', () => {
  // This block used to assert the opposite: sixteen pricing methods answered 501
  // here, so a pricing model in a JSON file was readable and not editable. The
  // generic store removed the distinction — a plugin's rows go through the same
  // path as everything else, so „editable" is now a property of the source and
  // not of which plugin is asking.
  test('a row survives a write and comes back with a version', async () => {
    await seed('plug-1');
    const repo = makeFileRepo(dirs);
    const written = await repo.putPluginRow('plug-1', 'com.example.sprints', 'entries', { id: 'e1', data: { name: 'Sprint 1' } });
    assert.equal(written.id, 'e1');
    assert.ok(written.version, 'the store hands back a counter to send as If-Match');
    const rows = await repo.listPluginRows('plug-1', 'com.example.sprints', 'entries');
    assert.deepEqual(rows.map((r) => r.data), [{ name: 'Sprint 1' }]);
  });

  test('a deleted row is gone from the file, not just from the answer', async () => {
    await seed('plug-2');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('plug-2', 'com.example.sprints', 'entries', { id: 'e1', data: {} });
    await repo.deletePluginRow('plug-2', 'com.example.sprints', 'entries', 'e1');
    const reread = makeFileRepo(dirs);
    assert.deepEqual(await reread.listPluginRows('plug-2', 'com.example.sprints', 'entries'), []);
  });
});

// ---------------------------------------------------------------------------
// directory sources: the Markdown write path

import { mkdir as mkdirp } from 'node:fs/promises';
import { existsSync } from 'node:fs';

async function seedDir(id: string, container: object, notes: Record<string, string>): Promise<string> {
  const dir = join(dirs.root, id);
  await mkdirp(dir, { recursive: true });
  await writeFile(join(dir, 'timeline.json'), JSON.stringify(container, null, 2), 'utf8');
  for (const [name, text] of Object.entries(notes)) {
    await mkdirp(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text, 'utf8');
  }
  return dir;
}

const NOTE_A = ['---', '# Kommentar', 'date: 2026-03-01', 'title: Erstes', 'eigenes: behalten', '---', '', 'Body-Text.', ''].join('\n');

describe('directory source: writing', () => {
  test('a date change patches only that line', async () => {
    const dir = await seedDir('w-date', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    await repo.updateItem('w-date', 'a', { start: '2026-04-05' });
    const text = await readFile(join(dir, 'a.md'), 'utf8');
    assert.match(text, /^date: 2026-04-05$/m);
    assert.ok(text.includes('# Kommentar'), 'der Kommentar bleibt');
    assert.ok(text.includes('eigenes: behalten'), 'fremde Schlüssel bleiben');
    assert.ok(text.includes('Body-Text.'), 'der Body bleibt');
  });

  test('a date that came from the filename is promoted to an explicit key', async () => {
    const dir = await seedDir('w-promote', {}, { '2026-05-01-x.md': '---\ntitle: X\n---\nBody\n' });
    const repo = makeFileRepo(dirs);
    await repo.updateItem('w-promote', '2026-05-01-x', { start: '2026-06-02' });
    const text = await readFile(join(dir, '2026-05-01-x.md'), 'utf8');
    assert.match(text, /^date: 2026-06-02$/m, 'the note now states its own date');
    const item = (await repo.getTimeline('w-promote'))!.items[0];
    assert.equal(item.start, '2026-06-02', 'and the explicit key wins over the filename');
  });

  test('the title is written back to `title`', async () => {
    const dir = await seedDir('w-title', {}, { 'a.md': NOTE_A });
    await makeFileRepo(dirs).updateItem('w-title', 'a', { content: 'Umbenannt' });
    assert.match(await readFile(join(dir, 'a.md'), 'utf8'), /^title: Umbenannt$/m);
  });

  test('a cleared field loses its line', async () => {
    const dir = await seedDir('w-clear', {}, { 'a.md': '---\ndate: 2026-03-01\nend: 2026-04-01\n---\nB\n' });
    await makeFileRepo(dirs).updateItem('w-clear', 'a', { end: null } as any);
    const text = await readFile(join(dir, 'a.md'), 'utf8');
    assert.ok(!text.includes('end:'));
    assert.ok(text.includes('date: 2026-03-01'));
  });

  test('the body is only touched when one was sent', async () => {
    const dir = await seedDir('w-body', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    await repo.updateItem('w-body', 'a', { start: '2026-03-02' });
    assert.ok((await readFile(join(dir, 'a.md'), 'utf8')).includes('Body-Text.'));
    await repo.updateItem('w-body', 'a', { body: 'Neuer Text.' });
    const text = await readFile(join(dir, 'a.md'), 'utf8');
    assert.ok(text.includes('Neuer Text.'));
    assert.ok(!text.includes('Body-Text.'));
    assert.ok(text.includes('date: 2026-03-02'), 'the frontmatter survives a body write');
  });

  test('an unchanged body leaves the file spacing alone', async () => {
    const dir = await seedDir('w-spacing', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    const stored = (await repo.getTimeline('w-spacing'))!.items[0];
    // Exactly the shape the viewer sends: everything, body included, unchanged.
    await repo.updateItem('w-spacing', 'a', { content: 'Erstes', body: stored.body, start: '2026-03-09' });
    const text = await readFile(join(dir, 'a.md'), 'utf8');
    assert.match(text, /---\n\nBody-Text\./, 'die Leerzeile unter dem Block bleibt');
  });

  test('a new item becomes a note named after its title', async () => {
    const dir = await seedDir('w-add', {}, {});
    const repo = makeFileRepo(dirs);
    const added = await repo.addItem('w-add', { content: 'Neuer Eintrag', start: '2026-08-01' });
    assert.equal(added.id, 'neuer-eintrag');
    const text = await readFile(join(dir, 'neuer-eintrag.md'), 'utf8');
    assert.match(text, /^title: Neuer Eintrag$/m);
    assert.match(text, /^date: 2026-08-01$/m);
  });

  test('two items with the same title do not collide', async () => {
    await seedDir('w-add2', {}, {});
    const repo = makeFileRepo(dirs);
    const a = await repo.addItem('w-add2', { content: 'Gleich' });
    const b = await repo.addItem('w-add2', { content: 'Gleich' });
    assert.notEqual(a.id, b.id);
  });

  test('deleting moves the note to .trash instead of unlinking it', async () => {
    const dir = await seedDir('w-del', {}, { 'a.md': NOTE_A });
    await makeFileRepo(dirs).deleteItem('w-del', 'a');
    assert.equal(existsSync(join(dir, 'a.md')), false);
    assert.equal(existsSync(join(dir, '.trash', 'a.md')), true, 'a file the tool did not create is never destroyed');
    assert.equal((await makeFileRepo(dirs).getTimeline('w-del'))!.items.length, 0, 'and it is gone from the timeline');
  });

  test('groups and phases are written to the container, not into a note', async () => {
    const dir = await seedDir('w-container', { name: 'C' }, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    await repo.upsertGroup('w-container', { id: 'g1', content: 'Phase 1' });
    await repo.updatePhases('w-container', [{ id: 'p', label: 'Vorlauf', start: '2026-01-01', end: '2026-02-01' }]);
    const container = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
    assert.equal(container.groups.length, 1);
    assert.equal(container.phases.length, 1);
    assert.ok(!('items' in container), 'the notes stay the only definition of the items');
    assert.ok((await readFile(join(dir, 'a.md'), 'utf8')).includes('# Kommentar'), 'the note was not touched');
  });

  test('the shared validations apply to a directory too', async () => {
    await seedDir('w-val', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    await assert.rejects(() => repo.updateItem('w-val', 'a', { end: '2025-01-01' }), ValidationError);
    await assert.rejects(
      () =>
        repo.updatePhases('w-val', [
          { id: 'x', label: 'A', start: '2026-01-01', end: '2026-03-01' },
          { id: 'y', label: 'B', start: '2026-02-01', end: '2026-04-01' },
        ]),
      ValidationError,
    );
  });

  test('the version moves forward on every write', async () => {
    await seedDir('w-ver', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push((await repo.updateItem('w-ver', 'a', { content: `v${i}` })).version!);
    }
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1]);
  });

  test('a stale version is a conflict for a directory as well', async () => {
    await seedDir('w-conf', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    const stale = (await repo.getTimeline('w-conf'))!.items[0].version!;
    await repo.updateItem('w-conf', 'a', { content: 'jemand anderes' });
    await assert.rejects(() => repo.updateItem('w-conf', 'a', { content: 'ich' }, stale), ConflictError);
  });
});

// ---------------------------------------------------------------------------
// plugin-owned rows
//
// The local half of the generic store. What these cover is the part that is
// genuinely different from the DB store: the rows live in the very document the
// user owns, and the lock is the file rather than the row. Everything ABOVE the
// repo — shape, references, cascade — is enforced once in the dispatcher and
// tested there (scripts/db/plugin-api.test.ts), not a second time here.

describe('plugin data: a JSON file holds it', () => {
  test('a written row lands in the file and comes back in order', async () => {
    await seed('pd-write');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-write', 'com.example.demo', 'tiers', { id: 'pro', data: { name: 'Pro' } });
    await repo.putPluginRow('pd-write', 'com.example.demo', 'tiers', { id: 'lite', data: { name: 'Lite' } });

    const onDisk = await raw('pd-write');
    assert.deepEqual(
      onDisk.pluginData?.['com.example.demo']?.tiers?.map((r) => r.id),
      ['pro', 'lite'],
      'the array order IS the order — a local file has no sort column',
    );
    assert.deepEqual((await repo.listPluginRows('pd-write', 'com.example.demo', 'tiers')).map((r) => r.id), ['pro', 'lite']);
  });

  test('the row keeps the plugin object untouched and the host fields beside it', async () => {
    await seed('pd-shape');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-shape', 'com.example.demo', 'tiers', { id: 'pro', data: { name: 'Pro', nested: { a: [1] } } }, undefined, 'someone@example.com');
    const [row] = (await raw('pd-shape')).pluginData!['com.example.demo'].tiers;
    assert.deepEqual(row.data, { name: 'Pro', nested: { a: [1] } });
    assert.equal(row.updatedBy, 'someone@example.com');
    assert.ok(row.updatedAt);
    assert.ok(!('version' in row), 'the version is the file\'s, so storing one would freeze a stale number');
  });

  test('a rewrite keeps the row in place instead of moving it to the end', async () => {
    await seed('pd-keep');
    const repo = makeFileRepo(dirs);
    for (const id of ['a', 'b', 'c']) await repo.putPluginRow('pd-keep', 'com.example.demo', 'f', { id, data: {} });
    await repo.putPluginRow('pd-keep', 'com.example.demo', 'f', { id: 'a', data: { changed: true } });
    assert.deepEqual((await repo.listPluginRows('pd-keep', 'com.example.demo', 'f')).map((r) => r.id), ['a', 'b', 'c']);
  });

  test('a patch merges, and a null clears the key', async () => {
    await seed('pd-patch');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-patch', 'com.example.demo', 'tiers', { id: 'pro', data: { name: 'Pro', price: '49' } });
    const patched = await repo.patchPluginRow('pd-patch', 'com.example.demo', 'tiers', 'pro', { price: null, tagline: 'x' });
    assert.deepEqual(patched.data, { name: 'Pro', tagline: 'x' });
  });

  test('patching a row that is not there is a NotFound, not a silent insert', async () => {
    await seed('pd-404');
    const repo = makeFileRepo(dirs);
    await assert.rejects(() => repo.patchPluginRow('pd-404', 'com.example.demo', 'tiers', 'ghost', { a: 1 }), NotFoundError);
  });

  test('deleting the last row of a collection leaves no empty husk in the file', async () => {
    await seed('pd-empty');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-empty', 'com.example.demo', 'tiers', { id: 'pro', data: {} });
    await repo.deletePluginRow('pd-empty', 'com.example.demo', 'tiers', 'pro');
    // This is a file somebody reads and edits by hand; `"pluginData": { "com.example.demo": { "tiers": [] } }`
    // is residue that reads as breakage.
    assert.ok(!('pluginData' in (await raw('pd-empty'))));
  });

  test('order is rewritten by orderPluginRows, and rows it omits are kept', async () => {
    await seed('pd-order');
    const repo = makeFileRepo(dirs);
    for (const id of ['a', 'b', 'c']) await repo.putPluginRow('pd-order', 'com.example.demo', 'f', { id, data: {} });
    await repo.orderPluginRows('pd-order', 'com.example.demo', 'f', ['c', 'a']);
    // `b` was not named. Dropping it would let an order list built from a stale
    // read delete rows, so it keeps its place at the end instead.
    assert.deepEqual((await repo.listPluginRows('pd-order', 'com.example.demo', 'f')).map((r) => r.id), ['c', 'a', 'b']);
  });
});

describe('plugin data: the file is the lock', () => {
  test('every row reports the file version, and it moves on each write', async () => {
    await seed('pd-ver');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-ver', 'com.example.demo', 'tiers', { id: 'pro', data: {} });
    await repo.putPluginRow('pd-ver', 'com.example.demo', 'tiers', { id: 'lite', data: {} });
    const rows = await repo.listPluginRows('pd-ver', 'com.example.demo', 'tiers');
    const versions = new Set(rows.map((r) => r.version));
    assert.equal(versions.size, 1, 'one document, one version');
    const after = await repo.putPluginRow('pd-ver', 'com.example.demo', 'tiers', { id: 'pro', data: { x: 1 } });
    assert.ok(after.version! > [...versions][0]!);
  });

  test('a stale If-Match is refused — coarser than the DB, and deliberately so', async () => {
    await seed('pd-conf');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-conf', 'com.example.demo', 'tiers', { id: 'pro', data: {} });
    const stale = (await repo.listPluginRows('pd-conf', 'com.example.demo', 'tiers'))[0].version!;
    // Another row of the same collection, so a DB source would allow both. Here
    // the file changed, and that is what the header means.
    await repo.putPluginRow('pd-conf', 'com.example.demo', 'tiers', { id: 'lite', data: {} });
    await assert.rejects(
      () => repo.putPluginRow('pd-conf', 'com.example.demo', 'tiers', { id: 'pro', data: { x: 1 } }, stale),
      ConflictError,
    );
  });

  test('the plugin rows travel with getTimeline, stamped like the items', async () => {
    await seed('pd-get');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-get', 'com.example.demo', 'tiers', { id: 'pro', data: { name: 'Pro' } });
    const file = await repo.getTimeline('pd-get');
    const row = file!.pluginData!['com.example.demo'].tiers[0];
    assert.equal(row.version, file!.items[0].version, 'the whole document shares one version');
  });

  test('a bulk replace preserves the section instead of emptying it', async () => {
    await seed('pd-bulk');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-bulk', 'com.example.demo', 'tiers', { id: 'pro', data: { name: 'Pro' } });
    const file = await repo.getTimeline('pd-bulk');
    await repo.replaceTimeline('pd-bulk', file!);
    const back = await repo.getTimeline('pd-bulk');
    assert.deepEqual(back!.pluginData!['com.example.demo'].tiers[0].data, { name: 'Pro' });
    // The round trip must not write the stamped version back into the file.
    assert.ok(!('version' in (await raw('pd-bulk')).pluginData!['com.example.demo'].tiers[0]));
  });
});

describe('plugin data: uninstall', () => {
  test('purging drops one plugin and leaves the others', async () => {
    await seed('pd-purge');
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-purge', 'com.example.demo', 'tiers', { id: 'pro', data: {} });
    await repo.putPluginRow('pd-purge', 'other', 'things', { id: 'x', data: {} });
    await repo.purgePluginData('com.example.demo', 'pd-purge');
    const onDisk = await raw('pd-purge');
    assert.equal(onDisk.pluginData?.['com.example.demo'], undefined);
    assert.equal(onDisk.pluginData?.other?.things?.length, 1);
  });

  test('the declared item metadata keys are stripped off the items', async () => {
    await seed('pd-meta', {
      name: 'Meta',
      items: [
        { id: 'a', content: 'A', start: '2026-01-01', metadata: { demoTier: 'pro', keep: 'yes' } },
        { id: 'b', content: 'B', start: '2026-02-01', metadata: { keep: 'yes' } },
      ],
    });
    const repo = makeFileRepo(dirs);
    assert.equal(await repo.purgeItemMetadata(['demoTier'], 'pd-meta'), 1, 'only the item carrying it counts');
    const items = (await raw('pd-meta')).items;
    assert.deepEqual(items[0].metadata, { keep: 'yes' });
    assert.deepEqual(items[1].metadata, { keep: 'yes' });
  });

  test('a directory source strips the key out of the note itself', async () => {
    const dir = await seedDir('pd-meta-dir', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    assert.equal(await repo.purgeItemMetadata(['eigenes'], 'pd-meta-dir'), 1);
    const note = await readFile(join(dir, 'a.md'), 'utf8');
    assert.ok(!note.includes('eigenes:'), 'the key is gone from the frontmatter');
    assert.ok(note.includes('title: Erstes'), 'and nothing else was rewritten');
    assert.ok(note.includes('# Kommentar'));
  });
});

describe('plugin data: a directory keeps it in the container', () => {
  test('a row written to a directory source lands in timeline.json, not in a note', async () => {
    const dir = await seedDir('pd-dir', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    await repo.putPluginRow('pd-dir', 'com.example.demo', 'tiers', { id: 'pro', data: { name: 'Pro' } });
    const container = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
    assert.deepEqual(container.pluginData['com.example.demo'].tiers[0].data, { name: 'Pro' });
    assert.ok(!('items' in container), 'the notes stay the only definition of the items');
    assert.equal((await repo.listPluginRows('pd-dir', 'com.example.demo', 'tiers')).length, 1);
  });
});


describe('plugin enablement on a local timeline', () => {
  test('enabling writes a plugin ref into the file, and the config with it', async () => {
    await seed('pe-on');
    const repo = makeFileRepo(dirs);
    await repo.setTimelinePlugin('pe-on', 'com.example.demo', { versions: ['1.0'] });
    assert.deepEqual((await raw('pe-on')).plugins, [{ id: 'com.example.demo', config: { versions: ['1.0'] } }]);
  });

  test('an empty config leaves the ref bare rather than storing an empty object', async () => {
    await seed('pe-bare');
    const repo = makeFileRepo(dirs);
    await repo.setTimelinePlugin('pe-bare', 'com.example.demo', {});
    assert.deepEqual((await raw('pe-bare')).plugins, [{ id: 'com.example.demo' }]);
  });

  test('enabling twice reconfigures instead of adding a second ref', async () => {
    await seed('pe-twice');
    const repo = makeFileRepo(dirs);
    await repo.setTimelinePlugin('pe-twice', 'com.example.demo', { a: 1 });
    await repo.setTimelinePlugin('pe-twice', 'com.example.demo', { a: 2 });
    assert.deepEqual((await raw('pe-twice')).plugins, [{ id: 'com.example.demo', config: { a: 2 } }]);
  });

  test('disabling removes the ref and keeps the rows the plugin owns', async () => {
    await seed('pe-off');
    const repo = makeFileRepo(dirs);
    await repo.setTimelinePlugin('pe-off', 'com.example.demo', {});
    await repo.putPluginRow('pe-off', 'com.example.demo', 'entries', { id: 'e1', data: { a: 1 } });
    await repo.removeTimelinePlugin('pe-off', 'com.example.demo');
    const onDisk = await raw('pe-off');
    // Reversible by design: the destructive operation is the instance-level
    // uninstall, and that one asks.
    assert.ok(!('plugins' in onDisk), 'an empty array reads as \u201esomething broke here"');
    assert.equal(onDisk.pluginData?.['com.example.demo']?.entries?.length, 1);
  });

  test('disabling one plugin leaves the others enabled', async () => {
    await seed('pe-other');
    const repo = makeFileRepo(dirs);
    await repo.setTimelinePlugin('pe-other', 'a', {});
    await repo.setTimelinePlugin('pe-other', 'b', {});
    await repo.removeTimelinePlugin('pe-other', 'a');
    assert.deepEqual((await raw('pe-other')).plugins, [{ id: 'b' }]);
  });

  test('a directory source keeps the refs in its container', async () => {
    const dir = await seedDir('pe-dir', {}, { 'a.md': NOTE_A });
    const repo = makeFileRepo(dirs);
    await repo.setTimelinePlugin('pe-dir', 'com.example.demo', { x: 1 });
    const container = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
    assert.deepEqual(container.plugins, [{ id: 'com.example.demo', config: { x: 1 } }]);
  });

  test('installing instance-wide is refused on a file-backed instance, truthfully', async () => {
    // A bare data directory has nowhere to record which artifact was fetched and
    // no loader to act on it, so reporting success would list a plugin as
    // installed that nothing could ever load.
    const repo = makeFileRepo(dirs);
    assert.deepEqual(await repo.listInstalledPlugins(), []);
    await assert.rejects(
      () =>
        repo.installPlugin({
          id: 'x',
          version: '1.0.0',
          apiVersion: '^1',
          artifact: { kind: 'builtin' },
          capabilities: [],
          manifest: {},
          enabled: true,
        }),
      NotSupportedError,
    );
    await assert.rejects(() => repo.removeInstalledPlugin('x'), NotSupportedError);
  });
});

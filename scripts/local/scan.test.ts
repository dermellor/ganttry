import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';

import {
  CONTAINER_FILE,
  DATE_SOURCE_KEY,
  FILENAME_DATE_SOURCE,
  directoryVersion,
  isTimelineDirectory,
  scanDirectory,
  timelineDirectories,
} from './scan.ts';

let root: string;

async function note(dir: string, rel: string, front: string, body = ''): Promise<void> {
  const path = join(dir, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `---\n${front}\n---\n${body}`, 'utf8');
}

async function fresh(name: string, container?: object): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (container) await writeFile(join(dir, CONTAINER_FILE), JSON.stringify(container), 'utf8');
  return dir;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'zeitlines-scan-'));
});

describe('scanDirectory: items out of Markdown', () => {
  test('a frontmatter date becomes the item start, and records which key it came from', async () => {
    const dir = await fresh('dates', {});
    await note(dir, 'a.md', 'date: 2026-03-01\ntitle: Erstes');
    const file = await scanDirectory(dir);
    assert.equal(file.items.length, 1);
    assert.equal(file.items[0].content, 'Erstes');
    assert.equal(file.items[0].start, '2026-03-01', 'a day stays a day, not an instant');
    assert.equal(file.items[0].metadata?.[DATE_SOURCE_KEY], 'date');
  });

  test('the cascade order decides which key wins', async () => {
    const dir = await fresh('cascade', {});
    await note(dir, 'a.md', 'scheduled: 2026-05-01\ncreated: 2026-01-01');
    const file = await scanDirectory(dir);
    assert.equal(file.items[0].metadata?.[DATE_SOURCE_KEY], 'scheduled');
  });

  test('a date in the filename is used, and marked as coming from there', async () => {
    const dir = await fresh('fromname', {});
    await note(dir, '2026-04-15-launch.md', 'title: Launch');
    const file = await scanDirectory(dir);
    assert.equal(file.items[0].start, '2026-04-15');
    assert.equal(
      file.items[0].metadata?.[DATE_SOURCE_KEY],
      FILENAME_DATE_SOURCE,
      'a later write needs to know this date has no frontmatter key yet',
    );
  });

  test('a note without any date is kept, not dropped', async () => {
    const dir = await fresh('dateless', {});
    await note(dir, 'ohne.md', 'title: Ohne Datum');
    const file = await scanDirectory(dir);
    assert.equal(file.items.length, 1, 'it belongs in the list view; the timeline filters it out itself');
    assert.equal(file.items[0].start, undefined);
  });

  test('the whole frontmatter survives on metadata', async () => {
    const dir = await fresh('meta', {});
    await note(dir, 'a.md', 'date: 2026-03-01\nowner: someone@example.com\ntags:\n  - eins\n  - zwei');
    const file = await scanDirectory(dir);
    const meta = file.items[0].metadata!;
    assert.equal(meta.owner, 'someone@example.com');
    assert.deepEqual(meta.tags, ['eins', 'zwei']);
    assert.equal(meta.path, 'a.md');
    assert.equal(meta.filename, 'a.md');
  });

  test('the body becomes the detail text', async () => {
    const dir = await fresh('body', {});
    await note(dir, 'a.md', 'date: 2026-03-01', '## Überschrift\n\nText.');
    const file = await scanDirectory(dir);
    assert.match(file.items[0].body!, /Überschrift/);
  });

  test('an explicit id wins over the path so a rename cannot break a reference', async () => {
    const dir = await fresh('ids', {});
    await note(dir, 'sub/tief.md', 'id: stabil\ndate: 2026-03-01');
    await note(dir, 'sub/andere.md', 'date: 2026-03-02');
    const file = await scanDirectory(dir);
    const ids = file.items.map((i) => i.id);
    assert.ok(ids.includes('stabil'));
    assert.ok(ids.includes('sub/andere'), 'without an explicit id the extension-less path is the handle');
  });

  test('item fields are read off the frontmatter', async () => {
    const dir = await fresh('fields', {});
    await note(dir, 'a.md', 'date: 2026-03-01\nend: 2026-04-01\ngroup: Phase 1\nicon: launch\ntype: range\nstatus: Doing');
    const item = (await scanDirectory(dir)).items[0];
    assert.equal(item.end, '2026-04-01');
    assert.equal(item.group, 'Phase 1');
    assert.equal(item.icon, 'launch');
    assert.equal(item.type, 'range');
    assert.equal(item.status, 'Doing');
  });

  test('dot-directories are skipped', async () => {
    const dir = await fresh('trash', {});
    await note(dir, 'echt.md', 'date: 2026-03-01');
    await note(dir, '.trash/geloescht.md', 'date: 2026-03-02');
    const file = await scanDirectory(dir);
    assert.equal(file.items.length, 1, 'a deleted note must not come back as an item');
    assert.equal(file.items[0].id, 'echt');
  });

  test('one unparseable file does not take the directory down', async () => {
    const dir = await fresh('broken', {});
    await note(dir, 'gut.md', 'date: 2026-03-01');
    await writeFile(join(dir, 'kaputt.md'), '---\n: : nope\n  - [\n---\n', 'utf8');
    const file = await scanDirectory(dir);
    assert.ok(file.items.some((i) => i.id === 'gut'));
  });

  test('the order is stable, date-less last', async () => {
    const dir = await fresh('order', {});
    await note(dir, 'c.md', 'date: 2026-05-01');
    await note(dir, 'a.md', 'date: 2026-01-01');
    await note(dir, 'z-ohne.md', 'title: Ohne');
    const ids = (await scanDirectory(dir)).items.map((i) => i.id);
    assert.deepEqual(ids, ['a', 'c', 'z-ohne']);
  });
});

describe('scanDirectory: the container file', () => {
  test('groups, phases and groupBy come from it', async () => {
    const dir = await fresh('container', {
      name: 'Mein Plan',
      groupBy: 'group',
      groups: [{ id: 'p1', content: 'Phase 1' }],
      phases: [{ id: 'ph', label: 'Vorlauf', start: '2026-01-01', end: '2026-02-01' }],
    });
    await note(dir, 'a.md', 'date: 2026-03-01\ngroup: p1');
    const file = await scanDirectory(dir);
    assert.equal(file.name, 'Mein Plan');
    assert.equal(file.groupBy, 'group');
    assert.equal(file.groups?.length, 1);
    assert.equal(file.phases?.length, 1);
  });

  test('an items array in the container is ignored', async () => {
    const dir = await fresh('container-items', {
      items: [{ id: 'erfunden', content: 'Sollte nicht erscheinen' }],
    });
    await note(dir, 'a.md', 'date: 2026-03-01\ntitle: Echt');
    const file = await scanDirectory(dir);
    assert.equal(file.items.length, 1);
    assert.equal(file.items[0].content, 'Echt', 'the Markdown files are the items, full stop');
  });

  test('a malformed container costs the groups, not the items', async () => {
    const dir = join(root, 'container-broken');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CONTAINER_FILE), '{ kaputt', 'utf8');
    await note(dir, 'a.md', 'date: 2026-03-01');
    const file = await scanDirectory(dir);
    assert.equal(file.items.length, 1, 'one typo must not hide every note');
  });

  test('without a container the directory falls back to its own name', async () => {
    const dir = join(root, 'namenlos');
    await mkdir(dir, { recursive: true });
    await note(dir, 'a.md', 'date: 2026-03-01');
    const file = await scanDirectory(dir);
    assert.equal(file.name, 'namenlos');
  });
});

describe('discovery', () => {
  test('a directory counts as a timeline once it holds a container file', async () => {
    const yes = await fresh('marked', {});
    const no = join(root, 'unmarked');
    await mkdir(no, { recursive: true });
    assert.equal(isTimelineDirectory(yes), true);
    assert.equal(isTimelineDirectory(no), false);
  });

  test('a container nested inside a timeline does not split it in two', async () => {
    const outer = await fresh('outer', {});
    await mkdir(join(outer, 'innen'), { recursive: true });
    await writeFile(join(outer, 'innen', CONTAINER_FILE), '{}', 'utf8');
    const found = await timelineDirectories(root);
    assert.ok(found.includes(outer));
    assert.ok(!found.includes(join(outer, 'innen')), 'the outer timeline owns its whole subtree');
  });

  test('the version moves when a note changes', async () => {
    const dir = await fresh('version', {});
    await note(dir, 'a.md', 'date: 2026-03-01');
    const before = await directoryVersion(dir);
    await new Promise((r) => setTimeout(r, 12));
    await note(dir, 'b.md', 'date: 2026-03-02');
    assert.ok((await directoryVersion(dir)) > before);
  });
});

describe('dates keep the shape the note wrote them in', () => {
  test('a day is a day, in both directions of the cascade', async () => {
    const dir = await fresh('dayshape', {});
    await note(dir, 'a.md', 'date: 2026-06-15');
    await note(dir, '2026-07-20-b.md', 'title: B');
    const items = (await scanDirectory(dir)).items;
    assert.equal(items.find((i) => i.id === 'a')!.start, '2026-06-15');
    assert.equal(items.find((i) => i.id === '2026-07-20-b')!.start, '2026-07-20');
  });

  test('a value that carries a time keeps it', async () => {
    const dir = await fresh('instant', {});
    await note(dir, 'a.md', "date: '2026-06-15T09:30:00Z'");
    assert.match((await scanDirectory(dir)).items[0].start!, /T09:30/);
  });

  test('an impossible day in a filename is not a date', async () => {
    const dir = await fresh('badday', {});
    await note(dir, '2026-02-31-nope.md', 'title: Nope');
    assert.equal((await scanDirectory(dir)).items[0].start, undefined);
  });
});

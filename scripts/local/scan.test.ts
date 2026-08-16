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

describe('scanDirectory: what the container declares about reading', () => {
  // A vault stamps `created` on every note. Reading it as the start puts every
  // item on the day it was typed, which looks like data and is an artefact of the
  // editor. An empty array has to survive as „no item dates here".
  test('an empty dateFields list leaves every item start-less', async () => {
    const dir = await fresh('no-dates', { scan: { dateFields: [] } });
    await note(dir, 'a.md', 'created: 2026-07-25\ntitle: Erstes');
    const file = await scanDirectory(dir);
    assert.equal(file.items.length, 1);
    assert.equal(file.items[0].start, undefined);
    // The value is still on metadata: the item must not become a lossy copy.
    assert.ok(file.items[0].metadata?.created);
  });

  test('without the declaration `created` is still a date, as before', async () => {
    const dir = await fresh('default-dates', {});
    await note(dir, 'a.md', 'created: 2026-07-25\ntitle: Erstes');
    const file = await scanDirectory(dir);
    assert.equal(file.items[0].start, '2026-07-25');
  });

  test('the container outranks the caller, because it travels with the folder', async () => {
    const dir = await fresh('container-wins', { scan: { dateFields: [] } });
    await note(dir, 'a.md', 'created: 2026-07-25');
    const file = await scanDirectory(dir, { dateFields: ['created'] });
    assert.equal(file.items[0].start, undefined);
  });

  test('groupFromFolder makes the subfolder the group, and frontmatter still wins', async () => {
    const dir = await fresh('folders', { scan: { groupFromFolder: true } });
    await note(dir, '_Revelations/a.md', 'title: A');
    await note(dir, '_Hints/b.md', 'title: B');
    await note(dir, '_Hints/c.md', 'group: eigene\ntitle: C');
    await note(dir, 'top.md', 'title: Top');
    const file = await scanDirectory(dir);
    const groupOf = (id: string) => file.items.find((i) => i.id === id)?.group;
    assert.equal(groupOf('_Revelations/a'), '_Revelations');
    assert.equal(groupOf('_Hints/b'), '_Hints');
    assert.equal(groupOf('_Hints/c'), 'eigene');
    // A note at the root has no folder to derive from, and must not get one.
    assert.equal(groupOf('top'), undefined);
  });

  test('groupFromFolder is off unless declared', async () => {
    const dir = await fresh('folders-off', {});
    await note(dir, '_Revelations/a.md', 'title: A');
    const file = await scanDirectory(dir);
    assert.equal(file.items[0].group, undefined);
  });

  // `scan` used to be stripped here — see „the scan block reaches the client"
  // below for why it is not any more. What is still true is that reading it never
  // costs the rest of the container: the two travel side by side.
  test('the scan block travels beside the container, not instead of it', async () => {
    const dir = await fresh('no-leak', { name: 'Buch', scan: { linkEdges: true } });
    await note(dir, 'a.md', 'title: A');
    const file = await scanDirectory(dir);
    assert.equal(file.name, 'Buch');
    assert.deepEqual(file.scan, { linkEdges: true });
  });
});

describe('scanDirectory: wikilinks as relations', () => {
  const dependsOn = (file: Awaited<ReturnType<typeof scanDirectory>>, id: string) =>
    file.items.find((i) => i.id === id)?.metadata?.dependsOn;

  test('a body link and a frontmatter link both become edges', async () => {
    const dir = await fresh('links', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, '_Scenes/Szene.md', 'Revelation:\n  - "[[Die Enthüllung]]"', 'Vgl. [[Der Hinweis]].');
    await note(dir, '_Revelations/Die Enthüllung.md', 'title: Die Enthüllung');
    await note(dir, '_Hints/Der Hinweis.md', 'title: Der Hinweis');
    const file = await scanDirectory(dir);
    assert.deepEqual(dependsOn(file, '_Scenes/Szene'), [
      '_Revelations/Die Enthüllung',
      '_Hints/Der Hinweis',
    ]);
  });

  test('a link resolves by full path as well as by bare title', async () => {
    const dir = await fresh('links-path', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', '', 'Siehe [[_Hints/Der Hinweis]] und [[Der Hinweis]].');
    await note(dir, '_Hints/Der Hinweis.md', 'title: Der Hinweis');
    // Both spellings name the same note, so it is one edge and not two.
    assert.deepEqual(dependsOn(await scanDirectory(dir), 'a'), ['_Hints/Der Hinweis']);
  });

  test('an alias, an anchor and a vault-absolute path all still resolve', async () => {
    const dir = await fresh('links-forms', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', '', 'A [[Ziel|anders genannt]] B [[Ziel#Abschnitt]] C [[Vault/Weit/Weg/Ziel|Ziel]]');
    await note(dir, 'Ziel.md', 'title: Ziel');
    assert.deepEqual(dependsOn(await scanDirectory(dir), 'a'), ['Ziel']);
  });

  // A vault carries both spellings of every quote, and matching the raw strings
  // makes an edge vanish with no error anywhere.
  test('typographic and straight quotes match each other', async () => {
    const dir = await fresh('links-quotes', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', '', "Siehe [[Finn's Plan]].");
    await note(dir, 'Finn’s Plan.md', 'title: Plan');
    assert.deepEqual(dependsOn(await scanDirectory(dir), 'a'), ['Finn’s Plan']);
  });

  test('a link to nothing, to itself, and one inside a code fence are all dropped', async () => {
    const dir = await fresh('links-junk', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', '', 'Fehlt: [[Gibt es nicht]]. Selbst: [[a]].\n```\n[[Der Hinweis]]\n```\n');
    await note(dir, '_Hints/Der Hinweis.md', 'title: Der Hinweis');
    assert.equal(dependsOn(await scanDirectory(dir), 'a'), undefined);
  });

  test('edges are off unless declared', async () => {
    const dir = await fresh('links-off', { scan: { dateFields: [] } });
    await note(dir, 'a.md', '', 'Siehe [[Ziel]].');
    await note(dir, 'Ziel.md', 'title: Ziel');
    assert.equal(dependsOn(await scanDirectory(dir), 'a'), undefined);
  });

  // Resolving as the walk goes would make an edge depend on directory order.
  test('a link pointing at a note the walk reaches later still resolves', async () => {
    const dir = await fresh('links-order', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'aaa.md', '', 'Siehe [[zzz]].');
    await note(dir, 'zzz.md', 'title: Z');
    assert.deepEqual(dependsOn(await scanDirectory(dir), 'aaa'), ['zzz']);
  });
});

// `dependsOn` flattens every link into one relation with one direction, and the
// field a link sat under is what says which direction was meant. These pin down
// that the scanner keeps the name without acting on it.
describe('scanDirectory: where a wikilink came from', () => {
  const wikilinks = (file: Awaited<ReturnType<typeof scanDirectory>>, id: string) =>
    file.items.find((i) => i.id === id)?.metadata?.wikilinks;
  const dependsOn = (file: Awaited<ReturnType<typeof scanDirectory>>, id: string) =>
    file.items.find((i) => i.id === id)?.metadata?.dependsOn;

  test('a frontmatter link carries its key, a body link carries null', async () => {
    const dir = await fresh('wl-field', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', 'Revelations:\n  - "[[Ziel]]"', 'Vgl. [[Hinweis]].');
    await note(dir, 'Ziel.md', 'title: Ziel');
    await note(dir, 'Hinweis.md', 'title: Hinweis');
    assert.deepEqual(wikilinks(await scanDirectory(dir), 'a'), [
      { field: 'Revelations', target: 'Ziel' },
      { field: null, target: 'Hinweis' },
    ]);
  });

  // The case the whole key exists for: two fields naming one note is what a
  // direction-aware consumer has to be able to tell apart.
  test('one target under two fields is two entries and one dependency', async () => {
    const dir = await fresh('wl-two', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', 'Revelations:\n  - "[[Ziel]]"\nHints:\n  - "[[Ziel]]"');
    await note(dir, 'Ziel.md', 'title: Ziel');
    const file = await scanDirectory(dir);
    assert.deepEqual(wikilinks(file, 'a'), [
      { field: 'Revelations', target: 'Ziel' },
      { field: 'Hints', target: 'Ziel' },
    ]);
    assert.deepEqual(dependsOn(file, 'a'), ['Ziel']);
  });

  test('one field naming a target twice is one entry', async () => {
    const dir = await fresh('wl-dup', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', 'Revelations:\n  - "[[Ziel]]"\n  - "[[Ziel|anders genannt]]"');
    await note(dir, 'Ziel.md', 'title: Ziel');
    assert.deepEqual(wikilinks(await scanDirectory(dir), 'a'), [{ field: 'Revelations', target: 'Ziel' }]);
  });

  // A sub-key is not a field of its own: „which field links this" is a statement
  // about the top-level key, which is the one a reader sees and selects.
  test('a nested value reports the top-level key it hangs under', async () => {
    const dir = await fresh('wl-nested', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', 'Struktur:\n  spaeter:\n    - "[[Ziel]]"');
    await note(dir, 'Ziel.md', 'title: Ziel');
    assert.deepEqual(wikilinks(await scanDirectory(dir), 'a'), [{ field: 'Struktur', target: 'Ziel' }]);
  });

  test('a link inside a code fence appears in neither key', async () => {
    const dir = await fresh('wl-fence', { scan: { linkEdges: true, dateFields: [] } });
    await note(dir, 'a.md', '', '```\n[[Ziel]]\n```\n');
    await note(dir, 'Ziel.md', 'title: Ziel');
    const file = await scanDirectory(dir);
    assert.equal(wikilinks(file, 'a'), undefined);
    assert.equal(dependsOn(file, 'a'), undefined);
  });

  test('nothing is recorded unless edges are declared', async () => {
    const dir = await fresh('wl-off', { scan: { dateFields: [] } });
    await note(dir, 'a.md', 'Revelations:\n  - "[[Ziel]]"');
    await note(dir, 'Ziel.md', 'title: Ziel');
    assert.equal(wikilinks(await scanDirectory(dir), 'a'), undefined);
  });
});

describe('scanDirectory: an order file as the items\' sequence', () => {
  const sequence = (file: Awaited<ReturnType<typeof scanDirectory>>, id: string) =>
    file.items.find((i) => i.id === id)?.metadata?.sequence;

  /** A folder whose notes are listed by `_Index.md`, plus one the index skips. */
  async function ordered(name: string, index: string, scan: object = {}): Promise<string> {
    const dir = await fresh(name, { scan: { dateFields: [], orderFrom: '_Index.md', ...scan } });
    await writeFile(join(dir, '_Index.md'), index, 'utf8');
    for (const title of ['Erste', 'Zweite', 'Dritte', 'Ungenannte']) {
      await note(dir, `_Scenes/${title}.md`, `title: ${title}`);
    }
    return dir;
  }

  test('the links of the order file number the items, top to bottom', async () => {
    const file = await scanDirectory(await ordered('seq', '- [[Zweite]]\n- [[Erste]]\n'));
    assert.equal(sequence(file, '_Scenes/Zweite'), 1);
    assert.equal(sequence(file, '_Scenes/Erste'), 2);
  });

  // The reading is deliberately blind to markdown structure: a heading naming a
  // note takes a position where it stands, which puts a part or a chapter just
  // ahead of what is listed under it.
  test('a heading and a nested bullet count like any other link', async () => {
    const file = await scanDirectory(
      await ordered('seq-shape', '## [[Erste]]\n\n- [[Zweite]]\n\t- [[Dritte]]\n'),
    );
    assert.deepEqual(
      ['Erste', 'Zweite', 'Dritte'].map((t) => sequence(file, `_Scenes/${t}`)),
      [1, 2, 3],
    );
  });

  test('a second mention does not move an item, and takes no position with it', async () => {
    const file = await scanDirectory(await ordered('seq-again', '- [[Erste]]\n- [[Erste]]\n- [[Zweite]]\n'));
    assert.equal(sequence(file, '_Scenes/Erste'), 1);
    assert.equal(sequence(file, '_Scenes/Zweite'), 2);
  });

  test('a link out of the folder is skipped rather than counted', async () => {
    const file = await scanDirectory(await ordered('seq-outside', '- [[Woanders]]\n- [[Erste]]\n'));
    assert.equal(sequence(file, '_Scenes/Erste'), 1);
  });

  test('an item the order file never names carries no position', async () => {
    const file = await scanDirectory(await ordered('seq-unnamed', '- [[Erste]]\n'));
    assert.equal(sequence(file, '_Scenes/Ungenannte'), undefined);
  });

  test('frontmatter and fenced code are not part of the order', async () => {
    const file = await scanDirectory(
      await ordered('seq-fence', '---\nlist:\n  - "[[Dritte]]"\n---\n```\n[[Zweite]]\n```\n- [[Erste]]\n'),
    );
    assert.equal(sequence(file, '_Scenes/Erste'), 1);
    assert.equal(sequence(file, '_Scenes/Zweite'), undefined);
    assert.equal(sequence(file, '_Scenes/Dritte'), undefined);
  });

  // Two independent settings: an order says where an item sits, a link says what it
  // relates to, and a folder can want either without the other.
  test('positions are recorded without linkEdges, and links without an order file', async () => {
    const withOrder = await scanDirectory(await ordered('seq-no-edges', '- [[Erste]]\n'));
    assert.equal(sequence(withOrder, '_Scenes/Erste'), 1);
    assert.equal(withOrder.items.find((i) => i.id === '_Scenes/Erste')?.metadata?.dependsOn, undefined);

    const dir = await fresh('seq-none', { scan: { dateFields: [], linkEdges: true } });
    await note(dir, 'a.md', '', 'Vgl. [[Ziel]].');
    await note(dir, 'Ziel.md', 'title: Ziel');
    const noOrder = await scanDirectory(dir);
    assert.deepEqual(noOrder.items.find((i) => i.id === 'a')?.metadata?.dependsOn, ['Ziel']);
    assert.equal(sequence(noOrder, 'Ziel'), undefined);
  });

  test('a named but missing order file leaves the items unpositioned', async () => {
    const dir = await fresh('seq-missing', { scan: { dateFields: [], orderFrom: '_Nope.md' } });
    await note(dir, 'a.md', 'title: A');
    const file = await scanDirectory(dir);
    assert.equal(file.items.length, 1);
    assert.equal(sequence(file, 'a'), undefined);
  });
});

// The scan block used to be stripped here, which left the settings form with no
// way to show a setting the code reads (AGENTS.md → „A stored setting is reachable
// in the interface"). It now travels with the result, and always as an object:
// its PRESENCE is what tells „this timeline is a scanned folder" from „this
// folder has named no order file", which are different answers.
describe('scanDirectory: the scan block reaches the client', () => {
  test('what the folder declares comes back as it stands', async () => {
    const dir = await fresh('scan-declared', {
      name: 'F',
      scan: { dateFields: [], orderFrom: '_Index.md', linkEdges: true },
    });
    await note(dir, 'a.md', 'title: A');
    assert.deepEqual((await scanDirectory(dir)).scan, {
      dateFields: [],
      orderFrom: '_Index.md',
      linkEdges: true,
    });
  });

  test('a folder that declares nothing still carries an empty block', async () => {
    const dir = await fresh('scan-empty', { name: 'F' });
    await note(dir, 'a.md', 'title: A');
    assert.deepEqual((await scanDirectory(dir)).scan, {});
  });

  // The defaults the caller passes are what the scan RAN with; the block is what
  // the folder SAYS. Folding the two together would show a form full of settings
  // nobody wrote, and saving one would write them all into the file.
  test('the block is what the folder declared, not what the scan resolved', async () => {
    const dir = await fresh('scan-opts', { name: 'F' });
    await note(dir, 'a.md', 'title: A');
    const file = await scanDirectory(dir, { dateFields: ['when'], orderFrom: '_Von-Aussen.md' });
    assert.deepEqual(file.scan, {});
  });
});

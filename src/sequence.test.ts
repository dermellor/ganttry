import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { orderChoices, orderedIds, sequencePositions } from './sequence';
import type { TimelineFileItem } from './types';
import { setLocale } from './i18n';
// German, for the reason timelineMeta.test.ts asks for it: what is pinned is the
// rule, and the wording is only how it is observed.
setLocale('de');

/** A note carrying body links, the shape the scan records them in. */
const note = (id: string, ...targets: string[]): TimelineFileItem => ({
  id,
  content: id,
  metadata: targets.length ? { wikilinks: targets.map((target) => ({ field: null, target })) } : {},
});

/** The same, but with the links sitting under a frontmatter key instead. */
const declared = (id: string, field: string, ...targets: string[]): TimelineFileItem => ({
  id,
  content: id,
  metadata: { wikilinks: targets.map((target) => ({ field, target })) },
});

describe('orderedIds', () => {
  test('the body links of the named note are the order, top to bottom', () => {
    const items = [note('_Index', 's2', 's1', 's3'), note('s1'), note('s2'), note('s3')];
    assert.deepEqual(orderedIds(items, '_Index'), ['s2', 's1', 's3']);
  });

  test('no note named, or a note this timeline does not carry, is no order', () => {
    const items = [note('_Index', 's1'), note('s1')];
    assert.deepEqual(orderedIds(items, ''), []);
    assert.deepEqual(orderedIds(items, null), []);
    assert.deepEqual(orderedIds(items, '_Weg'), []);
    assert.deepEqual(orderedIds(undefined, '_Index'), []);
  });

  // The order is what the *document* says. A link under a frontmatter key is a
  // relation somebody declared about the note, which is a different statement —
  // and the scan took the same reading when it skipped an order file's frontmatter.
  test('a link under a frontmatter key is not part of the order', () => {
    const items = [declared('_Index', 'Revelations', 's1', 's2'), note('s1'), note('s2')];
    assert.deepEqual(orderedIds(items, '_Index'), []);
  });

  test('the first mention wins, so a cross-reference cannot push a note to the end', () => {
    const items = [note('_Index', 's1', 's2', 's1'), note('s1'), note('s2')];
    assert.deepEqual(orderedIds(items, '_Index'), ['s1', 's2']);
  });

  test('a note with no body links at all yields nothing rather than throwing', () => {
    assert.deepEqual(orderedIds([note('_Leer')], '_Leer'), []);
  });
});

describe('sequencePositions', () => {
  test('a view that declares no order yields nothing', () => {
    assert.equal(sequencePositions([note('a', 'b'), note('b')]).size, 0);
    assert.equal(sequencePositions(undefined).size, 0);
  });

  test('the order numbers the items 1-based, in the order it lists them', () => {
    const out = sequencePositions([note('s1'), note('s2')], ['s1', 's2']);
    assert.deepEqual([...out], [['s1', 1], ['s2', 2]]);
  });

  // A link out of the folder was never recorded, so it never reached the list —
  // but an id that names nothing here can still arrive from a stored view whose
  // note was renamed. Counting it would leave a gap that reads as a deleted item.
  test('an id this timeline does not carry takes no position with it', () => {
    const out = sequencePositions([note('s1'), note('s2')], ['weg', 's1', 's2']);
    assert.deepEqual([...out], [['s1', 1], ['s2', 2]]);
  });

  test('an unlisted item takes the lowest position among the items linking to it', () => {
    const items = [note('s9', 'rev'), note('s4', 'rev'), note('s7', 'rev'), note('rev')];
    const out = sequencePositions(items, ['s4', 's7', 's9']);
    assert.equal(out.get('rev'), 1, 's4 is first in the order, so its position is the lowest');
  });

  test('a listed item does not inherit from a later one that mentions it', () => {
    const out = sequencePositions([note('s2'), note('s8', 's2')], ['s2', 's8']);
    assert.equal(out.get('s2'), 1);
  });

  // One hop: a position that seeped along a chain of references would make the
  // whole graph read as if it happened at the first scene.
  test('the derivation does not travel on from an item that inherited one', () => {
    const items = [note('s3', 'rev'), note('rev', 'hint'), note('hint')];
    const out = sequencePositions(items, ['s3']);
    assert.equal(out.get('rev'), 1);
    assert.equal(out.has('hint'), false);
  });

  test('a hand-written dependsOn links the same way a scanned wikilink does', () => {
    const scene: TimelineFileItem = { id: 's5', content: 's5', metadata: { dependsOn: ['rev'] } };
    assert.equal(sequencePositions([scene, note('rev')], ['s5']).get('rev'), 1);
  });

  test('a link to something that is not an item places nothing', () => {
    const out = sequencePositions([note('s1', 'missing')], ['s1']);
    // Recorded all the same: the map says where a position would fall, and the
    // consumers look ids up rather than iterate it.
    assert.equal(out.get('missing'), 1);
    assert.equal(out.get('s1'), 1);
  });
});

/** A note with a title of its own, for the choices below. */
const titled = (id: string, content: string, ...targets: string[]): TimelineFileItem => ({
  ...note(id, ...targets),
  content,
});

describe('orderChoices', () => {
  test('the notes listing the most are offered first, under their own titles', () => {
    const choices = orderChoices(
      [
        titled('_Klein', 'Kleine Liste', 'a', 'b'),
        titled('_Index', 'Index', 'a', 'b', 'c'),
        titled('a', 'Erste'),
        titled('b', 'Zweite'),
        titled('c', 'Dritte'),
      ],
      '',
    );
    assert.deepEqual(
      choices.map((c) => c.value),
      ['', '_Index', '_Klein'],
    );
    assert.equal(choices[0].label, 'Keine');
    assert.equal(choices[1].label, 'Index');
  });

  // Two is the smallest number that can state an order, and the threshold is what
  // keeps the list short enough to read: without it every note that mentions
  // another one would be offered as a table of contents.
  test('a note with a single link is not a running order', () => {
    const choices = orderChoices([titled('_Eins', 'Eins', 'a'), titled('a', 'A')], '');
    assert.deepEqual(choices.map((c) => c.value), ['']);
  });

  // A `<select>` reports its first option for a value it does not have, so a note
  // whose links were removed would read back as „Keine" and be saved as that on the
  // next change — the same trap the graph settings avoid from the other end.
  test('the stored choice is offered even when it lists nothing any more', () => {
    const choices = orderChoices([titled('_Leer', 'Leergeräumt')], '_Leer');
    assert.deepEqual(choices.map((c) => c.value), ['', '_Leer']);
    assert.equal(choices[1].label, 'Leergeräumt');
  });

  test('a stored choice this timeline no longer carries keeps its id as its name', () => {
    const choices = orderChoices([titled('a', 'A')], '_Weg');
    assert.deepEqual(choices.map((c) => c.value), ['', '_Weg']);
    assert.equal(choices[1].label, '_Weg');
  });

  test('a source recording no links at all offers nothing to choose between', () => {
    // Which is what hides the control: a JSON or database timeline states its
    // dependencies outright, and a folder read without `linkEdges` records none.
    assert.deepEqual(orderChoices([{ id: 'a', content: 'A' }], '').map((c) => c.value), ['']);
    assert.deepEqual(orderChoices(undefined, '').map((c) => c.value), ['']);
  });

  test('links under a frontmatter key do not make a note an order', () => {
    const items: TimelineFileItem[] = [
      { id: '_Rel', content: 'Relationen', metadata: { wikilinks: [
        { field: 'Revelations', target: 'a' },
        { field: 'Revelations', target: 'b' },
      ] } },
    ];
    assert.deepEqual(orderChoices(items, '').map((c) => c.value), ['']);
  });
});

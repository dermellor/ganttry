import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { sequencePositions } from './sequence';
import type { TimelineFileItem } from './types';

/** An item the order file placed, with the links it carries. */
const placed = (id: string, sequence: number, ...targets: string[]): TimelineFileItem => ({
  id,
  content: id,
  metadata: { sequence, wikilinks: targets.map((target) => ({ field: null, target })) },
});

/** An item the order file never named. */
const loose = (id: string, ...targets: string[]): TimelineFileItem => ({
  id,
  content: id,
  metadata: targets.length ? { wikilinks: targets.map((target) => ({ field: null, target })) } : {},
});

describe('sequencePositions', () => {
  test('a source that declares no order at all yields nothing', () => {
    assert.equal(sequencePositions([loose('a', 'b'), loose('b')]).size, 0);
    assert.equal(sequencePositions(undefined).size, 0);
  });

  test('a stated position is kept as it stands', () => {
    const out = sequencePositions([placed('s1', 1), placed('s2', 2)]);
    assert.deepEqual([...out], [['s1', 1], ['s2', 2]]);
  });

  test('an unlisted item takes the lowest position among the items linking to it', () => {
    const out = sequencePositions([
      placed('s9', 9, 'rev'),
      placed('s4', 4, 'rev'),
      placed('s7', 7, 'rev'),
      loose('rev'),
    ]);
    assert.equal(out.get('rev'), 4);
  });

  test('a listed item does not inherit from a later one that mentions it', () => {
    const out = sequencePositions([placed('s2', 2), placed('s8', 8, 's2')]);
    assert.equal(out.get('s2'), 2);
  });

  // One hop: a position that seeped along a chain of references would make the
  // whole graph read as if it happened at the first scene.
  test('the derivation does not travel on from an item that inherited one', () => {
    const out = sequencePositions([placed('s3', 3, 'rev'), loose('rev', 'hint'), loose('hint')]);
    assert.equal(out.get('rev'), 3);
    assert.equal(out.has('hint'), false);
  });

  test('a hand-written dependsOn links the same way a scanned wikilink does', () => {
    const scene: TimelineFileItem = {
      id: 's5',
      content: 's5',
      metadata: { sequence: 5, dependsOn: ['rev'] },
    };
    assert.equal(sequencePositions([scene, loose('rev')]).get('rev'), 5);
  });

  test('a link to something that is not an item places nothing', () => {
    const out = sequencePositions([placed('s1', 1, 'missing')]);
    // Recorded all the same: the map says where a position would fall, and the
    // consumers look ids up rather than iterate it.
    assert.equal(out.get('missing'), 1);
    assert.equal(out.get('s1'), 1);
  });
});

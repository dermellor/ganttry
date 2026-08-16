import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_FIELD,
  dependenciesFromLinks,
  directionOf,
  hasLinkFields,
  linkFieldsIn,
  sanitizeEdgeSelection,
  type EdgeSelection,
} from './linkEdges';
import type { TimelineFileItem } from './types';

const item = (id: string, links: Array<[string | null, string]>): TimelineFileItem => ({
  id,
  content: id,
  metadata: { wikilinks: links.map(([field, target]) => ({ field, target })) },
});

const deps = (items: TimelineFileItem[], selection: EdgeSelection) =>
  Object.fromEntries([...dependenciesFromLinks(items, selection)].sort());

describe('linkEdges: which fields are offered', () => {
  test('fields appear in first-seen order, with the body last', () => {
    const items = [
      item('a', [[null, 'b'], ['Hints', 'b']]),
      item('b', [['Revelations', 'a']]),
    ];
    assert.deepEqual(linkFieldsIn(items), ['Hints', 'Revelations', BODY_FIELD]);
  });

  // Every JSON and database source, and any folder read without `linkEdges`.
  test('a source that recorded nothing offers nothing', () => {
    const plain: TimelineFileItem[] = [{ id: 'a', content: 'a', metadata: { dependsOn: ['b'] } }];
    assert.equal(hasLinkFields(plain), false);
    assert.deepEqual(linkFieldsIn(plain), []);
    assert.deepEqual(linkFieldsIn(undefined), []);
  });
});

describe('linkEdges: deriving the dependencies', () => {
  const items = [item('scene', [['Revelations', 'reveal'], [null, 'hint']]), item('reveal', []), item('hint', [])];

  // The default has to reproduce what the scanner used to flatten onto
  // `dependsOn`, or turning this on would move every existing timeline's arrows.
  test('an unset field is incoming, matching what dependsOn always said', () => {
    assert.deepEqual(deps(items, {}), { scene: ['reveal', 'hint'] });
  });

  test('outgoing records the edge on the linked item instead', () => {
    assert.deepEqual(deps(items, { [BODY_FIELD]: 'out' }), { scene: ['reveal'], hint: ['scene'] });
  });

  test('off draws nothing for that field alone', () => {
    assert.deepEqual(deps(items, { Revelations: 'off' }), { scene: ['hint'] });
    assert.deepEqual(deps(items, { Revelations: 'off', [BODY_FIELD]: 'off' }), {});
  });

  // The case that motivated the whole feature: prose explaining a chain points
  // the opposite way from the field that states it, and flattening both onto one
  // direction silently restored edges the author had deleted.
  test('the two directions coexist on one pair of notes', () => {
    const pair = [item('beat2', [['Revelations', 'beat1'], [null, 'beat3']]), item('beat1', []), item('beat3', [])];
    assert.deepEqual(deps(pair, { [BODY_FIELD]: 'out' }), { beat2: ['beat1'], beat3: ['beat2'] });
  });

  test('a self link and a duplicate produce no edge and no repeat', () => {
    const odd = [item('a', [['F', 'a'], ['F', 'b'], [null, 'b']]), item('b', [])];
    assert.deepEqual(deps(odd, {}), { a: ['b'] });
  });

  test('an item without an id contributes nothing', () => {
    const anon: TimelineFileItem[] = [{ content: 'x', metadata: { wikilinks: [{ field: null, target: 'b' }] } }];
    assert.deepEqual(deps(anon, {}), {});
  });
});

describe('linkEdges: reading a stored selection', () => {
  test('a malformed entry reads as absent rather than throwing', () => {
    assert.deepEqual(sanitizeEdgeSelection({ a: 'in', b: 'sideways', c: 3, d: null }), { a: 'in' });
    assert.deepEqual(sanitizeEdgeSelection('nonsense'), {});
    assert.deepEqual(sanitizeEdgeSelection(undefined), {});
  });

  test('a field the selection says nothing about is incoming', () => {
    assert.equal(directionOf({}, 'Hints'), 'in');
    assert.equal(directionOf({ Hints: 'off' }, 'Hints'), 'off');
  });
});

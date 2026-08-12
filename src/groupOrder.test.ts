import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orderGroups } from './groupOrder';

const UNGROUPED = '__ungrouped';
const ids = (gs: { id: string }[]) => gs.map((g) => g.id);
const groups = (...list: string[]) => list.map((id) => ({ id }));

test('alpha is the default, and it is what every existing timeline gets', () => {
  const out = orderGroups(groups('c', 'a', 'b'), ['c', 'a', 'b'], undefined, UNGROUPED);
  assert.deepEqual(ids(out), ['a', 'b', 'c']);
  // Spelling the default out changes nothing.
  assert.deepEqual(ids(orderGroups(groups('c', 'a'), ['c', 'a'], 'alpha', UNGROUPED)), ['a', 'c']);
});

// The committed examples number their ids (`1-strategy`, `2-design`) to steer the
// alphabetical sort. That workaround has to keep working unchanged.
test('numbered ids still land in their numbered order', () => {
  const declared = ['1-strategy', '2-design', '3-engineering'];
  const out = orderGroups(groups('3-engineering', '1-strategy', '2-design'), declared, 'alpha', UNGROUPED);
  assert.deepEqual(ids(out), declared);
});

test('declared follows the declaration, however it sorts alphabetically', () => {
  // The folder names of a book: alphabetically „_Hero's" beats „_Hints", and the
  // reading order is neither.
  const declared = ['_Hints', '_Revelations', '_Scenes', "_Hero's Journey"];
  const out = orderGroups(
    groups('_Scenes', "_Hero's Journey", '_Hints', '_Revelations'),
    declared,
    'declared',
    UNGROUPED,
  );
  assert.deepEqual(ids(out), declared);
});

test('a group only seen on an item follows the declared ones, alphabetically', () => {
  const out = orderGroups(
    groups('zzz', '_Scenes', 'Exports', '_Hints'),
    ['_Hints', '_Scenes'],
    'declared',
    UNGROUPED,
  );
  // Declared first, in declaration order; then the undeclared ones by name — not
  // in whichever order the items happened to mention them.
  assert.deepEqual(ids(out), ['_Hints', '_Scenes', 'Exports', 'zzz']);
});

test('the ungrouped bucket is last under either mode', () => {
  for (const mode of ['alpha', 'declared'] as const) {
    const out = orderGroups(groups(UNGROUPED, 'b', 'a'), ['b', 'a'], mode, UNGROUPED);
    assert.equal(ids(out).at(-1), UNGROUPED, mode);
  }
});

test('the input array is not mutated', () => {
  const input = groups('c', 'a');
  orderGroups(input, ['c', 'a'], 'alpha', UNGROUPED);
  assert.deepEqual(ids(input), ['c', 'a']);
});

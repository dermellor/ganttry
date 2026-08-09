import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignMissingItemIds, nextItemId } from './itemId';

test('nextItemId starts at 1 and skips what is taken', () => {
  assert.equal(nextItemId([]), 'i1');
  assert.equal(nextItemId(['i1']), 'i2');
  assert.equal(nextItemId(['i1', 'i2', 'i3']), 'i4');
});

test('nextItemId reuses a gap left by a deletion', () => {
  // Linear probing rather than "highest + 1": ids are freed by deletion, and a
  // counter that only grows leaves them long and sparse.
  assert.equal(nextItemId(['i1', 'i3']), 'i2');
});

test('nextItemId ignores ids that are not of its shape', () => {
  assert.equal(nextItemId(['kickoff', 'launch-2026', 'a1']), 'i1');
});

test('nextItemId honours a prefix', () => {
  assert.equal(nextItemId(['g1', 'g2'], 'g'), 'g3');
  // A different prefix does not collide with the default one.
  assert.equal(nextItemId(['i1', 'i2'], 'g'), 'g1');
});

test('assignMissingItemIds fills only the gaps and reports whether it did', () => {
  const items = [{ id: 'kickoff' }, {}, { id: 'i2' }, {}];
  assert.equal(assignMissingItemIds(items), true);
  assert.deepEqual(items.map((i) => i.id), ['kickoff', 'i1', 'i2', 'i3']);
  // Second pass has nothing to do, and must say so — the caller persists on true.
  assert.equal(assignMissingItemIds(items), false);
});

test('two id-less items in one pass cannot both become i1', () => {
  const items: { id?: string }[] = [{}, {}, {}];
  assignMissingItemIds(items);
  assert.deepEqual(items.map((i) => i.id), ['i1', 'i2', 'i3']);
  assert.equal(new Set(items.map((i) => i.id)).size, 3);
});

test('an empty list is left alone', () => {
  const items: { id?: string }[] = [];
  assert.equal(assignMissingItemIds(items), false);
});

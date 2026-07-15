import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignableLeaves,
  firstAssignableGroup,
  parentGroupIds,
  resolveAssignableGroup,
  type GroupLike,
} from './groupHierarchy';

// Nested groups: a group with `nestedGroups` is a parent/container and is never
// assignable; items land only on its leaf children. These tests pin that
// classification, shared by the item form, drag handler, add-item defaults and
// the list view.

const GROUPS: GroupLike[] = [
  { id: 'comm', nestedGroups: ['comm-product', 'comm-tech'] },
  { id: 'comm-product' },
  { id: 'comm-tech' },
  { id: 'solo' }, // leaf with no children
];

test('parentGroupIds returns only groups that declare children', () => {
  assert.deepEqual([...parentGroupIds(GROUPS)], ['comm']);
});

test('parentGroupIds ignores an empty nestedGroups array', () => {
  assert.equal(parentGroupIds([{ id: 'x', nestedGroups: [] }]).size, 0);
});

test('assignableLeaves flattens a parent to its leaf children in order', () => {
  assert.deepEqual(assignableLeaves('comm', GROUPS), ['comm-product', 'comm-tech']);
});

test('assignableLeaves of a leaf group is the group itself', () => {
  assert.deepEqual(assignableLeaves('solo', GROUPS), ['solo']);
});

test('assignableLeaves descends through multiple nesting levels', () => {
  const deep: GroupLike[] = [
    { id: 'root', nestedGroups: ['mid'] },
    { id: 'mid', nestedGroups: ['leaf-1', 'leaf-2'] },
    { id: 'leaf-1' },
    { id: 'leaf-2' },
  ];
  assert.deepEqual(assignableLeaves('root', deep), ['leaf-1', 'leaf-2']);
});

test('assignableLeaves skips unknown and cyclic references', () => {
  const cyclic: GroupLike[] = [
    { id: 'a', nestedGroups: ['b', 'ghost'] },
    { id: 'b', nestedGroups: ['a'] }, // cycle back to a
  ];
  // a → b → (a already seen) → nothing; b and a are both parents, no real leaf.
  assert.deepEqual(assignableLeaves('a', cyclic), []);
});

test('resolveAssignableGroup redirects a parent to its first leaf', () => {
  assert.equal(resolveAssignableGroup('comm', GROUPS), 'comm-product');
});

test('resolveAssignableGroup keeps a leaf target unchanged', () => {
  assert.equal(resolveAssignableGroup('comm-tech', GROUPS), 'comm-tech');
});

test('resolveAssignableGroup returns undefined for null / unknown ids', () => {
  assert.equal(resolveAssignableGroup(null, GROUPS), undefined);
  assert.equal(resolveAssignableGroup('nope', GROUPS), undefined);
});

test('firstAssignableGroup skips a leading parent', () => {
  assert.equal(firstAssignableGroup(GROUPS), 'comm-product');
});

test('firstAssignableGroup returns undefined when every group is a parent', () => {
  const allParents: GroupLike[] = [
    { id: 'p1', nestedGroups: ['p2'] },
    { id: 'p2', nestedGroups: ['p1'] },
  ];
  assert.equal(firstAssignableGroup(allParents), undefined);
});

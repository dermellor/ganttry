import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hierarchyFolderTrees } from './hierarchyFolders';

const item = (id: string, group = 'g') => ({ id, group });

test('an expanded tree becomes one outer folder plus its nested folder', () => {
  const items = [item('root'), item('a'), item('mid'), item('leaf'), item('x')];
  const parents = new Map([['a', 'root'], ['mid', 'root'], ['leaf', 'mid']]);
  assert.deepEqual(hierarchyFolderTrees(items, parents), [
    { parentId: 'root', descendantIds: ['a', 'mid', 'leaf'], depth: 0 },
    { parentId: 'mid', descendantIds: ['leaf'], depth: 1 },
  ]);
});

test('a folded parent earns no empty folder body', () => {
  assert.deepEqual(hierarchyFolderTrees([item('root'), item('x')], new Map([['hidden', 'root']])), []);
});

test('a relationship crossing tracks does not paint a folder', () => {
  const items = [item('root', 'a'), item('child', 'b')];
  assert.deepEqual(hierarchyFolderTrees(items, new Map([['child', 'root']])), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorIds,
  childRollup,
  childrenByParent,
  extentOverflow,
  hiddenByCollapse,
  hierarchyDepth,
  readParentId,
  resolveParents,
  treeOrder,
  wouldCreateCycle,
} from './itemHierarchy';

const ids = (...list: string[]) => new Set(list);
const links = (o: Record<string, string>) => new Map(Object.entries(o));

test('readParentId accepts a non-empty string and nothing else', () => {
  assert.equal(readParentId({ parent: 'D-12' }), 'D-12');
  assert.equal(readParentId({ parent: '  D-12  ' }), 'D-12');
  assert.equal(readParentId({ parent: '   ' }), undefined);
  assert.equal(readParentId({ parent: ['D-12'] }), undefined);
  assert.equal(readParentId({}), undefined);
  assert.equal(readParentId(null), undefined);
});

test('resolveParents drops self-links and unknown targets', () => {
  const out = resolveParents(
    links({ a: 'a', b: 'ghost', c: 'p' }),
    ids('a', 'b', 'c', 'p'),
  );
  assert.deepEqual([...out], [['c', 'p']]);
});

test('resolveParents drops a child that no longer exists', () => {
  const out = resolveParents(links({ gone: 'p' }), ids('p'));
  assert.equal(out.size, 0);
});

// A cycle is what a hand-edited file or a re-parent done in two steps produces,
// and every walker downstream would recurse on it forever.
test('resolveParents breaks a cycle by dropping the closing edge', () => {
  const two = resolveParents(links({ a: 'b', b: 'a' }), ids('a', 'b'));
  assert.equal(two.size, 1);
  // Whichever edge survived, the child now sits one level under a real root.
  assert.equal(hierarchyDepth(two).get([...two.keys()][0]), 1);

  const three = resolveParents(links({ a: 'b', b: 'c', c: 'a' }), ids('a', 'b', 'c'));
  assert.equal(three.size, 2);
  // Whatever survived has to be walkable to a root.
  for (const id of three.keys()) assert.ok(ancestorIds(three, id).length >= 1);
});

test('childrenByParent keeps declaration order', () => {
  const out = childrenByParent(links({ 'D-1': 'D-12', 'D-2': 'D-12', 'D-5': 'D-2' }));
  assert.deepEqual(out.get('D-12'), ['D-1', 'D-2']);
  assert.deepEqual(out.get('D-5'), undefined);
  assert.deepEqual(out.get('D-2'), ['D-5']);
});

test('hierarchyDepth counts levels, roots stay absent', () => {
  const depth = hierarchyDepth(links({ b: 'a', c: 'b' }));
  assert.equal(depth.get('a') ?? 0, 0);
  assert.equal(depth.get('b'), 1);
  assert.equal(depth.get('c'), 2);
});

test('ancestorIds walks nearest-first', () => {
  assert.deepEqual(ancestorIds(links({ c: 'b', b: 'a' }), 'c'), ['b', 'a']);
  assert.deepEqual(ancestorIds(links({ c: 'b', b: 'a' }), 'a'), []);
});

test('wouldCreateCycle rejects self and any descendant', () => {
  const parents = links({ b: 'a', c: 'b' });
  assert.equal(wouldCreateCycle(parents, 'a', 'a'), true);
  assert.equal(wouldCreateCycle(parents, 'a', 'c'), true); // c is a's grandchild
  assert.equal(wouldCreateCycle(parents, 'c', 'a'), false); // already the case
  assert.equal(wouldCreateCycle(parents, 'x', 'c'), false);
});

// Collapsing a root has to take the grandchildren with it, or they float
// without the row they belong under.
test('hiddenByCollapse hides the whole subtree', () => {
  const parents = links({ b: 'a', c: 'b', d: 'a', e: 'z' });
  assert.deepEqual([...hiddenByCollapse(parents, new Set(['a']))].sort(), ['b', 'c', 'd']);
  assert.deepEqual([...hiddenByCollapse(parents, new Set(['b']))], ['c']);
  assert.equal(hiddenByCollapse(parents, new Set()).size, 0);
});

test('childRollup spans earliest start to latest end', () => {
  assert.deepEqual(
    childRollup([
      { start: '2026-08-06', end: '2026-08-11' },
      { start: '2026-07-16', end: '2026-07-24' },
      { start: '2026-09-07', end: '2026-09-21' },
    ]),
    { start: '2026-07-16', end: '2026-09-21' },
  );
  // A milestone occupies its start.
  assert.deepEqual(childRollup([{ start: '2026-08-24' }]), {
    start: '2026-08-24',
    end: '2026-08-24',
  });
  assert.equal(childRollup([{ end: '2026-08-24' }]), null);
  assert.equal(childRollup([]), null);
});

test('extentOverflow reports only the sides the children exceed', () => {
  const parent = { start: '2026-07-22', end: '2026-09-22' };
  assert.deepEqual(extentOverflow(parent, [{ start: '2026-07-16', end: '2026-07-24' }]), {
    before: '2026-07-16',
    after: null,
  });
  assert.deepEqual(extentOverflow(parent, [{ start: '2026-08-01', end: '2026-10-02' }]), {
    before: null,
    after: '2026-10-02',
  });
  assert.deepEqual(extentOverflow(parent, [{ start: '2026-08-01', end: '2026-08-09' }]), {
    before: null,
    after: null,
  });
  assert.deepEqual(extentOverflow({}, [{ start: '2026-08-01' }]), {
    before: null,
    after: null,
  });
});

test('treeOrder emits each item before its children', () => {
  const items = [{ id: 'D-1' }, { id: 'D-12' }, { id: 'D-2' }, { id: 'D-5' }];
  const out = treeOrder(items, links({ 'D-1': 'D-12', 'D-2': 'D-12', 'D-5': 'D-2' }));
  assert.deepEqual(
    out.map((e) => [e.item.id, e.depth]),
    [
      ['D-12', 0],
      ['D-1', 1],
      ['D-2', 1],
      ['D-5', 2],
    ],
  );
});

// A list section can hold a child without its parent (they carry different
// tags). Dropping it would make the item disappear from a view it belongs in.
test('treeOrder treats a child with an absent parent as a root', () => {
  const out = treeOrder([{ id: 'D-2' }], links({ 'D-2': 'D-12' }));
  assert.deepEqual(
    out.map((e) => [e.item.id, e.depth]),
    [['D-2', 0]],
  );
});

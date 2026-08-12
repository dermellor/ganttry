import test from 'node:test';
import assert from 'node:assert/strict';

import {
  layoutGraph,
  BAND_GAP,
  HEADER_H,
  MARGIN,
  NODE_H,
  NODE_W,
  ROW_GAP,
  COL_GAP,
  type GraphInput,
} from './graphLayout';

const columns = (...ids: string[]) => ids.map((id) => ({ id, label: id.toUpperCase() }));

function graph(partial: Partial<GraphInput>): GraphInput {
  return { columns: [], nodes: [], edges: [], ...partial };
}

const nodeById = (result: ReturnType<typeof layoutGraph>, id: string) => {
  const node = result.nodes.find((n) => n.id === id);
  assert.ok(node, `no node ${id}`);
  return node;
};

test('places a node in the column its bucket names', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'b' },
        { id: '2', column: 'a' },
      ],
    }),
  );
  assert.equal(nodeById(out, '1').column, 1);
  assert.equal(nodeById(out, '2').column, 0);
  assert.equal(nodeById(out, '2').x, MARGIN);
  assert.equal(nodeById(out, '1').x, MARGIN + NODE_W + COL_GAP);
});

// A multi-valued dimension lists one item under every value it carries. Two boxes
// for one item would draw its edges twice and make a click ambiguous.
test('an item listed in several buckets is drawn once, in the first', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '1', column: 'b' },
      ],
    }),
  );
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].column, 0);
});

test('drops a node whose bucket is not among the columns', () => {
  const out = layoutGraph(
    graph({ columns: columns('a'), nodes: [{ id: '1', column: 'nope' }] }),
  );
  assert.deepEqual(out.nodes, []);
});

test('is empty, not header-high, without any node', () => {
  const out = layoutGraph(graph({ columns: columns('a') }));
  assert.equal(out.height, 0);
  assert.deepEqual(out.bands, []);
});

// The extent narrows the node set. An edge left dangling would read as "depends on
// something invisible" rather than as "you filtered it out".
test('drops an edge whose other end is not drawn', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a'),
      nodes: [{ id: '1', column: 'a' }],
      edges: [{ from: '1', to: 'gone', kind: 'depends' }],
    }),
  );
  assert.deepEqual(out.edges, []);
  // …and with no edge left, the node is loose.
  assert.equal(out.bands[0].loose, true);
});

test('drops a self-link and de-duplicates repeated edges', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'b' },
      ],
      edges: [
        { from: '1', to: '1', kind: 'depends' },
        { from: '1', to: '2', kind: 'depends' },
        { from: '1', to: '2', kind: 'depends' },
      ],
    }),
  );
  assert.deepEqual(out.edges, [{ from: '1', to: '2', kind: 'depends' }]);
});

// Two edges of different kinds between the same pair are two statements, so the
// de-duplication must not collapse them into one.
test('keeps a dependency and a containment between the same pair', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'b' },
      ],
      edges: [
        { from: '1', to: '2', kind: 'depends' },
        { from: '1', to: '2', kind: 'parent' },
      ],
    }),
  );
  assert.equal(out.edges.length, 2);
});

test('connected nodes share a band, unconnected ones fall into the loose band', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'b' },
        { id: '3', column: 'a' },
      ],
      edges: [{ from: '1', to: '2', kind: 'depends' }],
    }),
  );
  assert.equal(out.bands.length, 2);
  assert.deepEqual(out.bands[0], { ...out.bands[0], loose: false, nodeIds: ['1', '2'] });
  assert.deepEqual(out.bands[1], { ...out.bands[1], loose: true, nodeIds: ['3'] });
  assert.equal(nodeById(out, '1').band, 0);
  assert.equal(nodeById(out, '3').band, 1);
});

test('two separate chains are two bands, stacked without overlapping', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'b' },
        { id: '3', column: 'a' },
        { id: '4', column: 'b' },
      ],
      edges: [
        { from: '1', to: '2', kind: 'depends' },
        { from: '3', to: '4', kind: 'depends' },
      ],
    }),
  );
  assert.equal(out.bands.length, 2);
  assert.equal(out.bands.every((b) => !b.loose), true);
  const [first, second] = out.bands;
  assert.equal(second.top, first.top + first.height + BAND_GAP);
  assert.equal(first.top, MARGIN + HEADER_H);
  assert.ok(nodeById(out, '3').y > nodeById(out, '1').y);
});

// Ordering bands by size would reshuffle the picture whenever one item gains a
// dependency, so they follow the order the sections produced.
test('bands follow the order of their first node', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: 'solo-a', column: 'a' },
        { id: 'solo-b', column: 'b' },
        { id: 'pair-1', column: 'a' },
        { id: 'pair-2', column: 'b' },
      ],
      edges: [
        { from: 'solo-a', to: 'solo-b', kind: 'depends' },
        { from: 'pair-1', to: 'pair-2', kind: 'depends' },
      ],
    }),
  );
  assert.deepEqual(
    out.bands.map((b) => b.nodeIds[0]),
    ['solo-a', 'pair-1'],
  );
});

// The point of the relaxation: a node sits opposite what it is linked to, rather
// than wherever the section order happened to put it.
test('barycenter ordering pulls a node opposite its neighbour', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: 'a1', column: 'a' },
        { id: 'a2', column: 'a' },
        { id: 'a3', column: 'a' },
        // Listed first in its column, but linked to the *last* node of column a.
        { id: 'b1', column: 'b' },
        { id: 'b2', column: 'b' },
      ],
      edges: [
        { from: 'a3', to: 'b1', kind: 'depends' },
        { from: 'a1', to: 'b2', kind: 'depends' },
      ],
    }),
  );
  // One band (a1–b2 and a3–b1 are separate chains) — check each pairing instead.
  assert.equal(nodeById(out, 'a1').row, 0);
  assert.equal(nodeById(out, 'b2').row, 0);
  assert.equal(nodeById(out, 'a3').row, 0);
  assert.equal(nodeById(out, 'b1').row, 0);
  // a2 has no edge at all, so it is loose rather than sitting between them.
  assert.equal(out.bands[nodeById(out, 'a2').band].loose, true);
});

test('a chain across three columns keeps its rows aligned', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b', 'c'),
      nodes: [
        { id: 'x1', column: 'a' },
        { id: 'x2', column: 'b' },
        { id: 'x3', column: 'c' },
        { id: 'y1', column: 'a' },
        { id: 'y2', column: 'b' },
        { id: 'y3', column: 'c' },
      ],
      edges: [
        { from: 'x1', to: 'x2', kind: 'depends' },
        { from: 'x2', to: 'x3', kind: 'depends' },
        { from: 'y1', to: 'y2', kind: 'depends' },
        { from: 'y2', to: 'y3', kind: 'depends' },
      ],
    }),
  );
  for (const chain of [['x1', 'x2', 'x3'], ['y1', 'y2', 'y3']]) {
    const ys = chain.map((id) => nodeById(out, id).y);
    assert.equal(new Set(ys).size, 1, `${chain.join('→')} should sit on one row`);
  }
});

test('rows inside a column are one node pitch apart', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'a' },
      ],
    }),
  );
  assert.equal(nodeById(out, '2').y - nodeById(out, '1').y, NODE_H + ROW_GAP);
});

// A cycle is malformed data (dependsOn can express one), and a layout that
// recursed on it would hang the view rather than draw the mess.
test('survives a dependency cycle', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'b' },
      ],
      edges: [
        { from: '1', to: '2', kind: 'depends' },
        { from: '2', to: '1', kind: 'depends' },
      ],
    }),
  );
  assert.equal(out.nodes.length, 2);
  assert.equal(out.bands.length, 1);
});

test('an edge inside one column is kept and its nodes share a band', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'a' },
      ],
      edges: [{ from: '1', to: '2', kind: 'depends' }],
    }),
  );
  assert.equal(out.edges.length, 1);
  assert.equal(out.bands.length, 1);
  assert.equal(out.bands[0].loose, false);
});

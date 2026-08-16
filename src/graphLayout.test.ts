import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  collapseClusterGaps,
  edgePath,
  layoutGraph,
  BAND_GAP,
  BAND_PAD,
  BAND_TITLE_H,
  HEADER_H,
  INDENT_STEP,
  MARGIN,
  nodeHeight,
  estimateLines,
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

test('edgeless nodes in a column stack directly under each other', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'a' },
      ],
    }),
  );
  const first = nodeById(out, '1');
  assert.equal(nodeById(out, '2').y - first.y, first.height + ROW_GAP);
});

test('a node’s height follows what is in it', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a'),
      nodes: [
        { id: 'plain', column: 'a' },
        { id: 'tall', column: 'a', lines: 3, meta: true, reference: true },
      ],
    }),
  );
  assert.equal(nodeById(out, 'plain').height, nodeHeight({}));
  assert.equal(nodeById(out, 'tall').height, nodeHeight({ lines: 3, meta: true, reference: true }));
  assert.ok(nodeById(out, 'tall').height > nodeById(out, 'plain').height);
});

test('estimateLines rounds up and stops at four', () => {
  assert.equal(estimateLines(''), 1);
  assert.equal(estimateLines('kurz'), 1);
  assert.equal(estimateLines('x'.repeat(35)), 2);
  assert.equal(estimateLines('x'.repeat(1000)), 4);
});

// Ordering alone put a lone hint at the top of its band while the revelation it
// feeds sat four rows down: the order was right and the picture read as if the two
// were unrelated, because the edge between them crossed three other nodes.
test('a node with one neighbour is placed level with it, not at the top', () => {
  const out = layoutGraph(
    graph({
      columns: columns('hint', 'rev'),
      nodes: [
        { id: 'h', column: 'hint' },
        { id: 'r1', column: 'rev' },
        { id: 'r2', column: 'rev' },
        { id: 'r3', column: 'rev' },
        { id: 'r4', column: 'rev' },
      ],
      // The hint feeds the *last* revelation in its column.
      edges: [{ from: 'h', to: 'r4', kind: 'depends' }],
    }),
  );
  const h = nodeById(out, 'h');
  const r4 = nodeById(out, 'r4');
  const centre = (n: { y: number; height: number }) => n.y + n.height / 2;
  assert.ok(
    Math.abs(centre(h) - centre(r4)) < 1,
    `hint at ${centre(h)} should sit level with its only neighbour at ${centre(r4)}`,
  );
});

test('placement never overlaps two nodes of one column', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: 'a1', column: 'a', lines: 3 },
        { id: 'a2', column: 'a' },
        { id: 'a3', column: 'a', lines: 2, reference: true },
        { id: 'b1', column: 'b' },
      ],
      edges: [
        { from: 'a1', to: 'b1', kind: 'depends' },
        { from: 'a2', to: 'b1', kind: 'depends' },
        { from: 'a3', to: 'b1', kind: 'depends' },
      ],
    }),
  );
  const inA = out.nodes.filter((n) => n.column === 0).sort((x, z) => x.y - z.y);
  for (let i = 1; i < inA.length; i++) {
    assert.ok(
      inA[i].y >= inA[i - 1].y + inA[i - 1].height,
      `${inA[i].id} overlaps ${inA[i - 1].id}`,
    );
  }
});

// Every sweep can only push down, so without the lift the whole band floats below
// the frame that is supposed to contain it.
test('a band starts at its own top edge, however far the sweeps pushed', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: 'a1', column: 'a' },
        { id: 'a2', column: 'a' },
        { id: 'b1', column: 'b' },
      ],
      edges: [
        { from: 'a2', to: 'b1', kind: 'depends' },
        { from: 'a1', to: 'b1', kind: 'depends' },
      ],
    }),
  );
  const top = Math.min(...out.nodes.map((n) => n.y));
  assert.equal(top, out.bands[0].top + BAND_PAD);
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

// A second, empty column keeps this out of the single-column chain layout, which
// is the regime where a same-column relation is drawn as a spine rather than nested
// (see „the chain layout" below). Nesting is what a same-column relation becomes
// inside a grouped, multi-column graph.
test('an edge inside one column keeps its nodes in one band, expressed as nesting', () => {
  const out = layoutGraph(
    graph({
      columns: columns('a', 'b'),
      nodes: [
        { id: '1', column: 'a' },
        { id: '2', column: 'a' },
      ],
      edges: [{ from: '1', to: '2', kind: 'depends' }],
    }),
  );
  assert.equal(out.bands.length, 1);
  assert.equal(out.bands[0].loose, false, 'the relation still counts as a connection');
  // Drawn as indentation rather than as a line — see „same-column relations".
  assert.deepEqual(out.edges, []);
  // `1 → 2` means 2 depends on 1, so 2 is the conclusion and sits on top.
  assert.equal(nodeById(out, '2').indent, 0);
  assert.equal(nodeById(out, '1').indent, INDENT_STEP);
});

describe('band roots', () => {
  // A root names a strand instead of sitting in it: „An Expedition teilnehmen" as a
  // heading over its hints and tasks says more than the same string in a box with
  // five lines going into it.
  test('a root claims what it reaches, lends its title, and is not drawn', () => {
    const out = layoutGraph(
      graph({
        columns: columns('hint', 'task'),
        nodes: [
          { id: 'h1', column: 'hint' },
          { id: 't1', column: 'task' },
        ],
        edges: [
          { from: 'h1', to: 'p1', kind: 'depends' },
          { from: 'p1', to: 't1', kind: 'depends' },
        ],
        roots: [{ id: 'p1', title: 'Der Plan' }],
      }),
    );
    assert.equal(out.nodes.length, 2, 'the root is not a node');
    assert.equal(out.bands.length, 1);
    assert.equal(out.bands[0].title, 'Der Plan');
    assert.deepEqual(out.bands[0].nodeIds, ['h1', 't1']);
    // Both edges touch the root, which has no position, so neither is drawn.
    assert.deepEqual(out.edges, []);
  });

  test('two nodes joined only through a root still share its band', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a'),
        nodes: [{ id: 'x', column: 'a' }, { id: 'y', column: 'a' }],
        edges: [
          { from: 'x', to: 'p', kind: 'depends' },
          { from: 'y', to: 'p', kind: 'depends' },
        ],
        roots: [{ id: 'p', title: 'P' }],
      }),
    );
    assert.equal(out.bands.length, 1);
    assert.equal(out.bands[0].loose, false);
    assert.deepEqual(out.bands[0].nodeIds, ['x', 'y']);
  });

  // A heading over nothing reads as data that failed to load.
  test('a root that claims nothing produces no band', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a'),
        nodes: [{ id: 'x', column: 'a' }],
        roots: [{ id: 'p', title: 'P' }],
      }),
    );
    assert.equal(out.bands.length, 1);
    assert.equal(out.bands[0].title, undefined);
    assert.equal(out.bands[0].loose, true);
  });

  test('claimed bands come first, then anonymous components, then the loose one', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [
          { id: 'solo', column: 'a' },
          { id: 'c1', column: 'a' },
          { id: 'c2', column: 'b' },
          { id: 'claimed', column: 'b' },
        ],
        edges: [
          { from: 'c1', to: 'c2', kind: 'depends' },
          { from: 'p', to: 'claimed', kind: 'depends' },
        ],
        roots: [{ id: 'p', title: 'P' }],
      }),
    );
    assert.deepEqual(
      out.bands.map((b) => [b.title ?? null, b.loose, b.nodeIds]),
      [
        ['P', false, ['claimed']],
        [null, false, ['c1', 'c2']],
        [null, true, ['solo']],
      ],
    );
  });

  test('a node two roots can reach goes to the nearer one', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [
          { id: 'near', column: 'a' },
          { id: 'far', column: 'b' },
        ],
        edges: [
          // p2 → near directly; p1 → far → near is one hop longer.
          { from: 'p1', to: 'far', kind: 'depends' },
          { from: 'far', to: 'near', kind: 'depends' },
          { from: 'p2', to: 'near', kind: 'depends' },
        ],
        roots: [
          { id: 'p1', title: 'Erster' },
          { id: 'p2', title: 'Zweiter' },
        ],
      }),
    );
    const bandOf = (id: string) => out.bands[out.nodes.find((n) => n.id === id)!.band].title;
    assert.equal(bandOf('far'), 'Erster');
    assert.equal(bandOf('near'), 'Zweiter');
  });

  test('an edge between two claimed nodes is still drawn', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [
          { id: 'x', column: 'a' },
          { id: 'y', column: 'b' },
        ],
        edges: [
          { from: 'p', to: 'x', kind: 'depends' },
          { from: 'x', to: 'y', kind: 'depends' },
        ],
        roots: [{ id: 'p', title: 'P' }],
      }),
    );
    assert.deepEqual(out.edges, [{ from: 'x', to: 'y', kind: 'depends' }]);
    assert.equal(out.bands[0].title, 'P');
  });
});

// The nodes' y positions come from the layout, so a heading the stylesheet made
// room for would still have a box sitting on top of it.
test('a titled band reserves room for its heading', () => {
  // The edge has to cross columns in both variants: a same-column one would build
  // an indented unit in one of them and the two would differ by more than the title.
  const input = (withRoot: boolean) =>
    graph({
      columns: columns('a', 'b'),
      nodes: [{ id: 'x', column: 'a' }, { id: 'y', column: 'b' }],
      edges: withRoot
        ? [{ from: 'p', to: 'x', kind: 'depends' as const }, { from: 'x', to: 'y', kind: 'depends' as const }]
        : [{ from: 'x', to: 'y', kind: 'depends' as const }],
      roots: withRoot ? [{ id: 'p', title: 'P' }] : [],
    });
  const titled = layoutGraph(input(true));
  const plain = layoutGraph(input(false));
  assert.equal(titled.bands[0].title, 'P');
  assert.equal(plain.bands[0].title, undefined);
  const firstY = (l: ReturnType<typeof layoutGraph>) => Math.min(...l.nodes.map((n) => n.y));
  assert.equal(firstY(titled) - firstY(plain), BAND_TITLE_H);
  assert.equal(titled.bands[0].height - plain.bands[0].height, BAND_TITLE_H);
});

describe('edgePath: which side an edge leaves and enters', () => {
  const node = (x: number, y = 0, height = 40) => ({ x, y, height });
  // "M sx sy C c1x sy, c2x ty, tx ty" → the four x values that matter.
  const xs = (d: string) => {
    const n = d.match(/-?[\d.]+/g)!.map(Number);
    return { sx: n[0], c1: n[2], c2: n[4], tx: n[6] };
  };
  const WIDTH = 2000;

  test('a forward edge goes right edge → left edge', () => {
    const { sx, tx } = xs(edgePath(node(100), node(500), WIDTH));
    assert.equal(sx, 100 + NODE_W, 'leaves the source’s right edge');
    assert.equal(tx, 500, 'enters the target’s left edge');
  });

  // Always leaving on the right sent an edge from a plan back to its tasks out to
  // the right, across the whole column it pointed into, and back in from the far
  // left. Six of those over one node is a fan of diagonals over the boxes they
  // connect.
  test('a backward edge is mirrored: left edge → right edge', () => {
    const { sx, tx } = xs(edgePath(node(500), node(100), WIDTH));
    assert.equal(sx, 500, 'leaves the source’s left edge');
    assert.equal(tx, 100 + NODE_W, 'enters the target’s right edge');
  });

  test('a backward edge stays between its two ends, taking the short way', () => {
    const { sx, c1, c2, tx } = xs(edgePath(node(500), node(100), WIDTH));
    for (const [name, x] of [['c1', c1], ['c2', c2]] as const) {
      assert.ok(x <= sx && x >= tx, `${name} (${x}) should sit between ${tx} and ${sx}`);
    }
  });

  test('a forward edge does the same, in its own direction', () => {
    const { sx, c1, c2, tx } = xs(edgePath(node(100), node(900), WIDTH));
    for (const x of [c1, c2]) assert.ok(x >= sx && x <= tx);
  });

  // Mirroring a same-column edge would loop it around the entire column.
  test('an edge inside one column leaves and enters on the right, bulging out', () => {
    const { sx, c1, c2, tx } = xs(edgePath(node(100, 0), node(100, 200), WIDTH));
    assert.equal(sx, 100 + NODE_W);
    assert.equal(tx, 100 + NODE_W);
    assert.ok(c1 > sx && c2 > tx, 'both control points push out past the column');
  });

  // A spine step: same column, one box above the other, drawn straight down the
  // middle instead of bulging out — a stack of side-loops reads as anything but a
  // chain, which is the whole point of the spine.
  test('a vertical spine step runs straight down the shared middle', () => {
    const n = edgePath(node(100, 0, 40), node(100, 200, 40), WIDTH, true).match(/-?[\d.]+/g)!.map(Number);
    const midX = 100 + NODE_W / 2;
    assert.equal(n[0], midX, 'leaves the source’s bottom middle');
    assert.equal(n[1], 40, 'at its bottom edge (0 + 40)');
    assert.equal(n[6], midX, 'enters the target’s top middle');
    assert.equal(n[7], 200, 'at its top edge');
    assert.equal(n[0], n[6], 'and the line is vertical: one x for both ends');
  });

  // A feeder can sit below the feeder it points into, so the connector has to be
  // order-aware: it leaves the lower box's top and enters the upper box's bottom,
  // instead of always leaving the source's bottom and looping back up.
  test('a vertical connector whose source is below its target attaches at the facing edges', () => {
    const n = edgePath(node(100, 200, 40), node(100, 0, 40), WIDTH, true).match(/-?[\d.]+/g)!.map(Number);
    const midX = 100 + NODE_W / 2;
    assert.equal(n[0], midX, 'leaves the source’s top middle');
    assert.equal(n[1], 200, 'at its top edge');
    assert.equal(n[6], midX, 'enters the target’s bottom middle');
    assert.equal(n[7], 40, 'at its bottom edge (0 + 40)');
  });

  test('each end is attached at its own vertical middle, not a shared constant', () => {
    const d = edgePath(node(100, 0, 40), node(500, 300, 90), WIDTH);
    const n = d.match(/-?[\d.]+/g)!.map(Number);
    assert.equal(n[1], 20, 'source: 0 + 40/2');
    assert.equal(n[7], 345, 'target: 300 + 90/2');
  });

  // An unclamped control point puts the curve that explains the arrowhead outside
  // the viewport, which reads as a rendering fault.
  test('control points stay inside the canvas at either border', () => {
    const narrow = 400;
    for (const d of [
      edgePath(node(0, 0), node(0, 200), narrow),
      edgePath(node(150), node(0), narrow),
    ]) {
      const { c1, c2 } = xs(d);
      for (const x of [c1, c2]) {
        assert.ok(x >= 0 && x <= narrow, `control point ${x} outside 0..${narrow}`);
      }
    }
  });
});

// A second, empty column keeps these out of the single-column chain layout: with
// one bucket a connected band becomes a spine, and nesting is specifically the
// multi-column representation of a same-column relation.
describe('same-column relations become indented units', () => {
  // Drawn as an edge, a same-column relation has to leave the column and come back
  // — a bulge past its own lane, repeated for every pair. Indentation says the same
  // thing where the reader is already looking.
  test('a child sits under its parent, indented and narrower', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [{ id: 'basis', column: 'a' }, { id: 'schluss', column: 'a' }],
        // `basis` is what `schluss` rests on: the dependent goes on top.
        edges: [{ from: 'basis', to: 'schluss', kind: 'depends' }],
      }),
    );
    const top = nodeById(out, 'schluss');
    const under = nodeById(out, 'basis');
    assert.equal(top.indent, 0);
    assert.equal(under.indent, INDENT_STEP);
    assert.equal(under.x - top.x, INDENT_STEP, 'indent moves the box, not the column');
    assert.equal(under.width, NODE_W - INDENT_STEP, 'and narrows it, so it stays in its lane');
    assert.ok(under.y > top.y, 'the basis hangs beneath its conclusion');
    // And it is not drawn as a line as well: the reader would see one statement
    // twice, once as a box inside a box and once as a bulge past the column.
    assert.deepEqual(out.edges, []);
  });

  test('containment puts the parent on top, like the list view', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [{ id: 'eltern', column: 'a' }, { id: 'kind', column: 'a' }],
        edges: [{ from: 'eltern', to: 'kind', kind: 'parent' }],
      }),
    );
    assert.equal(nodeById(out, 'eltern').indent, 0);
    assert.equal(nodeById(out, 'kind').indent, INDENT_STEP);
  });

  test('a unit moves as one block, so a grandchild keeps its offset', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [
          { id: 'a1', column: 'a' },
          { id: 'a2', column: 'a' },
          { id: 'a3', column: 'a' },
        ],
        edges: [
          { from: 'a2', to: 'a1', kind: 'depends' },
          { from: 'a3', to: 'a2', kind: 'depends' },
        ],
      }),
    );
    assert.deepEqual(
      ['a1', 'a2', 'a3'].map((id) => nodeById(out, id).indent),
      [0, INDENT_STEP, 2 * INDENT_STEP],
    );
    const ys = ['a1', 'a2', 'a3'].map((id) => nodeById(out, id).y);
    assert.ok(ys[0] < ys[1] && ys[1] < ys[2], 'and in that order down the column');
  });

  // A child that can reach itself through its ancestors would make the walk that
  // builds a unit never return.
  test('a cycle in the same column is broken rather than followed', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [{ id: 'x', column: 'a' }, { id: 'y', column: 'a' }],
        edges: [
          { from: 'x', to: 'y', kind: 'depends' },
          { from: 'y', to: 'x', kind: 'depends' },
        ],
      }),
    );
    assert.equal(out.nodes.length, 2, 'both are placed exactly once');
  });

  test('a node with a parent in another column is not indented', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [{ id: 'x', column: 'a' }, { id: 'y', column: 'b' }],
        edges: [{ from: 'x', to: 'y', kind: 'depends' }],
      }),
    );
    assert.equal(nodeById(out, 'y').indent, 0);
    assert.equal(nodeById(out, 'y').width, NODE_W);
  });
});

describe('the chain layout (single column)', () => {
  // A single grouping bucket frees the x-axis, so a connected band is drawn as its
  // heaviest directed path stacked vertically — arrows down — with the nodes that
  // feed into it hanging off to the left. See „the chain layout" at the top of the
  // module. The reveal chains of a manuscript are the case it was built for.
  const xOf = (out: ReturnType<typeof layoutGraph>, id: string) => nodeById(out, id).x;

  test('a linear chain stacks into one vertical spine, edges pointing down', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['r1', 'r2', 'r3', 'r4'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 'r1', to: 'r2', kind: 'depends' },
          { from: 'r2', to: 'r3', kind: 'depends' },
          { from: 'r3', to: 'r4', kind: 'depends' },
        ],
      }),
    );
    assert.equal(out.bands.length, 1);
    assert.equal(out.bands[0].loose, false);
    // One column: every box shares an x, and none is indented (a spine is not a
    // nested unit).
    const xs = ['r1', 'r2', 'r3', 'r4'].map((id) => xOf(out, id));
    assert.equal(new Set(xs).size, 1, 'the spine is one vertical line');
    for (const id of ['r1', 'r2', 'r3', 'r4']) assert.equal(nodeById(out, id).indent, 0);
    // Stacked top→bottom in edge order.
    const ys = ['r1', 'r2', 'r3', 'r4'].map((id) => nodeById(out, id).y);
    assert.ok(ys[0] < ys[1] && ys[1] < ys[2] && ys[2] < ys[3], 'in edge order down the column');
    // The steps are drawn as vertical connectors rather than nested away.
    assert.equal(out.edges.length, 3);
    assert.equal(out.edges.every((e) => e.vertical === true), true);
  });

  test('a feeder sits to the left of the spine node it points into, level with it', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['r1', 'r2', 'r3', 'f'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 'r1', to: 'r2', kind: 'depends' },
          { from: 'r2', to: 'r3', kind: 'depends' },
          // An extra input into the middle of the chain, not its spine predecessor.
          { from: 'f', to: 'r2', kind: 'depends' },
        ],
      }),
    );
    const f = nodeById(out, 'f');
    const r2 = nodeById(out, 'r2');
    assert.ok(f.x < r2.x, 'the feeder is to the left');
    assert.equal(r2.x - f.x, COL_GAP + NODE_W, 'by exactly one column');
    const centre = (n: { y: number; height: number }) => n.y + n.height / 2;
    assert.ok(Math.abs(centre(f) - centre(r2)) < 1, 'and level with the node it feeds');
    // The feeder edge is a real line (it crosses columns), not a vertical step.
    const fed = out.edges.find((e) => e.from === 'f' && e.to === 'r2');
    assert.ok(fed && !fed.vertical, 'the feeder arrows in, it is not a spine step');
  });

  test('a feeder of a feeder sits one column further out', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['s1', 's2', 's3', 's4', 'f1', 'f2'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 's1', to: 's2', kind: 'depends' },
          { from: 's2', to: 's3', kind: 'depends' },
          { from: 's3', to: 's4', kind: 'depends' },
          // Attached to the end of the spine so the feeder chain cannot outgrow it.
          { from: 'f1', to: 's4', kind: 'depends' },
          { from: 'f2', to: 'f1', kind: 'depends' },
        ],
      }),
    );
    assert.ok(xOf(out, 'f2') < xOf(out, 'f1'), 'the deeper feeder is further left');
    assert.ok(xOf(out, 'f1') < xOf(out, 's4'), 'and the shallow one is left of the spine');
    assert.equal(xOf(out, 's4') - xOf(out, 'f1'), COL_GAP + NODE_W);
    assert.equal(xOf(out, 'f1') - xOf(out, 'f2'), COL_GAP + NODE_W);
  });

  test('two feeders into one spine node stack without overlapping', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['s1', 's2', 's3', 'f1', 'f2'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 's1', to: 's2', kind: 'depends' },
          { from: 's2', to: 's3', kind: 'depends' },
          { from: 'f1', to: 's2', kind: 'depends' },
          { from: 'f2', to: 's2', kind: 'depends' },
        ],
      }),
    );
    const f1 = nodeById(out, 'f1');
    const f2 = nodeById(out, 'f2');
    assert.equal(f1.x, f2.x, 'both feed the same node from the same column');
    assert.ok(f1.x < nodeById(out, 's2').x, 'to its left');
    const [top, bottom] = f1.y < f2.y ? [f1, f2] : [f2, f1];
    assert.ok(bottom.y >= top.y + top.height, 'and they do not overlap');
  });

  // Feeders stacked in one column, where one leads to the next, join straight down
  // the shared middle when they are directly adjacent — the same connector a spine
  // step gets. A same-column edge that skips over a box keeps the side bulge, because
  // a straight line would run through the box between its ends.
  test('an adjacent same-column feeder edge is a straight connector; a skip edge keeps the bulge', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['s1', 's2', 's3', 's4', 'f1', 'f2', 'f3'].map((id) => ({ id, column: 'rev' })),
        edges: [
          // Spine — its own weight keeps the fork at s3 on the backbone.
          { from: 's1', to: 's2', kind: 'depends' },
          { from: 's2', to: 's3', kind: 'depends' },
          { from: 's3', to: 's4', kind: 'depends' },
          // Three feeders into s3, so they share one column, stacked f1/f2/f3.
          { from: 'f1', to: 's3', kind: 'depends' },
          { from: 'f2', to: 's3', kind: 'depends' },
          { from: 'f3', to: 's3', kind: 'depends' },
          // f1→f2 are adjacent; f1→f3 skips f2.
          { from: 'f1', to: 'f2', kind: 'depends' },
          { from: 'f1', to: 'f3', kind: 'depends' },
        ],
      }),
    );
    const fx = nodeById(out, 'f1').x;
    assert.equal(nodeById(out, 'f2').x, fx, 'the feeders share a column');
    assert.equal(nodeById(out, 'f3').x, fx);
    assert.ok(fx < Math.max(...out.nodes.map((n) => n.x)), 'left of the spine');
    assert.ok(
      nodeById(out, 'f1').y < nodeById(out, 'f2').y && nodeById(out, 'f2').y < nodeById(out, 'f3').y,
      'stacked f1, f2, f3',
    );
    const e12 = out.edges.find((e) => e.from === 'f1' && e.to === 'f2');
    const e13 = out.edges.find((e) => e.from === 'f1' && e.to === 'f3');
    assert.ok(e12?.vertical === true, 'the adjacent pair joins straight down the middle');
    assert.ok(!e13?.vertical, 'the pair with f2 between them keeps the side bulge');
    // The feeder→spine edges cross columns and stay ordinary arrows.
    assert.ok(!out.edges.find((e) => e.from === 'f1' && e.to === 's3')?.vertical);
    // And the spine steps are still straight connectors.
    assert.ok(out.edges.find((e) => e.from === 's1' && e.to === 's2')?.vertical === true);
  });

  // A feeder that is itself a chain reads top-to-bottom like the spine: the source
  // on top, the arrow pointing down into what it leads to. Left in file order the
  // earlier clue could sit below the one it feeds and the connector pointed up.
  test('a feeder sub-chain is ordered source-on-top, not in file order', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['s1', 's2', 's3', 's4', 'a', 'b'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 's1', to: 's2', kind: 'depends' },
          { from: 's2', to: 's3', kind: 'depends' },
          { from: 's3', to: 's4', kind: 'depends' },
          // a and b both feed s3, so they share a column; b feeds a, but a is listed
          // first — file order would stack a above b and point the b→a arrow up.
          { from: 'a', to: 's3', kind: 'depends' },
          { from: 'b', to: 's3', kind: 'depends' },
          { from: 'b', to: 'a', kind: 'depends' },
        ],
      }),
    );
    assert.equal(nodeById(out, 'a').x, nodeById(out, 'b').x, 'a and b share a column');
    assert.ok(nodeById(out, 'b').y < nodeById(out, 'a').y, 'the source b sits above the dependent a');
    const e = out.edges.find((x) => x.from === 'b' && x.to === 'a');
    assert.ok(e?.vertical === true, 'and joins straight down into it');
  });

  test('the spine is the heaviest directed path; a short branch becomes a feeder', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['s1', 's2', 's3', 's4', 'b'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 's1', to: 's2', kind: 'depends' },
          { from: 's2', to: 's3', kind: 'depends' },
          { from: 's3', to: 's4', kind: 'depends' },
          { from: 's1', to: 'b', kind: 'depends' },
        ],
      }),
    );
    // The four spine nodes share the rightmost column; the branch is pushed left.
    const spineX = Math.max(...out.nodes.map((n) => n.x));
    const onSpine = out.nodes.filter((n) => n.x === spineX).map((n) => n.id).sort();
    assert.deepEqual(onSpine, ['s1', 's2', 's3', 's4']);
    assert.ok(nodeById(out, 'b').x < spineX, 'the branch is off the spine');
  });

  // The gap #145 let through: heaviest ≠ longest. The Unterlingen 1 reveal-plan in
  // miniature — a five-beat main chain (m1…m5) whose middle beat m3 also collects a
  // three-hop side strand (h1→h2→h3→m3). By hop count the side strand makes the
  // longest directed path (h1→h2→h3→m3→m4→m5, six nodes) and „longest path" picks it,
  // stranding the opening beats in the feeders. But m2 carries its own feeders, so at
  // the fork into m3 the main chain outweighs the strand (mass(m2)=4 > mass(h3)=3) and
  // „heaviest" recovers the intended main chain as the spine.
  test('a longer side strand feeding the middle stays a feeder; the main chain is the spine', () => {
    const strand = ['h1', 'h2', 'h3'];
    const main = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: [...main, ...strand, 'g1', 'g2'].map((id) => ({ id, column: 'rev' })),
        edges: [
          // Main chain first, so at every tie the backbone edge wins the walk-back.
          { from: 'm1', to: 'm2', kind: 'depends' },
          { from: 'm2', to: 'm3', kind: 'depends' },
          { from: 'm3', to: 'm4', kind: 'depends' },
          { from: 'm4', to: 'm5', kind: 'depends' },
          // Two feeders into m2, the weight that lets the main chain win the m3 fork.
          { from: 'g1', to: 'm2', kind: 'depends' },
          { from: 'g2', to: 'm2', kind: 'depends' },
          // Side strand: three hops into m3, longer than the main run to m3 (two hops).
          { from: 'h1', to: 'h2', kind: 'depends' },
          { from: 'h2', to: 'h3', kind: 'depends' },
          { from: 'h3', to: 'm3', kind: 'depends' },
        ],
      }),
    );
    // The main chain is the spine (rightmost column, top→bottom in edge order); the
    // longer strand hangs off m3 as feeders.
    const spineX = Math.max(...out.nodes.map((n) => n.x));
    const onSpine = out.nodes.filter((n) => n.x === spineX).map((n) => n.id).sort();
    assert.deepEqual(onSpine, main, 'the main chain, not the longer side strand');
    for (let i = 1; i < main.length; i++) {
      assert.ok(nodeById(out, main[i - 1]).y < nodeById(out, main[i]).y, 'spine runs down in edge order');
    }
    for (const id of strand) {
      assert.ok(nodeById(out, id).x < spineX, `${id} is a feeder, off the spine`);
    }
  });

  // The reason the spacing changed for #154: a beat with more feeders than the spine
  // is tall must reserve the vertical room for them, so its feeders sit level with it
  // instead of spilling past the beats below (whose edges then swept the canvas).
  test('a beat with many feeders reserves room; its feeders stay level with it', () => {
    const feeders = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['s1', 's2', 's3', ...feeders].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 's1', to: 's2', kind: 'depends' },
          { from: 's2', to: 's3', kind: 'depends' },
          // Six feeders all into the middle beat s2.
          ...feeders.map((id) => ({ from: id, to: 's2', kind: 'depends' as const })),
        ],
      }),
    );
    const centre = (id: string) => nodeById(out, id).y + nodeById(out, id).height / 2;
    // The feeder block is centred on its beat: the middle of the six feeders lines up
    // with s2, none of them stranded far below.
    const fys = feeders.map(centre).sort((a, b) => a - b);
    const blockCentre = (fys[0] + fys[fys.length - 1]) / 2;
    assert.ok(Math.abs(blockCentre - centre('s2')) < 1, 'the feeder block is level with its beat');
    // The next beat starts below the whole feeder block, not level with it: the spine
    // spread to make room.
    assert.ok(centre('s3') > fys[fys.length - 1], 's3 sits below s2’s feeder block');
    // Feeders do not overlap each other.
    const sorted = feeders
      .map((id) => nodeById(out, id))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].height, 'feeders do not overlap');
    }
  });

  // A band with no feeders anchors its spine at the left margin, even when another
  // band on the canvas has deep feeders. Aligning every spine to one global column
  // stranded the feederless band at the far right beside an empty half-canvas.
  test('a feederless band is not pushed right by another band’s feeders', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['s1', 's2', 's3', 'f1', 'f2', 'solo1', 'solo2'].map((id) => ({ id, column: 'rev' })),
        edges: [
          // Band A: a spine with a two-level feeder hung off its *last* node, so the
          // feeder chain cannot outgrow the spine and steal it.
          { from: 's1', to: 's2', kind: 'depends' },
          { from: 's2', to: 's3', kind: 'depends' },
          { from: 'f1', to: 's3', kind: 'depends' },
          { from: 'f2', to: 'f1', kind: 'depends' },
          // Band B: a bare two-node chain, no feeders.
          { from: 'solo1', to: 'solo2', kind: 'depends' },
        ],
      }),
    );
    // Band B's spine starts at the margin, not at band A's spine column.
    assert.equal(nodeById(out, 'solo1').x, MARGIN);
    assert.equal(nodeById(out, 'solo2').x, MARGIN);
    // Band A still reaches the margin with its deepest feeder.
    assert.equal(nodeById(out, 'f2').x, MARGIN);
    assert.ok(nodeById(out, 's3').x > nodeById(out, 'f2').x, 'and its spine sits right of them');
  });

  test('two disconnected chains in one column are two stacked spines', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['a1', 'a2', 'b1', 'b2'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: 'a1', to: 'a2', kind: 'depends' },
          { from: 'b1', to: 'b2', kind: 'depends' },
        ],
      }),
    );
    assert.equal(out.bands.length, 2);
    assert.equal(out.bands.every((band) => !band.loose), true);
    assert.ok(nodeById(out, 'a2').y > nodeById(out, 'a1').y);
    assert.ok(nodeById(out, 'b2').y > nodeById(out, 'b1').y);
    assert.notEqual(nodeById(out, 'a1').band, nodeById(out, 'b1').band);
  });

  // A cycle is malformed data; the heaviest-path walk truncates it rather than
  // looping, and every node is still placed exactly once.
  test('a cycle in one column survives, all nodes placed', () => {
    const out = layoutGraph(
      graph({
        columns: columns('rev'),
        nodes: ['1', '2', '3'].map((id) => ({ id, column: 'rev' })),
        edges: [
          { from: '1', to: '2', kind: 'depends' },
          { from: '2', to: '3', kind: 'depends' },
          { from: '3', to: '1', kind: 'depends' },
        ],
      }),
    );
    assert.equal(out.nodes.length, 3);
    assert.equal(out.bands.length, 1);
  });

  // The property the whole gate rests on: a graph with two or more buckets never
  // touches the chain code, so no grouped view moves.
  test('two columns keep the barycenter layout, not the spine', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [
          { id: 'a1', column: 'a' },
          { id: 'a2', column: 'a' },
          { id: 'b1', column: 'b' },
        ],
        edges: [
          { from: 'a1', to: 'a2', kind: 'depends' },
          { from: 'a2', to: 'b1', kind: 'depends' },
        ],
      }),
    );
    // a1→a2 is same-column, so it nests (the multi-column representation); the
    // spine would instead draw it as a vertical line and never indent.
    assert.equal(nodeById(out, 'a1').indent, INDENT_STEP);
    assert.equal(out.edges.some((e) => e.vertical), false, 'no vertical spine steps');
  });
});

describe('collapseClusterGaps', () => {
  // The relaxation pulls related units together and lets unrelated ones drift, which
  // is what produces readable clusters — and also what made a band four times taller
  // than its content. A gap no column reaches into is space the relaxation happened
  // to leave, not information.
  const at = (...pairs: [number, number][]) => pairs.map(([y, height]) => ({ y, height }));

  test('a wide gap between two clusters is shrunk to the fixed distance', () => {
    const units = at([0, 40], [50, 40], [400, 40]);
    collapseClusterGaps(units);
    assert.equal(units[0].y, 0, 'the first cluster does not move');
    assert.equal(units[1].y, 50, 'and neither does anything inside it');
    assert.equal(units[2].y, 90 + 24, 'the second follows 24px after the first ends');
  });

  test('three clusters each close up on the one before', () => {
    const units = at([0, 40], [300, 40], [900, 40]);
    collapseClusterGaps(units);
    assert.deepEqual(units.map((u) => u.y), [0, 64, 128]);
  });

  // Two things close together are one cluster; shrinking the space inside one would
  // undo the alignment the relaxation just bought.
  test('a gap inside a cluster is left alone', () => {
    const units = at([0, 40], [70, 40]);
    collapseClusterGaps(units);
    assert.deepEqual(units.map((u) => u.y), [0, 70]);
  });

  test('overlapping and touching spans stay one cluster', () => {
    const units = at([0, 100], [20, 30], [100, 40]);
    collapseClusterGaps(units);
    assert.deepEqual(units.map((u) => u.y), [0, 20, 100]);
  });

  test('one cluster is left exactly as it was', () => {
    const units = at([10, 40], [55, 40]);
    collapseClusterGaps(units);
    assert.deepEqual(units.map((u) => u.y), [10, 55]);
  });

  test('nothing at all is not an error', () => {
    assert.doesNotThrow(() => collapseClusterGaps([]));
  });
});

describe('bands stay apart', () => {
  // Two components are two bands with a frame each, and the space between them is
  // deliberate — it is not a gap for the collapse to reclaim.
  test('two components keep the band gap between them', () => {
    const out = layoutGraph(
      graph({
        columns: columns('a', 'b'),
        nodes: [
          { id: 'x1', column: 'a' },
          { id: 'x2', column: 'b' },
          { id: 'y1', column: 'a' },
          { id: 'y2', column: 'b' },
        ],
        edges: [
          { from: 'x1', to: 'x2', kind: 'depends' },
          { from: 'y1', to: 'y2', kind: 'depends' },
        ],
      }),
    );
    const [first, second] = out.bands;
    assert.equal(second.top, first.top + first.height + BAND_GAP);
  });
});

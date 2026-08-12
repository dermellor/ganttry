// Where the nodes of the relation graph sit. Pure and DOM-free on purpose: the
// geometry is the part with rules worth testing (which column a node lands in,
// which nodes form one band, in what order the rows come out), and none of it
// needs an element to be decided. src/graphView.ts turns the result into SVG.
//
// The reading direction is left to right, one column per bucket of the active
// grouping dimension. That is the whole reason the columns are not a list this
// module owns: the buckets and their order come from `computeSections`
// (listGrouping.ts), the same function the list view sections with, so the two
// presentations cannot end up disagreeing about what the values of a dimension
// are or which order they come in.

/** What an edge means. The graph draws the two differently, so it has to know. */
export type EdgeKind = 'depends' | 'parent';

export type GraphInput = {
  /** The buckets of the grouping dimension, already in reading order. */
  columns: { id: string; label: string }[];
  /**
   * The nodes, in the order the sections listed them. A node may be listed more
   * than once: a multi-valued dimension (tags, a multi-select field) puts an item
   * into every bucket it carries, which is right for a list and wrong here — two
   * boxes for one item would also mean its edges drawn twice, and a click would
   * be ambiguous about which copy the detail panel belongs to. The first listing
   * wins, so the item sits in the leftmost bucket it belongs to.
   */
  nodes: { id: string; column: string }[];
  edges: { from: string; to: string; kind: EdgeKind }[];
};

export type PlacedNode = {
  id: string;
  /** Index into the laid-out columns. */
  column: number;
  /** Position within its column *inside its band*, not across the whole graph. */
  row: number;
  band: number;
  x: number;
  y: number;
};

export type PlacedBand = {
  index: number;
  /**
   * A band of nodes that have no edge at all. It is kept apart and drawn apart
   * because mixing them into the connected structure is what makes a graph look
   * like it has no structure: on a timeline where three items depend on each
   * other and forty do not, the three disappear into the forty.
   */
  loose: boolean;
  top: number;
  height: number;
  nodeIds: string[];
};

export type PlacedEdge = { from: string; to: string; kind: EdgeKind };

export type GraphLayout = {
  columns: { id: string; label: string; x: number }[];
  nodes: PlacedNode[];
  bands: PlacedBand[];
  edges: PlacedEdge[];
  width: number;
  height: number;
};

// Geometry. Exported because the view draws the boxes and the band frames from
// the same numbers — a second copy in the stylesheet is how a node ends up
// overlapping the frame that is supposed to contain it.
export const NODE_W = 210;
// Tall enough for a two-line title *plus* the date line under it. At 46 the meta
// line was clipped by the box on every node whose title wrapped, which reads as a
// broken date rather than as a box one line too short.
export const NODE_H = 62;
export const ROW_GAP = 12;
export const COL_GAP = 88;
export const BAND_PAD = 16;
export const BAND_GAP = 28;
export const MARGIN = 24;
/** Room above the first band for the column headers. */
export const HEADER_H = 34;

const ROW_PITCH = NODE_H + ROW_GAP;
const COL_PITCH = NODE_W + COL_GAP;

/** How often the barycenter sweep runs. Four passes settle the cases this draws;
 * more is measurable in time and not in the picture. */
const SWEEPS = 4;

/**
 * Lay out one graph. Nodes whose column is not among `columns` are dropped
 * rather than defaulted into the first one: a node in a bucket the caller did
 * not declare is a bug in the caller, and silently putting it somewhere makes
 * that bug look like a layout quirk.
 */
export function layoutGraph(input: GraphInput): GraphLayout {
  const columnIndex = new Map(input.columns.map((c, i) => [c.id, i]));

  const columnOf = new Map<string, number>();
  const order: string[] = [];
  for (const node of input.nodes) {
    if (columnOf.has(node.id)) continue; // first bucket wins, see GraphInput
    const index = columnIndex.get(node.column);
    if (index === undefined) continue;
    columnOf.set(node.id, index);
    order.push(node.id);
  }

  const edges = usableEdges(input.edges, columnOf);
  const bands = findBands(order, edges);

  const placed: PlacedNode[] = [];
  const placedBands: PlacedBand[] = [];
  let top = MARGIN + HEADER_H;

  for (const [index, band] of bands.entries()) {
    const rows = band.loose
      ? packLoose(band.nodeIds, columnOf, input.columns.length)
      : orderBand(band.nodeIds, columnOf, edges, order, input.columns.length);

    let height = 0;
    for (const [column, ids] of rows.entries()) {
      for (const [row, id] of ids.entries()) {
        placed.push({
          id,
          column,
          row,
          band: index,
          x: MARGIN + column * COL_PITCH,
          y: top + BAND_PAD + row * ROW_PITCH,
        });
      }
      height = Math.max(height, ids.length * ROW_PITCH - ROW_GAP);
    }

    const full = height + 2 * BAND_PAD;
    placedBands.push({ index, loose: band.loose, top, height: full, nodeIds: band.nodeIds });
    top += full + BAND_GAP;
  }

  const columns = input.columns.map((c, i) => ({ ...c, x: MARGIN + i * COL_PITCH }));
  return {
    columns,
    nodes: placed,
    bands: placedBands,
    edges,
    width: columns.length ? MARGIN + columns.length * COL_PITCH - COL_GAP + MARGIN : 0,
    // No band means no content; the empty state is the view's business, but a
    // height of `top` would still reserve the header strip for headers that have
    // nothing under them.
    height: placedBands.length ? top - BAND_GAP + MARGIN : 0,
  };
}

/**
 * Edges both of whose ends are actually drawn, de-duplicated, self-links removed.
 *
 * The filtering matters more than it looks: the extent narrows the node set, and
 * an edge whose other end was filtered away would otherwise be drawn into empty
 * space, which reads as „this item depends on something invisible" rather than
 * as „you filtered it out".
 */
function usableEdges(
  edges: { from: string; to: string; kind: EdgeKind }[],
  columnOf: Map<string, number>,
): PlacedEdge[] {
  const seen = new Set<string>();
  const out: PlacedEdge[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!columnOf.has(edge.from) || !columnOf.has(edge.to)) continue;
    const key = `${edge.kind}␟${edge.from}␟${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: edge.from, to: edge.to, kind: edge.kind });
  }
  return out;
}

type Band = { nodeIds: string[]; loose: boolean };

/**
 * Connected components over the undirected edge set, plus one trailing band for
 * everything with no edge.
 *
 * Bands come out in the order of their first node, which is the order the
 * sections produced. Ordering them by size instead would reshuffle the whole
 * picture whenever one item gains a dependency, and a layout that jumps on an
 * unrelated edit is one nobody trusts to be showing the same graph as before.
 */
function findBands(order: string[], edges: PlacedEdge[]): Band[] {
  const parent = new Map(order.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) {
      const next = parent.get(id)!;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const a = find(edge.from);
    const b = find(edge.to);
    if (a !== b) parent.set(a, b);
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const bands = new Map<string, string[]>();
  const loose: string[] = [];
  for (const id of order) {
    if (!degree.get(id)) {
      loose.push(id);
      continue;
    }
    const root = find(id);
    (bands.get(root) ?? bands.set(root, []).get(root)!).push(id);
  }

  const out: Band[] = [...bands.values()].map((nodeIds) => ({ nodeIds, loose: false }));
  if (loose.length) out.push({ nodeIds: loose, loose: true });
  return out;
}

/** Column buckets of one band, each a list of node ids in row order. */
type Rows = string[][];

function emptyRows(columns: number): Rows {
  return Array.from({ length: columns }, () => []);
}

/**
 * Row order inside a connected band, by barycenter relaxation: a node moves
 * towards the mean row of the nodes it is linked to. Sweeping both directions is
 * what keeps an edge that skips a column from being ignored — a single left-to-
 * right pass only ever looks backwards, so the last column never influences
 * anything.
 */
function orderBand(
  nodeIds: string[],
  columnOf: Map<string, number>,
  edges: PlacedEdge[],
  order: string[],
  columns: number,
): Rows {
  const rank = new Map(order.map((id, i) => [id, i]));
  const rows = emptyRows(columns);
  for (const id of nodeIds) rows[columnOf.get(id)!].push(id);
  for (const column of rows) column.sort((a, b) => rank.get(a)! - rank.get(b)!);

  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
  };
  for (const edge of edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const rowOf = new Map<string, number>();
  const reindex = () => {
    for (const column of rows) for (const [row, id] of column.entries()) rowOf.set(id, row);
  };
  reindex();

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const forward = sweep % 2 === 0;
    const indices = forward
      ? [...rows.keys()]
      : [...rows.keys()].reverse();
    for (const column of indices) {
      const bucket = rows[column];
      if (bucket.length < 2) continue;
      const key = new Map<string, number>();
      for (const id of bucket) {
        // Only neighbours on the side the sweep has already settled count. A node
        // with none keeps its place: pulling it to row 0 instead would let an
        // unconnected-in-this-direction node shove the settled ones around.
        const relevant = (neighbours.get(id) ?? []).filter((other) => {
          const c = columnOf.get(other);
          return c !== undefined && (forward ? c < column : c > column);
        });
        if (!relevant.length) {
          key.set(id, rowOf.get(id)!);
          continue;
        }
        const sum = relevant.reduce((acc, other) => acc + (rowOf.get(other) ?? 0), 0);
        key.set(id, sum / relevant.length);
      }
      // Ties keep the incoming order, so a sweep that learns nothing changes
      // nothing (Array.prototype.sort is stable).
      bucket.sort((a, b) => key.get(a)! - key.get(b)!);
    }
    reindex();
  }

  return rows;
}

/** Edgeless nodes: nothing to relax, so they just fill their column in order. */
function packLoose(nodeIds: string[], columnOf: Map<string, number>, columns: number): Rows {
  const rows = emptyRows(columns);
  for (const id of nodeIds) rows[columnOf.get(id)!].push(id);
  return rows;
}

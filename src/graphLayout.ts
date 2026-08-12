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
  nodes: {
    id: string;
    column: string;
    /** Title lines, from `estimateLines`. Absent = one. */
    lines?: number;
    /** Does it carry a dates line? */
    meta?: boolean;
    /** Does it carry a references line? */
    reference?: boolean;
  }[];
  edges: { from: string; to: string; kind: EdgeKind }[];
  /**
   * Nodes that name a band instead of sitting in one.
   *
   * A root claims everything reachable from it and lends the band its title, then
   * disappears from the picture — which is the whole point: „An Expedition
   * teilnehmen" as a heading over its hints, revelations and tasks says more than
   * the same string in a box with five lines going into it.
   *
   * Deliberately not part of `nodes`: a root has no column, and every rule here
   * that reads a node's column would need a special case for it. Edges touching a
   * root still belong in `edges` — they are what the claim follows — and are
   * dropped from the drawn set because one end has no position.
   */
  roots?: { id: string; title: string }[];
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
  /** Its own box height: nodes are not a grid, see `placeBand`. */
  height: number;
};

export type PlacedBand = {
  index: number;
  /** The claiming root's title, absent for an anonymous component. */
  title?: string;
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
export const NODE_W = 240;
export const ROW_GAP = 10;
export const COL_GAP = 90;
export const BAND_PAD = 16;
export const BAND_GAP = 28;
export const MARGIN = 24;
/** Room above the first band for the column headers. */
export const HEADER_H = 34;
/**
 * Extra room at the top of a band that carries a heading. Reserved by the layout
 * rather than by the stylesheet: the nodes' y positions come from here, so a title
 * the CSS made room for would still have a box sitting on top of it.
 */
export const BAND_TITLE_H = 26;

// A node's box, line by line. It is computed here rather than measured in the DOM
// because every y position downstream depends on it: measuring would mean laying
// out once to find the heights and again to use them, and the intermediate state is
// a screen of overlapping boxes.
export const NODE_PAD_Y = 7;
/** A title line. */
export const LINE_H = 16;
/** The muted lines under it — the dates, the references. */
export const SUB_LINE_H = 13;

const COL_PITCH = NODE_W + COL_GAP;

/** How often the barycenter sweep runs. Four passes settle the cases this draws;
 * more is measurable in time and not in the picture. */
const SWEEPS = 4;

/** How much of a node is available to its title, in characters per line. */
const CHARS_PER_LINE = 34;
/** Beyond this the title is clipped by CSS instead of growing the box further. */
const MAX_TITLE_LINES = 4;

/**
 * How many lines a title will take.
 *
 * An estimate from the character count, not a measurement, and that is a
 * deliberate trade: an exact answer needs the text in the document, which means
 * laying the graph out twice. Estimating slightly generously costs a few pixels of
 * air; estimating short would clip the last line, so the rounding goes up.
 */
export function estimateLines(label: string): number {
  const lines = Math.ceil((label.trim().length || 1) / CHARS_PER_LINE);
  return Math.min(MAX_TITLE_LINES, Math.max(1, lines));
}

/** The height of a node with this much in it. */
export function nodeHeight(node: { lines?: number; meta?: boolean; reference?: boolean }): number {
  const lines = node.lines ?? 1;
  const subs = (node.meta ? 1 : 0) + (node.reference ? 1 : 0);
  return 2 * NODE_PAD_Y + lines * LINE_H + subs * SUB_LINE_H;
}

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
  // Banding follows *every* edge, including the ones touching a root, because that
  // is what a root's claim travels along. Drawing follows only `edges`, where both
  // ends have a position.
  const bands = findBands(order, input.edges, input.roots ?? [], columnOf);

  const heightOf = new Map<string, number>();
  for (const node of input.nodes) {
    if (!columnOf.has(node.id) || heightOf.has(node.id)) continue;
    heightOf.set(node.id, nodeHeight(node));
  }

  const placed: PlacedNode[] = [];
  const placedBands: PlacedBand[] = [];
  let top = MARGIN + HEADER_H;

  for (const [index, band] of bands.entries()) {
    const rows = band.loose
      ? packLoose(band.nodeIds, columnOf, input.columns.length)
      : orderBand(band.nodeIds, columnOf, edges, order, input.columns.length);

    const titleRoom = band.title ? BAND_TITLE_H : 0;
    const baseY = top + BAND_PAD + titleRoom;
    const y = band.loose
      ? stackRows(rows, baseY, heightOf)
      : placeBand(rows, baseY, heightOf, edges, columnOf);

    let height = 0;
    for (const [column, ids] of rows.entries()) {
      for (const [row, id] of ids.entries()) {
        placed.push({
          id,
          column,
          row,
          band: index,
          x: MARGIN + column * COL_PITCH,
          y: y.get(id)!,
          height: heightOf.get(id)!,
        });
        height = Math.max(height, y.get(id)! + heightOf.get(id)! - baseY);
      }
    }

    const full = height + 2 * BAND_PAD + titleRoom;
    placedBands.push({
      index,
      title: band.title,
      loose: band.loose,
      top,
      height: full,
      nodeIds: band.nodeIds,
    });
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

type Band = { nodeIds: string[]; loose: boolean; title?: string };

/**
 * The bands, in the order they are stacked: the ones a root claims first, then the
 * anonymous connected components, then everything with no edge at all.
 *
 * Three tiers rather than one, because they answer different questions. A claimed
 * band says „this is what plan X consists of". An anonymous component says „these
 * hang together, and nothing declares why". The loose band says „these hang off
 * nothing" — and keeping it apart is what stops three connected items from
 * disappearing into forty unconnected ones.
 *
 * Within a tier the order follows the first node, which is the order the sections
 * produced. Ordering by size instead would reshuffle the whole picture whenever one
 * item gains a dependency, and a layout that jumps on an unrelated edit is one
 * nobody trusts to be showing the same graph as before.
 */
function findBands(
  order: string[],
  allEdges: { from: string; to: string }[],
  roots: { id: string; title: string }[],
  columnOf: Map<string, number>,
): Band[] {
  const rootIds = new Set(roots.map((r) => r.id));
  // An end that exists: drawn as a node, or a root, whose edge is real even though
  // the root itself is not placed. An end that is neither — a `dependsOn` naming
  // something the extent removed or that never existed — makes the edge nothing,
  // and a node whose only edge is that one is loose.
  const known = (id: string) => columnOf.has(id) || rootIds.has(id);

  // Undirected adjacency over everything, roots included: a claim spreads along an
  // edge regardless of which way the relation points.
  const near = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (near.get(a) ?? near.set(a, []).get(a)!).push(b);
  };
  const degree = new Map<string, number>();
  for (const edge of allEdges) {
    if (edge.from === edge.to) continue;
    if (!known(edge.from) || !known(edge.to)) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
    // Counted for the placed end only: a root is not a node that could be loose.
    if (columnOf.has(edge.from)) degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    if (columnOf.has(edge.to)) degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const claimedBy = new Map<string, string>();

  // Breadth-first from every root at once rather than root by root, so a node two
  // roots can both reach goes to the nearer one instead of to whichever root was
  // declared first. A tie at equal distance still falls to the earlier root, which
  // is at least stable.
  let frontier = roots.map((r) => r.id);
  const seen = new Set(frontier);
  const ownerOf = new Map(roots.map((r) => [r.id, r.id]));
  while (frontier.length) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const neighbour of near.get(current) ?? []) {
        if (seen.has(neighbour) || rootIds.has(neighbour)) continue;
        seen.add(neighbour);
        ownerOf.set(neighbour, ownerOf.get(current)!);
        if (columnOf.has(neighbour)) claimedBy.set(neighbour, ownerOf.get(current)!);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  const out: Band[] = [];

  // 1. One band per root that claimed anything. A root claiming nothing is not an
  //    empty band: a heading over nothing reads as data that failed to load.
  for (const root of roots) {
    const nodeIds = order.filter((id) => claimedBy.get(id) === root.id);
    if (nodeIds.length) out.push({ nodeIds, loose: false, title: root.title });
  }

  // 2. Connected components among what is left.
  const componentOf = new Map<string, number>();
  let components = 0;
  for (const id of order) {
    if (claimedBy.has(id) || componentOf.has(id) || !degree.get(id)) continue;
    const stack = [id];
    componentOf.set(id, components);
    while (stack.length) {
      const current = stack.pop()!;
      for (const neighbour of near.get(current) ?? []) {
        if (!columnOf.has(neighbour) || claimedBy.has(neighbour) || componentOf.has(neighbour)) continue;
        componentOf.set(neighbour, components);
        stack.push(neighbour);
      }
    }
    components += 1;
  }
  for (let c = 0; c < components; c++) {
    const nodeIds = order.filter((id) => componentOf.get(id) === c);
    if (nodeIds.length) out.push({ nodeIds, loose: false });
  }

  // 3. Everything untouched by any edge.
  const loose = order.filter((id) => !claimedBy.has(id) && !componentOf.has(id) && !degree.get(id));
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

/**
 * Stack a band's columns from the top, each node directly under the previous one.
 *
 * What the loose band wants: its nodes have no edges, so there is nothing to line
 * them up with and any air between them would be air for no reason.
 */
function stackRows(rows: Rows, baseY: number, heightOf: Map<string, number>): Map<string, number> {
  const y = new Map<string, number>();
  for (const column of rows) {
    let cursor = baseY;
    for (const id of column) {
      y.set(id, cursor);
      cursor += heightOf.get(id)! + ROW_GAP;
    }
  }
  return y;
}

/**
 * Where the nodes of a connected band actually sit.
 *
 * `orderBand` decided the order within each column; this decides the position, and
 * the two are genuinely different jobs. Ordering alone, with the rows then packed
 * from the top, is what made a lone hint sit at the top of its band while the
 * revelation it feeds sat four rows down — the order was right and the picture read
 * as if the two had nothing to do with each other, because the edge between them
 * was a long diagonal across three other nodes.
 *
 * So a node is pulled towards the mean centre of what it is linked to, and only
 * pushed down far enough to clear its own predecessor in the column. Sweeping both
 * directions matters more here than in the ordering pass: the leftmost column has
 * no left neighbours at all, so a single left-to-right pass leaves exactly the
 * lone-hint case unfixed.
 */
function placeBand(
  rows: Rows,
  baseY: number,
  heightOf: Map<string, number>,
  edges: PlacedEdge[],
  columnOf: Map<string, number>,
): Map<string, number> {
  const y = stackRows(rows, baseY, heightOf);
  const centre = (id: string) => y.get(id)! + heightOf.get(id)! / 2;

  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
  };
  for (const edge of edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  // One pass over one column: walk it in order, put each node where its links want
  // it, and never let it overlap the one above. `cursor` is what makes the result
  // overlap-free by construction rather than by a repair afterwards.
  const pass = (column: number, side: 'left' | 'right') => {
    let cursor = baseY;
    for (const id of rows[column]) {
      const relevant = (neighbours.get(id) ?? []).filter((other) => {
        const c = columnOf.get(other);
        if (c === undefined || !y.has(other)) return false;
        return side === 'left' ? c < column : c > column;
      });
      let wanted = cursor;
      if (relevant.length) {
        const mean = relevant.reduce((acc, other) => acc + centre(other), 0) / relevant.length;
        wanted = mean - heightOf.get(id)! / 2;
      }
      const at = Math.max(cursor, wanted);
      y.set(id, at);
      cursor = at + heightOf.get(id)! + ROW_GAP;
    }
  };

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const forward = sweep % 2 === 0;
    const indices = forward ? [...rows.keys()] : [...rows.keys()].reverse();
    for (const column of indices) pass(column, forward ? 'left' : 'right');
  }

  // Every sweep can only push down, so the last one may have left the whole band
  // floating below its frame. Pull it back up as a block: the relative positions are
  // what the sweeps were for, the absolute offset is not.
  let highest = Infinity;
  for (const id of y.keys()) highest = Math.min(highest, y.get(id)!);
  if (highest > baseY && Number.isFinite(highest)) {
    const lift = highest - baseY;
    for (const id of y.keys()) y.set(id, y.get(id)! - lift);
  }
  return y;
}

/** Edgeless nodes: nothing to relax, so they just fill their column in order. */
function packLoose(nodeIds: string[], columnOf: Map<string, number>, columns: number): Rows {
  const rows = emptyRows(columns);
  for (const id of nodeIds) rows[columnOf.get(id)!].push(id);
  return rows;
}

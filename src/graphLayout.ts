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
//
// The chain layout is the one exception, and it is gated to a single column
// (`columns.length === 1`). The x-axis normally *is* the grouping dimension, and a
// spine needs the x-axis to mean „on the spine versus feeding in from the side"
// instead — the two readings cannot both hold, so the spine may only repurpose x
// when the grouping axis carries nothing: one bucket, every node in column 0.
// There it stacks each connected component's heaviest directed path as a vertical
// spine (arrows down) and hangs the nodes that feed into it off to the left. With
// two or more buckets the old column-and-barycenter path runs unchanged, so no
// grouped graph view moves. See `chainPlan` and `spineUnits`.

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
    /**
     * Where the node sits in the order the source declares, if it declares one
     * (see src/sequence.ts). The chain layout starts its spine at the earliest of
     * them; absent means „unplaced", and an unplaced node never gets to be the
     * head. Nothing else in the layout reads it, and a source without any
     * positions lays out exactly as before.
     */
    sequence?: number;
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
  /** Its own width, narrowed by `indent`. */
  width: number;
  /**
   * How far it is indented inside its column, because something in the same column
   * relates to it. See `buildUnits`.
   */
  indent: number;
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

export type PlacedEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  /**
   * Two ends in the same column with no box between them, so the edge is drawn as a
   * straight vertical connector down the shared middle rather than the side bulge a
   * same-column edge gets otherwise. A spine step is the common case; a feeder
   * chained straight above the feeder it points into is the other. A same-column
   * edge that skips over a box is not marked, so it keeps the bulge.
   */
  vertical?: boolean;
};

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
/** One-sided passes: each column settles against the side already laid out. */
const SIDED_PASSES = 6;
/** Then both sides at once, which pulls a unit with neighbours either way to the middle. */
const BOTH_SIDED_PASSES = 4;

/** One step of indentation for a same-column child. */
export const INDENT_STEP = 18;
/** Deeper than this and the box has no width left; the tree keeps nesting flat. */
const MAX_INDENT_DEPTH = 4;
/** Vertical distance between a parent and its indented child. */
const SUBTREE_GAP = 8;

/**
 * Two things whose y intervals come within this of each other are read as one
 * cluster; anything more is a gap between clusters.
 */
const CLUSTER_SLACK = 40;
/** What a gap between two clusters is shrunk to. */
const CLUSTER_GAP = 24;

/** Least horizontal lead-out an edge gets, so a near-vertical one still curves. */
const MIN_PULL = 28;
/** How far an edge inside one column bulges out past its own column. */
const SAME_COLUMN_PULL = 64;

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
 * The SVG path of one edge, between two placed nodes.
 *
 * **Which side it leaves and enters depends on the direction it runs.** A forward
 * edge leaves the source's right edge and enters the target's left; a **backward**
 * one is mirrored — left edge out, right edge in. Always leaving on the right was
 * the obvious first cut and it draws the wrong picture: an edge from a plan back to
 * its tasks went out to the right, swept across the whole column it was pointing
 * into, and came back in from the far left. Six of those over one node is a fan of
 * long diagonals over the boxes they connect, which is unreadable in exactly the
 * case where the relation matters most.
 *
 * An edge inside one column is the third case and gets neither: both ends sit on
 * the right, so it bulges out and comes back. That is the right picture only when a
 * box sits *between* the two ends — a straight line would then run through it — so
 * the caller keeps the bulge for a same-column edge that skips over a neighbour.
 *
 * A same-column edge between two **adjacent** boxes is the fourth case, asked for
 * with `vertical`: with nothing between them the line runs straight through the
 * shared column centre, from the facing edge of one box to the facing edge of the
 * other. A spine step is one instance of this; a feeder chained straight above the
 * feeder it points into is another. The bulge would be wrong here — a stack of
 * little side-loops reads as anything but a chain. Order-aware: the source may sit
 * below the target (a feeder can), and then it leaves its *top* edge and enters the
 * target's *bottom*, so the connector never leaves the wrong side and loops back.
 *
 * Control points are clamped into the canvas. Unclamped, an edge near either border
 * pulls its control point outside and the curve that explains the arrowhead is cut
 * off — which reads as a rendering fault rather than as an edge pointing backwards.
 */
export function edgePath(
  from: { x: number; y: number; height: number; width?: number },
  to: { x: number; y: number; height: number; width?: number },
  width: number,
  vertical = false,
): string {
  // Each node's own width, because an indented one is narrower: using the column
  // constant attaches the line a few pixels past the box it leaves.
  const fromW = from.width ?? NODE_W;
  const toW = to.width ?? NODE_W;
  // Each end's own middle: the boxes are not a grid, so a shared constant would
  // attach the line above or below the box it belongs to.
  const sy = from.y + from.height / 2;
  const ty = to.y + to.height / 2;
  const edge = 4;
  const clamp = (x: number) => Math.min(width - edge, Math.max(edge, x));

  if (vertical) {
    // Straight through the shared column centre, from the facing edge of one box to
    // the facing edge of the other. The two share a column, so the x values are
    // equal and the line is vertical; the slight bezier keeps the join smooth where
    // the boxes are close. Order-aware: when the source sits below the target it
    // leaves its top and enters the target's bottom, so the sign of the lift follows
    // the gap rather than assuming the source is always on top.
    const cx = from.x + fromW / 2;
    const tcx = to.x + toW / 2;
    const fromAbove = from.y <= to.y;
    const sEdge = fromAbove ? from.y + from.height : from.y;
    const tEdge = fromAbove ? to.y : to.y + to.height;
    const gap = tEdge - sEdge;
    const lift = Math.sign(gap || 1) * Math.max(MIN_PULL, Math.abs(gap) / 2);
    return `M ${cx} ${sEdge} C ${cx} ${sEdge + lift}, ${tcx} ${tEdge - lift}, ${tcx} ${tEdge}`;
  }

  if (to.x === from.x) {
    const x = Math.max(from.x + fromW, to.x + toW);
    return `M ${x} ${sy} C ${clamp(x + SAME_COLUMN_PULL)} ${sy}, ${clamp(x + SAME_COLUMN_PULL)} ${ty}, ${x} ${ty}`;
  }

  const forward = to.x > from.x;
  const sx = forward ? from.x + fromW : from.x;
  const tx = forward ? to.x : to.x + toW;
  // Signed, so the mirrored case bends the same way relative to its own direction.
  const span = tx - sx;
  const pull = Math.sign(span) * Math.max(MIN_PULL, Math.abs(span) / 2);
  return `M ${sx} ${sy} C ${clamp(sx + pull)} ${sy}, ${clamp(tx - pull)} ${ty}, ${tx} ${ty}`;
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
  const linesOf = new Map<string, { lines: number; meta: boolean; reference: boolean }>();
  for (const node of input.nodes) {
    if (!columnOf.has(node.id) || heightOf.has(node.id)) continue;
    heightOf.set(node.id, nodeHeight(node));
    linesOf.set(node.id, {
      lines: node.lines ?? 1,
      meta: !!node.meta,
      reference: !!node.reference,
    });
  }

  // The chain layout, and only in a single column: the x-axis is otherwise the
  // grouping dimension, and a spine needs it to mean something else (see the top
  // of the file). One bucket makes that axis free. Each connected band is then a
  // spine plus its feeders; the loose band still just stacks.
  const chain = input.columns.length === 1;
  const plans: (ChainPlan | undefined)[] = [];
  const sequenceOf = new Map<string, number>();
  for (const node of input.nodes) {
    if (node.sequence === undefined || sequenceOf.has(node.id)) continue;
    if (columnOf.has(node.id)) sequenceOf.set(node.id, node.sequence);
  }
  // Only for the canvas width: the widest band decides how far left the feeders
  // reach. Each band still anchors its own spine (see `spineUnits`).
  let maxDepth = 0;
  if (chain) {
    for (const band of bands) {
      if (band.loose) {
        plans.push(undefined);
        continue;
      }
      const plan = chainPlan(band.nodeIds, edges, sequenceOf);
      plans.push(plan);
      for (const d of plan.depthOf.values()) maxDepth = Math.max(maxDepth, d);
    }
  }

  const placed: PlacedNode[] = [];
  const placedBands: PlacedBand[] = [];
  /** Relations expressed by nesting, so they are not drawn as lines as well. */
  const nested = new Set<string>();
  let top = MARGIN + HEADER_H;

  for (const [index, band] of bands.entries()) {
    const titleRoom = band.title ? BAND_TITLE_H : 0;
    const baseY = top + BAND_PAD + titleRoom;

    // Three regimes: the loose band stacks (no relations to relax against); a
    // connected band in a single column becomes a spine; anything else is the
    // column-and-barycenter layout the grouped views have always used.
    const cols = band.loose
      ? stackedUnits(band.nodeIds, columnOf, heightOf, input.columns.length, baseY)
      : chain
        ? spineUnits(band.nodeIds, plans[index]!, heightOf, baseY)
        : buildUnits(band.nodeIds, columnOf, heightOf, linesOf, edges, input.columns.length, nested);

    const flat = cols.flat();
    if (!band.loose && !chain) {
      const unitOf = new Map<string, Unit>();
      for (const unit of flat) for (const member of unit.members) unitOf.set(member.id, unit);
      relaxBand(cols, baseY, edges, unitOf);
      collapseClusterGaps(flat);
    }
    if (!band.loose) {
      // Both regimes can leave the band off its own top edge: the barycenter passes
      // only push down while the collapse pulls up by whole clusters, and a chain's
      // feeder can be taller than the spine node it hangs beside. Lift it back —
      // where the band sits is the caller's business, not the placement's. (The
      // loose band was stacked straight from `baseY`, so it never drifts.)
      const highest = Math.min(...flat.map((u) => u.y));
      if (Number.isFinite(highest) && highest !== baseY) {
        for (const unit of flat) unit.y -= highest - baseY;
      }
    }

    let height = 0;
    for (const col of cols) {
      for (const [row, unit] of col.entries()) {
        for (const member of unit.members) {
          const y = unit.y + member.dy;
          placed.push({
            id: member.id,
            column: unit.column,
            row,
            band: index,
            x: MARGIN + unit.column * COL_PITCH + member.indent,
            y,
            height: member.height,
            width: member.width,
            indent: member.indent,
          });
          height = Math.max(height, y + member.height - baseY);
        }
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
  // In a chain the feeders extend the picture to the left of the single column, so
  // the width is the spine's column plus one per feeder level; everywhere else it
  // is just the declared columns.
  const usedColumns = chain ? maxDepth + 1 : columns.length;

  // A same-column edge is drawn as a straight vertical connector when the two boxes
  // are directly adjacent — nothing of the same column sitting between them. That is
  // the reading the spine already had (consecutive spine nodes), extended to any
  // adjacent same-column pair, so a feeder chained straight above the feeder it
  // feeds joins it down the shared middle instead of bulging into the channel. An
  // edge that *skips* a box keeps the bulge (a straight line would cross that box),
  // and grouped views (more than one column) are left untouched, where a
  // same-column relation is nesting rather than a drawn line. See `edgePath`.
  const placedById = new Map(placed.map((n) => [n.id, n]));
  const isVertical = (e: PlacedEdge): boolean => {
    if (!chain) return false;
    const a = placedById.get(e.from);
    const b = placedById.get(e.to);
    if (!a || !b || a.x !== b.x) return false;
    const upper = a.y <= b.y ? a : b;
    const lower = a.y <= b.y ? b : a;
    for (const n of placed) {
      if (n.band !== a.band || n.id === a.id || n.id === b.id || n.x !== a.x) continue;
      if (n.y > upper.y && n.y < lower.y) return false; // a box sits between them
    }
    return true;
  };
  return {
    columns,
    nodes: placed,
    bands: placedBands,
    edges: edges
      .filter((e) => !nested.has(`${e.from}␟${e.to}`) && !nested.has(`${e.to}␟${e.from}`))
      .map((e) => (isVertical(e) ? { ...e, vertical: true } : e)),
    width: usedColumns ? MARGIN + usedColumns * COL_PITCH - COL_GAP + MARGIN : 0,
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

/**
 * The plan for laying one connected band out as a chain: its spine, and where
 * every other node sits relative to it.
 *
 * The spine runs from the band's **earliest source** down to its heaviest sink,
 * so the arrows read top-to-bottom. Everything else is measured by its undirected
 * distance to the spine — one hop for a node that feeds a spine node directly, two
 * for a node that feeds *that* one, and so on — and hangs off the side at that
 * depth, level with the node it reaches through.
 */
type ChainPlan = {
  /** The main directed path, source at the top down to the final dependent. */
  spine: string[];
  /** 0 for a spine node, then the number of hops to the spine for the rest. */
  depthOf: Map<string, number>;
  /** For a non-spine node, the neighbour one hop nearer the spine it hangs from. */
  anchorOf: Map<string, string>;
  /**
   * The feeders anchored to each node, already in the order they should stack top
   * to bottom: a dependency sub-chain among siblings runs source-first, so it reads
   * downward like the spine instead of in file order (which can put a clue below the
   * clue it leads to, pointing the connector backwards).
   */
  childrenOf: Map<string, string[]>;
};

function chainPlan(
  nodeIds: string[],
  edges: PlacedEdge[],
  sequenceOf: Map<string, number>,
): ChainPlan {
  const inBand = new Set(nodeIds);
  const adj = new Map<string, string[]>(); // directed, from → to
  const pred = new Map<string, string[]>(); // directed, to → from
  const near = new Map<string, string[]>(); // undirected
  const push = (m: Map<string, string[]>, a: string, b: string) =>
    (m.get(a) ?? m.set(a, []).get(a)!).push(b);
  for (const e of edges) {
    if (!inBand.has(e.from) || !inBand.has(e.to)) continue;
    push(adj, e.from, e.to);
    push(pred, e.to, e.from);
    push(near, e.from, e.to);
    push(near, e.to, e.from);
  }

  // The spine is the band's **heaviest** directed path, not its longest. `mass(n)`
  // is n plus everything that (recursively) feeds into it, so at every fork the
  // trunk is the branch that itself collects the most — a short-but-busy main chain
  // wins over a long-but-thin side strand. Memoised and cycle-safe: a node already
  // on the walk's own stack counts as weightless, so a malformed cycle (a
  // `dependsOn` can express one) stops the recursion instead of looping forever.
  const mass = new Map<string, number>();
  const onStack = new Set<string>();
  const massOf = (u: string): number => {
    const cached = mass.get(u);
    if (cached !== undefined) return cached;
    if (onStack.has(u)) return 0;
    onStack.add(u);
    let total = 1;
    for (const p of pred.get(u) ?? []) total += massOf(p);
    onStack.delete(u);
    mass.set(u, total);
    return total;
  };
  for (const id of nodeIds) massOf(id);
  // The chain ends at the heaviest sink (a node nothing leads out of — the final
  // revelation). Ties fall to the earlier node in section order, keeping the spine
  // stable across unrelated edits.
  let sink = nodeIds[0];
  let bestMass = -1;
  for (const id of nodeIds) {
    if ((adj.get(id) ?? []).length) continue; // not a sink
    if (massOf(id) > bestMass) {
      bestMass = massOf(id);
      sink = id;
    }
  }
  // The head is the band's **earliest source**: of the nodes nothing leads into,
  // the one the source's declared order puts first (see src/sequence.ts), among
  // those that can reach the sink at all.
  //
  // Weight decides the sink and the steps in between; it must not decide the head.
  // At a fork the trunk is whichever branch collected more, and a side strand of
  // three nodes therefore outweighs an opening beat that is a single source node —
  // so walking back into the heaviest predecessor reliably ends on the wrong one.
  // That is what Unterlingen 1's „Hauptkette" showed: the chain began at a Christa
  // revelation feeding the second station instead of at the opening
  // „Die vergangenen Expeditionen wurden sabotiert" (#161). Order is the answer to
  // „which of these comes first", and weight never was.
  //
  // Unplaced sorts last, so a node the order file does not mention can never claim
  // the head from one it does; weight breaks a tie between two equally early ones.
  const head = earliestSource(nodeIds, adj, pred, sequenceOf, sink, massOf);
  const spine: string[] = [];
  const spineSet = new Set<string>();
  if (head === undefined) {
    // No order to go by (a source that declares none, which is every JSON and
    // database timeline) or no source reaches the sink: walk back from the sink
    // into the heaviest predecessor at each step, exactly as before.
    for (let cur: string | undefined = sink; cur && !spineSet.has(cur); ) {
      spine.push(cur);
      spineSet.add(cur);
      let heaviest: string | undefined;
      for (const p of pred.get(cur) ?? []) {
        if (spineSet.has(p)) continue;
        if (heaviest === undefined || massOf(p) > massOf(heaviest)) heaviest = p;
      }
      cur = heaviest;
    }
    spine.reverse();
  } else {
    // Forward from the head into the heaviest successor at each step. Downstream
    // there is no earlier-or-later to read — the order file places the material,
    // not the relations between two things it never listed — so weight is the
    // measure again, with band order breaking a tie.
    for (let cur: string | undefined = head; cur && !spineSet.has(cur); ) {
      spine.push(cur);
      spineSet.add(cur);
      let heaviest: string | undefined;
      for (const n of adj.get(cur) ?? []) {
        if (spineSet.has(n)) continue;
        if (heaviest === undefined || massOf(n) > massOf(heaviest)) heaviest = n;
      }
      cur = heaviest;
    }
  }

  // Everything off the spine, by undirected distance, breadth-first from the whole
  // spine at once so a node two spine nodes could hang from goes to the nearer one.
  const depthOf = new Map<string, number>(spine.map((id) => [id, 0]));
  const anchorOf = new Map<string, string>();
  let frontier = [...spine];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of near.get(cur) ?? []) {
        if (depthOf.has(nb)) continue;
        depthOf.set(nb, depthOf.get(cur)! + 1);
        anchorOf.set(nb, cur);
        next.push(nb);
      }
    }
    frontier = next;
  }
  // A node no edge reaches (only possible if the band and the drawn edge set
  // disagree) still gets a column, so it is placed beside the spine rather than
  // dropped from the picture.
  for (const id of nodeIds) if (!depthOf.has(id)) depthOf.set(id, 1);

  // The feeders of each node, grouped in section order, then reordered so a
  // dependency sub-chain among siblings runs source-first (see `orderByFlow`).
  const childrenOf = new Map<string, string[]>();
  for (const id of nodeIds) {
    const anchor = anchorOf.get(id);
    if (anchor === undefined) continue;
    (childrenOf.get(anchor) ?? childrenOf.set(anchor, []).get(anchor)!).push(id);
  }
  for (const [anchor, kids] of childrenOf) childrenOf.set(anchor, orderByFlow(kids, adj));

  return { spine, depthOf, anchorOf, childrenOf };
}

/**
 * The node the chain should start at: of the band's sources — the nodes nothing
 * inside the band leads into — the one the declared order puts first, restricted
 * to those from which the sink is reachable at all.
 *
 * `undefined` when the band carries no declared order, and when no source reaches
 * the sink. Both mean „this rule has nothing to say here", and the caller then
 * falls back to the walk it did before, so a timeline whose source declares no
 * order lays out byte for byte as it always has.
 *
 * A node the order does not place counts as after every node it does, rather than
 * as position zero: an unplaced node is one nobody put anywhere, and letting it
 * open the chain is precisely the wrong reading of that silence.
 */
function earliestSource(
  nodeIds: string[],
  adj: Map<string, string[]>,
  pred: Map<string, string[]>,
  sequenceOf: Map<string, number>,
  sink: string,
  massOf: (id: string) => number,
): string | undefined {
  if (!nodeIds.some((id) => sequenceOf.has(id))) return undefined;

  // Reachability backwards from the sink, so „can this source get there" is one
  // traversal rather than one per candidate.
  const reachesSink = new Set<string>([sink]);
  const stack = [sink];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const p of pred.get(cur) ?? []) {
      if (reachesSink.has(p)) continue;
      reachesSink.add(p);
      stack.push(p);
    }
  }

  let best: string | undefined;
  for (const id of nodeIds) {
    if (id === sink) continue; // a one-node chain is not a chain
    if ((pred.get(id) ?? []).length) continue; // not a source
    if (!reachesSink.has(id)) continue;
    if (best === undefined) {
      best = id;
      continue;
    }
    const a = sequenceOf.get(id) ?? Infinity;
    const b = sequenceOf.get(best) ?? Infinity;
    // Earlier wins; equally early (or equally unplaced) falls to the heavier, and
    // an outright tie to the earlier node in band order, so the spine stays put
    // across unrelated edits.
    if (a < b || (a === b && massOf(id) > massOf(best))) best = id;
  }
  return best;
}

/**
 * One anchor's feeders, ordered so a dependency runs source before dependent —
 * a stable topological sort with section order breaking ties. The feeders of a
 * spine node share a column, and among them a clue can lead to the next clue; left
 * in file order the earlier clue can sit *below* the one it feeds, so the connector
 * points up, backwards from the spine's downward flow. Ordering source-first puts
 * the earlier clue on top and the arrow points down, matching the spine.
 *
 * Cycle-safe: a malformed cycle among siblings leaves some with a residual
 * in-degree, and the rest are emitted in section order rather than looping forever.
 */
function orderByFlow(sibs: string[], adj: Map<string, string[]>): string[] {
  if (sibs.length < 2) return sibs;
  const set = new Set(sibs);
  const indeg = new Map(sibs.map((s) => [s, 0]));
  for (const u of sibs) for (const v of adj.get(u) ?? []) if (set.has(v)) indeg.set(v, indeg.get(v)! + 1);
  const placed = new Set<string>();
  const out: string[] = [];
  while (out.length < sibs.length) {
    // The earliest sibling in section order that nothing still-unplaced leads into.
    const next = sibs.find((s) => !placed.has(s) && indeg.get(s) === 0);
    if (next === undefined) {
      for (const s of sibs) if (!placed.has(s)) out.push(s);
      break;
    }
    out.push(next);
    placed.add(next);
    for (const v of adj.get(next) ?? []) if (set.has(v)) indeg.set(v, indeg.get(v)! - 1);
  }
  return out;
}

/**
 * The units of one chain band: its spine in the band's own rightmost column,
 * feeders to the left, each spine node's feeders grouped into a compact block
 * level with it.
 *
 * The depth is the band's *own* deepest feeder, not the graph's — so every band is
 * anchored at the left margin and its spine sits just right of the feeders it
 * actually has. Aligning all the spines to one global column instead left a band
 * with no feeders stranded at the far right with an empty half-canvas beside it,
 * and separate components are separate blocks anyway (see the author's sketch).
 *
 * A spine node reserves as much vertical room as its **whole feeder subtree** needs,
 * not a flat row: a beat with eight feeders is eight rows tall here, and the next
 * beat starts below that block. Stacking the spine at a flat `ROW_GAP` was the bug
 * in #145 — a beat with more feeders than the spine was tall could not fit them
 * beside itself, so they spilled past the beats below and their edges swept
 * diagonally across the whole canvas. Reserving the room keeps every feeder level
 * with the beat it points into and every cross-link short.
 */
function spineUnits(
  nodeIds: string[],
  plan: ChainPlan,
  heightOf: Map<string, number>,
  baseY: number,
): Unit[][] {
  const maxLocal = Math.max(0, ...plan.depthOf.values());
  const cols: Unit[][] = Array.from({ length: maxLocal + 1 }, () => []);
  const yOf = new Map<string, number>();
  const heightAt = (id: string) => heightOf.get(id)!;

  // The feeders of each node, already ordered so a dependency sub-chain reads top to
  // bottom (see `ChainPlan.childrenOf`). A depth-2 feeder hangs off a depth-1 feeder,
  // so this is a tree and the height of a block has to be summed over it.
  const childrenOf = plan.childrenOf;

  // How tall a node's feeder block is — the sum of its children's own subtrees with
  // a gap between them — and how tall the node plus that block is. Memoised: the two
  // call each other, and the spine reads `subtreeHeight` for every node.
  const feederBlock = new Map<string, number>();
  const subtree = new Map<string, number>();
  const subtreeHeight = (id: string): number => {
    const cached = subtree.get(id);
    if (cached !== undefined) return cached;
    const kids = childrenOf.get(id) ?? [];
    let block = 0;
    for (const k of kids) block += subtreeHeight(k);
    if (kids.length > 1) block += ROW_GAP * (kids.length - 1);
    feederBlock.set(id, block);
    const total = Math.max(heightAt(id), block);
    subtree.set(id, total);
    return total;
  };

  // Place a node's children as a block centred on the node, then recurse — a beat's
  // feeders sit level with it, a feeder's own feeders level with the feeder. Each
  // child is centred inside its own reserved subtree, so a child with many feeders
  // of its own claims the room they need without pushing its siblings off-centre.
  const placeChildren = (id: string) => {
    const kids = childrenOf.get(id) ?? [];
    if (!kids.length) return;
    const nodeCentre = yOf.get(id)! + heightAt(id) / 2;
    let cur = nodeCentre - (feederBlock.get(id) ?? 0) / 2;
    for (const k of kids) {
      const room = subtreeHeight(k);
      yOf.set(k, cur + room / 2 - heightAt(k) / 2);
      placeChildren(k);
      cur += room + ROW_GAP;
    }
  };

  // The spine, each node reserving room for its own feeder block and centred in it.
  let cursor = baseY;
  for (const id of plan.spine) {
    const room = subtreeHeight(id);
    yOf.set(id, cursor + room / 2 - heightAt(id) / 2);
    placeChildren(id);
    cursor += room + ROW_GAP;
  }

  // A node the spine walk never reached (only when the band and the drawn edge set
  // disagree, so `anchorOf` has no path to it) still gets placed rather than dropped
  // from the picture — stacked below the spine in its own column.
  const tail = new Map<number, number>();
  for (const id of nodeIds) {
    if (yOf.has(id)) continue;
    const column = maxLocal - plan.depthOf.get(id)!;
    const at = Math.max(cursor, tail.get(column) ?? baseY);
    yOf.set(id, at);
    tail.set(column, at + heightAt(id) + ROW_GAP);
  }

  for (const id of nodeIds) {
    const column = maxLocal - plan.depthOf.get(id)!;
    const height = heightAt(id);
    cols[column].push({
      members: [{ id, indent: 0, height, width: NODE_W, dy: 0 }],
      height,
      column,
      y: yOf.get(id)!,
    });
  }
  return cols;
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
/** The loose band: one unit per node, stacked down each column. */
function stackedUnits(
  nodeIds: string[],
  columnOf: Map<string, number>,
  heightOf: Map<string, number>,
  columns: number,
  baseY: number,
): Unit[][] {
  const cols: Unit[][] = Array.from({ length: columns }, () => []);
  const cursor = new Array(columns).fill(baseY);
  for (const id of nodeIds) {
    const column = columnOf.get(id)!;
    const height = heightOf.get(id)!;
    cols[column].push({
      members: [{ id, indent: 0, height, width: NODE_W, dy: 0 }],
      height,
      column,
      y: cursor[column],
    });
    cursor[column] += height + ROW_GAP;
  }
  return cols;
}

/**
 * A node with its own box, plus how deep inside a unit it sits.
 *
 * `indent` narrows the box rather than pushing it out of the column: a column is a
 * fixed lane, and an indented box that kept its width would hang into the next one.
 */
type Member = { id: string; indent: number; height: number; width: number; dy: number };

/**
 * A unit: one node plus everything in the same column that relates to it,
 * indented beneath it, positioned as one block.
 *
 * This is what a same-column relation should look like. Drawn as an edge it has to
 * leave the column and come back — a bulge past its own lane that says nothing,
 * repeated for every pair. Drawn as indentation it says the same thing in the
 * place the reader is already looking, and it matches how the list view renders a
 * parent and its children.
 */
type Unit = { members: Member[]; height: number; column: number; y: number };

/**
 * Who hangs under whom, for the relations that stay inside one column.
 *
 * Direction is decided per edge kind rather than by one rule for both, because the
 * two mean different things:
 *
 *   - **containment** (`parent`) puts the parent on top, exactly as the list view
 *     indents a child under its parent;
 *   - **dependency** (`depends`) puts the *dependent* on top and what it rests on
 *     beneath it, so a column reads as a conclusion followed by its basis.
 *
 * One parent per child, first edge winning, and cycles are broken — a child that
 * can reach itself through its ancestors would make the walk below never return.
 */
function sameColumnParents(
  edges: PlacedEdge[],
  columnOf: Map<string, number>,
  inBand: Set<string>,
): { parentOf: Map<string, string>; childrenOf: Map<string, string[]> } {
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();

  for (const edge of edges) {
    if (!inBand.has(edge.from) || !inBand.has(edge.to)) continue;
    if (columnOf.get(edge.from) !== columnOf.get(edge.to)) continue;
    const [parent, child] = edge.kind === 'parent' ? [edge.from, edge.to] : [edge.to, edge.from];
    if (parentOf.has(child) || parent === child) continue;
    parentOf.set(child, parent);
    (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(child);
  }

  for (const [child, parent] of [...parentOf]) {
    const seen = new Set([child]);
    let cursor: string | undefined = parent;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
    if (!cursor) continue; // reached a root, no cycle
    // Detach from the parent this child actually had. Removing it from wherever the
    // walk *stopped* leaves the original link in place, and `buildUnits` then walks
    // the cycle it was told had been broken — straight into a stack overflow.
    parentOf.delete(child);
    const siblings = childrenOf.get(parent);
    if (siblings) childrenOf.set(parent, siblings.filter((id) => id !== child));
  }
  return { parentOf, childrenOf };
}

/** The units of one band, per column, in the order the sections listed their roots. */
function buildUnits(
  nodeIds: string[],
  columnOf: Map<string, number>,
  heightOf: Map<string, number>,
  linesOf: Map<string, { lines: number; meta: boolean; reference: boolean }>,
  edges: PlacedEdge[],
  columns: number,
  nested: Set<string>,
): Unit[][] {
  const inBand = new Set(nodeIds);
  const { parentOf, childrenOf } = sameColumnParents(edges, columnOf, inBand);
  // A relation drawn as nesting must not also be drawn as a line: the reader would
  // see one statement twice, once as a box inside a box and once as a bulge past the
  // column. `nested` is what the caller filters the drawn set with.
  for (const [child, parent] of parentOf) nested.add(`${parent}␟${child}`);

  const cols: Unit[][] = Array.from({ length: columns }, () => []);
  for (const id of nodeIds) {
    if (parentOf.has(id)) continue; // it belongs to somebody else's unit
    const members: Member[] = [];
    let dy = 0;
    const walk = (current: string, depth: number) => {
      const indent = Math.min(depth, MAX_INDENT_DEPTH) * INDENT_STEP;
      // A narrower box fits fewer characters per line, so the height has to be
      // recomputed rather than reused — otherwise a deeply indented title is
      // clipped by a box measured at full width.
      const shape = linesOf.get(current);
      const width = NODE_W - indent;
      const height = shape
        ? nodeHeight({
            lines: Math.min(MAX_TITLE_LINES, Math.ceil((shape.lines * NODE_W) / width)),
            meta: shape.meta,
            reference: shape.reference,
          })
        : heightOf.get(current)!;
      members.push({ id: current, indent, height, width, dy });
      dy += height + SUBTREE_GAP;
      for (const child of childrenOf.get(current) ?? []) walk(child, depth + 1);
    };
    walk(id, 0);
    cols[columnOf.get(id)!].push({
      members,
      height: dy - SUBTREE_GAP,
      column: columnOf.get(id)!,
      y: 0,
    });
  }
  return cols;
}

/**
 * Where a band's units sit.
 *
 * Each pass computes what every unit *wants* — the mean centre of what its members
 * link to, on the side being settled — then **sorts by that** and lays the column
 * out in the new order. Sorting is the part that matters: with a fixed order and
 * only a clamp, a unit that wants to be third stays first and drags its edge across
 * everything above it. Letting the order fall out of the relaxation is what makes
 * a strand line up.
 *
 * Left and right first, so each side settles against something; then both together,
 * which is what pulls a unit with neighbours on either side into the middle instead
 * of leaving it wherever the last one-sided pass put it.
 */
function relaxBand(
  cols: Unit[][],
  baseY: number,
  edges: PlacedEdge[],
  unitOf: Map<string, Unit>,
): void {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
  };
  for (const edge of edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  const centreOf = (id: string): number | undefined => {
    const unit = unitOf.get(id);
    if (!unit) return undefined;
    const member = unit.members.find((m) => m.id === id)!;
    return unit.y + member.dy + member.height / 2;
  };

  const desired = (unit: Unit, side: 'left' | 'right' | 'both'): number => {
    const wants: number[] = [];
    for (const member of unit.members) {
      for (const other of neighbours.get(member.id) ?? []) {
        const otherUnit = unitOf.get(other);
        if (!otherUnit || otherUnit === unit) continue;
        if (side === 'left' && otherUnit.column >= unit.column) continue;
        if (side === 'right' && otherUnit.column <= unit.column) continue;
        // Where the unit would have to sit for *this* member to line up with its
        // neighbour, not where the neighbour is: a member deep in a unit is offset
        // from the unit's own top by `dy`.
        const centre = centreOf(other)!;
        wants.push(centre - (member.dy + member.height / 2) + unit.height / 2);
      }
    }
    if (!wants.length) return unit.y + unit.height / 2;
    return wants.reduce((a, b) => a + b, 0) / wants.length;
  };

  const relax = (col: Unit[], side: 'left' | 'right' | 'both') => {
    if (col.length < 1) return;
    const wanted = col.map((unit) => ({ unit, want: desired(unit, side) }));
    wanted.sort((a, b) => a.want - b.want);
    let cursor = -Infinity;
    for (const { unit, want } of wanted) {
      const top = Math.max(cursor === -Infinity ? want - unit.height / 2 : cursor, want - unit.height / 2);
      unit.y = top;
      cursor = top + unit.height + ROW_GAP;
    }
    col.splice(0, col.length, ...wanted.map((w) => w.unit));
  };

  // Stack every column first, so the first pass has something to relax against.
  for (const col of cols) {
    let cursor = baseY;
    for (const unit of col) {
      unit.y = cursor;
      cursor += unit.height + ROW_GAP;
    }
  }

  for (let pass = 0; pass < SIDED_PASSES; pass++) {
    for (let c = 1; c < cols.length; c++) relax(cols[c], 'left');
    for (let c = cols.length - 2; c >= 0; c--) relax(cols[c], 'right');
  }
  for (let pass = 0; pass < BOTH_SIDED_PASSES; pass++) {
    for (const col of cols) relax(col, 'both');
  }
}

/**
 * Shrink the vertical gaps that run clear across every column.
 *
 * The relaxation pulls related units together and lets unrelated ones drift apart,
 * which is what produces readable clusters — and also what makes a band four times
 * taller than its content. A gap that no node in any column reaches into carries no
 * information: it is space the relaxation happened to leave. Collapsing each to the
 * same small distance keeps the clusters and their separation while removing the
 * emptiness between them.
 *
 * Only gaps *across all columns* count. Shrinking a gap that one column fills would
 * move that column's node relative to its neighbours, which is exactly the alignment
 * the relaxation just bought.
 */
export function collapseClusterGaps(units: { y: number; height: number }[]): void {
  const spans = units
    .map((u) => [u.y, u.y + u.height] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return;

  const clusters: [number, number][] = [];
  for (const span of spans) {
    const last = clusters[clusters.length - 1];
    if (last && span[0] <= last[1] + CLUSTER_SLACK) last[1] = Math.max(last[1], span[1]);
    else clusters.push([...span]);
  }
  if (clusters.length < 2) return;

  let shift = 0;
  const shifts: [number, number][] = clusters.map((cluster, i) => {
    if (i > 0) shift += clusters[i][0] - clusters[i - 1][1] - CLUSTER_GAP;
    return [cluster[0], shift];
  });
  for (const unit of units) {
    for (let i = shifts.length - 1; i >= 0; i--) {
      if (unit.y >= shifts[i][0] - 0.5) {
        unit.y -= shifts[i][1];
        break;
      }
    }
  }
}

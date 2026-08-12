// The „Graph" presentation: the items of the active build as boxes, the relations
// the model already carries as lines between them.
//
// It is the third rendering of one build, beside the timeline and the list, and it
// exists for what the other two cannot show. The timeline hides an item without a
// start (vis-timeline needs one to place a box), so a timeline whose point is the
// structure — what depends on what, what contains what — could only be read as a
// Gantt chart with arrows, and an item that has no date yet lived in the list and
// nowhere else.
//
// Two decisions worth knowing before changing anything here:
//
//   • The columns are the buckets of the *grouping* dimension, taken from
//     `computeSections` — the same function the list sections with. So the column
//     order cannot drift away from the list's section order, and choosing what the
//     columns mean is the perspective control rather than something this file
//     decides. („A presentation declares its accessories",
//     docs/information-architecture.md.)
//   • Nodes are HTML, edges are SVG, both inside one transformed canvas. Drawing
//     the boxes into the SVG as well would mean re-implementing text wrapping and
//     focus handling for one presentation; keeping them as HTML means a long title
//     truncates by CSS and a box is reachable by keyboard.

import './styles/graph.css';

import type { TimelineItem } from './buildItems';
import { GraphNode, Text, el } from './design-system';
import { showDetailForId } from './detailPanel';
import { computeSections } from './listGrouping';
import { metaOf, resolveGrouping, sectionContext, syncGroupByControl } from './grouping';
import { syncFilterControl } from './filterControl';
import { displayIdsFor, filterBuildForDisplay } from './render';
import { els, state, syncUrl } from './state';
import { layoutGraph, MARGIN, NODE_H, NODE_W, type EdgeKind } from './graphLayout';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Zoom limits. Below the lower one the labels are unreadable and the picture stops
// being worth panning; above the upper one a node fills the viewport.
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

/**
 * Pan and zoom, kept per timeline for as long as the app is open.
 *
 * Deliberately *not* persisted: it is a gesture on a picture whose shape changes
 * with the grouping and the filter, so a restored offset from another session
 * would drop the reader somewhere the graph no longer has anything. The time
 * window on the timeline is persisted because it means something without the
 * items; a scroll offset does not.
 */
const viewBoxes = new Map<string, { x: number; y: number; zoom: number }>();

function viewBoxFor(viewId: string) {
  let box = viewBoxes.get(viewId);
  if (!box) {
    box = { x: 0, y: 0, zoom: 1 };
    viewBoxes.set(viewId, box);
  }
  return box;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** „01.03.2026 – 14.03.2026", „20.05.2026", or an em-dash for an item with no date. */
function dateLabel(item: TimelineItem): string {
  const start = formatDate(item.start);
  if (!start) return '—';
  const end = formatDate(item.end);
  return end && end !== start ? `${start} – ${end}` : start;
}

function formatDate(value?: string | null): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value.slice(0, 10);
}

function statusOf(id: string): string | undefined {
  const value = metaOf(id)?.status;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The edges of one build, both kinds, as one list.
 *
 * `dependencies` is keyed by the *dependent* item and lists what it waits for, so
 * the edge runs predecessor → dependent. `parents` is keyed by the child, so the
 * edge runs parent → child. Getting either direction backwards draws a picture
 * that is wrong rather than merely ugly, which is why both are spelled out here
 * instead of at the two call sites.
 */
function edgesOf(
  dependencies: Map<string, string[]>,
  parents: Map<string, string>,
): { from: string; to: string; kind: EdgeKind }[] {
  const out: { from: string; to: string; kind: EdgeKind }[] = [];
  for (const [dependent, predecessors] of dependencies) {
    for (const predecessor of predecessors) out.push({ from: predecessor, to: dependent, kind: 'depends' });
  }
  for (const [child, parent] of parents) out.push({ from: parent, to: child, kind: 'parent' });
  return out;
}

/**
 * The path from one node's right edge to another's left edge.
 *
 * A backward or same-column edge gets the same shape with a fixed control-point
 * offset, which makes it bulge out to the right and come back: it reads as „this
 * one points against the reading direction" instead of as a straight line hidden
 * under the boxes it crosses.
 *
 * Both control points are clamped into the canvas the layout computed. Unclamped,
 * a backward edge in the leftmost column pulls its control point to a negative x
 * and the loop is drawn outside the viewport — the arrowhead then sits flat
 * against the left edge with the curve that explains it cut off, which reads as a
 * rendering fault rather than as an edge pointing backwards.
 */
function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  width: number,
): string {
  const sx = from.x + NODE_W;
  const sy = from.y + NODE_H / 2;
  const tx = to.x;
  const ty = to.y + NODE_H / 2;
  const forward = tx - sx;
  const pull = forward > 0 ? Math.max(28, forward / 2) : 64;
  const edge = 4;
  const cp1 = Math.min(width - edge, sx + pull);
  const cp2 = Math.max(edge, tx - pull);
  return `M ${sx} ${sy} C ${cp1} ${sy}, ${cp2} ${ty}, ${tx} ${ty}`;
}

/** The one `<defs>` block: the arrowheads, in both treatments. */
function arrowDefs(): SVGDefsElement {
  const defs = svg('defs');
  for (const id of ['graph-arrow', 'graph-arrow-hl']) {
    const marker = svg('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse',
    });
    const head = svg('path', { d: 'M 0 0 L 10 5 L 0 10 z' });
    head.setAttribute('class', id === 'graph-arrow' ? 'graph-arrowhead' : 'graph-arrowhead is-hl');
    marker.appendChild(head);
    defs.appendChild(marker);
  }
  return defs;
}

/** Everything the hover highlight needs, built once per render. */
type Neighbourhood = {
  nodes: Map<string, HTMLElement>;
  paths: { el: SVGPathElement; from: string; to: string }[];
};

function wireHighlight(canvas: HTMLElement, parts: Neighbourhood): void {
  const clear = () => {
    canvas.removeAttribute('data-highlighting');
    for (const node of parts.nodes.values()) delete node.dataset.dimmed;
    for (const path of parts.paths) delete path.el.dataset.hl;
  };

  for (const [id, node] of parts.nodes) {
    node.addEventListener('mouseenter', () => {
      // The node itself plus everything one edge away. One hop rather than the
      // whole component: the question a hover answers is „what does this one
      // touch", and lighting up the component answers a different one.
      const lit = new Set<string>([id]);
      for (const path of parts.paths) {
        if (path.from === id) lit.add(path.to);
        else if (path.to === id) lit.add(path.from);
      }
      canvas.dataset.highlighting = '';
      for (const [other, el] of parts.nodes) {
        if (lit.has(other)) delete el.dataset.dimmed;
        else el.dataset.dimmed = '';
      }
      for (const path of parts.paths) {
        if (path.from === id || path.to === id) path.el.dataset.hl = '';
        else delete path.el.dataset.hl;
      }
    });
    node.addEventListener('mouseleave', clear);
  }
}

/** Wheel to zoom around the pointer, drag on the background to pan. */
function wirePanZoom(viewport: HTMLElement, canvas: HTMLElement, viewId: string): void {
  const box = viewBoxFor(viewId);
  const apply = () => {
    canvas.style.transform = `translate(${box.x}px, ${box.y}px) scale(${box.zoom})`;
  };
  apply();

  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, box.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
      // Keep the point under the pointer where it is: without this the picture
      // drifts away under the cursor and zooming feels like it fights back.
      box.x = px - ((px - box.x) * next) / box.zoom;
      box.y = py - ((py - box.y) * next) / box.zoom;
      box.zoom = next;
      apply();
    },
    { passive: false },
  );

  let dragging = false;
  let originX = 0;
  let originY = 0;
  viewport.addEventListener('pointerdown', (event) => {
    // Only the background pans. Starting a drag on a node would swallow its click.
    if ((event.target as HTMLElement).closest('.ds-GraphNode')) return;
    dragging = true;
    originX = event.clientX - box.x;
    originY = event.clientY - box.y;
    viewport.setPointerCapture(event.pointerId);
    viewport.dataset.panning = '';
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    box.x = event.clientX - originX;
    box.y = event.clientY - originY;
    apply();
  });
  const stop = () => {
    dragging = false;
    delete viewport.dataset.panning;
  };
  viewport.addEventListener('pointerup', stop);
  viewport.addEventListener('pointercancel', stop);
}

/**
 * Clicking a node does what clicking a list row does: it becomes *the* selection.
 *
 * The same three steps in the same order as the list, and for the same reason —
 * the URL carries the selected item, the hidden timeline holds the selection the
 * detail panel and the context menu read, and the panel opens last. Doing only the
 * third step would open a panel for an item the rest of the app does not consider
 * selected.
 */
function selectNode(id: string): void {
  state.selectedItemId = id;
  try {
    state.timeline?.setSelection(displayIdsFor(id));
  } catch {
    /* the item may be filtered out of the timeline's current display */
  }
  syncGraphSelection();
  syncUrl();
  showDetailForId(id);
}

function emptyState(message: string): HTMLElement {
  return el('div', { class: 'graph-empty' }, Text({ as: 'p', text: message, tone: 'muted' }));
}

/**
 * Draw the graph for the active build into `els.graph`.
 *
 * Rebuilt from scratch on every call rather than diffed: the layout moves every
 * node whenever the grouping or the filter changes, so there is no stable subset
 * worth keeping, and a stale box left behind by a partial update is a node the
 * reader believes is still in the graph.
 */
export function renderGraphView(): void {
  const host = els.graph;
  if (!host) return;
  host.replaceChildren();

  const build = state.activeBuild;
  if (!build) return;

  const { items, groups } = filterBuildForDisplay(build);
  // Phase tints are drawn by the timeline's band, not by items — they carry no
  // identity a relation could point at.
  const entries = items.filter((it) => it.type !== 'background');

  const { dim, options } = resolveGrouping(entries);
  syncGroupByControl(options, dim);
  syncFilterControl();

  if (!entries.length) {
    host.appendChild(emptyState('Keine Einträge, die die Filter passieren lassen.'));
    return;
  }

  const { sections } = computeSections(entries, dim, options, sectionContext(groups));
  const layout = layoutGraph({
    columns: sections.map((s) => ({ id: s.id, label: s.label })),
    nodes: sections.flatMap((s) => s.items.map((it) => ({ id: it.id, column: s.id }))),
    edges: edgesOf(build.dependencies, build.parents),
  });

  const byId = new Map(entries.map((it) => [it.id, it]));
  const positions = new Map(layout.nodes.map((n) => [n.id, n]));

  // The node box size travels to CSS as two custom properties rather than being
  // repeated in the stylesheet: `layoutGraph` computes every position from these
  // two numbers, and a second copy of them is how a box ends up overlapping the
  // row the layout reserved for the next one.
  const canvas = el('div', {
    class: 'graph-canvas',
    style: `width:${layout.width}px;height:${layout.height}px;--ds-graph-node-w:${NODE_W}px;--ds-graph-node-h:${NODE_H}px`,
  });

  // Painting order, and it is load-bearing: band frames, then edges, then boxes.
  // The frame carries an opaque surface (that is what makes a band read as one
  // area), so appending it after the edges paints over every line — which looks
  // exactly like „the graph found no relations" rather than like a stacking bug.
  for (const band of layout.bands) {
    const frame = el('div', {
      class: 'graph-band',
      style: `left:${MARGIN / 2}px;top:${band.top}px;width:${Math.max(0, layout.width - MARGIN)}px;height:${band.height}px`,
    });
    if (band.loose) frame.dataset.loose = '';
    canvas.appendChild(frame);
  }

  const lines = svg('svg', { class: 'graph-edges', width: layout.width, height: layout.height });
  lines.appendChild(arrowDefs());
  const paths: Neighbourhood['paths'] = [];
  for (const edge of layout.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const path = svg('path', { d: edgePath(from, to, layout.width), class: 'graph-edge' });
    path.dataset.kind = edge.kind;
    lines.appendChild(path);
    paths.push({ el: path, from: edge.from, to: edge.to });
  }
  canvas.appendChild(lines);

  for (const column of layout.columns) {
    canvas.appendChild(
      el(
        'div',
        { class: 'graph-column-head', style: `left:${column.x}px;top:${MARGIN}px;width:${NODE_W}px` },
        column.label,
      ),
    );
  }

  const nodes = new Map<string, HTMLElement>();
  for (const placed of layout.nodes) {
    const item = byId.get(placed.id);
    if (!item) continue;
    const node = GraphNode({
      label: item.label ?? '',
      meta: dateLabel(item),
      status: statusOf(item.id),
      icon: item.icon,
      selected: state.selectedItemId === item.id,
      attrs: { style: `left:${placed.x}px;top:${placed.y}px`, 'data-id': item.id },
      on: { click: () => selectNode(item.id) },
    });
    canvas.appendChild(node);
    nodes.set(item.id, node);
  }

  const viewport = el('div', { class: 'graph-viewport' }, canvas);
  host.appendChild(viewport);

  // Only when both kinds are actually on screen: a legend for a line style the
  // picture does not contain explains nothing and takes up the corner anyway.
  const kinds = new Set(layout.edges.map((e) => e.kind));
  if (kinds.size > 1) {
    host.appendChild(
      el('div', { class: 'graph-legend' }, [
        el('span', { class: 'graph-legend-item' }, [
          el('span', { class: 'graph-legend-line' }),
          'Abhängigkeit',
        ]),
        el('span', { class: 'graph-legend-item' }, [
          el('span', { class: 'graph-legend-line', 'data-kind': 'parent' }),
          'Übergeordnet',
        ]),
      ]),
    );
  }

  wireHighlight(canvas, { nodes, paths });
  wirePanZoom(viewport, canvas, state.activeView?.id ?? '');
}

/** Re-mark the selected node without redrawing the picture. */
export function syncGraphSelection(): void {
  if (!els.graph) return;
  for (const node of els.graph.querySelectorAll<HTMLElement>('.ds-GraphNode')) {
    const selected = node.dataset.id === state.selectedItemId;
    if (selected) {
      node.dataset.selected = '';
      node.setAttribute('aria-pressed', 'true');
    } else {
      delete node.dataset.selected;
      node.removeAttribute('aria-pressed');
    }
  }
}

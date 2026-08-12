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

import { laneClassOf, type TimelineItem } from './buildItems';
import { classes, GraphNode, Text, el } from './design-system';
import { showDetailForId } from './detailPanel';
import { computeSections } from './listGrouping';
import { metaOf, resolveGrouping, sectionContext, syncGroupByControl } from './grouping';
import { syncFilterControl } from './filterControl';
import { displayIdsFor, filterBuildForDisplay } from './render';
import { els, state, syncUrl } from './state';
import {
  edgePath,
  estimateLines,
  layoutGraph,
  MARGIN,
  NODE_W,
  type EdgeKind,
} from './graphLayout';
import type { GraphConfig } from './types';

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

/**
 * The nodes that name a band rather than sitting in one.
 *
 * A root is an item of the declared group that no *other item of that same group*
 * points at — the top of its own chain. Sub-plans stay in their column, which is
 * what makes the picture read as „this plan, and the plans under it".
 *
 * Computed off the unfiltered relations on purpose: whether a plan is top-level is
 * a property of the timeline, not of what the reader currently has switched on.
 * Deriving it from the filtered set would promote a sub-plan to a heading the
 * moment its parent was filtered away.
 */
function bandRoots(
  entries: TimelineItem[],
  group: string | undefined,
  dependencies: Map<string, string[]>,
  inGroup: (id: string) => boolean,
): { id: string; title: string }[] {
  if (!group) return [];
  const out: { id: string; title: string }[] = [];
  for (const item of entries) {
    if (item.group !== group) continue;
    const hasParentOfSameKind = (dependencies.get(item.id) ?? []).some(inGroup);
    if (!hasParentOfSameKind) out.push({ id: item.id, title: item.label ?? item.id });
  }
  return out;
}

/**
 * For each item, the titles of the items in `group` that reference it.
 *
 * Built from the **unfiltered** relations, which is the entire point: a revelation
 * should still say which scenes it surfaces in after the extent has hidden the
 * scenes. Reading the filtered set would make the line vanish exactly when it is
 * most useful.
 */
function referencesByTarget(
  all: TimelineItem[],
  group: string | undefined,
  dependencies: Map<string, string[]>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!group) return out;
  const byId = new Map(all.map((it) => [it.id, it]));
  for (const item of all) {
    if (item.group !== group) continue;
    for (const target of dependencies.get(item.id) ?? []) {
      if (!byId.has(target)) continue;
      (out.get(target) ?? out.set(target, []).get(target)!).push(item.label ?? item.id);
    }
  }
  return out;
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

  // Keyed before the layout runs: a root only earns a heading if the extent still
  // lets its own kind through, and the layout has to be told which roots those are.
  const byIdVisible = new Map(entries.map((it) => [it.id, it]));
  const byId = byIdVisible;

  const { dim, options } = resolveGrouping(entries);
  syncGroupByControl(options, dim);
  syncFilterControl();

  if (!entries.length) {
    host.appendChild(emptyState('Keine Einträge, die die Filter passieren lassen.'));
    return;
  }

  const config: GraphConfig = state.activeSourceFile?.graph ?? {};
  // Both derivations read the *unfiltered* build: which plan is top-level, and which
  // scenes mention a revelation, are properties of the timeline rather than of what
  // the reader currently has switched on.
  const inRootGroup = (id: string) =>
    build.items.find((it) => it.id === id)?.group === config.bandRootGroup;
  const roots = bandRoots(build.items, config.bandRootGroup, build.dependencies, inRootGroup);
  const rootIds = new Set(roots.map((r) => r.id));
  const references = referencesByTarget(build.items, config.referenceGroup, build.dependencies);
  // The line is prefixed with the referencing group's own name („Szenen: …"), so it
  // says what the titles after it are without this file knowing any domain word.
  const referenceLabel =
    build.groups.find((g) => g.id === config.referenceGroup)?.label ?? config.referenceGroup ?? '';

  const { sections } = computeSections(entries, dim, options, sectionContext(groups));
  const layout = layoutGraph({
    columns: sections.map((s) => ({ id: s.id, label: s.label })),
    // The size hints travel with the node, because the layout's y positions depend
    // on them: a box whose height the layout guessed wrong overlaps its neighbour.
    nodes: sections.flatMap((s) =>
      s.items
        .filter((it) => !rootIds.has(it.id))
        .map((it) => ({
          id: it.id,
          column: s.id,
          lines: estimateLines(it.label ?? ''),
          meta: !!it.start,
          reference: !!references.get(it.id)?.length,
        })),
    ),
    edges: edgesOf(build.dependencies, build.parents),
    roots: roots.filter((r) => byIdVisible.has(r.id)),
  });

  const positions = new Map(layout.nodes.map((n) => [n.id, n]));
  const groupById = new Map(build.groups.map((g) => [g.id, g]));

  // The node box size travels to CSS as two custom properties rather than being
  // repeated in the stylesheet: `layoutGraph` computes every position from these
  // two numbers, and a second copy of them is how a box ends up overlapping the
  // row the layout reserved for the next one.
  const canvas = el('div', {
    class: 'graph-canvas',
    style: `width:${layout.width}px;height:${layout.height}px;--ds-graph-node-w:${NODE_W}px`,
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
    if (band.title) {
      frame.appendChild(el('div', { class: 'graph-band-title' }, band.title));
    }
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

  for (const [index, column] of layout.columns.entries()) {
    // The colour key belongs on the column rather than in a legend of its own: the
    // column *is* what the colour stands for, and a key at the other end of the
    // picture is a key nobody reads. Only drawn when the column really is one
    // colour — a dimension whose values cut across groups would make a single dot a
    // lie, so the check is „do all its nodes agree" rather than „is this the group
    // dimension".
    const swatches = new Set(
      layout.nodes
        .filter((n) => n.column === index)
        .map((n) => {
          const item = byId.get(n.id);
          const group = item?.group ? groupById.get(item.group) : undefined;
          return group?.color ?? laneClassOf(item?.className) ?? '';
        }),
    );
    const swatch = swatches.size === 1 ? [...swatches][0] : '';
    const dot = swatch
      ? el('span', {
          class: classes('graph-column-dot', swatch.startsWith('lane-') ? swatch : undefined),
          style: swatch.startsWith('lane-') ? undefined : `--graph-dot:${swatch}`,
        })
      : null;
    canvas.appendChild(
      el(
        'div',
        { class: 'graph-column-head', style: `left:${column.x}px;top:${MARGIN}px;width:${NODE_W}px` },
        [dot, column.label],
      ),
    );
  }

  const nodes = new Map<string, HTMLElement>();
  for (const placed of layout.nodes) {
    const item = byId.get(placed.id);
    if (!item) continue;
    const scenes = references.get(item.id);
    const node = GraphNode({
      color: item.group ? groupById.get(item.group)?.color : undefined,
      label: item.label ?? '',
      // Undated is the normal case for a relation graph, and a column of em-dashes
      // is a line of noise rather than information.
      meta: item.start ? dateLabel(item) : undefined,
      reference: scenes?.length ? `${referenceLabel}: ${scenes.join(', ')}` : undefined,
      lane: laneClassOf(item.className),
      status: statusOf(item.id),
      icon: item.icon,
      selected: state.selectedItemId === item.id,
      attrs: {
        style: `left:${placed.x}px;top:${placed.y}px;--ds-graph-node-h:${placed.height}px`,
        'data-id': item.id,
      },
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

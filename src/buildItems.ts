import type { TimelineFile, TimelineFileItem, View } from './types';
import { htmlAll, Tag } from './design-system';
import { normalizeIcon } from './icons';
import { isOverdue, normalizeStatus } from './status';
import type { StatusKey } from './status';
import { durationToMs } from './date';
import { childrenByParent, readParentId, resolveParents } from './itemHierarchy';
import { CLONE_SEP } from './cloneId';
import { orderGroups } from './groupOrder';
import { BACKGROUND_LABEL_CLASS } from './backgroundItemDisplay';

export const UNGROUPED = '_ungrouped';

export type TimelineItem = {
  id: string;
  group?: string;
  // Numeric on purpose: vis-timeline's string `subgroupOrder` sorts with
  // `a - b`, so a padded-string lane id ("l000") yields NaN and no sort. A plain
  // lane number sorts correctly (see layoutDependencyLanes).
  subgroup?: number;
  // Optional: start-less items live in the list view only; the timeline DataSet
  // filters them out (vis-timeline requires a start to position an item).
  start?: string;
  end?: string;
  // The item's name as **markup**: vis-timeline renders its items from HTML
  // strings, so this is escaped at build time and the escaping cannot move to
  // the consumer.
  content: string;
  // The same name as plain text. A consumer that builds DOM rather than markup
  // needs this one: setting `content` as a text node shows the entities
  // („Konzept &amp; Wireframes"), and unescaping it back would be a parser at
  // the wrong end of the pipeline.
  label: string;
  // Vis-timeline hover tooltip. Only the notes path derives one (title + date);
  // JSON/DB items carry none, so the tooltip is absent for them.
  title?: string;
  type: 'point' | 'range' | 'background' | 'box';
  className?: string;
  style?: string;
  icon?: string;
  status?: StatusKey;
  tags?: string[];
};

// A TimelineItem guaranteed to carry a start — the shape vis-timeline needs to
// position an item. `timelineItems()` (render.ts) narrows to this before feeding
// the vis DataSet.
export type TimelineItemWithStart = TimelineItem & { start: string };

export type TimelineGroup = {
  id: string;
  /** The author's own colour for this group, if they set one. See `TimelineFile`. */
  color?: string;
  /**
   * The group's name as **markup**, because vis-timeline renders a group label
   * from an HTML string. Escaped here, so the escaping cannot move to a consumer.
   */
  content: string;
  /**
   * The same name as plain text, for the consumers that build DOM rather than
   * markup — the list's section rows and the graph's column heads.
   *
   * The exact twin of `label` on `TimelineItem`, and it exists for the same reason
   * that one does: setting `content` as a text node shows the entities. A group
   * called „Hero's Journey" rendered as `Hero&#39;s Journey` in both the list and
   * the graph until this existed, and the bug was invisible until a group name
   * contained punctuation.
   */
  label: string;
  className?: string;
  nestedGroups?: string[];
  showNested?: boolean;
  subgroupOrder?: string;
  subgroupStack?: boolean;
  // Inline CSS text vis-timeline puts on the group's label element (`DataGroup.style`).
  // We use it for exactly one thing: `--lanes`, the lane count the track needs, which
  // the stylesheet turns into a `min-height` on the label — see LANE_COUNT_PROPERTY.
  style?: string;
};

// The lane count is published as a custom property on the group label because
// vis-timeline derives a track's height from what is *currently drawn*
// (`Group._calculateHeight` runs over `visibleItems`) and ends in
// `Math.max(height, props.label.height)`. Without a floor, a track whose items are
// all outside the current time window collapses to label height and every track
// below it jumps up; scrolling and zooming then shuffle the whole layout
// vertically. The label is the one height vis takes from us rather than from the
// viewport, and `timeline.css` turns this number into its `min-height`. Same
// mechanism the phase-band spacer already uses (`withBandSpacer` in render.ts).
const LANE_COUNT_PROPERTY = '--lanes';
const BACKGROUND_STACK_PROPERTY = '--background-stack';
const BACKGROUND_TINT_PROPERTY = '--background-tint';

export function backgroundLabelId(id: string): string {
  return `${id}${CLONE_SEP}background-label`;
}

export function isBackgroundLabel(item: TimelineItem): boolean {
  return item.className?.split(/\s+/).includes(BACKGROUND_LABEL_CLASS) ?? false;
}

function withBackgroundStack(style: string | undefined, stack: number): string {
  const cleaned = (style ?? '')
    .replace(/--background-(?:stack|tint):\s*[^;]+;?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Later overlap layers paint above earlier ones and get progressively lighter.
  const tint = Math.max(12, 35 - stack * 10);
  return [cleaned, `${BACKGROUND_STACK_PROPERTY}: ${stack};`, `${BACKGROUND_TINT_PROPERTY}: ${tint}%;`]
    .filter(Boolean)
    .join(' ');
}

function firstVisibleLabelExtent(
  item: TimelineItem,
  backgrounds: TimelineItem[],
  stackOf: ReadonlyMap<string, number>,
): { start: string; end: string } | null {
  if (!item.start || !item.end) return null;
  const ownStack = stackOf.get(item.id) ?? 0;
  let segments = [{ start: item.start, end: item.end }];
  for (const blocker of backgrounds) {
    if (!blocker.start || !blocker.end || (stackOf.get(blocker.id) ?? 0) <= ownStack) continue;
    const bs = new Date(blocker.start).getTime();
    const be = new Date(blocker.end).getTime();
    segments = segments.flatMap((segment) => {
      const ss = new Date(segment.start).getTime();
      const se = new Date(segment.end).getTime();
      if (be <= ss || bs >= se) return [segment];
      const visible: { start: string; end: string }[] = [];
      if (bs > ss) visible.push({ start: segment.start, end: blocker.start! });
      if (be < se) visible.push({ start: blocker.end!, end: segment.end });
      return visible;
    });
  }
  return segments[0] ?? null;
}

/**
 * Split a stored background into two display-only pieces: the original
 * full-height tint (without content) and a foreground label that can occupy a
 * real subgroup row. Keeping the title inside vis' BackgroundItem was the wrong
 * seam: all backgrounds share one non-stacking layer, so overlapping titles
 * stayed on top of each other no matter how their content was nudged with CSS.
 */
export function withBackgroundLabelItems(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const item of items) {
    if (item.type !== 'background' || !item.group || !item.start || !item.end || !item.content) {
      out.push(item);
      continue;
    }
    out.push({ ...item, content: '', icon: undefined, status: undefined, tags: undefined });
    out.push({
      ...item,
      id: backgroundLabelId(item.id),
      type: 'range',
      className: BACKGROUND_LABEL_CLASS,
      status: undefined,
      tags: undefined,
    });
  }
  return out;
}

export function laneCountStyle(lanes: number): string {
  return `${LANE_COUNT_PROPERTY}: ${Math.max(1, lanes)};`;
}

/**
 * Read a lane count back out of a group's inline style. Here rather than at the
 * call site so the property name stays spelled in one place; a second copy of it
 * would silently start reading nothing the day this one is renamed.
 */
export function laneCountOf(style: string | undefined): number {
  const match = style?.match(new RegExp(`${LANE_COUNT_PROPERTY}:\\s*(\\d+)`));
  return match ? Number(match[1]) : 1;
}

const LANE_COUNT = 6;

function laneClass(index: number): string {
  return `lane-${index % LANE_COUNT}`;
}

// `className` carries status marks and hierarchy flags beside the lane, so the
// lane has to be picked out rather than used whole.
const LANE_CLASS = /(?:^|\s)(lane-\d+)(?:\s|$)/;

/**
 * The lane colour class on an item or a group, or undefined for something that
 * never got one (the ungrouped bucket, a phase tint).
 *
 * Here beside `laneClass`, which produces it: the milestone rail and the graph
 * both need to read one back, and a second copy of the pattern silently starts
 * matching nothing the day the format changes.
 */
export function laneClassOf(className: string | undefined): string | undefined {
  return className?.match(LANE_CLASS)?.[1];
}

export function assignLanes(items: TimelineItem[], groups: TimelineGroup[]): void {
  if (groups.length === 0) return;
  const laneByGroup = new Map<string, string>();
  groups.forEach((g, i) => {
    if (g.id === UNGROUPED) return;
    const cls = laneClass(i);
    laneByGroup.set(g.id, cls);
    g.className = cls;
  });
  for (const item of items) {
    if (!item.group) continue;
    const cls = laneByGroup.get(item.group);
    if (cls) {
      item.className = isBackgroundLabel(item) ? `${cls} ${BACKGROUND_LABEL_CLASS}` : cls;
    }
  }
}

/**
 * Stamp each item's status onto its `className` as the rail's status-mark class
 * (see „Item rail → The status mark" in AGENTS.md). Runs *after* a build, once per
 * populate — never inside one, because `assignLanes` above owns `className` and
 * overwrites it on every regroup. Marked items are returned as **shallow copies**,
 * so the build's own items stay untouched and the persist diff never sees a
 * display concern.
 *
 * At most one mark per item: the two states are mutually exclusive. `status-mark`
 * carries the shared rail geometry, the state class only its glyph — so a third
 * state is a CSS rule plus a branch here.
 */
export function withStatusMarks<T extends TimelineItem>(items: T[], now: number): T[] {
  return items.map((it) => {
    const mark = statusMarkClass(it, now);
    return mark ? { ...it, className: `${it.className ? `${it.className} ` : ''}${mark}` } : it;
  });
}

function statusMarkClass(item: TimelineItem, now: number): string | null {
  if (item.status === 'Done') return 'status-mark status-done';
  return isOverdue(item, now) ? 'status-mark status-overdue' : null;
}

/**
 * Stamp the hierarchy onto `className`: `item-summary` on anything that has
 * children, `item-child` on anything that declares a parent, plus `is-collapsed`
 * while a subtree is folded away. Runs alongside `withStatusMarks` and for the
 * same reason — `assignLanes` owns `className` and rewrites it on every regroup,
 * so a display concern may only be appended on the way into the DataSet, never
 * inside a build.
 *
 * The collapse caret (itemCollapse.ts) finds its bars by `item-summary` rather
 * than by being handed a list of ids, which is what keeps „which bars can fold"
 * a single statement instead of two that drift.
 *
 * `realId` maps a display id back to the item it stands for: when the timeline
 * is grouped by tag or a custom field, one item renders once per lane it falls
 * into (see grouping.ts). Marking only the ids that match the source would leave
 * those clones without a caret — with their children still folded away, and no
 * way left to unfold them.
 */
export function withHierarchyMarks<T extends TimelineItem>(
  items: T[],
  parents: Map<string, string>,
  collapsed: ReadonlySet<string>,
  realId: (displayId: string) => string,
): T[] {
  if (parents.size === 0) return items;
  const hasChildren = new Set(parents.values());
  return items.map((it) => {
    const id = realId(it.id);
    const marks: string[] = [];
    if (parents.has(id)) marks.push('item-child');
    if (hasChildren.has(id)) {
      marks.push('item-summary');
      if (collapsed.has(id)) marks.push('is-collapsed');
    }
    if (marks.length === 0) return it;
    return { ...it, className: `${it.className ? `${it.className} ` : ''}${marks.join(' ')}` };
  });
}

export type DetailNote = {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  dateSource: string | null;
  folder: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!;
  });
}

/**
 * Inverse of `escapeHtml`, for the places that need an item's title as plain
 * text rather than as markup: canvas text measurement, and any `title` /
 * `aria-label` set as a DOM property (which renders entities verbatim, so a
 * milestone called "R&D" would read "R&amp;D"). `&amp;` is decoded last, so a
 * literal "&amp;lt;" in a title survives as "&lt;" instead of collapsing to "<".
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// `durationToMs` now lives in ./date (pure date/duration maths, no client-graph
// deps) so the Deno edge bundle can reach it via phaseOverlap without pulling in
// filter/icons. Re-exported here to keep buildItems' public API stable.
export { durationToMs };

/**
 * Add a duration (ms) to a start date and return an end string in the SAME
 * calendar frame as the start. Bare `YYYY-MM-DD` starts are interpreted as
 * LOCAL midnight — the way vis-timeline reads bare dates in the viewer — and the
 * result is emitted WITHOUT a `Z`, so it is parsed back in that same local
 * frame. Using `new Date(start).getTime()` + `.toISOString()` here (UTC, with a
 * trailing `Z`) instead makes a duration-derived end land TZ-offset hours past a
 * neighbouring item's local-midnight `start`: in CET/CEST that's 1–2h, so two
 * back-to-back bars overlap by ~8px and read as "touching" at high zoom.
 */
export function endFromDuration(start: string, ms: number): string | null {
  const base = new Date(
    typeof start === 'string' && start.length === 10 ? `${start}T00:00:00` : start,
  );
  const t = base.getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t + ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return time === '00:00:00' ? date : `${date}T${time}`;
}


export function detailFromJsonItem(raw: TimelineFileItem & { id: string }): DetailNote {
  return {
    id: raw.id,
    title: raw.content,
    start: raw.start ?? null,
    end: raw.end ?? null,
    dateSource: 'json',
    folder: '',
    filename: '',
    frontmatter: (raw.metadata ?? {}) as Record<string, unknown>,
    body: raw.body ?? '',
  };
}


export type ResolvedPhase = {
  id: string;
  label: string;
  start: string;
  end: string;
  color?: string;
  icon?: string;
  // Index into the source file's `phases` array, so drag/resize edits in the
  // ribbon can be written back to the exact phase they came from (auto-assigned
  // ids and skipped phases make id/position matching unreliable otherwise).
  srcIndex: number;
};

export type BuildResult = {
  items: TimelineItem[];
  groups: TimelineGroup[];
  details: Map<string, DetailNote>;
  dependencies: Map<string, string[]>;
  // child id → parent id, already sanitized (see itemHierarchy.resolveParents).
  // A peer of `dependencies`: both are edges between items that the item shape
  // itself does not carry, read once out of `metadata` at build time so no
  // renderer has to reach back into the source file.
  parents: Map<string, string>;
  phases: ResolvedPhase[];
};

function resolvePhases(file: TimelineFile): ResolvedPhase[] {
  const out: ResolvedPhase[] = [];
  let auto = 0;
  const phases = file.phases ?? [];
  for (let srcIndex = 0; srcIndex < phases.length; srcIndex++) {
    const p = phases[srcIndex];
    if (!p.start || !p.label) continue;
    let end = p.end;
    if (!end) {
      const ms = durationToMs(p.duration);
      if (ms && ms > 0) {
        end = endFromDuration(p.start, ms) ?? end;
      }
    }
    if (!end) continue; // a phase needs an extent to render
    out.push({
      id: p.id || `__phase_${auto++}`,
      label: escapeHtml(p.label),
      start: p.start,
      end,
      color: typeof p.color === 'string' ? p.color : undefined,
      icon: normalizeIcon(p.icon),
      srcIndex,
    });
  }
  return out;
}

// CSS-safe token for a phase id, shared by the background item's class name and
// the dynamic stylesheet PhaseBand injects to colour it.
export function phaseCssId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Item tags: lightweight visual theme markers within a lane (rendered as
// coloured pills before the title). Stored per item in `metadata.tags`
// (string[]); a legacy singular `metadata.tag` is still read for backwards
// compatibility. Colours resolved centrally here.
const TAG_COLORS: Record<string, string> = {
  'Stimmen & Modelle': '#8642FE',
  'Qualität & Daten': '#1D9E75',
  'Conversation Design': '#BA7517',
  'Agent Graph': '#315DFF',
};

const TAG_FALLBACK_COLOR = '#64748B';

export function tagColor(tag: string): string {
  return TAG_COLORS[tag] ?? TAG_FALLBACK_COLOR;
}

// Reads tags from metadata, accepting both the current `tags` array and the
// legacy singular `tag` string. Trims, drops empties, and de-duplicates while
// preserving order.
export function readTags(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const m = meta as Record<string, unknown>;
  const raw: unknown[] = [];
  if (Array.isArray(m.tags)) raw.push(...m.tags);
  if (typeof m.tag === 'string') raw.push(m.tag);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function tagPillsHtml(tags?: string[]): string {
  if (!tags || tags.length === 0) return '';
  // The `Tag` component sets `title` from the label, which is what keeps the tag
  // name reachable on hover once the pill collapses to a bare dot in the dense
  // (zoomed-out) view.
  return htmlAll(tags.map((tag) => Tag({ label: tag, color: tagColor(tag) })));
}

// Faint full-height tint per phase, rendered behind the items so you can read
// which items fall into which phase. Complements the labeled ribbon on top.
// Colour comes from a per-phase CSS class (see PhaseBand) — a plain inline
// style loses to `.vis-item { background-color: ...!important }`.
function phaseBackgroundItems(phases: ResolvedPhase[]): TimelineItem[] {
  return phases.map((p) => ({
    id: `__phasebg_${p.id}`,
    start: p.start,
    end: p.end,
    content: '',
    label: '',
    title: '',
    type: 'background' as const,
    className: `phase-bg phase-bg-${phaseCssId(p.id)}`,
  }));
}

// Greedily packs a set of non-overlapping-by-time items into as few lanes as
// possible, starting at lane index `base`. Returns the number of lanes used.
// Records each item's absolute lane in `laneOf`. "Tightest fit" (reuse the
// latest-finishing lane that's free) keeps rows dense.
function packBand(
  band: TimelineItem[],
  base: number,
  laneOf: Map<string, number>,
  startMs: (it: TimelineItem) => number,
  endMs: (it: TimelineItem) => number,
  prevLane?: (it: TimelineItem) => number | undefined,
): number {
  const laneEnds: number[] = [];
  const ordered = [...band].sort((a, b) => startMs(a) - startMs(b) || endMs(a) - endMs(b));
  for (const it of ordered) {
    const s = startMs(it);
    // Where the item sat before this pass. Keeping it there whenever the lane is
    // still free is what stops a re-pack from shuffling items that had no reason to
    // move: a zoom step changes the *reserved label width* of a few milestones, and
    // without this every item behind them slid to a different lane. The lane count
    // is unaffected, so the track does not get taller for it: processing in start
    // order and opening a new lane only when every existing one is busy uses
    // exactly as many lanes as the widest overlap, whichever free lane is picked.
    const remembered = prevLane?.(it);
    const preferred = remembered === undefined ? -1 : remembered - base;
    let chosen = preferred >= 0 && preferred < laneEnds.length && laneEnds[preferred] <= s ? preferred : -1;
    // Otherwise best-fit: the free lane that ends latest, which keeps the used
    // lanes tight instead of spreading items over fresh ones.
    if (chosen === -1) {
      let chosenEnd = -Infinity;
      for (let li = 0; li < laneEnds.length; li++) {
        if (laneEnds[li] <= s && laneEnds[li] > chosenEnd) {
          chosen = li;
          chosenEnd = laneEnds[li];
        }
      }
    }
    if (chosen === -1) {
      chosen = laneEnds.length;
      laneEnds.push(endMs(it));
    } else {
      laneEnds[chosen] = endMs(it);
    }
    laneOf.set(it.id, base + chosen);
  }
  return laneEnds.length;
}

// Deterministic vertical lane layout for every track, rendered via vis-timeline
// `subgroup`s (one subgroup per lane). We take stacking over from vis entirely
// (the timeline runs with `stack: false`) because vis only honours subgroups in
// its non-stacking path — and because fixed, precomputed lanes are stable while
// vis's own stacking re-flows vertically as items scroll in/out of view.
//
//   • A track carrying parent/child items is split into contiguous tree bands
//     first: a parent's entire subtree sits directly below it before an unrelated
//     item may start. Walking only by depth would put every root first and every
//     child second, which lets unrelated roots appear between a summary and its
//     children. Containment wins over the dependency staircase below because a
//     child is *part of* its parent, while a successor is merely after its
//     predecessor.
//   • Within one such band, tracks WITH an internal dependency graph get a
//     "staircase": connected items are placed in topological layers (longest-path
//     depth) so every predecessor sits on a lane strictly above its successors
//     and all dependency arrows flow downward; free items are packed into a block
//     below.
//   • Tracks WITHOUT internal dependencies just get a compact greedy packing —
//     visually identical to what vis's own stacking produced before. A track with
//     no hierarchy is one single band, so its layout is unchanged.
//
// Track order and group membership are never changed ("Tracks bleiben heilig").
export interface LanePackOptions {
  // Horizontal density of the current viewport. Point label widths (measured in
  // px) are translated into a time width via this factor.
  pxPerDay: number;
  // Measures the rendered label width (px) of a point item — dot + icon + tag
  // pills + content text. Supplied by the renderer, which has the DOM/font.
  pointLabelPx: (item: TimelineItem) => number;
}

const LANE_DAY_MS = 86_400_000;

/**
 * Ordered packing bands that keep every local subtree contiguous.
 *
 * Leaf siblings may still share a compact band. A child that has children of
 * its own starts a nested block, so its siblings cannot slip between it and its
 * descendants. The same rule at the root keeps unrelated items outside the
 * complete parent→descendant span. With no hierarchy the single returned band
 * preserves the old compact packing exactly.
 */
function hierarchyBands(
  items: TimelineItem[],
  parents: Map<string, string>,
  structuralParents: ReadonlySet<string>,
): TimelineItem[][] {
  if (parents.size === 0 && !items.some((it) => structuralParents.has(it.id))) return [items];

  const byId = new Map(items.map((it) => [it.id, it]));
  const children = childrenByParent(parents);
  const bands: TimelineItem[][] = [];
  let loose: TimelineItem[] = [];

  const flushLoose = (): void => {
    if (loose.length === 0) return;
    bands.push(loose);
    loose = [];
  };

  const emit = (item: TimelineItem): void => {
    const kids = (children.get(item.id) ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child ? [child] : [];
    });
    if (kids.length === 0 && !structuralParents.has(item.id)) {
      loose.push(item);
      return;
    }

    flushLoose();
    bands.push([item]);
    for (const child of kids) emit(child);
    flushLoose();
  };

  for (const root of items) {
    if (!parents.has(root.id)) emit(root);
  }
  flushLoose();
  return bands;
}

export function assignLaneSubgroups(
  items: TimelineItem[],
  groups: TimelineGroup[],
  dependencies: Map<string, string[]>,
  parents: Map<string, string>,
  opts?: LanePackOptions,
): void {
  // Only start-bearing items are laned (the bucket loop below skips start-less
  // ones), so `it.start` is present here.
  const startMs = (it: TimelineItem) => new Date(it.start!).getTime();
  // Effective right edge used for packing. For range items this is the real end
  // (bar width == time span, so time already captures the visual footprint). A
  // point item's time span is zero, but its label renders to the RIGHT of the
  // dot and occupies horizontal room — without reserving it, two nearby
  // milestones pack into one lane and their labels overlap. When pack options
  // are supplied (live, on every zoom) we convert the measured label width (px)
  // into a time width via the current px/day so the point reserves exactly the
  // room its label needs at this zoom level.
  // Read once, so every item in one packing pass measures its overrun (below)
  // against the same instant.
  const packedAt = Date.now();
  const endMs = (it: TimelineItem) => {
    if (it.type === 'point' && opts && opts.pxPerDay > 0 && Number.isFinite(opts.pxPerDay)) {
      return startMs(it) + (opts.pointLabelPx(it) / opts.pxPerDay) * LANE_DAY_MS;
    }
    const own = new Date(it.end ?? it.start!).getTime();
    // An overdue range runs on past its own end as the overrun line (see
    // overrun.ts), and that line is part of the item's visual footprint exactly
    // like a point's label is. Packing therefore reserves the room out to „now",
    // so a following bar is pushed into the next lane instead of landing on top of
    // the line. Points carry no line (their box is content-sized), so they keep
    // the label-width reservation above.
    return isOverdue(it, packedAt) ? Math.max(own, packedAt) : own;
  };

  // Cleared up front rather than only rewritten below: a track that lost its last
  // item (milestones-only, a value filter) would otherwise keep reserving room for
  // lanes that no longer have anything in them.
  for (const g of groups) g.style = undefined;

  // A stored background's tint stays full-height, while its display-only label
  // is a foreground range in one shared header subgroup. Overlapping tints are
  // layered in depth (later layers paint above and lighter), not given separate
  // vertical title rows. Every ordinary item starts below the one header row.
  const backgroundRows = new Map<string, number>();
  const backgroundsByGroup = new Map<string, TimelineItem[]>();
  for (const it of items) {
    if (!it.group || it.type !== 'background' || !it.start) continue;
    let bucket = backgroundsByGroup.get(it.group);
    if (!bucket) backgroundsByGroup.set(it.group, (bucket = []));
    bucket.push(it);
  }
  for (const [groupId, backgrounds] of backgroundsByGroup) {
    const rowOf = new Map<string, number>();
    packBand(
      backgrounds,
      0,
      rowOf,
      (it) => new Date(it.start!).getTime(),
      (it) => new Date(it.end ?? it.start!).getTime(),
    );
    backgroundRows.set(groupId, backgrounds.length ? 1 : 0);
    for (const it of backgrounds) {
      const label = items.find((candidate) => candidate.id === backgroundLabelId(it.id));
      const stack = rowOf.get(it.id) ?? 0;
      if (label) {
        label.subgroup = 0;
        const extent = firstVisibleLabelExtent(it, backgrounds, rowOf);
        if (extent) {
          label.start = extent.start;
          label.end = extent.end;
        } else {
          // A phase completely covered by higher layers has no visible header
          // segment. Keep the full-height tint selectable instead of painting a
          // title through the phase above it.
          label.start = undefined;
          label.end = undefined;
        }
      }
      it.style = withBackgroundStack(it.style, stack);
      if (label) label.style = withBackgroundStack(label.style, stack);
    }
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      group.style = laneCountStyle(1);
      group.subgroupOrder = 'subgroup';
    }
  }

  const byGroup = new Map<string, TimelineItem[]>();
  for (const it of items) {
    // Background items (phase tints) span the full group height and are not
    // laned; everything else gets a subgroup so nothing overlaps under
    // `stack: false`. Start-less items never reach the timeline DataSet, so
    // they get no lane (their NaN start would corrupt the packing math).
    if (!it.group || it.type === 'background' || isBackgroundLabel(it) || !it.start) continue;
    let bucket = byGroup.get(it.group);
    if (!bucket) byGroup.set(it.group, (bucket = []));
    bucket.push(it);
  }

  for (const [groupId, groupItems] of byGroup) {
    const ids = new Set(groupItems.map((i) => i.id));
    // A folded parent's children are absent from `groupItems`, but the parent
    // must keep its structural band. Otherwise it falls back into ordinary
    // compact packing and unrelated items jump from above to below it (or back)
    // whenever the subtree is toggled.
    const structuralParents = new Set(parents.values());

    // Intra-track hierarchy only, for the same reason the dependency edges below
    // are intra-track: a parent living in another group has no row here, so
    // banding under it would push the child out of its own track.
    const localParents = new Map<string, string>();
    for (const it of groupItems) {
      const p = parents.get(it.id);
      if (p && ids.has(p)) localParents.set(it.id, p);
    }
    // The lane each item sat in before this pass, read off the items themselves
    // (`subgroup` is only overwritten further down, after packing). Feeding it back
    // in is what keeps a re-pack from moving items that did not have to move.
    const headerRows = backgroundRows.get(groupId) ?? 0;
    const prevLane = (it: TimelineItem) => it.subgroup == null ? undefined : Math.max(0, it.subgroup - headerRows);

    const laneOf = new Map<string, number>();
    let base = 0;
    for (const band of hierarchyBands(groupItems, localParents, structuralParents)) {
      if (band.length) base += packTrackBand(band, dependencies, base, laneOf, startMs, endMs, prevLane);
    }

    // Numeric lane ids so vis-timeline's `subgroupOrder` (numeric `a - b` sort)
    // keeps lanes in the computed top-to-bottom order (lane 0 = top).
    for (const it of groupItems) {
      it.subgroup = headerRows + (laneOf.get(it.id) ?? 0);
    }
    const g = groups.find((x) => x.id === groupId);
    if (g) {
      g.subgroupOrder = 'subgroup';
      // `base` is the number of lanes the track ended up using. Publishing it lets
      // the label reserve the room, which is what keeps the track's height
      // independent of the current time window (see LANE_COUNT_PROPERTY).
      g.style = laneCountStyle(base + headerRows);
    }
  }
}

// Lay one band of a track out from lane `base` down, honouring the dependency
// edges *inside* the band, and return how many lanes it used. Edges leaving the
// band are ignored: the bands are already ordered (by hierarchy depth), so an
// edge across them is satisfied by that ordering, and layering on it again would
// only push items further down for no gain.
function packTrackBand(
  band: TimelineItem[],
  dependencies: Map<string, string[]>,
  base: number,
  laneOf: Map<string, number>,
  startMs: (it: TimelineItem) => number,
  endMs: (it: TimelineItem) => number,
  prevLane?: (it: TimelineItem) => number | undefined,
): number {
  const ids = new Set(band.map((i) => i.id));
  const preds = new Map<string, string[]>();
  const connected = new Set<string>();
  for (const it of band) {
    const ps = (dependencies.get(it.id) ?? []).filter((d) => ids.has(d) && d !== it.id);
    preds.set(it.id, ps);
    if (ps.length) {
      connected.add(it.id);
      for (const p of ps) connected.add(p);
    }
  }

  if (connected.size === 0) {
    // No internal dependencies: plain compact packing.
    return packBand(band, base, laneOf, startMs, endMs, prevLane);
  }

  // Longest-path layer per connected item (with a cycle guard so a malformed
  // dependsOn loop can't recurse forever).
  const layer = new Map<string, number>();
  const inStack = new Set<string>();
  const computeLayer = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (inStack.has(id)) return 0; // back-edge: break the cycle
    inStack.add(id);
    let best = 0;
    for (const p of preds.get(id) ?? []) best = Math.max(best, computeLayer(p) + 1);
    inStack.delete(id);
    layer.set(id, best);
    return best;
  };
  for (const id of connected) computeLayer(id);
  const maxLayer = Math.max(...[...connected].map((id) => layer.get(id) ?? 0));

  // Connected items as layer bands (top = layer 0); banding by layer guarantees
  // every edge points from a lower lane index to a higher one (i.e. downward).
  // Free items packed into a block below.
  let used = 0;
  for (let L = 0; L <= maxLayer; L++) {
    const layerBand = band.filter((it) => connected.has(it.id) && layer.get(it.id) === L);
    if (layerBand.length) used += packBand(layerBand, base + used, laneOf, startMs, endMs, prevLane);
  }
  const free = band.filter((it) => !connected.has(it.id));
  if (free.length) used += packBand(free, base + used, laneOf, startMs, endMs, prevLane);
  return used;
}

function extractDependsOn(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const v = (meta as Record<string, unknown>).dependsOn;
  if (Array.isArray(v)) return v.map(String).filter((s) => s.length > 0);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

export function buildFromJson(view: View, file: TimelineFile): BuildResult {
  const items: TimelineItem[] = [];
  const groupSet = new Map<string, TimelineGroup>();
  const details = new Map<string, DetailNote>();
  const dependencies = new Map<string, string[]>();
  const rawParents = new Map<string, string>();

  for (const declared of file.groups ?? []) {
    const g: TimelineGroup = {
      id: declared.id,
      content: escapeHtml(declared.content),
      label: declared.content,
    };
    if (typeof declared.color === 'string' && declared.color.trim()) g.color = declared.color.trim();
    if (declared.nestedGroups && declared.nestedGroups.length > 0) g.nestedGroups = [...declared.nestedGroups];
    if (typeof declared.showNested === 'boolean') g.showNested = declared.showNested;
    groupSet.set(declared.id, g);
  }

  let auto = 0;
  for (const raw of file.items) {
    // A start-less item is kept (it shows in the list view); only `content` is
    // required. The timeline DataSet filters out start-less items separately
    // (they can't be placed) — see `filterBuildForDisplay` callers in render.ts.
    if (!raw.content) continue;
    const id = raw.id || `__auto_${auto++}`;
    const deps = extractDependsOn(raw.metadata);
    if (deps.length) dependencies.set(id, deps);
    const parentId = readParentId(raw.metadata);
    if (parentId) rawParents.set(id, parentId);

    let endIso: string | undefined = raw.type === 'point' ? undefined : raw.end;
    if (!endIso && raw.type !== 'point' && raw.start) {
      const ms = durationToMs(raw.duration);
      if (ms && ms > 0) {
        endIso = endFromDuration(raw.start, ms) ?? endIso;
      }
    }

    const groupId = raw.group ?? UNGROUPED;
    if (!groupSet.has(groupId)) {
      groupSet.set(groupId, {
        id: groupId,
        content: groupId === UNGROUPED ? '—' : escapeHtml(groupId),
        label: groupId === UNGROUPED ? '—' : groupId,
      });
    }

    items.push({
      id,
      group: groupId,
      start: raw.start,
      end: endIso,
      content: escapeHtml(raw.content),
      label: raw.content ?? '',
      type: raw.type ?? (endIso ? 'range' : 'point'),
      icon: normalizeIcon(raw.icon),
      status: normalizeStatus(raw.status),
      tags: readTags(raw.metadata),
    });
    details.set(id, detailFromJsonItem({ ...raw, id }));
  }

  const hasGroupBy = view.groupBy || file.items.some((i) => i.group);
  const groups = hasGroupBy
    ? orderGroups(
        [...groupSet.values()],
        (file.groups ?? []).map((g) => g.id),
        file.groupOrder,
        UNGROUPED,
      )
    : [];

  // Resolved against the ids that survived the loop above, so a link to an item
  // that was dropped (no `content`) or deleted goes with it instead of leaving a
  // child parented to nothing.
  const parents = resolveParents(rawParents, new Set(items.map((it) => it.id)));

  const phases = resolvePhases(file);
  items.push(...phaseBackgroundItems(phases));
  assignLaneSubgroups(items, groups, dependencies, parents);
  assignLanes(items, groups);
  return { items, groups, details, dependencies, parents, phases };
}

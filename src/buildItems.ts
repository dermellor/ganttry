import type { TimelineFile, TimelineFileItem, View } from './types';
import { normalizeIcon } from './icons';
import { isOverdue, normalizeStatus } from './status';
import type { StatusKey } from './status';
import { durationToMs } from './date';
import { hierarchyDepth, readParentId, resolveParents } from './itemHierarchy';

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
  content: string;
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
  content: string;
  className?: string;
  nestedGroups?: string[];
  showNested?: boolean;
  subgroupOrder?: string;
  subgroupStack?: boolean;
};

const LANE_COUNT = 6;

function laneClass(index: number): string {
  return `lane-${index % LANE_COUNT}`;
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
    if (cls) item.className = cls;
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
 * children, plus `is-collapsed` while its subtree is folded away. Runs alongside
 * `withStatusMarks` and for the same reason — `assignLanes` owns `className` and
 * rewrites it on every regroup, so a display concern may only be appended on the
 * way into the DataSet, never inside a build.
 *
 * Being a child gets no class: the lane it sits in already says so, and a mark
 * that repeats what the layout shows is one more thing to keep in step.
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
    if (!hasChildren.has(id)) return it;
    const marks = collapsed.has(id) ? 'item-summary is-collapsed' : 'item-summary';
    return { ...it, className: `${it.className ? `${it.className} ` : ''}${marks}` };
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
  return tags
    .map(
      (tag) =>
        // `title` keeps the tag name reachable on hover even when the pill
        // collapses to a bare dot in the dense (zoomed-out) view.
        `<span class="item-tag" style="background-color:${tagColor(tag)}" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`,
    )
    .join('');
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
): number {
  const laneEnds: number[] = [];
  const ordered = [...band].sort((a, b) => startMs(a) - startMs(b) || endMs(a) - endMs(b));
  for (const it of ordered) {
    const s = startMs(it);
    let chosen = -1;
    let chosenEnd = -Infinity;
    for (let li = 0; li < laneEnds.length; li++) {
      if (laneEnds[li] <= s && laneEnds[li] > chosenEnd) {
        chosen = li;
        chosenEnd = laneEnds[li];
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
//   • A track carrying parent/child items is split into bands by hierarchy depth
//     first: every parent sits above all of its children, which is what makes a
//     summary bar read as one. Depth wins over the dependency staircase below
//     because a child is *contained* by its parent, while a successor is merely
//     after its predecessor — reversing the two would let a chain of children
//     climb above the bar that summarizes them.
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

  const byGroup = new Map<string, TimelineItem[]>();
  for (const it of items) {
    // Background items (phase tints) span the full group height and are not
    // laned; everything else gets a subgroup so nothing overlaps under
    // `stack: false`. Start-less items never reach the timeline DataSet, so
    // they get no lane (their NaN start would corrupt the packing math).
    if (!it.group || it.type === 'background' || !it.start) continue;
    let bucket = byGroup.get(it.group);
    if (!bucket) byGroup.set(it.group, (bucket = []));
    bucket.push(it);
  }

  for (const [groupId, groupItems] of byGroup) {
    const ids = new Set(groupItems.map((i) => i.id));

    // Intra-track hierarchy only, for the same reason the dependency edges below
    // are intra-track: a parent living in another group has no row here, so
    // banding under it would push the child out of its own track.
    const localParents = new Map<string, string>();
    for (const it of groupItems) {
      const p = parents.get(it.id);
      if (p && ids.has(p)) localParents.set(it.id, p);
    }
    const depth = hierarchyDepth(localParents);
    const maxDepth = groupItems.reduce((m, it) => Math.max(m, depth.get(it.id) ?? 0), 0);

    const laneOf = new Map<string, number>();
    let base = 0;
    for (let d = 0; d <= maxDepth; d++) {
      const band = maxDepth === 0 ? groupItems : groupItems.filter((it) => (depth.get(it.id) ?? 0) === d);
      if (band.length) base += packTrackBand(band, dependencies, base, laneOf, startMs, endMs);
    }

    // Numeric lane ids so vis-timeline's `subgroupOrder` (numeric `a - b` sort)
    // keeps lanes in the computed top-to-bottom order (lane 0 = top).
    for (const it of groupItems) {
      it.subgroup = laneOf.get(it.id) ?? 0;
    }
    const g = groups.find((x) => x.id === groupId);
    if (g) g.subgroupOrder = 'subgroup';
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
    return packBand(band, base, laneOf, startMs, endMs);
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
    if (layerBand.length) used += packBand(layerBand, base + used, laneOf, startMs, endMs);
  }
  const free = band.filter((it) => !connected.has(it.id));
  if (free.length) used += packBand(free, base + used, laneOf, startMs, endMs);
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
    const g: TimelineGroup = { id: declared.id, content: escapeHtml(declared.content) };
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
      });
    }

    items.push({
      id,
      group: groupId,
      start: raw.start,
      end: endIso,
      content: escapeHtml(raw.content),
      type: raw.type ?? (endIso ? 'range' : 'point'),
      icon: normalizeIcon(raw.icon),
      status: normalizeStatus(raw.status),
      tags: readTags(raw.metadata),
    });
    details.set(id, detailFromJsonItem({ ...raw, id }));
  }

  const hasGroupBy = view.groupBy || file.items.some((i) => i.group);
  const groups = hasGroupBy
    ? [...groupSet.values()].sort((a, b) => {
        if (a.id === UNGROUPED) return 1;
        if (b.id === UNGROUPED) return -1;
        return a.id.localeCompare(b.id, 'de');
      })
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


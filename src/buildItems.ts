import type { Config, FilterClause, Note, TimelineFile, TimelineFileItem, View } from './types';
import { matches, resolveGroupBy } from './filter';
import { normalizeIcon } from './icons';
import { normalizeStatus } from './status';
import type { StatusKey } from './status';

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
  title: string;
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

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;

export function durationToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const m = s.match(DURATION_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const map: Record<string, number> = {
    ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000,
    d: 86400000, day: 86400000, w: 604800000, wk: 604800000,
    mo: 2592000000, month: 2592000000, y: 31536000000, year: 31536000000,
  };
  return n * (map[unit] ?? 0) || null;
}

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

export function pickStartForView(
  note: Note,
  view: View,
  fallbackFields: string[],
): { iso: string; field: string } | null {
  const fields = view.dateFields ?? fallbackFields;
  for (const f of fields) {
    const v = (note.frontmatter as Record<string, unknown>)[f];
    if (v == null || v === '') continue;
    const date =
      v instanceof Date
        ? v
        : new Date(typeof v === 'string' && v.length === 10 ? `${v}T00:00:00` : String(v));
    if (!isNaN(date.getTime())) return { iso: date.toISOString(), field: f };
  }
  if (note.start) return { iso: note.start, field: note.dateSource ?? '__filename__' };
  return null;
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

export function detailFromNote(note: Note, dateField: string, startIso: string): DetailNote {
  return {
    id: note.id,
    title: note.title,
    start: startIso,
    end: note.end,
    dateSource: dateField,
    folder: note.folder,
    filename: note.filename,
    frontmatter: note.frontmatter,
    body: note.body,
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
//   • Tracks WITH an internal dependency graph get a "staircase": connected
//     items are placed in topological layers (longest-path depth) so every
//     predecessor sits on a lane strictly above its successors and all
//     dependency arrows flow downward; free items are packed into a block below.
//   • Tracks WITHOUT internal dependencies just get a compact greedy packing —
//     visually identical to what vis's own stacking produced before.
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
  const endMs = (it: TimelineItem) => {
    if (it.type === 'point' && opts && opts.pxPerDay > 0 && Number.isFinite(opts.pxPerDay)) {
      return startMs(it) + (opts.pointLabelPx(it) / opts.pxPerDay) * LANE_DAY_MS;
    }
    return new Date(it.end ?? it.start!).getTime();
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

    // Intra-group edges only (cross-group deps are ignored — they'd force items
    // out of their track).
    const preds = new Map<string, string[]>();
    const connected = new Set<string>();
    for (const it of groupItems) {
      const ps = (dependencies.get(it.id) ?? []).filter((d) => ids.has(d) && d !== it.id);
      preds.set(it.id, ps);
      if (ps.length) {
        connected.add(it.id);
        for (const p of ps) connected.add(p);
      }
    }

    const laneOf = new Map<string, number>();
    let base = 0;

    if (connected.size > 0) {
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

      // Connected items as layer bands (top = layer 0); banding by layer
      // guarantees every edge points from a lower lane index to a higher one
      // (i.e. downward). Free items packed into a block below.
      for (let L = 0; L <= maxLayer; L++) {
        const band = groupItems.filter((it) => connected.has(it.id) && layer.get(it.id) === L);
        if (band.length) base += packBand(band, base, laneOf, startMs, endMs);
      }
      const free = groupItems.filter((it) => !connected.has(it.id));
      if (free.length) base += packBand(free, base, laneOf, startMs, endMs);
    } else {
      // No internal dependencies: plain compact packing.
      base += packBand(groupItems, base, laneOf, startMs, endMs);
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
      title: raw.title ? escapeHtml(raw.title) : escapeHtml(raw.content),
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

  const phases = resolvePhases(file);
  items.push(...phaseBackgroundItems(phases));
  assignLaneSubgroups(items, groups, dependencies);
  assignLanes(items, groups);
  return { items, groups, details, dependencies, phases };
}

export function buildFromNotes(view: View, notes: Note[], cfg: Config): BuildResult {
  const items: TimelineItem[] = [];
  const groupSet = new Map<string, TimelineGroup>();
  const details = new Map<string, DetailNote>();

  for (const note of notes) {
    if (!matches(note, view.filter as FilterClause)) continue;
    const start = pickStartForView(note, view, cfg.dateFields);
    if (!start) continue;

    const groupId = resolveGroupBy(note, view.groupBy) ?? UNGROUPED;
    if (!groupSet.has(groupId)) {
      groupSet.set(groupId, {
        id: groupId,
        content: groupId === UNGROUPED ? '—' : escapeHtml(groupId),
      });
    }

    const isRange = !!note.end && note.end !== start.iso;
    items.push({
      id: note.id,
      group: groupId,
      start: start.iso,
      end: isRange ? note.end! : undefined,
      content: escapeHtml(note.title),
      title: `${note.title}\n${start.field}: ${start.iso.slice(0, 10)}`,
      type: isRange ? 'range' : 'point',
    });
    details.set(note.id, detailFromNote(note, start.field, start.iso));
  }

  const groups = [...groupSet.values()].sort((a, b) => {
    if (a.id === UNGROUPED) return 1;
    if (b.id === UNGROUPED) return -1;
    return a.id.localeCompare(b.id, 'de');
  });

  assignLaneSubgroups(items, groups, new Map());
  assignLanes(items, groups);
  return { items, groups, details, dependencies: new Map(), phases: [] };
}

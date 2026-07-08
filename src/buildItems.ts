import type { Config, FilterClause, Note, TimelineFile, TimelineFileItem, View } from './types';
import { matches, resolveGroupBy } from './filter';
import { normalizeIcon } from './icons';

export const UNGROUPED = '_ungrouped';

export type TimelineItem = {
  id: string;
  group?: string;
  start: string;
  end?: string;
  content: string;
  title: string;
  type: 'point' | 'range' | 'background' | 'box';
  className?: string;
  style?: string;
  icon?: string;
  tags?: string[];
};

export type TimelineGroup = {
  id: string;
  content: string;
  className?: string;
  nestedGroups?: string[];
  showNested?: boolean;
};

const LANE_COUNT = 6;

function laneClass(index: number): string {
  return `lane-${index % LANE_COUNT}`;
}

function assignLanes(items: TimelineItem[], groups: TimelineGroup[]): void {
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
    start: raw.start,
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
        const startMs = new Date(p.start).getTime();
        if (!Number.isNaN(startMs)) end = new Date(startMs + ms).toISOString();
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
    if (!raw.start || !raw.content) continue;
    const id = raw.id || `__auto_${auto++}`;
    const deps = extractDependsOn(raw.metadata);
    if (deps.length) dependencies.set(id, deps);

    let endIso: string | undefined = raw.type === 'point' ? undefined : raw.end;
    if (!endIso && raw.type !== 'point') {
      const ms = durationToMs(raw.duration);
      if (ms && ms > 0) {
        const startMs = new Date(raw.start).getTime();
        if (!Number.isNaN(startMs)) endIso = new Date(startMs + ms).toISOString();
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

  assignLanes(items, groups);
  return { items, groups, details, dependencies: new Map(), phases: [] };
}

// How the display state of a timeline is stored: per timeline, not per instance.
//
// Presentation, grouping dimension, value filter and the milestones-only
// narrowing all describe how *one* timeline is being looked at, yet each of them
// used to be a single `localStorage` key for the whole instance. Switching
// timelines therefore carried a filter into a timeline it was never meant for,
// and the code paid for it after the fact: a stored dimension that no longer
// exists turns the filter off, a stored grouping falls back to `group`, a stored
// plugin mode gets kicked back to the timeline. Those guards still earn their
// place for a timeline whose own fields changed; they were never a fix for
// somebody else's filter.
//
// The shape follows `COLLAPSED_ITEMS_KEY` in state.ts, which already solved this
// for folded items: one key holding `{ [viewId]: … }`, an absent or malformed
// entry reading as „nothing stored". Two per-timeline stores with two different
// shapes is how one of them ends up with the fix and the other does not.
//
// This module stays free of the DOM and of the plugin registry, so the migration
// and the parsing are unit-testable. The stored `mode` is handed on as a plain
// string: turning it into a `ViewMode` needs the registry's legacy lookup, and
// that decision stays at the one call site that already makes it.

import { filterSelectionFromPair, isFilterSelectionActive, type FilterSelection } from './filterRule';
import { GROUP_DIM, TYPE_DIM } from './listGrouping';
import { DEFAULT_EDGE_DIRECTION, sanitizeEdgeSelection, type EdgeSelection } from './linkEdges';

/** What one presentation of one timeline remembers. */
export type StoredPresentationPrefs = {
  groupBy?: string;
  /** Selected values per filter dimension. */
  filters?: FilterSelection;
};

/** What one timeline remembers, as it sits in storage. */
export type StoredViewPrefs = {
  /** A `ViewMode`, unparsed: see the module comment. */
  mode?: string;
  /**
   * Perspective and extent, per presentation, keyed by its addressable mode.
   *
   * One entry per timeline was a scope too coarse: lanes and list sections are
   * different mechanisms, so „group by Gruppe on the timeline, by Status in the
   * list" is an ordinary wish that setting one value cannot express. A plugin view
   * would also have inherited whatever the item list happened to use, which for a
   * view over other data means nothing.
   */
  presentations?: Record<string, StoredPresentationPrefs>;
  /**
   * The timeline-wide values `presentations` replaced. Read as the **fallback** for
   * any presentation without an entry of its own, never written. Copying them into
   * one entry per mode instead would mean guessing which presentations exist, and a
   * plugin's views are not knowable while migrating.
   */
  groupBy?: string;
  filters?: FilterSelection;
  /**
   * The shape `filters` replaced: one dimension plus its values. Still read,
   * never written. It sits in the stored state of everybody who used the
   * single-dimension filter, and ignoring it clears their saved narrowing.
   */
  filterDim?: string;
  filterValues?: string[];
  /**
   * „Nur Meilensteine", when it was a control of its own. Also read-only now: it
   * is the type dimension of `filters`, so a stored `true` is folded into that
   * selection and never written again.
   */
  milestonesOnly?: boolean;
  /**
   * Which recorded link fields become edges, and which way they point.
   *
   * At the timeline level rather than per presentation, unlike grouping and the
   * filter: those describe how one presentation bundles and narrows, while this
   * decides which relations *exist* at all. The Gantt arrows and the graph read
   * one dependency map, so a per-presentation answer would let the two disagree
   * about what depends on what — which reads as a bug in one of them rather than
   * as a setting.
   */
  edges?: EdgeSelection;
};

/** Perspective and extent resolved for one presentation. */
export type PresentationPrefs = {
  groupBy: string;
  filters: FilterSelection;
};

/** What the app works with: which presentation, and its own two settings. */
export type ViewPrefs = PresentationPrefs & { mode: string };

export type ViewPrefsStore = Record<string, StoredViewPrefs>;

/** The per-timeline store. */
export const VIEW_PREFS_KEY = 'timelines.viewPrefs';

/**
 * The instance-wide keys this replaces. Read once, to seed the first timeline
 * opened after the update, then removed: renaming a `timelines.*` key without
 * reading the old one silently resets every user's saved view, grouping and
 * filter (see „The name covers the product…" in AGENTS.md).
 */
export const LEGACY_PREF_KEYS = {
  mode: 'timelines.viewMode',
  groupBy: 'timelines.listGroupBy',
  filterDim: 'timelines.filterDim',
  filterValues: 'timelines.filterValues',
  milestonesOnly: 'timelines.milestonesOnly',
} as const;

/** The state of a timeline nobody has looked at yet. */
export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  mode: 'timeline',
  groupBy: GROUP_DIM,
  filters: {},
};

/** What „nur Meilensteine" means now: the type dimension narrowed to `point`. */
export const MILESTONES_ONLY_SELECTION: FilterSelection = { [TYPE_DIM]: ['point'] };

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === 'string');
}

/** A selection with every entry copied, so no caller shares an array with the store. */
function copySelection(filters: FilterSelection): FilterSelection {
  const out: FilterSelection = {};
  for (const [dim, values] of Object.entries(filters)) {
    if (values.length) out[dim] = [...values];
  }
  return out;
}

function selection(raw: unknown): FilterSelection | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: FilterSelection = {};
  for (const [dim, values] of Object.entries(raw as Record<string, unknown>)) {
    const list = stringList(values);
    if (dim && list?.length) out[dim] = list;
  }
  return out;
}

function presentationMap(raw: unknown): Record<string, StoredPresentationPrefs> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, StoredPresentationPrefs> = {};
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!mode || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const entry: StoredPresentationPrefs = {};
    if (typeof rec.groupBy === 'string') entry.groupBy = rec.groupBy;
    const filters = selection(rec.filters);
    if (filters && Object.keys(filters).length) entry.filters = filters;
    if (Object.keys(entry).length) out[mode] = entry;
  }
  return out;
}

/**
 * Keep only well-typed fields. A stored value of the wrong type reads as absent
 * rather than throwing: a display preference must never keep a timeline from
 * rendering.
 */
function sanitize(raw: unknown): StoredViewPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const out: StoredViewPrefs = {};
  if (typeof rec.mode === 'string') out.mode = rec.mode;
  const presentations = presentationMap(rec.presentations);
  if (presentations) out.presentations = presentations;
  if (typeof rec.groupBy === 'string') out.groupBy = rec.groupBy;
  const filters = selection(rec.filters);
  if (filters) out.filters = filters;
  if (typeof rec.filterDim === 'string') out.filterDim = rec.filterDim;
  const values = stringList(rec.filterValues);
  if (values) out.filterValues = values;
  if (typeof rec.milestonesOnly === 'boolean') out.milestonesOnly = rec.milestonesOnly;
  const edges = sanitizeEdgeSelection(rec.edges);
  if (Object.keys(edges).length) out.edges = edges;
  return out;
}

/** Parse the whole store. Malformed JSON reads as „nothing stored". */
export function parseViewPrefsStore(raw: string | null | undefined): ViewPrefsStore {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: ViewPrefsStore = {};
  for (const [viewId, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[viewId] = sanitize(value);
  }
  return out;
}

/**
 * The selection a stored entry carries: the current shape when it has one, the
 * single-dimension pair otherwise. `filters` wins, so a re-saved entry stops
 * consulting the old pair without it having to be deleted.
 */
function storedSelection(stored: StoredViewPrefs | undefined): FilterSelection {
  if (!stored) return {};
  const base = stored.filters
    ? copySelection(stored.filters)
    : filterSelectionFromPair(stored.filterDim, stored.filterValues);
  // „Nur Meilensteine" was a second narrowing beside the filter and composed with
  // it, so a stored `true` adds the type dimension rather than replacing what is
  // there. An explicit type selection wins: it is the newer statement about the
  // same dimension.
  if (stored.milestonesOnly && !base[TYPE_DIM]?.length) {
    return { ...base, ...MILESTONES_ONLY_SELECTION };
  }
  return base;
}

/** Which presentation a timeline was last looked at in. */
export function storedMode(store: ViewPrefsStore, viewId: string | null | undefined): string {
  const stored = viewId ? store[viewId] : undefined;
  return stored?.mode ?? DEFAULT_VIEW_PREFS.mode;
}

/** Which link fields a timeline draws edges from. Empty means „every field, incoming". */
export function storedEdges(store: ViewPrefsStore, viewId: string | null | undefined): EdgeSelection {
  const stored = viewId ? store[viewId] : undefined;
  return { ...(stored?.edges ?? {}) };
}

/**
 * The store with `viewId`'s edge selection replaced. Separate from `withViewPrefs`
 * because the two are saved by different controls at different moments, and
 * folding this into that one would make every grouping change rewrite the edges.
 */
export function withEdgeSelection(
  store: ViewPrefsStore,
  viewId: string,
  edges: EdgeSelection,
): ViewPrefsStore {
  const next: ViewPrefsStore = { ...store };
  const entry: StoredViewPrefs = { ...store[viewId] };
  // Only what deviates is written, and a selection back at the default drops the
  // key: the same reason the presentation entry is deleted rather than stored
  // empty, otherwise the store grows a key per timeline anybody ever opened.
  const kept: EdgeSelection = {};
  for (const [field, dir] of Object.entries(edges)) {
    if (dir !== DEFAULT_EDGE_DIRECTION) kept[field] = dir;
  }
  if (Object.keys(kept).length) entry.edges = kept;
  else delete entry.edges;
  if (!Object.keys(entry).length) {
    delete next[viewId];
    return next;
  }
  next[viewId] = entry;
  return next;
}

/**
 * Perspective and extent for one presentation: its own entry, else the timeline's
 * legacy values, else the defaults.
 *
 * The fallback is what keeps the change from resetting anybody: a timeline saved
 * before this had one grouping and one filter for all of its presentations, and
 * every presentation that has not been touched since still reads them.
 */
export function presentationPrefsFor(
  store: ViewPrefsStore,
  viewId: string | null | undefined,
  mode: string,
): PresentationPrefs {
  const stored = viewId ? store[viewId] : undefined;
  const own = stored?.presentations?.[mode];
  return {
    groupBy: own?.groupBy ?? stored?.groupBy ?? DEFAULT_VIEW_PREFS.groupBy,
    filters: own
      ? copySelection(own.filters ?? {})
      : storedSelection(stored),
  };
}

/** What `viewId` remembers: its presentation, and that presentation's own settings. */
export function viewPrefsFor(
  store: ViewPrefsStore,
  viewId: string | null | undefined,
  mode?: string,
): ViewPrefs {
  const active = mode ?? storedMode(store, viewId);
  return { mode: active, ...presentationPrefsFor(store, viewId, active) };
}

function isDefaultPresentation(prefs: PresentationPrefs): boolean {
  return prefs.groupBy === DEFAULT_VIEW_PREFS.groupBy && !isFilterSelectionActive(prefs.filters);
}

/**
 * The store with `viewId`'s state replaced. Only what differs from the default
 * is written, and a timeline back at its default loses its entry entirely — the
 * same reason `toggleItemCollapsed` deletes instead of storing an empty list:
 * otherwise the store grows a key per timeline anybody ever opened.
 *
 * The legacy `filterDim` / `filterValues` pair and `milestonesOnly` are never
 * written back, so a timeline that has been saved once carries only the current
 * shape.
 */
export function withViewPrefs(
  store: ViewPrefsStore,
  viewId: string,
  prefs: ViewPrefs,
): ViewPrefsStore {
  const next: ViewPrefsStore = { ...store };
  const previous = store[viewId];

  // Every other presentation's entry is carried over untouched: a save is about the
  // one that is on screen, and rewriting the map would erase the grouping somebody
  // set in a presentation they are not in.
  const presentations: Record<string, StoredPresentationPrefs> = { ...previous?.presentations };
  if (isDefaultPresentation(prefs)) delete presentations[prefs.mode];
  else {
    const own: StoredPresentationPrefs = {};
    if (prefs.groupBy !== DEFAULT_VIEW_PREFS.groupBy) own.groupBy = prefs.groupBy;
    if (isFilterSelectionActive(prefs.filters)) own.filters = copySelection(prefs.filters);
    presentations[prefs.mode] = own;
  }

  const entry: StoredViewPrefs = {};
  if (prefs.mode !== DEFAULT_VIEW_PREFS.mode) entry.mode = prefs.mode;
  if (Object.keys(presentations).length) entry.presentations = presentations;
  // The legacy fallback is kept as long as some presentation still relies on it,
  // which is any presentation without an entry of its own. Dropping it on the first
  // save would silently reset the ones nobody has visited yet.
  if (previous?.groupBy != null) entry.groupBy = previous.groupBy;
  if (previous?.filters) entry.filters = copySelection(previous.filters);
  if (previous?.filterDim != null) entry.filterDim = previous.filterDim;
  if (previous?.filterValues) entry.filterValues = [...previous.filterValues];
  if (previous?.milestonesOnly) entry.milestonesOnly = true;
  // Carried over rather than rebuilt: the edge selection belongs to the timeline
  // and has a save of its own, so a grouping change must not clear it.
  if (previous?.edges) entry.edges = { ...previous.edges };

  if (!Object.keys(entry).length) {
    delete next[viewId];
    return next;
  }
  next[viewId] = entry;
  return next;
}

/**
 * Seed a timeline's **fallback layer** from the instance-wide keys.
 *
 * Not through `withViewPrefs`: that writes one presentation's entry, and these
 * values were never about a presentation — they applied to everything. Written as
 * the fallback, every presentation of that timeline inherits them until it is given
 * settings of its own, which is exactly what „carry the old state over" means.
 */
export function withLegacyFallback(
  store: ViewPrefsStore,
  viewId: string,
  legacy: Partial<ViewPrefs>,
): ViewPrefsStore {
  const entry: StoredViewPrefs = { ...store[viewId] };
  if (legacy.mode && legacy.mode !== DEFAULT_VIEW_PREFS.mode) entry.mode = legacy.mode;
  if (legacy.groupBy && legacy.groupBy !== DEFAULT_VIEW_PREFS.groupBy) entry.groupBy = legacy.groupBy;
  if (legacy.filters && isFilterSelectionActive(legacy.filters)) {
    entry.filters = copySelection(legacy.filters);
  }
  if (!Object.keys(entry).length) return store;
  return { ...store, [viewId]: entry };
}

/**
 * The state left behind by the instance-wide keys, or null when none of them is
 * set. `null` and „all of them at their default" are deliberately the same
 * answer: both mean there is nothing to carry over.
 */
export function legacyViewPrefs(
  get: (key: string) => string | null,
): Partial<ViewPrefs> | null {
  const raw = {
    mode: get(LEGACY_PREF_KEYS.mode),
    groupBy: get(LEGACY_PREF_KEYS.groupBy),
    filterDim: get(LEGACY_PREF_KEYS.filterDim),
    filterValues: get(LEGACY_PREF_KEYS.filterValues),
    milestonesOnly: get(LEGACY_PREF_KEYS.milestonesOnly),
  };
  if (Object.values(raw).every((v) => v == null)) return null;

  const prefs: Partial<ViewPrefs> = {};
  if (raw.mode) prefs.mode = raw.mode;
  if (raw.groupBy) prefs.groupBy = raw.groupBy;
  if (raw.filterDim && raw.filterValues) {
    try {
      const values = stringList(JSON.parse(raw.filterValues));
      const filters = filterSelectionFromPair(raw.filterDim, values);
      if (isFilterSelectionActive(filters)) prefs.filters = filters;
    } catch {
      // A malformed list carries over as „no selection", which is what an empty
      // selection already means: no restriction.
    }
  }
  // Same fold as a stored per-timeline `milestonesOnly`: the type dimension joins
  // whatever the filter already narrowed, because the two used to compose.
  if (raw.milestonesOnly === 'true' && !prefs.filters?.[TYPE_DIM]?.length) {
    prefs.filters = { ...(prefs.filters ?? {}), ...MILESTONES_ONLY_SELECTION };
  }
  return Object.keys(prefs).length ? prefs : null;
}

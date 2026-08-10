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
import { GROUP_DIM } from './listGrouping';

/** What one timeline remembers, as it sits in storage. */
export type StoredViewPrefs = {
  /** A `ViewMode`, unparsed: see the module comment. */
  mode?: string;
  groupBy?: string;
  /** Selected values per filter dimension. */
  filters?: FilterSelection;
  /**
   * The shape `filters` replaced: one dimension plus its values. Still read,
   * never written. It sits in the stored state of everybody who used the
   * single-dimension filter, and ignoring it clears their saved narrowing.
   */
  filterDim?: string;
  filterValues?: string[];
  milestonesOnly?: boolean;
};

/** The same thing resolved, which is what the app works with. */
export type ViewPrefs = {
  mode: string;
  groupBy: string;
  filters: FilterSelection;
  milestonesOnly: boolean;
};

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
  milestonesOnly: false,
};

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
  if (typeof rec.groupBy === 'string') out.groupBy = rec.groupBy;
  const filters = selection(rec.filters);
  if (filters) out.filters = filters;
  if (typeof rec.filterDim === 'string') out.filterDim = rec.filterDim;
  const values = stringList(rec.filterValues);
  if (values) out.filterValues = values;
  if (typeof rec.milestonesOnly === 'boolean') out.milestonesOnly = rec.milestonesOnly;
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
  if (stored.filters) return copySelection(stored.filters);
  return filterSelectionFromPair(stored.filterDim, stored.filterValues);
}

/** What `viewId` remembers, filled up with the defaults. */
export function viewPrefsFor(
  store: ViewPrefsStore,
  viewId: string | null | undefined,
): ViewPrefs {
  const stored = viewId ? store[viewId] : undefined;
  return {
    mode: stored?.mode ?? DEFAULT_VIEW_PREFS.mode,
    groupBy: stored?.groupBy ?? DEFAULT_VIEW_PREFS.groupBy,
    filters: storedSelection(stored),
    milestonesOnly: stored?.milestonesOnly ?? DEFAULT_VIEW_PREFS.milestonesOnly,
  };
}

function isDefault(prefs: ViewPrefs): boolean {
  return (
    prefs.mode === DEFAULT_VIEW_PREFS.mode &&
    prefs.groupBy === DEFAULT_VIEW_PREFS.groupBy &&
    !isFilterSelectionActive(prefs.filters) &&
    prefs.milestonesOnly === DEFAULT_VIEW_PREFS.milestonesOnly
  );
}

/**
 * The store with `viewId`'s state replaced. Only what differs from the default
 * is written, and a timeline back at its default loses its entry entirely — the
 * same reason `toggleItemCollapsed` deletes instead of storing an empty list:
 * otherwise the store grows a key per timeline anybody ever opened.
 *
 * The legacy `filterDim` / `filterValues` pair is never written back, so a
 * timeline that has been saved once carries only the current shape.
 */
export function withViewPrefs(
  store: ViewPrefsStore,
  viewId: string,
  prefs: ViewPrefs,
): ViewPrefsStore {
  const next: ViewPrefsStore = { ...store };
  if (isDefault(prefs)) {
    delete next[viewId];
    return next;
  }
  const entry: StoredViewPrefs = {};
  if (prefs.mode !== DEFAULT_VIEW_PREFS.mode) entry.mode = prefs.mode;
  if (prefs.groupBy !== DEFAULT_VIEW_PREFS.groupBy) entry.groupBy = prefs.groupBy;
  if (isFilterSelectionActive(prefs.filters)) entry.filters = copySelection(prefs.filters);
  if (prefs.milestonesOnly) entry.milestonesOnly = true;
  next[viewId] = entry;
  return next;
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
  if (raw.milestonesOnly === 'true') prefs.milestonesOnly = true;
  return Object.keys(prefs).length ? prefs : null;
}

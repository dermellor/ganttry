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

import { GROUP_DIM } from './listGrouping';

/** What one timeline remembers about the way it is displayed. */
export type StoredViewPrefs = {
  /** A `ViewMode`, unparsed: see the module comment. */
  mode?: string;
  groupBy?: string;
  filterDim?: string;
  filterValues?: string[];
  milestonesOnly?: boolean;
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
export const DEFAULT_VIEW_PREFS: Required<StoredViewPrefs> = {
  mode: 'timeline',
  groupBy: GROUP_DIM,
  filterDim: '',
  filterValues: [],
  milestonesOnly: false,
};

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === 'string');
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

/** What `viewId` remembers, filled up with the defaults. */
export function viewPrefsFor(
  store: ViewPrefsStore,
  viewId: string | null | undefined,
): Required<StoredViewPrefs> {
  const stored = viewId ? store[viewId] : undefined;
  return {
    ...DEFAULT_VIEW_PREFS,
    ...(stored ?? {}),
    // Spread copies the array reference, and the default one is shared: a caller
    // mutating it would edit every other timeline's default.
    filterValues: [...(stored?.filterValues ?? DEFAULT_VIEW_PREFS.filterValues)],
  };
}

function isDefault(prefs: Required<StoredViewPrefs>): boolean {
  return (
    prefs.mode === DEFAULT_VIEW_PREFS.mode &&
    prefs.groupBy === DEFAULT_VIEW_PREFS.groupBy &&
    prefs.filterDim === DEFAULT_VIEW_PREFS.filterDim &&
    prefs.filterValues.length === 0 &&
    prefs.milestonesOnly === DEFAULT_VIEW_PREFS.milestonesOnly
  );
}

/**
 * The store with `viewId`'s state replaced. Only what differs from the default
 * is written, and a timeline back at its default loses its entry entirely — the
 * same reason `toggleItemCollapsed` deletes instead of storing an empty list:
 * otherwise the store grows a key per timeline anybody ever opened.
 */
export function withViewPrefs(
  store: ViewPrefsStore,
  viewId: string,
  prefs: Required<StoredViewPrefs>,
): ViewPrefsStore {
  const next: ViewPrefsStore = { ...store };
  if (isDefault(prefs)) {
    delete next[viewId];
    return next;
  }
  const entry: StoredViewPrefs = {};
  if (prefs.mode !== DEFAULT_VIEW_PREFS.mode) entry.mode = prefs.mode;
  if (prefs.groupBy !== DEFAULT_VIEW_PREFS.groupBy) entry.groupBy = prefs.groupBy;
  if (prefs.filterDim !== DEFAULT_VIEW_PREFS.filterDim) entry.filterDim = prefs.filterDim;
  if (prefs.filterValues.length) entry.filterValues = [...prefs.filterValues];
  if (prefs.milestonesOnly) entry.milestonesOnly = true;
  next[viewId] = entry;
  return next;
}

/**
 * The state left behind by the instance-wide keys, or null when none of them is
 * set. `null` and „all five at their default" are deliberately the same answer:
 * both mean there is nothing to carry over.
 */
export function legacyViewPrefs(
  get: (key: string) => string | null,
): StoredViewPrefs | null {
  const raw = {
    mode: get(LEGACY_PREF_KEYS.mode),
    groupBy: get(LEGACY_PREF_KEYS.groupBy),
    filterDim: get(LEGACY_PREF_KEYS.filterDim),
    filterValues: get(LEGACY_PREF_KEYS.filterValues),
    milestonesOnly: get(LEGACY_PREF_KEYS.milestonesOnly),
  };
  if (Object.values(raw).every((v) => v == null)) return null;

  const prefs: StoredViewPrefs = {};
  if (raw.mode) prefs.mode = raw.mode;
  if (raw.groupBy) prefs.groupBy = raw.groupBy;
  if (raw.filterDim) prefs.filterDim = raw.filterDim;
  if (raw.filterValues) {
    try {
      const values = stringList(JSON.parse(raw.filterValues));
      if (values?.length) prefs.filterValues = values;
    } catch {
      // A malformed list carries over as „no selection", which is what an empty
      // selection already means: no restriction.
    }
  }
  if (raw.milestonesOnly === 'true') prefs.milestonesOnly = true;
  return Object.keys(prefs).length ? prefs : null;
}

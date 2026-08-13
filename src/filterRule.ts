// The value filter's rule: which items survive a selection.
//
// A selection is per dimension (`{ status: ['Open'], 'cf:tier': ['Free'] }`),
// combined with AND across dimensions and OR within one. It used to be a single
// dimension plus its values, and that shape could not express „only milestones and
// status Open", which is a narrowing the interface already offered through a
// second control beside the filter.
//
// DOM-free and state-free on purpose: `grouping.ts` supplies the app state and
// imports this, the same split `listGrouping.ts` has against it. The rule is what
// every consumer (timeline, list, export, status line) shares, so it is worth
// unit-testing without a browser.

import type { TimelineItem } from './buildItems';
import { bucketsFor, NO_BUCKET, TYPE_DIM, type SectionContext } from './listGrouping';

/** Selected bucket values per dimension key. */
export type FilterSelection = Record<string, string[]>;

/** What „nur Meilensteine" means now: the type dimension narrowed to `point`. */
export const MILESTONES_ONLY_SELECTION: FilterSelection = { [TYPE_DIM]: ['point'] };

/**
 * Fold a „nur Meilensteine" flag into a selection.
 *
 * „Nur Meilensteine" was a control of its own beside the filter and **composed**
 * with it, so it adds the type dimension rather than replacing what is there. An
 * explicit type selection wins: it is the newer statement about the same dimension.
 *
 * It lives here because three callers need exactly this rule — the stored
 * per-presentation state, the instance-wide keys it replaced, and now a link
 * carrying `m=1` — and a fourth copy is how one of them ends up composing and the
 * others overwriting.
 */
export function withMilestonesNarrowing(filters: FilterSelection): FilterSelection {
  if (filters[TYPE_DIM]?.length) return filters;
  return { ...filters, ...MILESTONES_ONLY_SELECTION };
}

/** The dimensions actually narrowing anything, in the selection's own order. */
export function activeFilterDims(filters: FilterSelection): string[] {
  return Object.keys(filters).filter((dim) => dim && filters[dim]?.length);
}

/** Is any dimension narrowing? An empty selection means „no restriction". */
export function isFilterSelectionActive(filters: FilterSelection): boolean {
  return activeFilterDims(filters).length > 0;
}

/** How many values are selected in total, for the toolbar's label. */
export function filterValueCount(filters: FilterSelection): number {
  return activeFilterDims(filters).reduce((n, dim) => n + filters[dim].length, 0);
}

/**
 * Does the item pass every narrowed dimension? An item with no value for a
 * dimension passes it only when the „Ohne …" bucket is selected there, which is
 * the same rule the single-dimension filter had, applied per dimension.
 */
export function passesFilters(
  item: TimelineItem,
  filters: FilterSelection,
  ctx: SectionContext,
): boolean {
  for (const dim of activeFilterDims(filters)) {
    const selected = filters[dim];
    const buckets = bucketsFor(item, dim, ctx);
    const ok = buckets.length === 0
      ? selected.includes(NO_BUCKET)
      : buckets.some((b) => selected.includes(b));
    if (!ok) return false;
  }
  return true;
}

/**
 * Drop what this timeline no longer has: a dimension that is gone (a custom field
 * was removed, the last tag went) and values that are no longer present in a
 * dimension that stayed. Returns the same object when nothing changed, so callers
 * can persist on identity rather than diffing.
 *
 * Per dimension, deliberately: one vanished dimension used to turn the whole
 * filter off, which with several of them would throw away narrowings that are
 * still perfectly valid.
 */
export function pruneFilters(
  filters: FilterSelection,
  availableDims: string[],
  valuesFor: (dim: string) => string[],
): FilterSelection {
  const available = new Set(availableDims);
  const next: FilterSelection = {};
  let changed = false;
  for (const dim of Object.keys(filters)) {
    const selected = filters[dim] ?? [];
    if (!available.has(dim)) {
      changed = true;
      continue;
    }
    const present = new Set(valuesFor(dim));
    const kept = selected.filter((v) => present.has(v));
    if (kept.length !== selected.length) changed = true;
    if (kept.length) next[dim] = kept;
    else if (selected.length) changed = true;
  }
  return changed ? next : filters;
}

/** Replace one dimension's selection, dropping the key when it ends up empty. */
export function withFilterValues(
  filters: FilterSelection,
  dim: string,
  values: string[],
): FilterSelection {
  const next: FilterSelection = { ...filters };
  if (values.length) next[dim] = [...values];
  else delete next[dim];
  return next;
}

/**
 * Read the shape that came before: one dimension plus its values. Kept because it
 * sits in every user's stored per-timeline state (see „Where the display state
 * lives" in docs/editing.md), and dropping it would clear every saved filter.
 */
export function filterSelectionFromPair(
  dim: string | undefined,
  values: string[] | undefined,
): FilterSelection {
  return dim && values?.length ? { [dim]: [...values] } : {};
}

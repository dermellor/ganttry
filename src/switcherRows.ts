// Which timelines the switcher shows, in which order, for a given search.
//
// The picker was a flat `<select>` over every discovered source: database
// timelines, JSON files and note directories unsorted in one list, with no origin
// and no search. On an instance with a few dozen timelines that is the first thing
// that breaks, and a `<select>` cannot be searched or grouped.
//
// DOM-free so the matching and the ordering are unit-testable — they are the part
// that decides whether somebody finds their timeline, and the part a rendering test
// would only cover by accident.

import type { SourceKind, View } from './types';

export type SwitcherRow = {
  view: View;
  /** True for the timeline that is open. */
  active: boolean;
};

export type SwitcherGroup = {
  kind: SourceKind;
  label: string;
  rows: SwitcherRow[];
};

/** The heading a group of sources gets, in the words the origin badge uses. */
export const ORIGIN_GROUP_LABEL: Record<SourceKind, string> = {
  db: 'Datenbank',
  local: 'Lokal',
};

/**
 * Fold the accents and the case out of a string for matching. „Roadmap" has to be
 * found by „roadmap", and a name with an umlaut by its plain spelling — the search
 * exists to save typing, so it must not demand exactness the label does not show.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Does the query match this view? The name first, then the id — somebody who knows
 * the id (from a link, from the API) should not have to remember the label.
 */
export function matchesQuery(view: View, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  // Every whitespace-separated part has to match somewhere, so „launch road" finds
  // „Launch-Roadmap" without the parts having to be adjacent.
  const haystack = `${fold(view.name)} ${fold(view.id)}`;
  return q.split(/\s+/).every((part) => haystack.includes(part));
}

/**
 * The groups to render: one per origin, in a fixed order, each holding the matching
 * timelines by name.
 *
 * Grouped by origin rather than sorted flat, because „where does this come from"
 * decides what you can do with it: a database timeline is live and editable, a local
 * one is a file on somebody's disk (see „Source kinds" in docs/architecture.md).
 * Empty groups are dropped — a heading over nothing reads as a failed load.
 *
 * The open timeline is never filtered away, however narrow the query: it is the one
 * row whose absence would read as „it is gone" rather than „it does not match".
 */
export function switcherGroups(
  views: readonly View[],
  query: string,
  activeId: string | null,
): SwitcherGroup[] {
  const order: SourceKind[] = ['db', 'local'];
  const byKind = new Map<SourceKind, SwitcherRow[]>();

  for (const view of views) {
    const active = view.id === activeId;
    if (!active && !matchesQuery(view, query)) continue;
    const kind = view.source.kind;
    const rows = byKind.get(kind) ?? byKind.set(kind, []).get(kind)!;
    rows.push({ view, active });
  }

  const groups: SwitcherGroup[] = [];
  for (const kind of order) {
    const rows = byKind.get(kind);
    if (!rows?.length) continue;
    rows.sort((a, b) => a.view.name.localeCompare(b.view.name, 'de'));
    groups.push({ kind, label: ORIGIN_GROUP_LABEL[kind] ?? kind, rows });
  }
  // A kind this build does not know about still gets listed, under its own name:
  // dropping it would hide timelines that exist (see `SourceKind` — the next one is
  // a new adapter, not a mistake).
  for (const [kind, rows] of byKind) {
    if (order.includes(kind)) continue;
    rows.sort((a, b) => a.view.name.localeCompare(b.view.name, 'de'));
    groups.push({ kind, label: ORIGIN_GROUP_LABEL[kind] ?? kind, rows });
  }
  return groups;
}

/** Every row across the groups, in the order they are rendered. */
export function flattenRows(groups: readonly SwitcherGroup[]): SwitcherRow[] {
  return groups.flatMap((g) => g.rows);
}

/**
 * The row a keypress moves to, wrapping at both ends.
 *
 * Wrapping rather than stopping: the list is short and a wrap costs one keypress,
 * while stopping at the end leaves somebody holding a key that does nothing.
 */
export function nextRowIndex(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

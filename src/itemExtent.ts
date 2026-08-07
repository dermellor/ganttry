// An item's `end` must lie AFTER its `start`. This is the single source of truth
// for that rule, shared by the server write path (rejects a reversed extent from
// any source — UI, MCP, direct API) and the client (item form validation).
//
// Why it exists: vis-timeline derives a bar's width from `end - start`. A
// non-positive result collapses the bar to its minimum width, so a reversed (or
// zero-length) interval renders as a hairline stripe that looks like a rendering
// glitch rather than bad data — and every write path used to accept it silently.
//
// Strict, mirroring `resolvePhaseExtentMs` in ./phaseOverlap, which likewise
// demands `end > start`: `end == start` is a zero-day range and produces the
// exact same hairline. An item that really covers one point in time is a
// Meilenstein (`type: 'point'`), and one that covers a single day carries
// `duration: '1d'`.
//
// `duration` needs no counterpart rule: `durationToMs` rejects non-positive
// values and its pattern accepts no sign, so an extent expressed that way can
// never run backwards.

// Explicit .ts extension: this module is reachable from the Deno edge bundle
// (timeline-repo → itemExtent), and Deno resolves relative imports only with
// their extension. `./date` is dependency-free, so pulling it server-side is
// safe — see the same note in ./phaseOverlap.ts.
import { parseLocalDay } from './date.ts';

export type ItemExtentInput = { start?: unknown; end?: unknown; content?: unknown };

/**
 * Is this pair of dates a reversed (or zero-length) extent? Only a *resolvable*
 * pair can be: a missing or unparseable value is some other problem and is left
 * to the caller that owns it, so this never rejects a date-less item or one
 * carrying only a `duration`.
 *
 * Day strings are read as *local* midnight via `parseLocalDay`, the same
 * boundary vis-timeline places an item at, so the rule matches what the bar
 * actually renders.
 */
export function isReversedExtent(start: unknown, end: unknown): boolean {
  if (typeof start !== 'string' || typeof end !== 'string') return false;
  if (!start || !end) return false;
  const s = parseLocalDay(start).getTime();
  const e = parseLocalDay(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return e <= s;
}

/** Convenience over `isReversedExtent` for a whole item-shaped object. */
export function hasReversedExtent(item: ItemExtentInput): boolean {
  return isReversedExtent(item?.start, item?.end);
}

/** Human-readable reason for a rejected write / blocked save. */
export function describeReversedExtent(start: unknown, end: unknown): string {
  return `Das End-Datum muss nach dem Start liegen (Start ${String(start)}, Ende ${String(end)}).`;
}

/**
 * First item with a reversed extent, or null if none. Used by the bulk write
 * path (`replaceTimeline`) so one bad item rejects the whole write rather than
 * being persisted alongside good ones.
 */
export function findReversedExtent<T extends ItemExtentInput>(items: T[]): T | null {
  for (const it of items ?? []) if (hasReversedExtent(it)) return it;
  return null;
}

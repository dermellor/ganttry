// The sprint raster: the one place that decides which sprint a date falls into.
//
// The raster is a **rule, not data**. Which sprint an item is in follows from its
// start date, the anchor and the fixed sprint length, so nothing is stored per item
// and an item that moves changes sprint by itself. Keeping the computation in one
// module is what stops `fields.ts` (the lanes a user sees) and `tools.ts` (the
// capacity arithmetic an agent gets) from bucketing items differently: a capacity
// sum taken over a different bucketing than the lanes is wrong in a way nobody can
// see, because both halves look right on their own.
//
// Four constraints this module lives under:
//
//   - **The config bag is user-editable data.** It comes out of a JSON file a person
//     maintains or an MCP call an agent made, so every value is read defensively and
//     a malformed one yields „no raster" rather than an exception. `derive` runs over
//     every item on every build, so a throw here costs the plugin its values on all
//     of them.
//   - **A bare `YYYY-MM-DD` is a LOCAL calendar day**, the way vis-timeline reads
//     one and the way `endFromDuration` (src/buildItems.ts) writes one. So the day
//     arithmetic below reads local components, and then counts whole days on a
//     DST-free axis: local midnight to local midnight is 23 or 25 hours across a
//     clock change, so subtracting two timestamps and dividing by 86_400_000 puts
//     every item after the change one sprint off. Verified against the Europe/Berlin
//     change of 2026-03-29 in `raster.test.ts`, where it decides sprint 6 against
//     sprint 7 for an item the example timeline actually has.
//   - **A value that is NOT a bare day is whatever `new Date` makes of it**, read
//     back in local components. That is not a second rule, it is the same one the
//     core applies in `parseLocalDay` (src/date.ts): a bare day keeps its written
//     components, anything with a time component honours a `Z` or an offset. Reading
//     only the leading `YYYY-MM-DD` of every string instead put an item on a lane the
//     viewer does not draw it in: `2026-02-15T23:00:00Z` is Feb 16 in Europe/Berlin,
//     so the bar sits in sprint 4 while the capacity sum counted it in sprint 3.
//   - **`lengthDays` is never guessed.** An absent value takes the documented
//     default; a present but unusable one (0, negative, fractional, a word) yields no
//     raster at all. Falling back to 14 there would bucket every item against a
//     cadence the user did not ask for and never sees, which is worse than a plugin
//     that visibly contributes nothing.
//
// The day helpers are re-implemented here rather than imported from `src/date.ts`
// because the plugin contract does not carry date maths: a plugin may import
// `pluginHost/api`, `types` and its own folder, and nothing else
// (scripts/ci/check-plugin-isolation.mjs). See `AGENTS.md` in this folder.

import type { TimelineFileItem } from '../../types';

/** Sprint length when the config does not name one. */
export const DEFAULT_LENGTH_DAYS = 14;

/**
 * The estimate options offered when the config names no `scale`. Fibonacci-ish,
 * because that is the ladder the practice actually uses; it is a default, not a
 * rule, and a team with its own scale sets one.
 */
export const DEFAULT_SCALE = ['1', '2', '3', '5', '8', '13', '21'] as const;

const DAY_MS = 86_400_000;
/** A calendar day and nothing else, the one shape whose components are taken as written. */
const BARE_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * A stored date **as it is written**: a calendar day, optionally followed by a time
 * component. Anchored at both ends, unlike a leading-day match: `"2026-03-2900"` used
 * to read as the day `2026-03-29` with a tail of `"00"`, and shifting it produced
 * `"2026-04-1200"` — a value nothing can parse back, so the item silently lost its
 * sprint after a move.
 */
const STORED_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/;

/**
 * The config bag as this plugin reads it. Every field is already checked, so no
 * consumer repeats the tolerance rules.
 */
export type SprintConfig = {
  /** Anchor day of sprint 1 as `YYYY-MM-DD`, or null when absent or unusable. */
  start: string | null;
  /** Sprint length in days: the default when absent, null when present and unusable. */
  lengthDays: number | null;
  /**
   * Points a sprint is expected to hold, or null when absent, zero, negative or
   * unparseable. One null for all four cases on purpose: the answer the capacity and
   * forecast verbs owe the caller is the same either way, and „velocity: 0" is not a
   * capacity a rule may divide by.
   */
  velocity: number | null;
  /** The estimate options offered, in order, de-duplicated. */
  scale: string[];
};

/** A usable raster: an anchor plus a length. Only `rasterFrom` produces one. */
export type SprintRaster = {
  anchor: string;
  lengthDays: number;
  velocity: number | null;
  scale: string[];
};

/** Days since the epoch for three already-known day components, on the DST-free UTC axis. */
function utcDayIndex(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/**
 * Days since the epoch for a **bare** day, or null when that day does not exist.
 *
 * `2026-02-31` is refused rather than rolled forward into March, because a silently
 * rolled date lands the item in a sprint the author never wrote down.
 */
function bareDayIndex(year: number, month: number, day: number): number | null {
  const local = new Date(year, month - 1, day);
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null;
  return utcDayIndex(year, month, day);
}

/**
 * Days since the epoch for the calendar day a value names, or null when it names none.
 *
 * The split mirrors `parseLocalDay` (src/date.ts) exactly, and has to: that function
 * decides where vis-timeline draws the bar, and this one decides which sprint counts
 * it. A bare `YYYY-MM-DD` keeps its written components; anything else goes through
 * `new Date(value)`, which honours a `Z` or an offset, and is then read back in LOCAL
 * components. Reading only the leading day of every string made
 * `2026-02-15T23:00:00Z` count in sprint 3 while Europe/Berlin draws it on Feb 16, in
 * sprint 4 — a disagreement between the lanes and the sums that looks right on both
 * sides. Both are schema-valid values an MCP `add_item` can write.
 *
 * The counting then happens on the UTC axis, which has no clock changes. That is what
 * makes „14 days later" mean fourteen calendar days rather than 14 × 24 hours.
 */
function dayIndex(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bare = BARE_DAY_RE.exec(trimmed);
  if (bare) return bareDayIndex(Number(bare[1]), Number(bare[2]), Number(bare[3]));
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return utcDayIndex(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

/**
 * Inverse of `dayIndex`: the calendar day a day count names, or null when that day
 * cannot be written as one.
 *
 * Outside four digits the formatting produces a string this module itself refuses to
 * read back (`9999-12-30` plus fourteen days is `"10000-01-13"`), so an item moved
 * there would silently lose its sprint. Null means „no such day string" and every
 * caller reports that instead of emitting the value.
 */
function dayFromIndex(index: number): string | null {
  const d = new Date(index * DAY_MS);
  const year = d.getUTCFullYear();
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  // UTC components, because `dayIndex` put the value on the UTC axis. Mixing the
  // two directions is what makes a shifted date land a day off in a UTC+ zone.
  return `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Does the value name a calendar day at all?
 *
 * Exported because „no sprint" and „no date" are two different answers that
 * `sprintOfDay` returns as the same null: a day before the anchor is a real day the
 * raster does not cover, while `""`, `"heute"` and `"2026-13-40"` are not days. A
 * verb that counts from sprint 1 in both cases states a confident number over an
 * argument it could not read, and nothing in its answer says so.
 */
export function isDayString(value: unknown): boolean {
  return dayIndex(value) != null;
}

/**
 * Move a stored date by whole calendar days, keeping any time component.
 *
 * The time is preserved rather than dropped because a move is a move along the
 * raster: an item that starts at 09:00 still starts at 09:00 a sprint later, and
 * rewriting it to midnight would silently change the item's extent as a side effect
 * of rebalancing.
 *
 * The shift applies to the day **as written** rather than to the local day
 * `dayIndex` reads, which is the only way to keep a tail that carries a zone
 * truthful: shifting the written day of `2026-02-15T23:00:00Z` by fourteen moves the
 * instant by fourteen days, so the local day moves by fourteen too. Shifting the
 * local day and re-attaching the same `Z` would move it by fifteen.
 *
 * Refuses anything that is not a day optionally followed by a time (`"2026-03-2900"`
 * used to shift to `"2026-04-1200"`), and refuses a result outside the four-digit
 * year range. Both produced a value the day parser rejects, so the item came out of
 * the move without a sprint and nothing said why.
 */
export function shiftDayString(value: unknown, days: number): string | null {
  if (typeof value !== 'string') return null;
  const m = STORED_DATE_RE.exec(value.trim());
  if (!m) return null;
  const index = bareDayIndex(Number(m[1]), Number(m[2]), Number(m[3]));
  if (index == null) return null;
  const shifted = dayFromIndex(index + days);
  if (shifted == null) return null;
  return `${shifted}${m[4] ?? ''}`;
}

/** A finite number out of a number or a numeric string, else null. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Numeric strings are accepted because a hand-written JSON source is not checked
  // against `configSchema` by anything: `"lengthDays": "14"` would otherwise turn
  // the whole plugin off with no visible reason.
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read the config bag. Never throws: every unusable value becomes the documented
 * default or null, and `rasterFrom` decides what that means for the plugin.
 */
export function readSprintConfig(raw: Record<string, unknown> | null | undefined): SprintConfig {
  const bag = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const startIndex = dayIndex(bag.start);
  const start = startIndex == null ? null : dayFromIndex(startIndex);
  // `dayFromIndex` may still refuse the day (a four-digit year is what a day string
  // is), and then there is no anchor: `rasterFrom` turns that into „no raster".

  const rawLength = bag.lengthDays;
  const length = rawLength == null ? DEFAULT_LENGTH_DAYS : toNumber(rawLength);
  const lengthDays = length != null && Number.isInteger(length) && length >= 1 ? length : null;

  const velocityValue = toNumber(bag.velocity);
  const velocity = velocityValue != null && velocityValue > 0 ? velocityValue : null;

  const scale: string[] = [];
  for (const entry of Array.isArray(bag.scale) ? bag.scale : []) {
    // Numbers are accepted for the same reason numeric strings are above: a scale
    // written as `[1, 2, 3]` is what a person types, and the field's values are
    // strings.
    const value = typeof entry === 'number' && Number.isFinite(entry) ? String(entry) : entry;
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!scale.includes(value.trim())) scale.push(value.trim());
  }

  return { start, lengthDays, velocity, scale: scale.length ? scale : [...DEFAULT_SCALE] };
}

/**
 * The raster a config describes, or null when it describes none.
 *
 * Null is the answer for a config without `start`: the anchor is what sprint 1 is,
 * so there is no raster to compute against and the plugin contributes nothing rather
 * than inventing an anchor of its own.
 */
export function rasterFrom(config: SprintConfig): SprintRaster | null {
  if (!config.start || config.lengthDays == null) return null;
  return {
    anchor: config.start,
    lengthDays: config.lengthDays,
    velocity: config.velocity,
    scale: config.scale,
  };
}

/**
 * The sprint a day falls into, 1-based, or null when it falls outside the raster.
 *
 * A day **before the anchor** has no sprint rather than a „Sprint 0": the raster
 * starts where the team's cadence started, and numbering backwards would invent
 * sprints that were never run. Such an item lands in the „Ohne …" bucket, which is
 * the truthful place for it.
 */
export function sprintOfDay(raster: SprintRaster, day: unknown): number | null {
  const anchor = dayIndex(raster.anchor);
  const index = dayIndex(day);
  if (anchor == null || index == null) return null;
  const offset = index - anchor;
  if (offset < 0) return null;
  return Math.floor(offset / raster.lengthDays) + 1;
}

/**
 * The sprint an item belongs to, from its **start** alone.
 *
 * An item spanning several sprints belongs to the one it starts in, and that is a
 * decision rather than a simplification: it keeps one item in one lane and lets a
 * capacity sum count it exactly once. The cost is that a long item is absent from
 * the sprints it runs through (see „Improve this plugin", question 1, in the
 * README).
 */
export function sprintOfItem(raster: SprintRaster, item: TimelineFileItem): number | null {
  return sprintOfDay(raster, item.start);
}

/**
 * The sprints the items actually occupy, ascending.
 *
 * A sprint holding nothing is absent from this list, which is what keeps grouping by
 * sprint from drawing a run of empty lanes out to the end of the raster. It also
 * means the field's options are evidence rather than a guess about how long the plan
 * is.
 */
export function sprintsInPlay(raster: SprintRaster, items: readonly TimelineFileItem[]): number[] {
  const seen = new Set<number>();
  for (const item of items ?? []) {
    const n = sprintOfItem(raster, item);
    if (n != null) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** First day of a sprint. Answers „from when" in a forecast. */
export function sprintFirstDay(raster: SprintRaster, sprint: number): string | null {
  const anchor = dayIndex(raster.anchor);
  if (anchor == null || !Number.isInteger(sprint) || sprint < 1) return null;
  return dayFromIndex(anchor + (sprint - 1) * raster.lengthDays);
}

/**
 * The stored value of the derived `sprint` field.
 *
 * An id rather than the label, like every other field value in the product: the
 * label is German interface text and a filter or a saved view that persisted it
 * would break the day it is reworded. Nothing is stored per item, but a filter
 * selection is.
 */
export function sprintValue(sprint: number): string {
  return `sprint-${sprint}`;
}

/** What a person reads: „Sprint 7". The numbering *is* the model (see the README). */
export function sprintLabel(sprint: number): string {
  return `Sprint ${sprint}`;
}

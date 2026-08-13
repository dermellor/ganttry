// The burndown's arithmetic, with no DOM anywhere in it.
//
// It is a module of its own because this is the part of the chart that can be
// wrong in a way nobody sees. An ideal line that ignores weekends, a
// reconstruction that counts a missing estimate as zero, a frozen series quietly
// recomputed from live items: each of those draws a plausible picture, and a
// plausible picture is what gets believed. Proving them needs the arithmetic
// reachable without a browser, which is also why every function here takes its
// „today" as an argument and reads no clock.
//
// **Day arithmetic is `raster.ts`'s, never restated here.** `dayOf` is the plugin's
// single reading of a stored date — it keeps a bare `YYYY-MM-DD` as written and
// reads anything carrying a zone back in LOCAL components, exactly as
// `parseLocalDay` does for the bar the viewer draws. A second copy of that rule
// would put a point one column away from the item it belongs to, and each half
// would look right on its own. Canonical day strings compare lexicographically,
// which is why nothing below needs an index of its own.
//
// The contract these functions implement is „The burndown" in `docs/model.md`.
// Three of its rules are load-bearing here:
//
//   - the ideal line is **working-day aware** (Azure DevOps computes it from
//     working days, Linear flattens it over non-working days; OpenProject's plain
//     straight line is the counterexample the model rejects);
//   - for an active sprint the actual line is a **reconstruction** from status and
//     end date, because this repo keeps no item revision log;
//   - for a closed sprint the frozen series is the truth and is **never**
//     recomputed.
//
// **The y value of a point is the remaining work at the END of that day**, for the
// actual line and for every point of the plan except its first. Both lines use that
// convention, which is what makes them comparable at every x position. The first
// point of the plan is the exception on purpose: it is the anchor at the full scope
// on the start date (see `idealSeries`).
//
// **A figure that is not a representable number is refused, never plotted.** A
// scope of Infinity divides, compares and formats as though it were a capacity, and
// what reached the SVG was `points="0,NaN 7.69,NaN"` beside a header printing
// „Infinity". So the sums answer `null` and the caller has to say so, which is what
// `unusableSumNote` already does for the verbs (`tools.ts`).

import { durationToMs, endFromDuration } from '../../pluginHost/api';
import { dayOf, shiftDayString } from './raster';
import type { CapacityUnit } from './sprints';

/**
 * The longest window this module will build an axis for.
 *
 * Canon fixes a sprint at one month or less, so anything past a year is not a
 * sprint window but a row somebody mistyped. The bound is a refusal rather than a
 * tidy-up because the alternative is a hang: a window of a century is 36 500 x
 * positions, one SVG node each, and the tab stops responding before anybody reads
 * the chart. The view says which of the two cases it is looking at.
 */
export const MAX_SPRINT_DAYS = 400;

/**
 * Is this day one the plan expects work on?
 *
 * Monday to Friday, fixed. `docs/model.md` demands working-day awareness and does
 * not say which days those are, and a configurable calendar is a different feature
 * (it needs per-instance holidays before it is worth anything). Fixed and stated
 * beats a default nobody can see: a `workingDays` config key is where this goes
 * when a team on a Sunday-to-Thursday week asks.
 *
 * Read on the UTC axis off a canonical day, which has no clock change in it.
 */
export function isWorkingDay(value: unknown): boolean {
  const day = dayOf(value);
  if (!day) return false;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

/**
 * Every calendar day of a sprint window, first and last included.
 *
 * Empty when either end is unreadable, when the end precedes the start, or when the
 * window is longer than `MAX_SPRINT_DAYS`. A window that cannot be read has no
 * axis, and inventing one would draw a chart over dates the sprint does not have.
 */
export function sprintDays(start: unknown, end: unknown): string[] {
  const from = dayOf(start);
  const to = dayOf(end);
  if (!from || !to || to < from) return [];
  const days: string[] = [];
  let day: string | null = from;
  while (day && day <= to) {
    days.push(day);
    if (days.length > MAX_SPRINT_DAYS) return [];
    day = shiftDayString(day, 1);
  }
  // The step refused before reaching the end — a window running past year 9999 is
  // not one this module can label, and half an axis is worse than none.
  return day ? days : [];
}

/**
 * A usable estimate, or null.
 *
 * `estimateOf` in `sprints.ts` is the reading of an item's estimate and this is not
 * a second copy of it: this one takes a bare value, which is what a stored capacity
 * and a frozen figure are. The two agree down to the „greater than zero", and they
 * have to: when they diverge, the chart and the agent verbs answer „what is in this
 * sprint" differently and each looks right on its own.
 *
 * Null is the answer for every unusable value, and the caller has to **name** the
 * item rather than count it as zero (`docs/model.md`, open question 4). A scope
 * that quietly omits three items reads as a scope statement and is not one.
 *
 * A single huge estimate stays usable, and the refusal for it belongs one level up:
 * `1e308` is a representable number and `estimateOf` (`sprints.ts`) accepts it as well,
 * so refusing it here would make the two readings of one value disagree. What is not
 * representable is their SUM, and that is where `scopeAndCompleted` says so.
 */
export function parseEstimate(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // A plain decimal, and nothing else. `Number()` reads `"0x10"` as 16 and `"1e3"`
  // as 1000, which turns a typo into a capacity figure.
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Two decimals. The chart's own precision, not the data's: `20 * (1 - 1/3)` is
 * `13.333333333333334`, and printing that in a label claims a precision no
 * estimate has.
 *
 * The overflow guard is not decoration: `value * 100` becomes Infinity above
 * ~1.8e306, and `Math.round(Infinity) / 100` renders a finite sum as a number that
 * is not one. Same guard as `atPrintedResolution` in `tools.ts`.
 */
export function round2(value: number): number {
  const scaled = value * 100;
  if (!Number.isFinite(scaled)) return value;
  return Math.round(scaled) / 100;
}

export type BurndownPoint = {
  day: string;
  /** Remaining work at the end of `day`, in the configured unit. */
  remaining: number;
};

/**
 * One item as the chart needs it. Deliberately not `TimelineFileItem`: the reading
 * of an item — its assignment, its estimate, its „done" test — is `sprints.ts`'s,
 * and taking the reduced shape here is what keeps this module provable without a
 * timeline.
 */
export type BurndownItem = {
  /** Whatever the caller names the item by. Only ever handed back, never matched on. */
  id: string;
  /** Null when the item carries no usable estimate. Never 0 as a stand-in. */
  estimate: number | null;
  done: boolean;
  /** The item's `start` **as stored**, or null. */
  start: string | null;
  /** The item's `end` **as stored**, or null — absent whenever it carries a `duration`. */
  end: string | null;
  /** The item's `duration` as stored (`"2w"`, a number of ms, …), if any. */
  duration?: unknown;
  /** A milestone: it has no extent, so its work lands on its start (`type: 'point'`). */
  point?: boolean;
};

/**
 * The day an item's work leaves the scope: its `end`, the end its `duration`
 * describes, or its `start`.
 *
 * The three stored fields rather than a resolved end from the caller, and the
 * resolution through the **core's** `durationToMs` + `endFromDuration` (host API 1.6):
 * every item in the shipped example carries `duration` and no `end`, so a caller
 * resolving „end, else start" burned each of them on the day the work STARTED. The
 * curve then described when work began, and the two closed sprints' frozen series were
 * not reproducible by the code that writes them. These are the same functions the
 * viewer places bars with, which is the point: a plugin computing a different end than
 * the one on screen is wrong wherever the two are compared.
 *
 * The precedence is the core's, in the core's order (`buildFromJson` in
 * src/buildItems.ts), including that a `point` ignores both: a milestone has no extent,
 * so a stray `duration` on one must not burn on a day no bar covers.
 */
export function itemEndDay(item: BurndownItem): string | null {
  if (!item.point) {
    const end = dayOf(item.end);
    if (end) return end;
    const start = typeof item.start === 'string' ? item.start.trim() : '';
    const ms = start ? durationToMs(item.duration) : null;
    if (ms != null && ms > 0) {
      const derived = dayOf(endFromDuration(start, ms));
      if (derived) return derived;
    }
  }
  return dayOf(item.start);
}

/**
 * The line the plan describes: **the full scope on the first day**, nothing left on
 * the last, flat across every day the plan expects no work on.
 *
 * The anchor at the start is the convention every product that draws a guideline
 * follows, and it is a correction rather than a preference: burning the first day too
 * opened the line below the scope it belongs to, so on a sprint of 13 over twelve days
 * the plan read 11.7 while the actual line read 13, and day one drew the team behind
 * before anything had happened. The denominator therefore counts the burning days
 * **after** the first, which is what keeps „first == scope and last == 0" true for
 * every window.
 *
 * Working-day aware, as `docs/model.md` demands. Two fallbacks, in this order:
 *
 *   - a window with no working day at all (a sprint deliberately placed over a
 *     weekend) burns on every day of its own;
 *   - a window whose only burning day is the first one burns on the remaining days
 *     instead. Both fallbacks exist to keep the line reaching zero: one that stayed
 *     flat at the full scope would say the plan never finishes, which is a statement
 *     about the calendar rather than about the sprint.
 *
 * A one-day sprint is a single point at the **scope**: one x position can only carry
 * the anchor, and „13 planned on the one day this sprint has" is the true half of
 * what a one-position axis can say.
 */
export function idealSeries(days: readonly string[], scope: number | null): BurndownPoint[] {
  // No coordinates for a scope that is not a number: see the module header.
  if (!days.length || scope == null || !Number.isFinite(scope)) return [];
  const working = days.filter(isWorkingDay);
  const candidates = new Set<string>(working.length ? working : days);
  const rest = days.slice(1);
  const afterFirst = rest.filter((day) => candidates.has(day));
  const burning = new Set<string>(afterFirst.length ? afterFirst : rest);
  const total = burning.size;
  if (!total) return days.map((day) => ({ day, remaining: round2(scope) }));
  let burned = 0;
  return days.map((day) => {
    if (burning.has(day)) burned++;
    return { day, remaining: round2(scope * (1 - burned / total)) };
  });
}

export type ScopeRead = {
  /** The scope in the unit asked for, or null when the sum is not a representable number. */
  scope: number | null;
  /** What is done, in the same unit. Null under the same condition. */
  completed: number | null;
  /**
   * Ids with no usable estimate. Named, never counted as zero.
   *
   * Empty when the unit counts items: an entry is one entry whether or not anybody
   * sized it, so nothing is missing from that sum. The estimate is still named, by
   * `sprintWarnings` („item-without-estimate"), which is where it is a question about
   * the item rather than about the sum.
   */
  unestimated: string[];
};

/** A figure a note can print and an axis can plot, or null. */
function representable(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * What one item contributes to the scope, or null when it contributes nothing
 * countable. One place, so the curve and the two sums cannot weigh an item differently.
 */
function weightOf(item: BurndownItem, unit: CapacityUnit): number | null {
  return unit === 'items' ? 1 : item.estimate;
}

/**
 * The two sums over one sprint's items, in the unit the sprint is planned in.
 *
 * Exported because the header shows them and the curve is built from them, and two
 * summations of one scope is exactly how a header and a chart end up disagreeing by
 * one item. `reconstructSeries` calls this rather than repeating it.
 *
 * `unit` decides what is being counted, and „items" is not cosmetic: a sprint with
 * `capacityUnit: 'items'` and a capacity of 3 holding two items of 8 and 13 points was
 * reported as „Umfang 21 von 3 Einträgen (überbucht)" — a story-point sum against a
 * count of entries, over-budget by an arithmetic nobody performed. The default is
 * „points" so a caller that has no unit gets the sum it used to get.
 */
export function scopeAndCompleted(
  items: readonly BurndownItem[],
  unit: CapacityUnit = 'points',
): ScopeRead {
  let scope = 0;
  let completed = 0;
  const unestimated: string[] = [];
  for (const it of items) {
    const weight = weightOf(it, unit);
    if (weight == null) {
      unestimated.push(it.id);
      continue;
    }
    scope += weight;
    if (it.done) completed += weight;
  }
  return {
    scope: representable(round2(scope)),
    completed: representable(round2(completed)),
    unestimated,
  };
}

export type Reconstruction = {
  /**
   * Remaining at the end of each day up to `asOf`. Empty before the sprint starts, and
   * empty when the scope is not a representable number: a line has to be plottable.
   */
  points: BurndownPoint[];
  /** The scope, or null when the sum left the representable range. */
  scope: number | null;
  /** What is done, in the same unit. Null under the same condition. */
  completed: number | null;
  /** Ids with no usable estimate. Named, never counted as zero. */
  unestimated: string[];
  /** Ids whose end fell before the sprint started, so their work burns on day one. */
  clampedToStart: string[];
  /**
   * Ids that are done and carry no date the drawn window contains, so their work
   * burns on the last drawn day.
   */
  clampedToAsOf: string[];
};

/**
 * The actual line, reconstructed from each item's status and end date.
 *
 * There is no record of when something became done — this repo keeps no item
 * revision log (`docs/model.md`, „What this model cannot do", 4) — so moving an
 * item's end date changes yesterday's curve. Taiga computes its chart the same
 * way. The view has to say so in words; this function cannot.
 *
 * Two clamps, and both exist to keep the last drawn point equal to the „completed"
 * figure a header shows over the same set of items:
 *
 *   - an end **before** the sprint started burns on the first day, the way Taiga
 *     does it — the work is in the sprint's scope, so it has to leave the scope
 *     somewhere;
 *   - an end **after** the last drawn day, or no end at all, burns on the last
 *     drawn day. It is done now and we cannot know when, so the most recent point
 *     is the only place it can go. Leaving it out instead made the final point of
 *     the line disagree with the completed figure beside it, over the same items.
 *
 * `asOf` is the day the reconstruction runs to: today for an active sprint, the
 * close for a freeze. Nothing is drawn past it, because a burndown that continues
 * into the future is a forecast wearing the actual line's colour.
 *
 * The day an item burns on is `itemEndDay`, which resolves a `duration` the way the
 * core does. Before that, a `duration`-only item burned on the day it started.
 */
export function reconstructSeries(
  days: readonly string[],
  items: readonly BurndownItem[],
  asOf: unknown,
  unit: CapacityUnit = 'points',
): Reconstruction {
  const { scope, completed, unestimated } = scopeAndCompleted(items, unit);
  const empty: Reconstruction = {
    points: [],
    scope,
    completed,
    unestimated,
    clampedToStart: [],
    clampedToAsOf: [],
  };
  // A curve out of a sum that is not a number would be a row of NaN coordinates, which
  // an SVG draws as nothing while the legend still claims a line.
  if (!days.length || scope == null) return empty;

  const first = days[0];
  const last = days[days.length - 1];
  const asOfDay = dayOf(asOf);
  // Before the sprint starts there is nothing to reconstruct. A single point at
  // full scope would look like a measurement taken on day one.
  if (!asOfDay || asOfDay < first) return empty;
  const cut = asOfDay < last ? asOfDay : last;

  const clampedToStart: string[] = [];
  const clampedToAsOf: string[] = [];
  // Work leaving the scope, keyed by the day it leaves on.
  const burnedOn = new Map<string, number>();
  for (const it of items) {
    const weight = weightOf(it, unit);
    if (!it.done || weight == null) continue;
    const end = itemEndDay(it);
    let on: string;
    if (!end || end > cut) {
      on = cut;
      clampedToAsOf.push(it.id);
    } else if (end < first) {
      on = first;
      clampedToStart.push(it.id);
    } else {
      on = end;
    }
    burnedOn.set(on, (burnedOn.get(on) ?? 0) + weight);
  }

  const points: BurndownPoint[] = [];
  let remaining = scope;
  for (const day of days) {
    if (day > cut) break;
    remaining -= burnedOn.get(day) ?? 0;
    points.push({ day, remaining: round2(remaining) });
  }
  return { points, scope, completed, unestimated, clampedToStart, clampedToAsOf };
}

export type FrozenRead = {
  /** The stored points that belong to the window, in day order. */
  points: BurndownPoint[];
  /** Stored days the window does not contain. Named rather than drawn. */
  outside: string[];
  /**
   * Entries that are not a day plus a finite number. Counted so the view can say so.
   *
   * It is only ever non-zero because `readReports` (`sprints.ts`) hands the stored list
   * over **unfiltered**. While it filtered first, the two readers disagreed in both
   * directions over the same row: a point with a negative `remaining` was dropped
   * there, so the view drew „no record" for a day that has one, and this count stayed
   * at 0 for a series it was supposed to report as damaged.
   */
  malformed: number;
};

/**
 * A closed sprint's frozen `reports.series`, read and never recomputed.
 *
 * Linear preserves a completed cycle's graph as a snapshot precisely because the
 * issue list keeps moving afterwards; recomputing a past chart from live items
 * means every edit silently rewrites history (`docs/model.md`).
 *
 * So nothing here fills in a missing day. A stored series with gaps is drawn with
 * gaps — see `splitAtGaps` — because interpolating across one would invent a
 * measurement, and the frozen series exists to be the record rather than a curve.
 * Days the window does not contain are handed back as `outside` rather than
 * dropped: a series whose dates run outside its sprint is a bug in whatever wrote
 * it, and silently drawing the intersection hides it forever.
 *
 * It takes `unknown`, and that is now the whole arrangement rather than a courtesy:
 * `readReports` (`sprints.ts`) carries the stored `series` through untouched, so this
 * is the **one** reader of a frozen curve. Two readers of one row is what produced a
 * day the view called „no record" while the count of damaged entries stayed 0.
 *
 * A stored `remaining` below zero is kept rather than counted as damage: it is a
 * record somebody wrote, `yForValue` puts it on the baseline, and dropping the day
 * would draw a gap that says „nothing was measured here" about a day that has a
 * measurement.
 */
export function frozenSeries(days: readonly string[], raw: unknown): FrozenRead {
  const out: FrozenRead = { points: [], outside: [], malformed: 0 };
  if (!Array.isArray(raw)) {
    // A `series` that is not a list is not „no series": it is a row somebody wrote
    // wrong, and the view has to be able to say so.
    if (raw != null) out.malformed = 1;
    return out;
  }
  const known = new Map<string, number>();
  days.forEach((day, i) => known.set(day, i));
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') {
      out.malformed++;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const day = dayOf(record.day);
    const remaining = typeof record.remaining === 'number' && Number.isFinite(record.remaining) ? record.remaining : null;
    if (!day || remaining == null) {
      out.malformed++;
      continue;
    }
    if (!known.has(day)) {
      out.outside.push(day);
      continue;
    }
    // A repeated day is not a second measurement, it is the same one written twice;
    // the first wins so the read stays deterministic.
    if (seen.has(day)) continue;
    seen.add(day);
    out.points.push({ day, remaining });
  }
  out.points.sort((a, b) => known.get(a.day)! - known.get(b.day)!);
  return out;
}

/**
 * A series split into runs of consecutive days.
 *
 * A polyline drawn straight through a gap claims a value for the missing days.
 * Drawing one line per run says „no record here" instead, which is the only true
 * thing a frozen series with a hole can say.
 */
export function splitAtGaps(points: readonly BurndownPoint[], days: readonly string[]): BurndownPoint[][] {
  const position = new Map<string, number>();
  days.forEach((day, i) => position.set(day, i));
  const runs: BurndownPoint[][] = [];
  let previous: number | null = null;
  for (const point of points) {
    const at = position.get(point.day);
    if (at == null) continue;
    if (previous != null && at === previous + 1) runs[runs.length - 1].push(point);
    else runs.push([point]);
    previous = at;
  }
  return runs;
}

export type PlotBox = { left: number; top: number; width: number; height: number };

/** The x of one day position inside the plot box. A single day sits in the middle. */
export function xForIndex(index: number, count: number, box: PlotBox): number {
  if (count <= 1) return round2(box.left + box.width / 2);
  return round2(box.left + (index / (count - 1)) * box.width);
}

/**
 * The y of one value. `maxY <= 0` puts everything on the baseline.
 *
 * It takes a finite value, and the refusal for one that is not lives at the sums
 * (`scopeAndCompleted` answers null) and in `polylinePoints` (which drops the point).
 * Returning a coordinate for `NaN` here instead is what put `"0,NaN"` in the markup:
 * an SVG draws nothing for it while the legend still names the line.
 */
export function yForValue(value: number, maxY: number, box: PlotBox): number {
  if (!(maxY > 0)) return round2(box.top + box.height);
  const clamped = Math.min(Math.max(value, 0), maxY);
  return round2(box.top + box.height * (1 - clamped / maxY));
}

/**
 * One run of points as an SVG `points` attribute.
 *
 * Geometry rather than drawing, and here rather than in the view for the same
 * reason the rest of this module is: „is the last point at the right edge" is a
 * question a test can answer and a screenshot cannot.
 */
export function polylinePoints(
  run: readonly BurndownPoint[],
  days: readonly string[],
  maxY: number,
  box: PlotBox,
): string {
  // A non-finite axis top has no proportions to place anything against, so there is no
  // line rather than a line of NaN coordinates.
  if (!Number.isFinite(maxY)) return '';
  const position = new Map<string, number>();
  days.forEach((day, i) => position.set(day, i));
  return run
    .map((point) => {
      const at = position.get(point.day);
      if (at == null || !Number.isFinite(point.remaining)) return null;
      return `${xForIndex(at, days.length, box)},${yForValue(point.remaining, maxY, box)}`;
    })
    .filter((part): part is string => part != null)
    .join(' ');
}

/**
 * Which day positions get a label, so the axis stays legible at the width the
 * content area gives us.
 *
 * Always the first and the last: a burndown whose axis starts on an unnamed day is
 * a chart nobody can date. `max` is the number of labels that fit, and the ones
 * between are spread evenly. Every index appears at most once, so a short sprint
 * does not get the same day labelled twice.
 */
export function tickIndices(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const slots = Math.max(2, Math.min(max, count));
  const out = new Set<number>();
  for (let i = 0; i < slots; i++) out.add(Math.round((i / (slots - 1)) * (count - 1)));
  return [...out].sort((a, b) => a - b);
}

/**
 * The y-axis top: the scope, or the tallest value drawn when a frozen series
 * carries one above it.
 *
 * Rounded up so the top gridline is a number a reader recognises. Taking the scope
 * alone would clip a stored curve that starts above it — which happens whenever the
 * scope grew during the sprint and the freeze recorded it.
 *
 * A scope that is not a representable number is no axis: every gridline label came out
 * as „Infinity" and every y coordinate as NaN, which is a chart claiming to have been
 * drawn.
 */
export function axisMax(scope: number | null, ...series: readonly BurndownPoint[][]): number {
  let max = scope != null && Number.isFinite(scope) ? scope : 0;
  for (const points of series) {
    for (const point of points) if (Number.isFinite(point.remaining)) max = Math.max(max, point.remaining);
  }
  if (!(max > 0)) return 0;
  const step = max <= 10 ? 1 : max <= 50 ? 5 : max <= 200 ? 10 : 50;
  return Math.ceil(max / step) * step;
}

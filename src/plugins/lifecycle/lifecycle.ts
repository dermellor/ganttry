// The domain rules, as pure functions over a timeline.
//
// A migration plan is dated from the far end: the vendor fixes end of support, and
// the plan's own dates follow backwards from it. That is the whole reason this is a
// plugin rather than a handful of items — every interesting fact here is computed,
// and computed from a date nobody on the project controls.
//
// **The two clocks.** One is the vendor's (end of support, extended support) and
// cannot be moved. One is the project's (start, cutover, shutdown) and is the only
// one a plan can change. Every rule below is a statement about the gap between
// them, which is why none of them ever writes a vendor date.
//
// This module is DOM-free and reads no clock: `now` arrives as an argument, so the
// boundaries the domain actually cares about — an end-of-support date in the past,
// a freeze window longer than the time that is left — are testable rather than
// reachable only on the right day. It is imported statically by the registry and by
// the process that serves agent calls, so it may reach the contract barrel and
// nothing else.

import { isoDateOnly, shiftDays } from '../../pluginHost/api';
import type { TimelineFile, TimelineFileItem } from '../../types';
import { hasPlugin } from '../../pluginHost/api';
import { LIFECYCLE_COLLECTIONS, lifecycleManifest } from './manifest';

/** Stable id of this plugin, read from the manifest so it exists exactly once. */
export const LIFECYCLE_PLUGIN = lifecycleManifest.id;

// The `metadata` keys this plugin owns. Every one of them is declared in the
// manifest's `metadataKeys` **except** the two derived ones below, and that
// difference is load-bearing: `metadataKeys` is what an uninstall purges off items,
// and a derived key has nothing on an item to purge.
export const SYSTEM_KEY = 'system';
export const END_OF_SUPPORT_KEY = 'endOfSupport';
export const EXTENDED_UNTIL_KEY = 'extendedUntil';
export const LEAD_TIME_KEY = 'leadTimeDays';
export const CUTOVER_KEY = 'cutover';
export const SHUTDOWN_KEY = 'shutdown';

/** Computed on every build and stored nowhere. Deliberately not in `metadataKeys`. */
export const LATEST_START_KEY = 'latestStart';
export const SUPPORT_WINDOW_KEY = 'supportWindow';

/**
 * Where a day falls in a system's lifecycle.
 *
 * Three values and no more, because the fourth one people expect — „extended support
 * is available but not bought" — is a vendor-specific fact this plugin refuses to
 * guess (see „How well is this domain modelled?" in the README). The ids are stored
 * nowhere (the field is derived) but stay English anyway: they are what a grouping
 * dimension keys on, and a translated bucket id would split one lane in two the
 * first time somebody switched language.
 */
export const SUPPORT_WINDOWS = ['standard', 'extended', 'unsupported'] as const;
export type SupportWindow = (typeof SUPPORT_WINDOWS)[number];

/** A span in which no cutover may be scheduled. One row of the `freezes` collection. */
export type Freeze = {
  id: string;
  name: string;
  /** First blocked day, `YYYY-MM-DD`. */
  from: string;
  /** Last blocked day, inclusive. */
  to: string;
};

/** What one item says about one system's migration. */
export type LifecyclePlan = {
  itemId: string;
  content: string;
  /** The system this entry is about, when it names one. */
  system?: string;
  /** When the plan's own work starts: the item's own start. */
  start?: string;
  endOfSupport?: string;
  extendedUntil?: string;
  leadTimeDays?: number;
  cutover?: string;
  shutdown?: string;
};

/** The plugin's config bag on this timeline. */
export type LifecycleConfig = {
  /**
   * The shortest parallel run the plan may have, in days.
   *
   * **No default, on purpose.** The sources disagree by an order of magnitude — two
   * to four weeks, fifteen days to three months, two to eight weeks, a full business
   * year — so any number here would be this plugin inventing a domain rule and
   * presenting it as one. Absent, the rules that need it say they cannot answer.
   */
  minParallelRunDays?: number;
  /**
   * Lead time for an item that names none. A convenience for a timeline where every
   * system is migrated by the same team at the same pace; absent for the same reason
   * as above rather than defaulted.
   */
  defaultLeadTimeDays?: number;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || undefined;
}

/**
 * A calendar day, or `undefined`.
 *
 * Strict on the shape rather than parsing what `new Date()` accepts: these values
 * are typed into a text field, and „01.05.2026" read as an American date put every
 * computed date four months from where the author meant it — with nothing on screen
 * saying so. Refusing is the only outcome that is visible.
 */
export function day(value: unknown): string | undefined {
  const s = text(value);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  // A well-formed but impossible day (2026-02-30) parses to March 2nd, which would
  // be a date the author never wrote. `isoDateOnly` of the parsed value differs from
  // the input exactly then.
  return isoDateOnly(new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))) === s
    ? s
    : undefined;
}

/** A whole number of days, greater than zero, or `undefined`. */
export function days(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(text(value));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** The config bag, with everything unusable dropped rather than defaulted. */
export function readConfig(raw: Record<string, unknown> | null | undefined): LifecycleConfig {
  if (!isPlainObject(raw)) return {};
  return {
    minParallelRunDays: days(raw.minParallelRunDays),
    defaultLeadTimeDays: days(raw.defaultLeadTimeDays),
  };
}

/**
 * The freeze windows, earliest first.
 *
 * A row missing either end is dropped: a span with one date is not a span, and
 * defaulting the other end would block days nobody declared. A row whose `to`
 * precedes its `from` is **kept, with its ends swapped**, because the author plainly
 * meant a span and refusing it silently would let a cutover be planned into a window
 * somebody had declared closed.
 */
export function readFreezes(file: TimelineFile | null | undefined): Freeze[] {
  if (!file || !hasPlugin(file, LIFECYCLE_PLUGIN)) return [];
  const own = (file as { pluginData?: unknown }).pluginData;
  if (!isPlainObject(own)) return [];
  const collections = own[LIFECYCLE_PLUGIN];
  if (!isPlainObject(collections)) return [];
  const rows = collections[LIFECYCLE_COLLECTIONS.freezes];
  if (!Array.isArray(rows)) return [];

  const out: Freeze[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row) || !isPlainObject(row.data)) continue;
    const id = text(row.id);
    // A repeated id keeps its first row: two rows under one id cannot both be
    // addressed, and taking the later one would make the answer depend on read order.
    if (!id || seen.has(id)) continue;
    const from = day(row.data.from);
    const to = day(row.data.to);
    if (!from || !to) continue;
    seen.add(id);
    out.push({
      id,
      name: text(row.data.name) ?? id,
      from: from <= to ? from : to,
      to: from <= to ? to : from,
    });
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** One item's plan, read off its metadata. */
export function readPlan(item: TimelineFileItem, config: LifecycleConfig = {}): LifecyclePlan {
  const meta = isPlainObject(item.metadata) ? item.metadata : {};
  return {
    itemId: item.id ?? '',
    content: item.content ?? '',
    system: text(meta[SYSTEM_KEY]),
    start: day(isoDateOnly(item.start ?? '')),
    endOfSupport: day(meta[END_OF_SUPPORT_KEY]),
    extendedUntil: day(meta[EXTENDED_UNTIL_KEY]),
    leadTimeDays: days(meta[LEAD_TIME_KEY]) ?? config.defaultLeadTimeDays,
    cutover: day(meta[CUTOVER_KEY]),
    shutdown: day(meta[SHUTDOWN_KEY]),
  };
}

/** Every item that says anything at all about a lifecycle. */
export function readPlans(file: TimelineFile | null | undefined, config: LifecycleConfig = {}): LifecyclePlan[] {
  if (!file || !hasPlugin(file, LIFECYCLE_PLUGIN)) return [];
  return (file.items ?? [])
    .filter((item) => !!item.id)
    .map((item) => readPlan(item, config))
    .filter((plan) => plan.endOfSupport || plan.cutover || plan.shutdown || plan.system);
}

/**
 * The last day the old system may still be running with support behind it.
 *
 * Extended support wins when a date for it is present, and that is the only thing
 * this plugin will say about extended support: it takes the date as input and never
 * derives one from end of support, because how long extended support runs — and
 * whether it can be bought at all — differs per vendor and has no industry
 * definition. Guessing „three years" here would be a rule nobody can trace.
 *
 * An extended date **earlier** than end of support is ignored rather than honoured:
 * extended support extends, so an earlier date is a typo, and taking it would shorten
 * a deadline the vendor had not shortened.
 */
export function deadlineOf(plan: Pick<LifecyclePlan, 'endOfSupport' | 'extendedUntil'>): string | undefined {
  const { endOfSupport, extendedUntil } = plan;
  if (!endOfSupport) return extendedUntil;
  if (!extendedUntil) return endOfSupport;
  return extendedUntil > endOfSupport ? extendedUntil : endOfSupport;
}

/**
 * The latest day work can start and still fit the lead time before the deadline.
 *
 * The rule the domain states outright: the support deadline is the last possible
 * moment, not the right one. A plan starting after this date is already late, and
 * saying so is the entire job — this function never moves the date it measures
 * against.
 */
export function latestStart(plan: Pick<LifecyclePlan, 'endOfSupport' | 'extendedUntil' | 'leadTimeDays'>): string | undefined {
  const deadline = deadlineOf(plan);
  if (!deadline || !plan.leadTimeDays) return undefined;
  return shiftDays(deadline, -plan.leadTimeDays) || undefined;
}

/**
 * Which support window a day falls in.
 *
 * `undefined` when no end-of-support date is known, rather than `standard`: „nobody
 * told us when this dies" and „this is inside standard support" are different facts,
 * and collapsing them would report a whole timeline as safe because it is empty.
 */
export function supportWindowOf(
  day_: string | undefined,
  plan: Pick<LifecyclePlan, 'endOfSupport' | 'extendedUntil'>,
): SupportWindow | undefined {
  if (!day_ || !plan.endOfSupport) return undefined;
  if (day_ <= plan.endOfSupport) return 'standard';
  if (plan.extendedUntil && day_ <= plan.extendedUntil) return 'extended';
  return 'unsupported';
}

/**
 * The window a day is blocked by, or `null`.
 *
 * Both ends inclusive: a freeze declared „from the 20th to the 31st" blocks the 31st,
 * which is what everybody who wrote the row meant. Half-open would silently free the
 * last day of every year-end freeze.
 */
export function freezeAt(day_: string, freezes: readonly Freeze[]): Freeze | null {
  return freezes.find((f) => day_ >= f.from && day_ <= f.to) ?? null;
}

/**
 * The first admissible day at or after `from`.
 *
 * Walks rather than testing once, because freezes chain: leaving one window can land
 * inside the next, and two adjacent year-end freezes are the normal case rather than
 * a pathological one. `limit` bounds the walk so a freeze with an absurd `to` cannot
 * spin — reaching it returns null, which the callers report as „no admissible day"
 * instead of inventing one.
 */
export function nextFreeDay(from: string, freezes: readonly Freeze[], limit = 3650): string | null {
  let candidate = from;
  for (let steps = 0; steps <= limit; ) {
    const hit = freezeAt(candidate, freezes);
    if (!hit) return candidate;
    const next = shiftDays(hit.to, 1);
    if (!next) return null;
    steps += Math.max(1, daysBetween(candidate, next));
    candidate = next;
  }
  return null;
}

/**
 * The last admissible day at or before `from`.
 *
 * The mirror of `nextFreeDay`, and the direction `plan_cutover` needs: moving a
 * cutover *earlier* lengthens the parallel run, while moving it later eats into it,
 * so backward dating has to walk backwards or it produces a plan that breaks the one
 * minimum it was given.
 */
export function previousFreeDay(from: string, freezes: readonly Freeze[], limit = 3650): string | null {
  let candidate = from;
  for (let steps = 0; steps <= limit; ) {
    const hit = freezeAt(candidate, freezes);
    if (!hit) return candidate;
    const previous = shiftDays(hit.from, -1);
    if (!previous) return null;
    steps += Math.max(1, daysBetween(previous, candidate));
    candidate = previous;
  }
  return null;
}

/** Days the two systems run side by side, or `undefined` when either end is missing. */
export function parallelRunDays(plan: Pick<LifecyclePlan, 'cutover' | 'shutdown'>): number | undefined {
  if (!plan.cutover || !plan.shutdown) return undefined;
  return daysBetween(plan.cutover, plan.shutdown);
}

/** Why a placement could not be made. Each one is a real state, not an error path. */
export type PlacementRefusal =
  | 'no-deadline'
  | 'no-minimum'
  | 'freeze-blocks-every-day'
  | 'no-room-before-start';

/** What backward dating produced. */
export type Placement = {
  cutover: string;
  shutdown: string;
  /** Days between the two, at least the configured minimum. */
  parallelRunDays: number;
  /** The freeze the first candidate landed in, when the date had to move. */
  movedOutOf?: Freeze;
  /** Set when the deadline is already behind `now`. The plan is produced anyway. */
  deadlinePast?: boolean;
  /** Set when the plan's own start is later than the latest start. */
  startsLate?: boolean;
};

/**
 * Place cutover and shutdown backwards from the deadline.
 *
 * The rule, in order: the old system is off by the deadline, the parallel run before
 * it is at least as long as the minimum, and the cutover does not sit in a freeze
 * window. Only the cutover moves, and it moves **earlier** — that is what keeps the
 * parallel run at or above its minimum instead of quietly trading it away.
 *
 * A deadline in the past is placed rather than refused, with `deadlinePast` set. The
 * dates it produces are all behind us and that is the honest answer: the plan is
 * late, and reporting „cannot compute" would hide a migration that has already
 * missed its date.
 */
export function placeCutover(args: {
  plan: Pick<LifecyclePlan, 'endOfSupport' | 'extendedUntil' | 'leadTimeDays' | 'start'>;
  minParallelRunDays: number | undefined;
  freezes: readonly Freeze[];
  now: string;
}): { ok: true; placement: Placement } | { ok: false; reason: PlacementRefusal; freeze?: Freeze } {
  const { plan, minParallelRunDays, freezes, now } = args;
  const deadline = deadlineOf(plan);
  if (!deadline) return { ok: false, reason: 'no-deadline' };
  if (!minParallelRunDays) return { ok: false, reason: 'no-minimum' };

  const shutdown = deadline;
  const wanted = shiftDays(shutdown, -minParallelRunDays);
  if (!wanted) return { ok: false, reason: 'no-deadline' };

  const blocked = freezeAt(wanted, freezes);
  const cutover = blocked ? previousFreeDay(wanted, freezes) : wanted;
  // A freeze reaching back further than the plan has room for. Reporting it is the
  // whole point: this is the case where the freeze calendar and the vendor's date
  // are jointly unsatisfiable, and a tool that returned *some* date here would be
  // presenting a plan that cannot be run.
  if (!cutover) return { ok: false, reason: 'freeze-blocks-every-day', freeze: blocked ?? undefined };
  if (plan.start && cutover < plan.start) {
    return { ok: false, reason: 'no-room-before-start', freeze: blocked ?? undefined };
  }

  const latest = latestStart({ ...plan, leadTimeDays: plan.leadTimeDays });
  return {
    ok: true,
    placement: {
      cutover,
      shutdown,
      parallelRunDays: daysBetween(cutover, shutdown),
      movedOutOf: blocked ?? undefined,
      deadlinePast: deadline < now ? true : undefined,
      startsLate: latest && plan.start && plan.start > latest ? true : undefined,
    },
  };
}

/** One thing wrong with one plan. `check_eol_risk` reports these; nothing here writes. */
export type RiskKind =
  | 'no-end-of-support'
  | 'starts-after-latest-start'
  | 'no-lead-time'
  | 'shutdown-after-deadline'
  | 'cutover-in-freeze'
  | 'parallel-run-too-short'
  | 'shutdown-before-cutover'
  | 'deadline-past';

export type Risk = { kind: RiskKind; plan: LifecyclePlan; freeze?: Freeze; days?: number; day?: string };

/**
 * Every risk the rows and the items jointly produce.
 *
 * Ordered by plan and then by the order below rather than by severity: severity in
 * this domain depends on facts the plugin does not have (what the system does, who
 * depends on it), so ranking them here would be an invented judgement. The caller
 * reads them all.
 */
export function risksOf(args: {
  plans: readonly LifecyclePlan[];
  freezes: readonly Freeze[];
  config: LifecycleConfig;
  now: string;
}): Risk[] {
  const { plans, freezes, config, now } = args;
  const out: Risk[] = [];

  for (const plan of plans) {
    const deadline = deadlineOf(plan);
    if (!deadline) {
      out.push({ kind: 'no-end-of-support', plan });
      continue;
    }
    if (deadline < now) out.push({ kind: 'deadline-past', plan, day: deadline });

    if (!plan.leadTimeDays) {
      out.push({ kind: 'no-lead-time', plan });
    } else {
      const latest = latestStart(plan);
      if (latest && plan.start && plan.start > latest) {
        out.push({ kind: 'starts-after-latest-start', plan, day: latest, days: daysBetween(latest, plan.start) });
      }
    }

    if (plan.shutdown && plan.shutdown > deadline) {
      out.push({ kind: 'shutdown-after-deadline', plan, day: deadline, days: daysBetween(deadline, plan.shutdown) });
    }
    if (plan.cutover) {
      const hit = freezeAt(plan.cutover, freezes);
      if (hit) out.push({ kind: 'cutover-in-freeze', plan, freeze: hit, day: plan.cutover });
    }
    const run = parallelRunDays(plan);
    if (run != null && run < 0) {
      out.push({ kind: 'shutdown-before-cutover', plan, days: run });
    } else if (run != null && config.minParallelRunDays && run < config.minParallelRunDays) {
      out.push({ kind: 'parallel-run-too-short', plan, days: run });
    }
  }

  return out;
}

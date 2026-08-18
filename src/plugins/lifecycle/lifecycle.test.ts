import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFECYCLE_PLUGIN,
  day,
  days,
  daysBetween,
  deadlineOf,
  freezeAt,
  latestStart,
  nextFreeDay,
  parallelRunDays,
  placeCutover,
  previousFreeDay,
  readConfig,
  readFreezes,
  readPlan,
  readPlans,
  risksOf,
  supportWindowOf,
  type Freeze,
} from './lifecycle';
import type { TimelineFile, TimelineFileItem } from '../../types';

// One test per rule, and one per boundary the domain cares about rather than one per
// happy path: a cutover already inside a freeze window, a freeze window longer than the
// time that is left, an end-of-support date in the past, an extended date that moves the
// deadline backwards, and chained freezes. A plausible-looking wrong rule here produces
// a date somebody plans a weekend around, which is why the arithmetic is pinned this
// closely.

const NOW = '2026-08-18';

const freeze = (id: string, from: string, to: string, name = id): Freeze => ({ id, name, from, to });

type PlanSpec = {
  system?: string;
  endOfSupport?: string;
  extendedUntil?: string;
  leadTimeDays?: unknown;
  cutover?: string;
  shutdown?: string;
  start?: string;
};

const item = (id: string, spec: PlanSpec = {}): TimelineFileItem => {
  const metadata: Record<string, unknown> = {};
  if (spec.system !== undefined) metadata.system = spec.system;
  if (spec.endOfSupport !== undefined) metadata.endOfSupport = spec.endOfSupport;
  if (spec.extendedUntil !== undefined) metadata.extendedUntil = spec.extendedUntil;
  if (spec.leadTimeDays !== undefined) metadata.leadTimeDays = spec.leadTimeDays;
  if (spec.cutover !== undefined) metadata.cutover = spec.cutover;
  if (spec.shutdown !== undefined) metadata.shutdown = spec.shutdown;
  return { id, content: id, ...(spec.start ? { start: spec.start } : {}), metadata };
};

const file = (items: TimelineFileItem[], freezes: Freeze[] = []): TimelineFile =>
  ({
    id: 't',
    plugins: [{ id: LIFECYCLE_PLUGIN }],
    pluginData: {
      [LIFECYCLE_PLUGIN]: {
        freezes: freezes.map((f) => ({ id: f.id, data: { name: f.name, from: f.from, to: f.to } })),
      },
    },
    items,
  }) as unknown as TimelineFile;

// ---- parsing ---------------------------------------------------------------------

test('day() takes only YYYY-MM-DD, so a German date cannot be read as an American one', () => {
  assert.equal(day('2026-10-14'), '2026-10-14');
  // The whole reason the check is strict: `new Date()` would take this and land the
  // result four months from where the author meant it.
  assert.equal(day('01.05.2026'), undefined);
  assert.equal(day('14/10/2026'), undefined);
  assert.equal(day('October 2026'), undefined);
  assert.equal(day(''), undefined);
  assert.equal(day(null), undefined);
});

test('day() refuses a well-formed but impossible date rather than rolling it over', () => {
  // 2026-02-30 parses to March 2nd, a day the author never wrote.
  assert.equal(day('2026-02-30'), undefined);
  assert.equal(day('2026-13-01'), undefined);
  assert.equal(day('2026-02-28'), '2026-02-28');
});

test('days() takes a whole positive number, from a string or a number', () => {
  assert.equal(days(180), 180);
  assert.equal(days('180'), 180);
  assert.equal(days(0), undefined);
  assert.equal(days(-5), undefined);
  assert.equal(days(1.5), undefined);
  assert.equal(days('viel'), undefined);
});

test('daysBetween counts whole calendar days in both directions', () => {
  assert.equal(daysBetween('2026-08-18', '2026-08-28'), 10);
  assert.equal(daysBetween('2026-08-28', '2026-08-18'), -10);
  assert.equal(daysBetween('2026-08-18', '2026-08-18'), 0);
  // Across a DST boundary in Europe/Berlin, which the test script pins.
  assert.equal(daysBetween('2026-10-20', '2026-11-03'), 14);
});

test('readConfig drops an unusable value instead of defaulting it', () => {
  assert.deepEqual(readConfig({ minParallelRunDays: 30, defaultLeadTimeDays: 180 }), {
    minParallelRunDays: 30,
    defaultLeadTimeDays: 180,
  });
  // No default anywhere: the practice has no industry-wide number, so absent has to
  // stay absent or the plugin invents a domain rule.
  assert.deepEqual(readConfig({}), { minParallelRunDays: undefined, defaultLeadTimeDays: undefined });
  assert.deepEqual(readConfig({ minParallelRunDays: 0 }), {
    minParallelRunDays: undefined,
    defaultLeadTimeDays: undefined,
  });
  assert.deepEqual(readConfig(null), {});
});

// ---- the freeze rows -------------------------------------------------------------

test('readFreezes drops a span with only one end and keeps one whose ends are swapped', () => {
  const f = {
    id: 't',
    plugins: [{ id: LIFECYCLE_PLUGIN }],
    pluginData: {
      [LIFECYCLE_PLUGIN]: {
        freezes: [
          { id: 'a', data: { name: 'ok', from: '2026-12-20', to: '2026-12-31' } },
          { id: 'b', data: { name: 'half', from: '2026-12-20' } },
          { id: 'c', data: { name: 'reversed', from: '2026-06-30', to: '2026-06-01' } },
          { id: '', data: { name: 'no id', from: '2026-01-01', to: '2026-01-02' } },
        ],
      },
    },
    items: [],
  } as unknown as TimelineFile;

  const read = readFreezes(f);
  assert.deepEqual(
    read.map((x) => [x.id, x.from, x.to]),
    [
      // Sorted by `from`, so the reversed one comes first once its ends are righted.
      ['c', '2026-06-01', '2026-06-30'],
      ['a', '2026-12-20', '2026-12-31'],
    ],
  );
});

test('readFreezes keeps the first of two rows sharing an id', () => {
  const f = {
    id: 't',
    plugins: [{ id: LIFECYCLE_PLUGIN }],
    pluginData: {
      [LIFECYCLE_PLUGIN]: {
        freezes: [
          { id: 'a', data: { name: 'first', from: '2026-12-20', to: '2026-12-31' } },
          { id: 'a', data: { name: 'second', from: '2026-01-01', to: '2026-01-02' } },
        ],
      },
    },
    items: [],
  } as unknown as TimelineFile;
  assert.deepEqual(readFreezes(f).map((x) => x.name), ['first']);
});

test('readFreezes returns nothing when the plugin is not enabled', () => {
  const f = {
    id: 't',
    plugins: [],
    pluginData: { [LIFECYCLE_PLUGIN]: { freezes: [{ id: 'a', data: { name: 'x', from: '2026-01-01', to: '2026-01-02' } }] } },
    items: [],
  } as unknown as TimelineFile;
  assert.deepEqual(readFreezes(f), []);
});

// ---- the deadline ----------------------------------------------------------------

test('deadlineOf prefers extended support and ignores an extended date that is earlier', () => {
  assert.equal(deadlineOf({ endOfSupport: '2026-10-14' }), '2026-10-14');
  assert.equal(deadlineOf({ endOfSupport: '2026-10-14', extendedUntil: '2029-10-09' }), '2029-10-09');
  // Extended support extends. An earlier date is a typo, and honouring it would shorten
  // a deadline the vendor never shortened.
  assert.equal(deadlineOf({ endOfSupport: '2026-10-14', extendedUntil: '2025-01-01' }), '2026-10-14');
  assert.equal(deadlineOf({}), undefined);
});

test('latestStart is the deadline minus the lead time, and undefined without either', () => {
  assert.equal(latestStart({ endOfSupport: '2026-10-14', leadTimeDays: 180 }), '2026-04-17');
  // Extended support moves it, because it moves the deadline.
  assert.equal(latestStart({ endOfSupport: '2026-10-14', extendedUntil: '2029-10-09', leadTimeDays: 180 }), '2029-04-12');
  assert.equal(latestStart({ endOfSupport: '2026-10-14' }), undefined);
  assert.equal(latestStart({ leadTimeDays: 180 }), undefined);
});

test('supportWindowOf is undefined without a vendor date rather than "standard"', () => {
  // „Nobody told us when this dies" and „this is inside standard support" are different
  // facts, and collapsing them would report an empty timeline as safe.
  assert.equal(supportWindowOf('2026-01-01', {}), undefined);
  assert.equal(supportWindowOf(undefined, { endOfSupport: '2026-10-14' }), undefined);
});

test('supportWindowOf places a day in the three windows, both ends inclusive', () => {
  const plan = { endOfSupport: '2026-10-14', extendedUntil: '2029-10-09' };
  assert.equal(supportWindowOf('2026-01-01', plan), 'standard');
  assert.equal(supportWindowOf('2026-10-14', plan), 'standard'); // the last supported day
  assert.equal(supportWindowOf('2026-10-15', plan), 'extended');
  assert.equal(supportWindowOf('2029-10-09', plan), 'extended'); // the last extended day
  assert.equal(supportWindowOf('2029-10-10', plan), 'unsupported');
  // With no extended date bought, the day after end of support is already unsupported.
  assert.equal(supportWindowOf('2026-10-15', { endOfSupport: '2026-10-14' }), 'unsupported');
});

// ---- the freeze calendar ---------------------------------------------------------

test('freezeAt blocks both ends of a window', () => {
  const freezes = [freeze('ye', '2026-12-20', '2026-12-31', 'Year-end freeze')];
  assert.equal(freezeAt('2026-12-19', freezes), null);
  assert.equal(freezeAt('2026-12-20', freezes)?.id, 'ye');
  // Half-open would silently free the last day of every year-end freeze.
  assert.equal(freezeAt('2026-12-31', freezes)?.id, 'ye');
  assert.equal(freezeAt('2027-01-01', freezes), null);
});

test('nextFreeDay walks through chained windows rather than testing once', () => {
  const freezes = [freeze('a', '2026-12-20', '2026-12-31'), freeze('b', '2027-01-01', '2027-01-10')];
  assert.equal(nextFreeDay('2026-12-01', freezes), '2026-12-01');
  // Leaving `a` lands inside `b`, which is the normal case at a year end and not a
  // pathological one.
  assert.equal(nextFreeDay('2026-12-25', freezes), '2027-01-11');
});

test('previousFreeDay walks backwards through chained windows', () => {
  const freezes = [freeze('a', '2026-12-20', '2026-12-31'), freeze('b', '2027-01-01', '2027-01-10')];
  assert.equal(previousFreeDay('2027-01-05', freezes), '2026-12-19');
  assert.equal(previousFreeDay('2026-12-01', freezes), '2026-12-01');
});

test('parallelRunDays needs both ends and reports a negative run', () => {
  assert.equal(parallelRunDays({ cutover: '2026-09-01', shutdown: '2026-10-01' }), 30);
  assert.equal(parallelRunDays({ cutover: '2026-09-01' }), undefined);
  // Not clamped to zero: „the shutdown is before the cutover" is a fault to report.
  assert.equal(parallelRunDays({ cutover: '2026-10-01', shutdown: '2026-09-01' }), -30);
});

// ---- backward dating -------------------------------------------------------------

test('placeCutover counts back from the deadline and keeps the minimum parallel run', () => {
  const placed = placeCutover({
    plan: { endOfSupport: '2026-10-14', leadTimeDays: 180, start: '2026-03-01' },
    minParallelRunDays: 30,
    freezes: [],
    now: NOW,
  });
  assert.equal(placed.ok, true);
  assert.ok(placed.ok);
  assert.equal(placed.placement.shutdown, '2026-10-14');
  assert.equal(placed.placement.cutover, '2026-09-14');
  assert.equal(placed.placement.parallelRunDays, 30);
  assert.equal(placed.placement.movedOutOf, undefined);
});

test('placeCutover refuses without a vendor date and without a configured minimum', () => {
  const noDate = placeCutover({ plan: { leadTimeDays: 180 }, minParallelRunDays: 30, freezes: [], now: NOW });
  assert.equal(noDate.ok, false);
  assert.ok(!noDate.ok);
  assert.equal(noDate.reason, 'no-deadline');

  // No fallback minimum: the sources disagree by an order of magnitude, so the rule
  // says it cannot answer instead of picking one.
  const noMin = placeCutover({
    plan: { endOfSupport: '2026-10-14', leadTimeDays: 180 },
    minParallelRunDays: undefined,
    freezes: [],
    now: NOW,
  });
  assert.equal(noMin.ok, false);
  assert.ok(!noMin.ok);
  assert.equal(noMin.reason, 'no-minimum');
});

test('placeCutover moves a cutover that lands in a freeze EARLIER, lengthening the run', () => {
  // The boundary the acceptance criteria name: the first candidate is already inside a
  // window. Moving later would trade away the minimum it was just given, so it moves
  // back — and the parallel run gets longer, never shorter.
  const placed = placeCutover({
    plan: { endOfSupport: '2027-01-15', leadTimeDays: 300 },
    minParallelRunDays: 20,
    freezes: [freeze('ye', '2026-12-20', '2026-12-31', 'Year-end freeze')],
    now: NOW,
  });
  assert.ok(placed.ok);
  // 2027-01-15 minus 20 days is 2026-12-26, inside the window.
  assert.equal(placed.placement.cutover, '2026-12-19');
  assert.equal(placed.placement.movedOutOf?.id, 'ye');
  assert.equal(placed.placement.parallelRunDays, 27);
  assert.ok(placed.placement.parallelRunDays > 20);
});

test('placeCutover refuses when a freeze window is longer than the time that is left', () => {
  // The second named boundary. The freeze reaches back past everything the plan has
  // room for, so the freeze calendar and the vendor's date are jointly unsatisfiable.
  // Returning *some* date here would present a plan that cannot be run.
  const placed = placeCutover({
    plan: { endOfSupport: '2026-10-14', leadTimeDays: 180, start: '2026-09-01' },
    minParallelRunDays: 30,
    freezes: [freeze('long', '2026-01-01', '2026-10-14', 'Whole-year freeze')],
    now: NOW,
  });
  assert.equal(placed.ok, false);
  assert.ok(!placed.ok);
  assert.equal(placed.reason, 'no-room-before-start');
  assert.equal(placed.freeze?.id, 'long');
});

test('placeCutover reports "no admissible day at all" when the walk runs off the calendar', () => {
  const placed = placeCutover({
    plan: { endOfSupport: '2026-10-14', leadTimeDays: 180 },
    minParallelRunDays: 30,
    // A window with no reachable start: walking back never leaves it inside the bound.
    freezes: [freeze('forever', '1990-01-01', '2026-10-14', 'Everything')],
    now: NOW,
  });
  assert.equal(placed.ok, false);
  assert.ok(!placed.ok);
  assert.equal(placed.reason, 'freeze-blocks-every-day');
});

test('placeCutover still places a plan whose end-of-support date is in the past', () => {
  // The third named boundary. Every date it produces is behind us, and that is the
  // honest answer: reporting „cannot compute" would hide a migration that has already
  // missed its date.
  const placed = placeCutover({
    plan: { endOfSupport: '2025-10-14', leadTimeDays: 180 },
    minParallelRunDays: 30,
    freezes: [],
    now: NOW,
  });
  assert.ok(placed.ok);
  assert.equal(placed.placement.shutdown, '2025-10-14');
  assert.equal(placed.placement.cutover, '2025-09-14');
  assert.equal(placed.placement.deadlinePast, true);
});

test('placeCutover flags a plan that starts after the latest possible start', () => {
  const placed = placeCutover({
    plan: { endOfSupport: '2026-10-14', leadTimeDays: 180, start: '2026-08-01' },
    minParallelRunDays: 30,
    freezes: [],
    now: NOW,
  });
  assert.ok(placed.ok);
  // Latest start is 2026-04-17; the plan starts three and a half months after it.
  assert.equal(placed.placement.startsLate, true);
});

// ---- reading the plans ------------------------------------------------------------

test('readPlan takes the lead time from the item, falling back to the config', () => {
  assert.equal(readPlan(item('a', { leadTimeDays: 90 }), { defaultLeadTimeDays: 180 }).leadTimeDays, 90);
  assert.equal(readPlan(item('a'), { defaultLeadTimeDays: 180 }).leadTimeDays, 180);
  assert.equal(readPlan(item('a'), {}).leadTimeDays, undefined);
  // An unusable value falls back rather than being read as a number.
  assert.equal(readPlan(item('a', { leadTimeDays: 'bald' }), { defaultLeadTimeDays: 180 }).leadTimeDays, 180);
});

test('readPlans keeps only items that say something about a lifecycle', () => {
  const f = file([
    item('a', { endOfSupport: '2026-10-14' }),
    item('b', { system: 'Exchange' }),
    item('c'), // nothing at all
    { id: '', content: 'no id', metadata: { endOfSupport: '2026-10-14' } } as TimelineFileItem,
  ]);
  assert.deepEqual(readPlans(f).map((p) => p.itemId), ['a', 'b']);
});

// ---- the risk report --------------------------------------------------------------

test('risksOf reports what it cannot judge, not only what is wrong', () => {
  // Silence would read as safety on a timeline where nobody filled in a vendor date.
  const risks = risksOf({
    plans: readPlans(file([item('a', { system: 'Exchange' })])),
    freezes: [],
    config: {},
    now: NOW,
  });
  assert.deepEqual(risks.map((r) => r.kind), ['no-end-of-support']);
});

test('risksOf finds a plan that starts after the latest possible start', () => {
  const risks = risksOf({
    plans: readPlans(file([item('a', { endOfSupport: '2026-10-14', leadTimeDays: 180, start: '2026-08-01' })])),
    freezes: [],
    config: {},
    now: NOW,
  });
  const late = risks.find((r) => r.kind === 'starts-after-latest-start');
  assert.ok(late);
  assert.equal(late.day, '2026-04-17');
  assert.equal(late.days, 106);
});

test('risksOf finds a shutdown after the deadline, a frozen cutover and a short run', () => {
  const risks = risksOf({
    plans: readPlans(
      file([
        item('a', {
          endOfSupport: '2026-10-14',
          leadTimeDays: 180,
          start: '2026-01-01',
          cutover: '2026-12-22',
          shutdown: '2026-12-27',
        }),
      ]),
    ),
    freezes: [freeze('ye', '2026-12-20', '2026-12-31', 'Year-end freeze')],
    config: { minParallelRunDays: 30 },
    now: NOW,
  });
  const kinds = risks.map((r) => r.kind);
  assert.ok(kinds.includes('shutdown-after-deadline'));
  assert.ok(kinds.includes('cutover-in-freeze'));
  assert.ok(kinds.includes('parallel-run-too-short'));
  assert.equal(risks.find((r) => r.kind === 'cutover-in-freeze')?.freeze?.id, 'ye');
});

test('risksOf reports a negative parallel run as its own fault, not as a short one', () => {
  const risks = risksOf({
    plans: readPlans(
      file([item('a', { endOfSupport: '2027-10-14', leadTimeDays: 180, cutover: '2026-10-01', shutdown: '2026-09-01' })]),
    ),
    freezes: [],
    config: { minParallelRunDays: 30 },
    now: NOW,
  });
  const kinds = risks.map((r) => r.kind);
  assert.ok(kinds.includes('shutdown-before-cutover'));
  assert.ok(!kinds.includes('parallel-run-too-short'));
});

test('risksOf reports a past deadline and does not also demand a lead time answer', () => {
  const risks = risksOf({
    plans: readPlans(file([item('a', { endOfSupport: '2025-10-14' })])),
    freezes: [],
    config: {},
    now: NOW,
  });
  const kinds = risks.map((r) => r.kind);
  assert.ok(kinds.includes('deadline-past'));
  assert.ok(kinds.includes('no-lead-time'));
});

test('risksOf finds nothing wrong with a plan that holds', () => {
  const risks = risksOf({
    plans: readPlans(
      file([
        item('a', {
          endOfSupport: '2026-10-14',
          leadTimeDays: 180,
          start: '2026-03-01',
          cutover: '2026-09-14',
          shutdown: '2026-10-14',
        }),
      ]),
    ),
    freezes: [freeze('ye', '2026-12-20', '2026-12-31')],
    config: { minParallelRunDays: 30 },
    now: NOW,
  });
  assert.deepEqual(risks, []);
});

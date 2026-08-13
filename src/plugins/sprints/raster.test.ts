import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LENGTH_DAYS,
  DEFAULT_SCALE,
  isDayString,
  rasterFrom,
  readSprintConfig,
  shiftDayString,
  sprintFirstDay,
  sprintLabel,
  sprintOfDay,
  sprintOfItem,
  sprintValue,
  sprintsInPlay,
  type SprintRaster,
} from './raster';
import type { TimelineFileItem } from '../../types';

// The raster is the rule the whole plugin rests on: the lanes a user sees and the
// capacity sums an agent gets are both bucketed by it, so an off-by-one here is wrong
// in two places at once and looks right in both. These are the boundaries a
// practitioner would name.

const raster = (over: Partial<SprintRaster> = {}): SprintRaster => ({
  anchor: '2026-01-05',
  lengthDays: 14,
  velocity: 20,
  scale: [...DEFAULT_SCALE],
  ...over,
});

const item = (over: Partial<TimelineFileItem> = {}): TimelineFileItem => ({ content: 'x', ...over });

/**
 * The local calendar day of an instant, exactly the way `localDay` (src/date.ts)
 * writes one. The zone tests below assert against this rather than against a fixed
 * day, so they state the rule („the sprint of the day the viewer draws it on") and hold
 * in any timezone. A rule that only holds in Europe/Berlin, where `npm test` pins the
 * suite, is still a bug.
 */
const localDayOf = (value: string): string => {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Is the suite running in the zone `npm test` pins it to? */
const BERLIN = new Date('2026-02-15T12:00:00Z').getTimezoneOffset() === -60;

// ---- reading the config -----------------------------------------------------

test('an empty config yields no raster, because the anchor is what sprint 1 is', () => {
  const config = readSprintConfig({});
  assert.equal(config.start, null);
  assert.equal(config.lengthDays, DEFAULT_LENGTH_DAYS);
  assert.equal(config.velocity, null);
  assert.deepEqual(config.scale, [...DEFAULT_SCALE]);
  assert.equal(rasterFrom(config), null);
});

test('a malformed config is read, never thrown on', () => {
  // The bag is user-editable data and `derive` runs over every item on every build, so
  // an exception here would cost the plugin its values on all of them.
  for (const bag of [
    { start: 'irgendwann', lengthDays: 'zwei Wochen', velocity: 'viel', scale: 'nope' },
    { start: 42, velocity: {}, scale: [null, '', '  '] },
    // A day that does not exist must not roll forward into March: the item would land
    // in a sprint the author never wrote down.
    { start: '2026-02-31' },
  ] as Record<string, unknown>[]) {
    const config = readSprintConfig(bag);
    assert.equal(config.start, null, JSON.stringify(bag));
    assert.equal(config.velocity, null);
    assert.deepEqual(config.scale, [...DEFAULT_SCALE]);
    assert.equal(rasterFrom(config), null);
  }
  assert.equal(readSprintConfig(undefined).start, null);
  assert.equal(readSprintConfig(null).start, null);
});

test('a lengthDays of 0 or below yields no raster rather than a guessed cadence', () => {
  // The failure this prevents is a silent one: falling back to 14 would bucket every
  // item against a cadence nobody configured, and nothing in the interface would say
  // so. Dividing by 0 or looping on a negative length is the other half.
  for (const lengthDays of [0, -14, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const config = readSprintConfig({ start: '2026-01-05', lengthDays });
    assert.equal(config.lengthDays, null, `lengthDays ${lengthDays}`);
    assert.equal(rasterFrom(config), null);
  }
  // A length of one day is legitimate, however unusual.
  assert.equal(readSprintConfig({ start: '2026-01-05', lengthDays: 1 }).lengthDays, 1);
});

test('numbers written as strings are accepted, because nothing validates a hand-written file', () => {
  const config = readSprintConfig({ start: '2026-01-05', lengthDays: '7', velocity: '12.5', scale: [1, 2, 2, 3] });
  assert.equal(config.lengthDays, 7);
  assert.equal(config.velocity, 12.5);
  assert.deepEqual(config.scale, ['1', '2', '3']);
});

test('velocity 0, negative or unparseable is the same case as absent: no yardstick', () => {
  for (const velocity of [0, -5, 'viel', {}, null]) {
    assert.equal(readSprintConfig({ start: '2026-01-05', velocity }).velocity, null, `velocity ${String(velocity)}`);
  }
});

// ---- which sprint a day is in -----------------------------------------------

test('the anchor day is sprint 1, and every boundary belongs to the sprint it opens', () => {
  const r = raster();
  assert.equal(sprintOfDay(r, '2026-01-05'), 1);
  assert.equal(sprintOfDay(r, '2026-01-18'), 1); // last day of sprint 1
  assert.equal(sprintOfDay(r, '2026-01-19'), 2); // exactly on the next boundary
  assert.equal(sprintOfDay(r, '2026-02-02'), 3);
});

test('a day before the anchor has no sprint, never a „Sprint 0"', () => {
  const r = raster();
  assert.equal(sprintOfDay(r, '2026-01-04'), null);
  assert.equal(sprintOfDay(r, '2025-12-15'), null);
});

test('an item with no start has no sprint, and lands in the „Ohne …" bucket', () => {
  const r = raster();
  assert.equal(sprintOfItem(r, item()), null);
  assert.equal(sprintOfItem(r, item({ start: '' })), null);
  assert.equal(sprintOfItem(r, item({ start: 'bald' })), null);
});

test('an item spanning several sprints belongs to the one its start falls into', () => {
  // One item, one lane, counted exactly once by the capacity sum. The trade is that a
  // long item is absent from the sprints it runs through (README, question 1).
  const r = raster();
  assert.equal(sprintOfItem(r, item({ start: '2026-03-02', duration: '4w' })), 5);
  assert.equal(sprintOfItem(r, item({ start: '2026-03-02', end: '2026-03-30' })), 5);
});

test('a sprint boundary across a clock change counts calendar days, not 24-hour blocks', () => {
  // Europe/Berlin springs forward on 2026-03-29, so local midnight to local midnight
  // is 23 hours there. Subtracting two timestamps and dividing by 86_400_000 returns
  // 83.96 days for 2026-03-30 against the anchor, floors to 83, and puts the item in
  // sprint 6 instead of 7, and every item after that date one sprint off, silently.
  // The example timeline has an item on exactly that day.
  const r = raster();
  assert.equal(sprintOfDay(r, '2026-03-29'), 6);
  assert.equal(sprintOfDay(r, '2026-03-30'), 7);
  assert.equal(sprintFirstDay(r, 7), '2026-03-30');
  // And once more past the autumn change (2026-10-25), where the error is the other way.
  assert.equal(sprintOfDay(r, '2026-10-26'), 22);
  assert.equal(sprintFirstDay(r, 22), '2026-10-26');
});

test('a start with a time component is still a calendar day', () => {
  assert.equal(sprintOfItem(raster(), item({ start: '2026-01-19T09:30:00' })), 2);
});

test('a start carrying a zone is bucketed on the day the viewer draws it', () => {
  // `parseLocalDay` (src/date.ts) reads a BARE day as written and hands anything with a
  // time component to `new Date(value)`, which honours a `Z` or an offset. Reading only
  // the leading `YYYY-MM-DD` of every string instead put the sums and the lanes on
  // different days: `2026-02-15T23:00:00Z` is 2026-02-16 in Europe/Berlin, so the bar
  // sits in sprint 4 while the capacity sum counted it in sprint 3. Both are
  // schema-valid values an MCP `add_item` can write.
  const r = raster();
  for (const value of ['2026-02-15T23:00:00Z', '2026-02-16T00:30:00+02:00', '2026-03-29T22:30:00Z']) {
    assert.equal(sprintOfDay(r, value), sprintOfDay(r, localDayOf(value)), value);
    assert.equal(sprintOfItem(r, item({ start: value })), sprintOfDay(r, localDayOf(value)), value);
  }
  // The two exact cases from the report, in the zone `npm test` pins the suite to. Kept
  // beside the timezone-free assertions above rather than instead of them: the numbers
  // are what a reader can check against the example, the rule is what has to hold
  // everywhere.
  if (BERLIN) {
    assert.equal(sprintOfDay(r, '2026-02-15T23:00:00Z'), 4);
    assert.equal(sprintOfDay(r, '2026-02-16T00:30:00+02:00'), 3);
  }
});

test('„is this a date at all" is a different question from „which sprint"', () => {
  // `sprintOfDay` answers null for both „before the anchor" and „not a date", and a
  // caller that treats the two alike states a confident number over an argument it
  // could not read (see `forecast_completion`).
  assert.equal(isDayString('2026-01-04'), true);
  assert.equal(sprintOfDay(raster(), '2026-01-04'), null);
  for (const value of ['', '   ', 'heute', '2026-13-40', '2026-02-31', undefined, null, 42, {}]) {
    assert.equal(isDayString(value), false, JSON.stringify(value) ?? String(value));
  }
});

test('a one-day cadence puts every day in its own sprint', () => {
  const r = raster({ lengthDays: 1 });
  assert.equal(sprintOfDay(r, '2026-01-05'), 1);
  assert.equal(sprintOfDay(r, '2026-01-06'), 2);
});

// ---- the set of sprints in play ---------------------------------------------

test('only the sprints the items occupy are in play, in chronological order', () => {
  // A sprint holding nothing offers no option and gets no lane, so grouping shows the
  // sprints in play rather than a run of empty ones out to the end of the raster.
  const items = [
    item({ start: '2026-02-02' }), // 3
    item({ start: '2026-01-05' }), // 1
    item({}), // none
    item({ start: '2025-12-15' }), // before the anchor
    item({ start: '2026-03-30' }), // 7, sprint 6 stays empty
    item({ start: '2026-02-09' }), // 3 again
  ];
  assert.deepEqual(sprintsInPlay(raster(), items), [1, 3, 7]);
  assert.deepEqual(sprintsInPlay(raster(), []), []);
});

// ---- the field value, and shifting a date -----------------------------------

test('the field stores an id and shows a label', () => {
  // A filter or a saved view persists the value, so it must not be German interface
  // text that a rewording would orphan.
  assert.equal(sprintValue(7), 'sprint-7');
  assert.equal(sprintLabel(7), 'Sprint 7');
});

test('shifting a date moves whole calendar days and keeps the time of day', () => {
  assert.equal(shiftDayString('2026-02-11', 14), '2026-02-25');
  // Across the spring change again: 24-hour arithmetic would return 2026-04-11T23:00.
  assert.equal(shiftDayString('2026-03-29', 14), '2026-04-12');
  assert.equal(shiftDayString('2026-01-05T09:30:00', 14), '2026-01-19T09:30:00');
  assert.equal(shiftDayString('irgendwann', 14), null);
  assert.equal(shiftDayString(undefined, 14), null);
  // A tail that carries a zone keeps it, and the written day is what moves: shifting the
  // local day and re-attaching the same `Z` would move the instant by fifteen days.
  assert.equal(shiftDayString('2026-02-15T23:00:00Z', 14), '2026-03-01T23:00:00Z');
  assert.equal(shiftDayString('2026-03-29 09:30', 14), '2026-04-12 09:30');
});

test('shifting refuses a value that merely starts like a day', () => {
  // The day pattern had no `$` and the tail was taken with `slice(10)`, so
  // „2026-03-2900" read as the day 2026-03-29 with a tail of „00" and shifted to
  // „2026-04-1200" — a value the day parser then refuses, so the item silently lost its
  // sprint after the move and nothing said why.
  for (const value of ['2026-03-2900', '2026-03-29-01', '2026-03-29x', '2026-03-290']) {
    assert.equal(shiftDayString(value, 14), null, value);
  }
  // And a day that does not exist stays refused, tail or no tail.
  assert.equal(shiftDayString('2026-02-31', 14), null);
});

test('a shift out of the four-digit year range is refused rather than emitted', () => {
  // „10000-01-13" is not a day string either: the parser refuses it, so the item came
  // out of the move without a sprint. A refusal names the item instead.
  assert.equal(shiftDayString('9999-12-30', 14), null);
  assert.equal(shiftDayString('1000-01-05', -14), null);
  // Inside the range the shift still works right up to the edge.
  assert.equal(shiftDayString('9999-12-01', 14), '9999-12-15');
});

test('sprintFirstDay refuses a sprint number that is not one', () => {
  const r = raster();
  assert.equal(sprintFirstDay(r, 1), '2026-01-05');
  assert.equal(sprintFirstDay(r, 0), null);
  assert.equal(sprintFirstDay(r, 1.5), null);
});

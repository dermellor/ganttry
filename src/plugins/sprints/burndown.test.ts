// The burndown's arithmetic, proven without a DOM.
//
// Every case here is one the chart would draw plausibly if it were wrong: an ideal
// line that burns through a weekend, a reconstruction that treats a missing
// estimate as zero, a frozen series silently repaired. A screenshot cannot tell any
// of them from the correct picture, which is why they are asserted here rather than
// looked at.
//
// The window used throughout is 2026-03-02 (Mon) to 2026-03-13 (Fri): twelve
// calendar days, ten of them working days, with 2026-03-07/08 the weekend in the
// middle. A scope of 20 over ten working days burns 2 a day, so every expected
// value below is exact rather than rounded — a test whose arithmetic needs rounding
// to pass cannot tell a formula error from a float.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  MAX_SPRINT_DAYS,
  axisMax,
  frozenSeries,
  idealSeries,
  isWorkingDay,
  itemEndDay,
  parseEstimate,
  polylinePoints,
  reconstructSeries,
  round2,
  scopeAndCompleted,
  splitAtGaps,
  sprintDays,
  tickIndices,
  xForIndex,
  yForValue,
  type BurndownItem,
  type PlotBox,
} from './burndown';
import { shiftDayString } from './raster';
import {
  estimateOf,
  isDone,
  itemsOfSprint,
  readReports,
  readSprints,
  reportOfSprint,
  sprintWindow,
  type Sprint,
} from './sprints';
import type { TimelineFile } from '../../types';

const WINDOW = { start: '2026-03-02', end: '2026-03-13' };
const DAYS = sprintDays(WINDOW.start, WINDOW.end);

// ---- days ------------------------------------------------------------------

test('sprintDays covers both ends of the window', () => {
  assert.equal(DAYS.length, 12);
  assert.equal(DAYS[0], '2026-03-02');
  assert.equal(DAYS[DAYS.length - 1], '2026-03-13');
});

test('sprintDays refuses a window it cannot read, rather than inventing an axis', () => {
  assert.deepEqual(sprintDays('2026-03-13', '2026-03-02'), [], 'end before start');
  assert.deepEqual(sprintDays('2026-02-31', '2026-03-02'), [], 'a day that does not exist');
  assert.deepEqual(sprintDays(undefined, '2026-03-02'), [], 'no start');
  assert.deepEqual(sprintDays('2026-03-02', ''), [], 'no end');
});

test('a one-day window is one day, not zero', () => {
  assert.deepEqual(sprintDays('2026-03-09', '2026-03-09'), ['2026-03-09']);
});

test('a window longer than a sprint is refused rather than drawn', () => {
  // Canon fixes a sprint at one month or less, so a window of a century is a
  // mistyped row. Building its axis would emit 36 500 SVG nodes and hang the tab.
  assert.deepEqual(sprintDays('2026-01-01', '2126-01-01'), []);
  assert.equal(sprintDays('2026-01-01', '2026-12-31').length, 365, 'a year still draws');
  assert.ok(MAX_SPRINT_DAYS >= 365);
});

test('a date carrying a zone burns on the local day the viewer draws it on', () => {
  // Europe/Berlin, which `npm test` pins: 23:00Z is the next local day. Reading
  // only the leading day would burn this item one column to the left of its bar.
  const out = reconstructSeries(
    DAYS,
    [item({ id: 'a', estimate: 4, done: true, end: '2026-03-02T23:00:00Z' })],
    '2026-03-04',
  );
  assert.deepEqual(
    out.points.map((p) => p.remaining),
    [4, 0, 0],
    'burned on 03-03, not on 03-02',
  );
});

test('isWorkingDay is Monday to Friday', () => {
  assert.equal(isWorkingDay('2026-03-06'), true, 'Friday');
  assert.equal(isWorkingDay('2026-03-07'), false, 'Saturday');
  assert.equal(isWorkingDay('2026-03-08'), false, 'Sunday');
  assert.equal(isWorkingDay('2026-03-09'), true, 'Monday');
  assert.equal(isWorkingDay('nicht ein Tag'), false);
});

// ---- the ideal line --------------------------------------------------------

test('the ideal line flattens over the weekend instead of burning through it', () => {
  // Nine working days AFTER the anchor day, so each of them burns 20/9 ≈ 2.22.
  const ideal = idealSeries(DAYS, 20);
  assert.deepEqual(
    ideal.map((p) => p.remaining),
    [20, 17.78, 15.56, 13.33, 11.11, 11.11, 11.11, 8.89, 6.67, 4.44, 2.22, 0],
  );
  // The two flat steps are the weekend, and they are what a plain straight line
  // gets wrong: it would read 20 * (1 - 1/11) ≈ 18.18 on day two.
  assert.equal(ideal[4].day, '2026-03-06');
  assert.equal(ideal[5].day, '2026-03-07');
  assert.equal(ideal[6].day, '2026-03-08');
  assert.equal(ideal[5].remaining, ideal[4].remaining);
  assert.equal(ideal[6].remaining, ideal[4].remaining);
});

test('the ideal line opens at the full scope and ends at zero, for every window length', () => {
  // The anchor is the convention every product that draws a guideline follows, and
  // burning the first day too was the bug: on a sprint of 13 the plan opened at 11.7
  // while the actual line opened at 13, so day one drew the team behind before
  // anything had happened.
  assert.equal(idealSeries(DAYS, 13)[0].remaining, 13);
  assert.equal(idealSeries(DAYS, 13)[11].remaining, 0);
  for (let length = 2; length <= 60; length++) {
    const days = sprintDays('2026-03-02', shiftDayString('2026-03-02', length - 1));
    assert.equal(days.length, length, `window of ${length} days`);
    const ideal = idealSeries(days, 13);
    assert.equal(ideal[0].remaining, 13, `first point of ${length} days`);
    assert.equal(ideal[ideal.length - 1].remaining, 0, `last point of ${length} days`);
  }
});

test('a one-day sprint is a single point, and it is the scope', () => {
  // One x position can only carry the anchor, and „13 geplant an dem einen Tag, den
  // dieser Sprint hat" is the true half of what a one-position axis can say. A single
  // point at zero read as a plan that was already finished when it started.
  assert.deepEqual(idealSeries(['2026-03-09'], 8), [{ day: '2026-03-09', remaining: 8 }]);
});

test('a sprint with zero scope is a flat line at zero, never a division by nothing', () => {
  const ideal = idealSeries(DAYS, 0);
  assert.equal(ideal.length, 12);
  assert.ok(
    ideal.every((p) => p.remaining === 0),
    'every point at zero',
  );
});

test('a sprint placed entirely on a weekend burns over its own days', () => {
  // No working day in the window at all. A line that stayed flat at the full scope
  // would say the plan never finishes, which is a claim about the calendar rather
  // than about the sprint.
  assert.deepEqual(
    idealSeries(['2026-03-07', '2026-03-08'], 4).map((p) => p.remaining),
    [4, 0],
  );
});

test('a window whose only working day is its first still reaches zero', () => {
  // Friday, Saturday, Sunday: the one working day is the anchor, so nothing is left to
  // burn on. Counting the remaining days instead is what keeps the line from claiming
  // a plan that never finishes.
  assert.deepEqual(
    idealSeries(['2026-03-06', '2026-03-07', '2026-03-08'], 4).map((p) => p.remaining),
    [4, 2, 0],
  );
});

test('the ideal line of an empty window is empty', () => {
  assert.deepEqual(idealSeries([], 20), []);
});

test('the ideal line is drawn at two decimals, not at float precision', () => {
  // 20 over the 2 working days after the anchor: 6.666666666666668 in a label is
  // false precision.
  const ideal = idealSeries(['2026-03-09', '2026-03-10', '2026-03-11'], 20);
  assert.deepEqual(
    ideal.map((p) => p.remaining),
    [20, 10, 0],
  );
  assert.deepEqual(
    idealSeries(['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12'], 20).map((p) => p.remaining),
    [20, 13.33, 6.67, 0],
  );
});

test('a scope that is not a representable number draws no plan at all', () => {
  // The guard the geometry needs: `Infinity * (1 - 1/9)` is Infinity and
  // `yForValue` turned it into „0,NaN" in the markup, which draws nothing while the
  // legend still names the line.
  assert.deepEqual(idealSeries(DAYS, Number.POSITIVE_INFINITY), []);
  assert.deepEqual(idealSeries(DAYS, Number.NaN), []);
  assert.deepEqual(idealSeries(DAYS, null), []);
});

// ---- estimates -------------------------------------------------------------

test('a usable estimate is a plain decimal above zero, and nothing else', () => {
  assert.equal(parseEstimate('8'), 8);
  assert.equal(parseEstimate('8.5'), 8.5);
  assert.equal(parseEstimate(' 3 '), 3);
  assert.equal(parseEstimate(5), 5);
  assert.equal(parseEstimate(''), null);
  assert.equal(parseEstimate('XL'), null);
  assert.equal(parseEstimate(0), null, 'zero cannot move a sum, so it is named instead');
  assert.equal(parseEstimate('-3'), null);
  assert.equal(parseEstimate('0x10'), null, 'Number() would read 16');
  assert.equal(parseEstimate('1e3'), null, 'Number() would read 1000');
  assert.equal(parseEstimate([8]), null);
  assert.equal(parseEstimate(undefined), null);
});

test('round2 survives a value whose scaling overflows', () => {
  assert.equal(round2(2e307), 2e307);
  assert.equal(round2(13.333333333333334), 13.33);
});

// ---- the reconstructed actual line -----------------------------------------

const item = (over: Partial<BurndownItem> & { id: string }): BurndownItem => ({
  estimate: 5,
  done: false,
  start: null,
  end: null,
  ...over,
});

test('the two sums are one function, so a header cannot disagree with the curve', () => {
  const items = [
    item({ id: 'a', estimate: 5, done: true }),
    item({ id: 'b', estimate: 3, done: false }),
    item({ id: 'c', estimate: null, done: true }),
  ];
  const sums = scopeAndCompleted(items);
  assert.deepEqual(sums, { scope: 8, completed: 5, unestimated: ['c'] });
  // The same numbers the reconstruction reports, because it calls this rather than
  // summing again: two summations of one scope is how the header ends up one item
  // away from the line under it.
  const out = reconstructSeries(DAYS, items, '2026-03-04');
  assert.equal(out.scope, sums.scope);
  assert.equal(out.completed, sums.completed);
  assert.deepEqual(out.unestimated, sums.unestimated);
});

test('the sums are answerable without a window, which is what the header needs', () => {
  assert.deepEqual(scopeAndCompleted([]), { scope: 0, completed: 0, unestimated: [] });
});

test('a sprint counted in items counts entries, never their story points', () => {
  // A capacity of 3 „Einträge" against items of 8 and 13 points was reported as
  // „Umfang 21 von 3 Einträgen (überbucht)": a story-point sum compared against a count.
  const items = [
    item({ id: 'a', estimate: 8, done: true, end: '2026-03-03' }),
    item({ id: 'b', estimate: 13, done: false }),
    // No estimate: an entry is one entry whether or not anybody sized it, so nothing is
    // missing from this sum and the item is not named as unmeasurable.
    item({ id: 'c', estimate: null, done: true, end: '2026-03-04' }),
  ];
  assert.deepEqual(scopeAndCompleted(items, 'items'), { scope: 3, completed: 2, unestimated: [] });
  assert.deepEqual(scopeAndCompleted(items, 'points'), { scope: 21, completed: 8, unestimated: ['c'] });
  // The curve is built in the same unit, or the y axis carries points under a label
  // that says entries.
  assert.deepEqual(
    reconstructSeries(DAYS, items, '2026-03-05', 'items').points.map((p) => p.remaining),
    [3, 2, 1, 1],
  );
  assert.deepEqual(
    reconstructSeries(DAYS, items, '2026-03-05', 'points').points.map((p) => p.remaining),
    [21, 13, 13, 13],
  );
});

test('a sum that is not a representable number is null, never a coordinate', () => {
  // Two estimates of 1e308 are each a number and their sum is not. It used to be plotted:
  // the header printed „Infinity" and the polyline came out as „0,NaN 7.69,NaN".
  const items = [
    item({ id: 'a', estimate: 1e308, done: true, end: '2026-03-03' }),
    item({ id: 'b', estimate: 1e308, done: true, end: '2026-03-04' }),
  ];
  const sums = scopeAndCompleted(items);
  assert.equal(sums.scope, null);
  assert.equal(sums.completed, null);
  const out = reconstructSeries(DAYS, items, '2026-03-05');
  assert.equal(out.scope, null);
  assert.deepEqual(out.points, [], 'no line rather than a line of NaN');
  // …and nothing downstream of it produces a coordinate either.
  assert.deepEqual(idealSeries(DAYS, sums.scope), []);
  assert.equal(axisMax(sums.scope), 0);
  const box: PlotBox = { left: 40, top: 10, width: 400, height: 200 };
  assert.equal(polylinePoints([{ day: '2026-03-02', remaining: Number.NaN }], DAYS, 20, box), '');
  assert.equal(polylinePoints([{ day: '2026-03-02', remaining: 5 }], DAYS, Number.POSITIVE_INFINITY, box), '');
  // A single huge estimate stays usable: it is a representable number, `estimateOf`
  // accepts it too, and refusing it here would make the two readings disagree.
  assert.equal(parseEstimate(1e308), 1e308);
  assert.equal(scopeAndCompleted([item({ id: 'a', estimate: 1e308 })]).scope, 1e308);
});

test('an item carrying a duration burns on the day it ENDS, not on the day it started', () => {
  // The bug this reversed: every item in the shipped example carries `duration` and no
  // `end`, so a reconstruction that read „end, else start" described when work BEGAN.
  // The resolution goes through the core's own `endFromDuration` (host API 1.6), which
  // is the function the viewer places the bar with.
  assert.equal(itemEndDay(item({ id: 'a', start: '2026-03-02', duration: '1w' })), '2026-03-09');
  assert.equal(itemEndDay(item({ id: 'a', start: '2026-03-02', duration: '2d' })), '2026-03-04');
  // A written end wins over a duration, in the core's order.
  assert.equal(itemEndDay(item({ id: 'a', start: '2026-03-02', end: '2026-03-05', duration: '2w' })), '2026-03-05');
  // A milestone has no extent, so a stray duration on it must not burn on a day no bar
  // covers.
  assert.equal(itemEndDay(item({ id: 'a', start: '2026-03-02', duration: '1w', point: true })), '2026-03-02');
  // Nothing usable to resolve with: the start is the day the work landed on.
  assert.equal(itemEndDay(item({ id: 'a', start: '2026-03-02', duration: 'bald' })), '2026-03-02');
  assert.equal(itemEndDay(item({ id: 'a' })), null);

  const out = reconstructSeries(
    DAYS,
    [item({ id: 'a', estimate: 6, done: true, start: '2026-03-02', duration: '2d' })],
    '2026-03-06',
  );
  assert.deepEqual(
    out.points.map((p) => p.remaining),
    [6, 6, 0, 0, 0],
    'burned on 03-04, three days after it started',
  );
});

test('the reconstruction burns each done item on its end date', () => {
  const items = [
    item({ id: 'a', estimate: 5, done: true, end: '2026-03-03' }),
    item({ id: 'b', estimate: 3, done: true, end: '2026-03-05' }),
    item({ id: 'c', estimate: 2, done: false, end: '2026-03-12' }),
  ];
  const out = reconstructSeries(DAYS, items, '2026-03-06');
  assert.equal(out.scope, 10);
  assert.equal(out.completed, 8);
  assert.deepEqual(
    out.points.map((p) => p.remaining),
    [10, 5, 5, 2, 2],
    'one point per day up to asOf',
  );
  assert.equal(out.points.length, 5);
  assert.equal(out.points[4].day, '2026-03-06');
});

test('nothing is drawn past the day the reconstruction runs to', () => {
  const out = reconstructSeries(DAYS, [item({ id: 'a', done: true, end: '2026-03-03' })], '2026-03-04');
  assert.equal(out.points.length, 3, 'a burndown continuing into the future is a forecast');
});

test('asOf after the window stops at the last day of the sprint', () => {
  const out = reconstructSeries(DAYS, [item({ id: 'a', done: true, end: '2026-03-03' })], '2026-04-01');
  assert.equal(out.points.length, 12);
  assert.equal(out.points[11].day, '2026-03-13');
});

test('before the sprint starts there is no actual line at all', () => {
  const out = reconstructSeries(DAYS, [item({ id: 'a' })], '2026-02-20');
  assert.deepEqual(out.points, [], 'a single point at full scope would look like a measurement');
  assert.equal(out.scope, 5, 'the scope is still known');
});

test('an unreadable asOf yields no actual line rather than a line to today', () => {
  assert.deepEqual(reconstructSeries(DAYS, [item({ id: 'a' })], 'gestern').points, []);
});

test('an item done before the sprint started burns on the first day', () => {
  // Taiga computes its chart from completion dates the same way. The work is in
  // this sprint's scope, so it has to leave the scope somewhere, and the first day
  // is the only place a window can put it.
  const out = reconstructSeries(
    DAYS,
    [item({ id: 'early', estimate: 5, done: true, end: '2026-02-27' })],
    '2026-03-04',
  );
  assert.deepEqual(out.clampedToStart, ['early']);
  assert.deepEqual(
    out.points.map((p) => p.remaining),
    [0, 0, 0],
  );
});

test('a done item with no date, or one past the last drawn day, burns on that day', () => {
  // Otherwise the final point of the line disagrees with the completed figure
  // beside it, over the same two items.
  const out = reconstructSeries(
    DAYS,
    [
      item({ id: 'undated', estimate: 4, done: true, end: null }),
      item({ id: 'later', estimate: 6, done: true, end: '2026-03-20' }),
    ],
    '2026-03-04',
  );
  assert.deepEqual(out.clampedToAsOf.sort(), ['later', 'undated']);
  assert.deepEqual(
    out.points.map((p) => p.remaining),
    [10, 10, 0],
  );
  assert.equal(out.completed, 10, 'and the last point agrees with it');
});

test('an item with no usable estimate is named and never counted as zero', () => {
  const out = reconstructSeries(
    DAYS,
    [
      item({ id: 'sized', estimate: 8, done: false, end: '2026-03-10' }),
      item({ id: 'unsized', estimate: null, done: true, end: '2026-03-03' }),
    ],
    '2026-03-04',
  );
  assert.deepEqual(out.unestimated, ['unsized']);
  assert.equal(out.scope, 8, 'the unsized item is not in the scope');
  assert.equal(out.completed, 0, 'and finishing it moves nothing');
  assert.deepEqual(
    out.points.map((p) => p.remaining),
    [8, 8, 8],
    'the line does not dip for work it cannot measure',
  );
});

test('a reconstruction over an empty window has no points but keeps the numbers', () => {
  const out = reconstructSeries([], [item({ id: 'a', estimate: 3, done: true, end: '2026-03-03' })], '2026-03-04');
  assert.deepEqual(out.points, []);
  assert.equal(out.scope, 3);
  assert.equal(out.completed, 3);
});

test('two items finishing on one day burn together', () => {
  const out = reconstructSeries(
    DAYS,
    [
      item({ id: 'a', estimate: 3, done: true, end: '2026-03-03' }),
      item({ id: 'b', estimate: 4, done: true, end: '2026-03-03' }),
    ],
    '2026-03-04',
  );
  assert.deepEqual(
    out.points.map((p) => p.remaining),
    [7, 0, 0],
  );
});

// ---- the frozen series -----------------------------------------------------

test('a frozen series with gaps keeps its gaps', () => {
  const days = sprintDays('2026-03-02', '2026-03-06');
  const read = frozenSeries(days, [
    { day: '2026-03-02', remaining: 10 },
    { day: '2026-03-03', remaining: 8 },
    { day: '2026-03-05', remaining: 4 },
    { day: '2026-03-06', remaining: 0 },
  ]);
  assert.equal(read.malformed, 0);
  assert.deepEqual(read.outside, []);
  assert.deepEqual(
    read.points.map((p) => p.day),
    ['2026-03-02', '2026-03-03', '2026-03-05', '2026-03-06'],
    'nothing is filled in for 03-04',
  );
  assert.deepEqual(
    splitAtGaps(read.points, days).map((run) => run.map((p) => p.day)),
    [
      ['2026-03-02', '2026-03-03'],
      ['2026-03-05', '2026-03-06'],
    ],
    'drawn as two runs, so no line claims a value for the missing day',
  );
});

test('a frozen series whose dates run outside the window names them rather than drawing them', () => {
  const read = frozenSeries(DAYS, [
    { day: '2026-02-28', remaining: 22 },
    { day: '2026-03-02', remaining: 20 },
    { day: '2026-04-01', remaining: 0 },
  ]);
  assert.deepEqual(read.outside, ['2026-02-28', '2026-04-01']);
  assert.deepEqual(
    read.points.map((p) => p.day),
    ['2026-03-02'],
  );
});

test('a frozen series is never recomputed, so a stored value above the scope survives', () => {
  const read = frozenSeries(DAYS, [{ day: '2026-03-02', remaining: 34 }]);
  assert.equal(read.points[0].remaining, 34);
});

test('a frozen series is read in day order whatever order it was stored in', () => {
  const read = frozenSeries(DAYS, [
    { day: '2026-03-05', remaining: 4 },
    { day: '2026-03-02', remaining: 10 },
  ]);
  assert.deepEqual(
    read.points.map((p) => p.day),
    ['2026-03-02', '2026-03-05'],
  );
});

test('a day stored twice is one measurement written twice', () => {
  const read = frozenSeries(DAYS, [
    { day: '2026-03-02', remaining: 10 },
    { day: '2026-03-02', remaining: 3 },
  ]);
  assert.deepEqual(read.points, [{ day: '2026-03-02', remaining: 10 }]);
});

test('malformed entries are counted, so the view can say the record is damaged', () => {
  const read = frozenSeries(DAYS, [
    { day: 'irgendwann', remaining: 1 },
    { day: '2026-03-03' },
    { day: '2026-03-04', remaining: 'viel' },
    { day: '2026-03-05', remaining: Number.NaN },
    'nope',
    null,
    { day: '2026-03-06', remaining: 2 },
  ]);
  assert.equal(read.malformed, 6);
  assert.deepEqual(read.points, [{ day: '2026-03-06', remaining: 2 }]);
});

test('a series that is not a list at all is reported, not read as absent', () => {
  assert.deepEqual(frozenSeries(DAYS, undefined), { points: [], outside: [], malformed: 0 });
  assert.equal(frozenSeries(DAYS, { day: '2026-03-02' }).malformed, 1);
  assert.equal(frozenSeries(DAYS, 'series').malformed, 1);
});

test('splitAtGaps ignores a point the window does not contain', () => {
  assert.deepEqual(splitAtGaps([{ day: '2026-04-01', remaining: 1 }], DAYS), []);
});

test('one reader decides what a frozen point is, including a malformed one', () => {
  // `readReports` hands the stored list over untouched, so this is the only place a
  // frozen curve is read. While it filtered first, the two disagreed over one row: a
  // negative `remaining` was dropped there and accepted here, so the view drew „kein
  // Verlauf" for a day that has a record while this count stayed at 0.
  const days = sprintDays('2026-03-02', '2026-03-04');
  const read = frozenSeries(days, [
    { day: '2026-03-02', remaining: 10 },
    // A record somebody wrote, below what the schema allows. Kept: `yForValue` puts it
    // on the baseline, and dropping the day would claim nothing was measured on it.
    { day: '2026-03-03', remaining: -4 },
    { day: '2026-03-04', remaining: 'viel' },
  ]);
  assert.deepEqual(read.points, [
    { day: '2026-03-02', remaining: 10 },
    { day: '2026-03-03', remaining: -4 },
  ]);
  assert.equal(read.malformed, 1, 'and the damaged entry is countable, so a view can say so');
});

// ---- the example, against the code that writes it --------------------------

/**
 * The committed example, read the way the app reads it.
 *
 * It is the fixture for the one property that says the writer and the reader agree: a
 * closed sprint's frozen curve has to be what a reconstruction of the same sprint
 * produces. They did not agree, and the example was what proved it — every item in it
 * carries `duration` and no `end`, so sprint 1's stored curve (13 13 13 … 8 8 8 0 0 0)
 * came out of the code as 5 5 0 0 …: the reconstruction described when work started.
 */
const EXAMPLE = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'data', 'example-sprint-planung.json'), 'utf8'),
) as TimelineFile;

/** The items of one sprint as the chart reads them. The rules are `sprints.ts`'s. */
const membersOf = (sprint: Sprint): BurndownItem[] =>
  itemsOfSprint(EXAMPLE.items, sprint.id).map((it) => ({
    id: it.id ?? it.content,
    estimate: estimateOf(it),
    done: isDone(it),
    start: it.start ?? null,
    end: it.end ?? null,
    duration: it.duration,
    point: it.type === 'point',
  }));

test('every closed sprint of the example reconstructs to exactly its frozen series', () => {
  const sprints = readSprints(EXAMPLE);
  const reports = readReports(EXAMPLE);
  const closed = sprints.filter((sprint) => sprint.state === 'closed');
  assert.ok(closed.length >= 2, 'the example is the fixture, so it has to carry closed sprints');

  for (const sprint of closed) {
    const report = reportOfSprint(reports, sprint.id);
    assert.ok(report, `${sprint.id} has no frozen report`);
    const window = sprintWindow(sprint, null);
    assert.ok(window, `${sprint.id} has no window`);
    const days = sprintDays(window.start, window.end);
    // The freeze runs to the close, which is what `closeSprint` (index.ts) hands over.
    const built = reconstructSeries(days, membersOf(sprint), sprint.closedOn, report.unit);
    assert.deepEqual(
      built.points,
      frozenSeries(days, report.series).points,
      `${sprint.id}: the stored curve is not what the code that writes it produces`,
    );
    // …and the frozen figures come from the same two sums.
    assert.equal(built.scope, report.scopeAtClose, `${sprint.id}: scope`);
    assert.equal(built.completed, report.completed, `${sprint.id}: completed`);
  }
});

// ---- geometry --------------------------------------------------------------

const BOX: PlotBox = { left: 40, top: 10, width: 400, height: 200 };

test('the first and last day sit on the edges of the plot box', () => {
  assert.equal(xForIndex(0, 12, BOX), 40);
  assert.equal(xForIndex(11, 12, BOX), 440);
});

test('a single day sits in the middle rather than on the left edge', () => {
  assert.equal(xForIndex(0, 1, BOX), 240);
});

test('the y axis puts the maximum at the top and zero on the baseline', () => {
  assert.equal(yForValue(20, 20, BOX), 10);
  assert.equal(yForValue(0, 20, BOX), 210);
  assert.equal(yForValue(10, 20, BOX), 110);
});

test('a maximum of zero puts everything on the baseline instead of dividing by it', () => {
  assert.equal(yForValue(0, 0, BOX), 210);
  assert.equal(yForValue(5, 0, BOX), 210);
});

test('a value above the maximum is clamped into the box rather than drawn outside it', () => {
  assert.equal(yForValue(30, 20, BOX), 10);
  assert.equal(yForValue(-4, 20, BOX), 210);
});

test('polylinePoints places a run at the day positions it belongs to', () => {
  const points = polylinePoints(
    [
      { day: '2026-03-02', remaining: 20 },
      { day: '2026-03-13', remaining: 0 },
    ],
    DAYS,
    20,
    BOX,
  );
  assert.equal(points, '40,10 440,210');
});

test('polylinePoints drops a point the axis has no position for', () => {
  assert.equal(polylinePoints([{ day: '2026-04-01', remaining: 1 }], DAYS, 20, BOX), '');
});

test('axisMax rounds up to a number a reader recognises, and never clips a stored curve', () => {
  assert.equal(axisMax(20), 20);
  assert.equal(axisMax(13), 15);
  assert.equal(axisMax(7), 7);
  assert.equal(axisMax(6.5), 7);
  assert.equal(axisMax(20, [{ day: '2026-03-02', remaining: 34 }]), 35);
  assert.equal(axisMax(0), 0, 'an empty sprint has no axis to scale');
});

test('the axis always labels its first and last day', () => {
  const ticks = tickIndices(12, 6);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 11);
  assert.ok(ticks.length <= 6);
});

test('a short axis labels every day at most once', () => {
  assert.deepEqual(tickIndices(3, 6), [0, 1, 2]);
  assert.deepEqual(tickIndices(1, 6), [0]);
  assert.deepEqual(tickIndices(0, 6), []);
});

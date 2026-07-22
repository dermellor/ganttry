import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDateOnly, parseLocalDay } from './date';

// The regression these guard (Date→day shifting back a day) only manifests in a
// UTC+ timezone, so `npm test` runs with TZ=Europe/Berlin. Warn — don't silently
// pass — if someone runs the file in UTC, where a broken (UTC-slice) impl would
// look fine.
test('timezone sanity: exercising the regression needs a UTC+ zone', () => {
  if (new Date(2026, 6, 9).getTimezoneOffset() >= 0) {
    console.warn('⚠ run with TZ=Europe/Berlin (npm test) — UTC hides the date-shift regression');
  }
});

test('local-midnight Date → its local calendar day (the resize/drag path)', () => {
  // vis-timeline hands back local-midnight Dates. The old toISOString().slice
  // returned the *previous* day in UTC+ zones, which dragged a bar's left edge
  // left on every write.
  assert.equal(isoDateOnly(new Date(2026, 6, 9)), '2026-07-09');
  assert.equal(isoDateOnly(new Date(2026, 0, 1)), '2026-01-01'); // year start
  assert.equal(isoDateOnly(new Date(2026, 11, 31)), '2026-12-31'); // year end
  assert.equal(isoDateOnly(new Date(2026, 2, 29)), '2026-03-29'); // around DST switch
});

test('round-trip is stable: stored day → local-midnight Date → same stored day', () => {
  // Mirrors the exact loop that drifted before (vis parses "YYYY-MM-DD" as local
  // midnight; we format it back). Must be a fixed point for every day.
  for (const day of ['2026-07-08', '2026-07-09', '2026-03-29', '2026-10-25', '2027-01-01']) {
    const [y, m, d] = day.split('-').map(Number);
    assert.equal(isoDateOnly(new Date(y, m - 1, d)), day);
  }
});

test('a stored YYYY-MM-DD string passes through unchanged', () => {
  assert.equal(isoDateOnly('2026-07-09'), '2026-07-09');
  assert.equal(isoDateOnly('2026-07-09T12:34:56Z'), '2026-07-09');
});

test('nullish / empty input yields an empty string', () => {
  assert.equal(isoDateOnly(null), '');
  assert.equal(isoDateOnly(undefined), '');
  assert.equal(isoDateOnly(''), '');
});

test('parseLocalDay: a bare YYYY-MM-DD is local midnight, not UTC', () => {
  // The phase-ribbon regression: `new Date("2026-10-15")` is UTC midnight, which
  // in a UTC+ zone lands hours off from where vis-timeline (local midnight) puts
  // the matching item — a visible ribbon/tint offset. parseLocalDay must match
  // vis, i.e. round-trip through isoDateOnly to the *same* day.
  for (const day of ['2026-07-09', '2026-10-15', '2026-03-29', '2026-10-25', '2027-01-01']) {
    const d = parseLocalDay(day);
    assert.equal(d.getHours(), 0);
    assert.equal(isoDateOnly(d), day);
  }
});

test('parseLocalDay: Date and number inputs pass through unchanged', () => {
  const d = new Date(2026, 9, 15, 8, 30);
  assert.equal(parseLocalDay(d), d);
  const ms = new Date(2026, 9, 15).getTime();
  assert.equal(parseLocalDay(ms).getTime(), ms);
});

test('parseLocalDay: a value with a time component keeps its instant', () => {
  // Not a bare day → native parsing (here an explicit UTC instant).
  assert.equal(parseLocalDay('2026-10-15T09:00:00Z').getTime(), Date.UTC(2026, 9, 15, 9));
});

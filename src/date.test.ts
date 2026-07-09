import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDateOnly } from './date';

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

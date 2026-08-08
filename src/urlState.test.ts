import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrlWindow, readUrlState, type UrlState } from './urlState';
import { isoDateOnly } from './date';

// readUrlState reads `location.hash`; in node --test there is no DOM, so the
// tests below drive it through a minimal stub. Going through the real function
// (rather than hand-building a UrlState) is the point: it covers the decoding of
// the percent-escaped `view=src%3A…` a shared link actually carries.
function withHash<T>(hash: string, fn: (state: UrlState) => T): T {
  const prev = (globalThis as any).location;
  (globalThis as any).location = { hash };
  try {
    return fn(readUrlState());
  } finally {
    if (prev === undefined) delete (globalThis as any).location;
    else (globalThis as any).location = prev;
  }
}

// The offset this file guards against is zero in UTC, so `npm test` pins
// TZ=Europe/Berlin. Warn rather than pass quietly when it runs elsewhere.
test('timezone sanity: exercising the offset needs a non-UTC zone', () => {
  if (new Date(2026, 0, 1).getTimezoneOffset() === 0) {
    console.warn('⚠ run with TZ=Europe/Berlin (npm test) — UTC hides the window offset');
  }
});

test('a date-string deep link maps to the window it names, at local midnight', () => {
  // The exact link shape a user shares. `new Date('2026-01-01')` would land this
  // on UTC midnight — an hour off in CET, two in CEST — and out of step with the
  // local-midnight days vis-timeline places items on.
  const win = withHash(
    '#view=src%3Aexample-projektplan&mode=timeline&from=2026-01-01&to=2026-05-01',
    parseUrlWindow,
  );
  assert.ok(win);
  assert.deepEqual(win.start, new Date(2026, 0, 1));
  assert.deepEqual(win.end, new Date(2026, 4, 1));
  // Spelled out separately: deepEqual on Dates compares instants, so this is the
  // part that fails on a UTC-parsed value even where the calendar day survives.
  assert.equal(win.start.getHours(), 0);
  assert.equal(win.end.getHours(), 0);
});

test('the rest of the hash still parses alongside the window', () => {
  const state = withHash(
    '#view=src%3Aexample-projektplan&item=i1&from=2026-01-01&to=2026-05-01&m=1&mode=list',
    (s) => s,
  );
  assert.equal(state.view, 'src:example-projektplan');
  assert.equal(state.item, 'i1');
  assert.equal(state.milestones, true);
  assert.equal(state.mode, 'list');
});

test('round trip is a fixed point: written window → read window → same days', () => {
  // syncUrl writes the window with isoDateOnly, so opening that link must give
  // the days back unchanged. This half held even under the UTC-parsing bug (a
  // UTC-midnight Date still reads back as the same *day* in CET), so it is a
  // guard on the day mapping, not on the offset — the test above covers that.
  // Includes both DST switches, where the offset changes mid-window.
  for (const [from, to] of [
    ['2026-01-01', '2026-05-01'],
    ['2026-03-29', '2026-10-25'], // CET→CEST and back
    ['2026-06-15', '2026-06-16'], // adjacent days, deep in CEST
    ['2026-12-31', '2027-01-01'], // across a year boundary
  ]) {
    const win = withHash(`#from=${from}&to=${to}`, parseUrlWindow);
    assert.ok(win, `${from}..${to} should parse`);
    assert.equal(isoDateOnly(win.start), from);
    assert.equal(isoDateOnly(win.end), to);
  }
});

test('a link carrying a full timestamp keeps resolving to that instant', () => {
  // Backwards compatibility: only the bare-day case changed meaning. Anything
  // with a time component goes through the native constructor as before, so an
  // already-shared link of that shape opens on the same window it used to.
  const win = withHash('#from=2026-01-01T12:00:00Z&to=2026-05-01T12:00:00Z', parseUrlWindow);
  assert.ok(win);
  assert.equal(win.start.getTime(), Date.parse('2026-01-01T12:00:00Z'));
  assert.equal(win.end.getTime(), Date.parse('2026-05-01T12:00:00Z'));
});

test('an incomplete or unparseable window yields null, not an epoch window', () => {
  // A half-specified or broken window must leave the viewport to the normal
  // item-extent fit. Falling back to `new Date(undefined)`/NaN here is what would
  // show as a window near the epoch with no items in it.
  assert.equal(withHash('#view=src%3Aexample-projektplan', parseUrlWindow), null);
  assert.equal(withHash('#from=2026-01-01', parseUrlWindow), null); // no `to`
  assert.equal(withHash('#to=2026-05-01', parseUrlWindow), null); // no `from`
  assert.equal(withHash('#from=&to=', parseUrlWindow), null);
  assert.equal(withHash('#from=tomorrow&to=someday', parseUrlWindow), null);
  assert.equal(withHash('#from=2026-01-01&to=not-a-date', parseUrlWindow), null);
});

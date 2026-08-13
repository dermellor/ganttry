import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrlWindow, readUrlState, writeUrlState, type UrlState } from './urlState';
import { isoDateOnly } from './date';
import { NO_BUCKET } from './listGrouping';

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

/**
 * The hash `writeUrlState` produces, and the state reading it back yields.
 *
 * Both halves in one helper on purpose: the filter parameter is the one thing written
 * pre-encoded and read out of the raw hash, so a round trip is the only check that
 * catches an escape applied twice or decoded twice.
 */
function roundTrip(state: UrlState): { hash: string; read: UrlState } {
  const prevLocation = (globalThis as any).location;
  const prevHistory = (globalThis as any).history;
  const loc = { hash: '', pathname: '/', search: '' };
  (globalThis as any).location = loc;
  (globalThis as any).history = {
    replaceState: (_a: unknown, _b: unknown, url: string) => {
      loc.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    },
  };
  try {
    writeUrlState(state);
    return { hash: loc.hash, read: readUrlState() };
  } finally {
    if (prevLocation === undefined) delete (globalThis as any).location;
    else (globalThis as any).location = prevLocation;
    if (prevHistory === undefined) delete (globalThis as any).history;
    else (globalThis as any).history = prevHistory;
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

test('a bare #settings opens the area; an absent key leaves it closed', () => {
  // `URLSearchParams` reads a valueless key as the empty string, which is a
  // *present* key — telling that apart from an absent one is why `readUrlState`
  // checks `!= null` rather than truthiness. Collapse the two and the short link
  // an operator actually types stops opening anything.
  assert.equal(withHash('#settings', (s) => s.settings), '');
  assert.equal(withHash('#settings=members', (s) => s.settings), 'members');
  assert.equal(withHash('#view=src%3Aexample-projektplan', (s) => s.settings), undefined);
});

test('the area travels alongside the view rather than replacing it', () => {
  // Closing the area returns to the timeline the operator left, which only works
  // if the view, the item and the window survive in the hash while it is open.
  const state = withHash('#view=src%3Aexample-projektplan&item=kickoff&settings=instance', (s) => s);
  assert.equal(state.settings, 'instance');
  assert.equal(state.view, 'src:example-projektplan');
  assert.equal(state.item, 'kickoff');
});

test('the filter selection travels, and the separators stay readable', () => {
  const { hash, read } = roundTrip({
    view: 'src:example-projektplan',
    filters: { status: ['Open', 'Done'], 'cf:tier': ['Free'] },
  });
  // The whole point of the parameter: whoever pastes this can see what it narrows.
  assert.equal(hash, '#view=src%3Aexample-projektplan&f=status:Open,Done;cf%3Atier:Free');
  assert.deepEqual(read.filters, { status: ['Open', 'Done'], 'cf:tier': ['Free'] });
});

test('a value carrying a separator survives the round trip through the hash', () => {
  // Encoded per value, so the split cannot see it. This is the case that decides
  // whether the parameter can be read through URLSearchParams at all — it cannot:
  // that decodes first, and `a+b` would arrive as „a b".
  const filters = { group: ['Phase 1, Discovery'], note: ['a+b', '100%'] };
  const { read } = roundTrip({ view: 'v', filters });
  assert.deepEqual(read.filters, filters);
});

test('the „Ohne …" bucket survives, so „items without an owner" is shareable', () => {
  const { read } = roundTrip({ view: 'v', filters: { owner: [NO_BUCKET] } });
  assert.deepEqual(read.filters, { owner: [NO_BUCKET] });
});

test('nothing narrowed writes no parameter, so a plain link stays plain', () => {
  assert.equal(roundTrip({ view: 'v', filters: {} }).hash, '#view=v');
  assert.equal(roundTrip({ view: 'v', filters: { status: [] } }).hash, '#view=v');
  assert.equal(roundTrip({ view: 'v' }).hash, '#view=v');
});

test('an absent parameter and an empty one are different answers', () => {
  // Absent: „this link says nothing about the narrowing", which on load leaves the
  // timeline's stored selection alone. Present and empty: „nothing is narrowed",
  // which is what makes back reverse a filter set in the panel.
  assert.equal(withHash('#view=v', (s) => s.filters), undefined);
  assert.deepEqual(withHash('#view=v&f=', (s) => s.filters), {});
});

test('m=1 still resolves, and is still not written', () => {
  // It sits in links that are already out there. Writing it as well would put the
  // same narrowing in the hash twice, in two grammars.
  assert.equal(withHash('#view=v&m=1', (s) => s.milestones), true);
  assert.equal(roundTrip({ view: 'v', filters: { type: ['point'] } }).hash, '#view=v&f=type:point');
});

test('the filter sits beside the saved view, for a display that drifted from it', () => {
  const { hash, read } = roundTrip({ view: 'v', savedView: 'q3', filters: { status: ['Open'] } });
  assert.equal(hash, '#view=v&f=status:Open&sv=q3');
  assert.equal(read.savedView, 'q3');
  assert.deepEqual(read.filters, { status: ['Open'] });
});

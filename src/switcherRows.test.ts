import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenRows, matchesQuery, nextRowIndex, switcherGroups } from './switcherRows';
import type { SourceKind, View } from './types';
import { setLocale } from './i18n';
// The wording below is German, so these tests ask for German. The module reads
// the language from `src/i18n` module state rather than taking it as an argument
// (it renders, it does not validate), so the request is a `setLocale` here — the
// same move `fieldDefs.test.ts` makes with its `locale` parameter, and for the
// same reason: what is pinned is the rule, and the wording is only how it is
// observed. Without this the assertions would follow `DEFAULT_LOCALE` and break
// the day the product default changes.
setLocale('de');


// The switcher replaces a flat `<select>` over every discovered source. These tests
// pin the two things that decide whether somebody finds their timeline: what the
// search matches, and what the list is grouped and sorted by.

const view = (id: string, name: string, kind: SourceKind = 'db'): View => ({
  id,
  name,
  source: { kind, id },
});

const VIEWS = [
  view('src:zebra', 'Zebra-Plan', 'local'),
  view('db:launch', 'Launch-Roadmap'),
  view('db:alpha', 'Alpha'),
  view('src:notes', 'Notizen', 'local'),
];

test('groups follow a fixed origin order and sort by name inside', () => {
  const groups = switcherGroups(VIEWS, '', null);
  assert.deepEqual(groups.map((g) => g.label), ['Datenbank', 'Lokal']);
  assert.deepEqual(groups[0].rows.map((r) => r.view.name), ['Alpha', 'Launch-Roadmap']);
  assert.deepEqual(groups[1].rows.map((r) => r.view.name), ['Notizen', 'Zebra-Plan']);
});

test('an empty group is dropped rather than shown as a heading over nothing', () => {
  const groups = switcherGroups(VIEWS, 'zebra', null);
  assert.deepEqual(groups.map((g) => g.label), ['Lokal']);
});

test('the parts of a query may be scattered across the name', () => {
  assert.equal(matchesQuery(view('x', 'Launch-Roadmap 2026'), 'launch road'), true);
  assert.equal(matchesQuery(view('x', 'Launch-Roadmap 2026'), 'road launch'), true);
  assert.equal(matchesQuery(view('x', 'Launch-Roadmap 2026'), 'launch berlin'), false);
});

test('case and accents do not have to be typed', () => {
  assert.equal(matchesQuery(view('x', 'Übersicht'), 'ubersicht'), true);
  assert.equal(matchesQuery(view('x', 'Übersicht'), 'ÜBER'), true);
});

test('the id is searchable too, for somebody who knows it from a link', () => {
  assert.equal(matchesQuery(view('src:scratch/demo', 'Ganz anders'), 'scratch'), true);
});

test('the open timeline is never filtered away', () => {
  // Its absence would read as „it is gone" rather than „it does not match".
  const groups = switcherGroups(VIEWS, 'zzzz', 'db:alpha');
  assert.deepEqual(flattenRows(groups).map((r) => r.view.id), ['db:alpha']);
  assert.equal(flattenRows(groups)[0].active, true);
});

test('an unknown source kind is listed under its own name rather than hidden', () => {
  const groups = switcherGroups([...VIEWS, view('gs:sheet', 'Tabelle', 'gsheet' as SourceKind)], '', null);
  assert.deepEqual(groups.map((g) => g.label), ['Datenbank', 'Lokal', 'gsheet']);
});

test('keyboard movement wraps at both ends', () => {
  assert.equal(nextRowIndex(3, -1, 1), 0, 'from nothing, down picks the first');
  assert.equal(nextRowIndex(3, -1, -1), 2, 'from nothing, up picks the last');
  assert.equal(nextRowIndex(3, 2, 1), 0);
  assert.equal(nextRowIndex(3, 0, -1), 2);
  assert.equal(nextRowIndex(0, -1, 1), -1, 'an empty list has nothing to move to');
});

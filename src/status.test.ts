import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverdue, normalizeStatus, statusOrDefault } from './status';

// Fixed "now": 2026-08-06 12:00 local (tests run with TZ=Europe/Berlin).
const NOW = new Date(2026, 7, 6, 12, 0).getTime();

test('normalizeStatus canonicalises and rejects', () => {
  assert.equal(normalizeStatus('done'), 'Done');
  assert.equal(normalizeStatus(' DOING '), 'Doing');
  assert.equal(normalizeStatus('erledigt'), undefined);
  assert.equal(normalizeStatus(undefined), undefined);
  assert.equal(statusOrDefault('nonsense'), 'Open');
});

test('isOverdue: a past finish with an unfinished status', () => {
  assert.equal(isOverdue({ start: '2026-06-01', end: '2026-07-01', status: 'Open' }, NOW), true);
  assert.equal(isOverdue({ start: '2026-06-01', end: '2026-07-01', status: 'Doing' }, NOW), true);
});

test('isOverdue: Done is never overdue', () => {
  assert.equal(isOverdue({ start: '2026-06-01', end: '2026-07-01', status: 'Done' }, NOW), false);
});

test('isOverdue: a finish still ahead is not overdue', () => {
  assert.equal(isOverdue({ start: '2026-08-01', end: '2026-09-01', status: 'Open' }, NOW), false);
});

test('isOverdue: the finish is the start when there is no end (milestone)', () => {
  assert.equal(isOverdue({ start: '2026-07-01', status: 'Open' }, NOW), true);
  assert.equal(isOverdue({ start: '2026-09-01', status: 'Open' }, NOW), false);
});

// A day string is the *local* midnight that starts it — the same boundary
// vis-timeline places the item at, so the mark appears when the bar's right edge
// crosses "now", not a timezone offset later.
test('isOverdue: a day boundary counts from local midnight', () => {
  const midnight = new Date(2026, 7, 6, 0, 0).getTime();
  assert.equal(isOverdue({ start: '2026-08-06', status: 'Open' }, midnight), true);
  assert.equal(isOverdue({ start: '2026-08-07', status: 'Open' }, midnight), false);
});

test('isOverdue: no status at all (file-based source) never warns', () => {
  assert.equal(isOverdue({ start: '2026-06-01', end: '2026-07-01' }, NOW), false);
});

test('isOverdue: a date-less item never warns', () => {
  assert.equal(isOverdue({ status: 'Open' }, NOW), false);
});

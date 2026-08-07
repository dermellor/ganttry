import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeReversedExtent,
  findReversedExtent,
  hasReversedExtent,
  isReversedExtent,
} from './itemExtent';

test('isReversedExtent: end before start is reversed, end after start is not', () => {
  // The bug this rule exists for: a month typo turning the interval backwards.
  assert.equal(isReversedExtent('2026-06-29', '2026-06-12'), true);
  assert.equal(isReversedExtent('2026-06-29', '2026-08-12'), false);
  assert.equal(isReversedExtent('2026-06-29', '2026-06-30'), false);
  // Across a year boundary, where a lexicographic comparison of the raw strings
  // would still work but the intent is clearer stated as dates.
  assert.equal(isReversedExtent('2026-01-05', '2025-12-20'), true);
});

test('isReversedExtent: end == start counts as reversed (zero-length renders as a hairline)', () => {
  assert.equal(isReversedExtent('2026-06-29', '2026-06-29'), true);
});

test('isReversedExtent: an unresolvable pair is not this rule to reject', () => {
  // Date-less item, duration-only extent, empty strings, non-strings: all left
  // to whoever owns that field.
  assert.equal(isReversedExtent(undefined, '2026-06-12'), false);
  assert.equal(isReversedExtent('2026-06-29', undefined), false);
  assert.equal(isReversedExtent('', ''), false);
  assert.equal(isReversedExtent('2026-06-29', ''), false);
  assert.equal(isReversedExtent(null, null), false);
  assert.equal(isReversedExtent(1_700_000_000_000, 1_600_000_000_000), false);
  assert.equal(isReversedExtent('not-a-date', 'also-not'), false);
});

test('isReversedExtent: values carrying a time component still compare correctly', () => {
  assert.equal(isReversedExtent('2026-06-29T10:00', '2026-06-29T09:00'), true);
  assert.equal(isReversedExtent('2026-06-29T10:00', '2026-06-29T11:00'), false);
});

test('hasReversedExtent reads an item-shaped object', () => {
  assert.equal(hasReversedExtent({ start: '2026-06-29', end: '2026-06-12' }), true);
  assert.equal(hasReversedExtent({ start: '2026-06-29', end: '2026-07-12' }), false);
  assert.equal(hasReversedExtent({ start: '2026-06-29' }), false);
  assert.equal(hasReversedExtent({}), false);
});

test('findReversedExtent returns the first offender, or null for a clean set', () => {
  const items = [
    { id: 'a', start: '2026-01-01', end: '2026-01-08' },
    { id: 'b', start: '2026-02-01', end: '2026-01-08' },
    { id: 'c', start: '2026-03-01', end: '2026-02-08' },
  ];
  assert.equal(findReversedExtent(items)?.id, 'b');
  assert.equal(findReversedExtent(items.slice(0, 1)), null);
  assert.equal(findReversedExtent([]), null);
});

test('describeReversedExtent names both dates', () => {
  const msg = describeReversedExtent('2026-06-29', '2026-06-12');
  assert.match(msg, /2026-06-29/);
  assert.match(msg, /2026-06-12/);
});

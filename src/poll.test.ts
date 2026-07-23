import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPollDelay,
  watermarkChanged,
  POLL_INTERVAL_VISIBLE_MS,
  POLL_INTERVAL_HIDDEN_MS,
} from './poll';
import type { Watermark } from './types';

const wm = (v: number, n: number, t: string | null): Watermark => ({ v, n, t });

test('nextPollDelay: visible polls briskly, hidden backs off', () => {
  assert.equal(nextPollDelay(false), POLL_INTERVAL_VISIBLE_MS);
  assert.equal(nextPollDelay(true), POLL_INTERVAL_HIDDEN_MS);
  assert.ok(POLL_INTERVAL_HIDDEN_MS > POLL_INTERVAL_VISIBLE_MS);
});

test('watermarkChanged: identical watermark is no change', () => {
  assert.equal(watermarkChanged(wm(3, 5, '2026-07-23T10:00:00Z'), wm(3, 5, '2026-07-23T10:00:00Z')), false);
});

test('watermarkChanged: a bumped item version (edit) is a change', () => {
  assert.equal(watermarkChanged(wm(3, 5, 't1'), wm(4, 5, 't2')), true);
});

test('watermarkChanged: count change (insert/delete) is a change even when v and t are stale', () => {
  // A delete lowers n while max version and (surviving) max updated_at are unchanged.
  assert.equal(watermarkChanged(wm(9, 5, 't'), wm(9, 4, 't')), true);
});

test('watermarkChanged: a meta/phase write bumps only t and still counts', () => {
  assert.equal(watermarkChanged(wm(3, 5, 't1'), wm(3, 5, 't2')), true);
});

test('watermarkChanged: null vs set timestamp (first row added to empty timeline)', () => {
  assert.equal(watermarkChanged(wm(0, 0, null), wm(1, 1, 't')), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extentsOverlap,
  findPhaseOverlap,
  phaseGapBounds,
  resolvePhaseExtentMs,
} from './phaseOverlap';
import type { TimelinePhase } from './types';

const ph = (id: string, start: string, end?: string, duration?: string): TimelinePhase => ({
  id,
  label: id,
  start,
  ...(end ? { end } : {}),
  ...(duration ? { duration } : {}),
});

const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

test('resolvePhaseExtentMs: end and duration both resolve; no-extent is null', () => {
  assert.deepEqual(resolvePhaseExtentMs(ph('a', '2026-01-01', '2026-01-08')), {
    start: day('2026-01-01'),
    end: day('2026-01-08'),
  });
  const dur = resolvePhaseExtentMs(ph('b', '2026-01-01', undefined, '1w'));
  assert.equal(dur?.start, day('2026-01-01'));
  assert.equal(dur?.end, day('2026-01-08'));
  assert.equal(resolvePhaseExtentMs(ph('c', '2026-01-01')), null); // no end, no duration
  assert.equal(resolvePhaseExtentMs({ label: 'x', start: '' } as TimelinePhase), null);
});

test('extentsOverlap: touching boundaries do not count as overlap', () => {
  const a = { start: day('2026-01-01'), end: day('2026-01-10') };
  const touch = { start: day('2026-01-10'), end: day('2026-01-20') };
  const over = { start: day('2026-01-09'), end: day('2026-01-20') };
  const gap = { start: day('2026-01-15'), end: day('2026-01-20') };
  assert.equal(extentsOverlap(a, touch), false);
  assert.equal(extentsOverlap(a, over), true);
  assert.equal(extentsOverlap(a, gap), false);
});

test('findPhaseOverlap: contiguous (touching) sequence is clean', () => {
  const phases = [
    ph('pre', '2026-06-28', '2026-10-14'),
    ph('launch', '2026-10-14', '2026-10-15'),
    ph('amplify', '2026-10-15', '2027-01-17'),
    ph('sustain', '2027-01-18', '2027-03-27'),
  ];
  assert.equal(findPhaseOverlap(phases), null);
});

test('findPhaseOverlap: a phase reaching into the next is caught (the Sona bug)', () => {
  const phases = [
    ph('pre', '2026-06-28', '2026-11-07'), // overlaps launch & amplify
    ph('launch', '2026-10-14', '2026-10-15'),
    ph('amplify', '2026-10-15', '2027-01-17'),
  ];
  const clash = findPhaseOverlap(phases);
  assert.ok(clash);
  assert.equal(clash!.a.id, 'pre');
  assert.equal(clash!.b.id, 'launch');
});

test('findPhaseOverlap: gaps are allowed; duration-based overlap is caught; extent-less skipped', () => {
  assert.equal(
    findPhaseOverlap([ph('a', '2026-01-01', '2026-01-05'), ph('b', '2026-01-10', '2026-01-15')]),
    null,
  );
  assert.ok(
    findPhaseOverlap([ph('a', '2026-01-01', undefined, '1w'), ph('b', '2026-01-05', undefined, '1w')]),
  );
  // A phase with no resolvable extent can't overlap anything.
  assert.equal(findPhaseOverlap([ph('a', '2026-01-01', '2026-02-01'), ph('b', '2026-01-10')]), null);
});

test('phaseGapBounds: bounds come from the nearest neighbour on each side', () => {
  const others = [
    ph('left', '2026-01-01', '2026-01-10'),
    ph('right', '2026-02-01', '2026-02-10'),
  ];
  const b = phaseGapBounds(others, day('2026-01-15'), day('2026-01-20'));
  assert.equal(b.minStart, day('2026-01-10')); // left neighbour's end
  assert.equal(b.maxEnd, day('2026-02-01')); // right neighbour's start
});

test('phaseGapBounds: open on a side with no neighbour', () => {
  const b = phaseGapBounds([ph('right', '2026-02-01', '2026-02-10')], day('2026-01-15'), day('2026-01-20'));
  assert.equal(b.minStart, -Infinity);
  assert.equal(b.maxEnd, day('2026-02-01'));
});

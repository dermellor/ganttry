import test from 'node:test';
import assert from 'node:assert/strict';
import { railMarks, spreadCoincident } from './milestoneRail';
import type { TimelineItem } from './buildItems';

function item(partial: Partial<TimelineItem> & { id: string }): TimelineItem {
  return {
    content: partial.id,
    type: 'point',
    ...partial,
  } as TimelineItem;
}

test('picks only point items that carry a start', () => {
  const marks = railMarks([
    item({ id: 'a', start: '2026-03-01' }),
    item({ id: 'b', type: 'range', start: '2026-03-02', end: '2026-04-01' }),
    item({ id: 'c', type: 'background', start: '2026-03-03' }),
    // Start-less items live in the list view only — there is no x to place them at.
    item({ id: 'd' }),
  ]);
  assert.deepEqual(
    marks.map((m) => m.id),
    ['a'],
  );
});

test('orders by date regardless of item order', () => {
  const marks = railMarks([
    item({ id: 'late', start: '2026-11-30' }),
    item({ id: 'early', start: '2026-01-05' }),
    item({ id: 'mid', start: '2026-06-15' }),
  ]);
  assert.deepEqual(
    marks.map((m) => m.id),
    ['early', 'mid', 'late'],
  );
});

test('takes the lane colour class out of a className that also carries status marks', () => {
  const [mark] = railMarks([
    item({ id: 'a', start: '2026-03-01', className: 'lane-3 status-mark status-done' }),
  ]);
  assert.equal(mark.laneClass, 'lane-3');
});

test('reports no lane when the build has no groups to colour by', () => {
  const [mark] = railMarks([item({ id: 'a', start: '2026-03-01', className: 'status-mark' })]);
  assert.equal(mark.laneClass, null);
  const [bare] = railMarks([item({ id: 'b', start: '2026-03-01' })]);
  assert.equal(bare.laneClass, null);
});

test('does not mistake a lane-like substring for a lane class', () => {
  const [mark] = railMarks([item({ id: 'a', start: '2026-03-01', className: 'sublane-2' })]);
  assert.equal(mark.laneClass, null);
});

test('collapses regroup clones of one item back to a single mark', () => {
  // Grouping by tag clones a multi-valued item into one lane per value, using
  // the U+241F-separated display ids grouping.ts mints. Two marks on one date for
  // one milestone would be noise, and selection runs on the real id anyway.
  const marks = railMarks([
    item({ id: 'm1␟Qualität', start: '2026-05-01', className: 'lane-0' }),
    item({ id: 'm1␟Agent Graph', start: '2026-05-01', className: 'lane-2' }),
  ]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].id, 'm1');
  // The first clone wins, so the mark keeps a lane that item actually renders in.
  assert.equal(marks[0].laneClass, 'lane-0');
});

test('decodes the escaped title so a tooltip shows the real characters', () => {
  const [mark] = railMarks([
    item({ id: 'a', start: '2026-03-01', content: 'R&amp;D &quot;Alpha&quot;' }),
  ]);
  assert.equal(mark.label, 'R&D "Alpha"');
});

test('spread: marks that already clear each other are left exactly where they are', () => {
  assert.deepEqual(spreadCoincident([100, 130, 400], 12), [100, 130, 400]);
  // Exactly one pitch apart is the boundary and still counts as clear.
  assert.deepEqual(spreadCoincident([100, 112], 12), [100, 112]);
});

test('spread: two milestones on the same day end up one pitch apart, centred on it', () => {
  // Without this, the second diamond covers the first completely and the rail
  // reports one milestone where there are two.
  assert.deepEqual(spreadCoincident([200, 200], 12), [194, 206]);
});

test('spread: an odd-sized cluster keeps its middle member on the true date', () => {
  assert.deepEqual(spreadCoincident([200, 200, 200], 12), [188, 200, 212]);
});

test('spread: a run is centred on itself rather than pushed to the right', () => {
  const out = spreadCoincident([100, 104, 108], 12);
  // Mid of the run (100…108) is 104, so it spreads to 92/104/116 — the run's
  // centre is unmoved. A push-right placement would give 100/112/124 and walk
  // the whole cluster off its dates, further with every added member.
  assert.deepEqual(out, [92, 104, 116]);
  assert.equal((out[0] + out[2]) / 2, 104);
});

test('spread: every neighbour in a spread run is at least a pitch apart', () => {
  const out = spreadCoincident([50, 50, 55, 56, 300, 302], 12);
  for (let i = 1; i < out.length; i++) {
    assert.ok(
      out[i] - out[i - 1] >= 12 - 1e-9,
      `marks ${i - 1} and ${i} still overlap: ${out[i - 1]} → ${out[i]}`,
    );
  }
});

test('spread: a separate cluster further along is untouched by an earlier one', () => {
  const out = spreadCoincident([100, 100, 500], 12);
  assert.deepEqual(out, [94, 106, 500]);
});

test('spread: nothing to do for an empty or single-mark rail', () => {
  assert.deepEqual(spreadCoincident([], 12), []);
  assert.deepEqual(spreadCoincident([42], 12), [42]);
});

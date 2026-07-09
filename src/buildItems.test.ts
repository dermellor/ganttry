import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignLaneSubgroups,
  type LanePackOptions,
  type TimelineGroup,
  type TimelineItem,
} from './buildItems';

// Lane packing lays out items into vertical lanes (`subgroup`) so nothing
// overlaps under vis-timeline's `stack: false`. The subtle case: a point item
// (milestone) has zero time span, but its label renders to the RIGHT of the dot
// and takes horizontal room. Without reserving that room, two nearby milestones
// pack into one lane and their labels overlap. `LanePackOptions` translates the
// measured label width (px) into a time width via the current px/day, so the
// layout follows the zoom: wide-apart when zoomed out, tight when zoomed in.

const GROUPS: TimelineGroup[] = [{ id: 'g', content: 'g' }];

function point(id: string, start: string): TimelineItem {
  return { id, group: 'g', start, content: id, title: '', type: 'point' };
}

function laneOf(items: TimelineItem[], id: string): number | undefined {
  return items.find((i) => i.id === id)!.subgroup;
}

// A fixed 120px label, regardless of item — keeps the arithmetic predictable.
const opts = (pxPerDay: number): LanePackOptions => ({ pxPerDay, pointLabelPx: () => 120 });

test('nearby milestones separate onto different lanes when zoomed out', () => {
  // 120px label @ 10px/day == 12 days; the two points are 2 days apart, so the
  // first label would run through the second → they must not share a lane.
  const items = [point('a', '2026-02-10'), point('b', '2026-02-12')];
  assignLaneSubgroups(items, GROUPS, new Map(), opts(10));
  assert.notEqual(laneOf(items, 'a'), laneOf(items, 'b'));
});

test('the same milestones pack onto one lane when zoomed in', () => {
  // 120px label @ 100px/day == 1.2 days < the 2-day gap → labels no longer
  // overlap, so packing them onto a single lane is correct (dense layout).
  const items = [point('a', '2026-02-10'), point('b', '2026-02-12')];
  assignLaneSubgroups(items, GROUPS, new Map(), opts(100));
  assert.equal(laneOf(items, 'a'), laneOf(items, 'b'));
});

test('without pack options, zero-width points share a lane (legacy behaviour)', () => {
  // The file-build / notes path calls without options; points then have zero
  // effective width and pack together exactly as before this feature.
  const items = [point('a', '2026-02-10'), point('b', '2026-02-12')];
  assignLaneSubgroups(items, GROUPS, new Map());
  assert.equal(laneOf(items, 'a'), 0);
  assert.equal(laneOf(items, 'b'), 0);
});

test('range items are packed by their time span, unaffected by label width', () => {
  // Two non-overlapping range bars share a lane whether or not options are
  // supplied — only points reserve label width; ranges keep their time footprint.
  const ranges: TimelineItem[] = [
    { id: 'r1', group: 'g', start: '2026-02-01', end: '2026-02-05', content: 'r1', title: '', type: 'range' },
    { id: 'r2', group: 'g', start: '2026-02-10', end: '2026-02-15', content: 'r2', title: '', type: 'range' },
  ];
  assignLaneSubgroups(ranges, GROUPS, new Map(), opts(10));
  assert.equal(laneOf(ranges, 'r1'), laneOf(ranges, 'r2'));
});

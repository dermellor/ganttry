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
  assignLaneSubgroups(items, GROUPS, new Map(), new Map(), opts(10));
  assert.notEqual(laneOf(items, 'a'), laneOf(items, 'b'));
});

test('the same milestones pack onto one lane when zoomed in', () => {
  // 120px label @ 100px/day == 1.2 days < the 2-day gap → labels no longer
  // overlap, so packing them onto a single lane is correct (dense layout).
  const items = [point('a', '2026-02-10'), point('b', '2026-02-12')];
  assignLaneSubgroups(items, GROUPS, new Map(), new Map(), opts(100));
  assert.equal(laneOf(items, 'a'), laneOf(items, 'b'));
});

test('without pack options, zero-width points share a lane (legacy behaviour)', () => {
  // The file-build / notes path calls without options; points then have zero
  // effective width and pack together exactly as before this feature.
  const items = [point('a', '2026-02-10'), point('b', '2026-02-12')];
  assignLaneSubgroups(items, GROUPS, new Map(), new Map());
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
  assignLaneSubgroups(ranges, GROUPS, new Map(), new Map(), opts(10));
  assert.equal(laneOf(ranges, 'r1'), laneOf(ranges, 'r2'));
});

// Hierarchy bands the track before anything else packs it: a summary bar that
// sat below one of its children would not read as summarizing them.
function range(id: string, start: string, end: string): TimelineItem {
  return { id, group: 'g', start, end, content: id, title: '', type: 'range' };
}

test('a parent takes a lane above every one of its children', () => {
  // p spans both children, so plain packing would push it onto its own lane
  // *below* them (they are declared first and pack tighter).
  const items = [
    range('c1', '2026-02-01', '2026-02-05'),
    range('c2', '2026-02-10', '2026-02-15'),
    range('p', '2026-02-01', '2026-02-15'),
  ];
  assignLaneSubgroups(items, GROUPS, new Map(), new Map([['c1', 'p'], ['c2', 'p']]));
  assert.equal(laneOf(items, 'p'), 0);
  assert.ok(laneOf(items, 'c1')! > 0);
  assert.ok(laneOf(items, 'c2')! > 0);
  // The two children have no time overlap, so they still share their lane.
  assert.equal(laneOf(items, 'c1'), laneOf(items, 'c2'));
});

test('a grandchild lands below its parent, which is below the root', () => {
  const items = [
    range('root', '2026-02-01', '2026-02-20'),
    range('mid', '2026-02-02', '2026-02-10'),
    range('leaf', '2026-02-03', '2026-02-06'),
  ];
  assignLaneSubgroups(items, GROUPS, new Map(), new Map([['mid', 'root'], ['leaf', 'mid']]));
  assert.ok(laneOf(items, 'root')! < laneOf(items, 'mid')!);
  assert.ok(laneOf(items, 'mid')! < laneOf(items, 'leaf')!);
});

// The dependency staircase still applies, but only inside one hierarchy band —
// otherwise a chain of children would climb past the bar summarizing them.
test('the dependency staircase runs within a hierarchy band', () => {
  const items = [
    range('p', '2026-02-01', '2026-02-20'),
    range('a', '2026-02-01', '2026-02-05'),
    range('b', '2026-02-06', '2026-02-10'),
  ];
  const deps = new Map([['b', ['a']]]);
  assignLaneSubgroups(items, GROUPS, deps, new Map([['a', 'p'], ['b', 'p']]));
  assert.equal(laneOf(items, 'p'), 0);
  assert.ok(laneOf(items, 'a')! < laneOf(items, 'b')!);
});

// A parent in another track has no row here, so it cannot band this one.
test('a parent outside the track leaves the layout alone', () => {
  const items = [range('a', '2026-02-01', '2026-02-05'), range('b', '2026-02-10', '2026-02-15')];
  assignLaneSubgroups(items, GROUPS, new Map(), new Map([['a', 'elsewhere']]));
  assert.equal(laneOf(items, 'a'), 0);
  assert.equal(laneOf(items, 'b'), 0);
});

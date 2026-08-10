import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignLaneSubgroups,
  laneCountStyle,
  withHierarchyMarks,
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
  return { id, group: 'g', start, content: id, label: id, title: '', type: 'point' };
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
    { id: 'r1', group: 'g', start: '2026-02-01', end: '2026-02-05', content: 'r1', label: 'r1', title: '', type: 'range' },
    { id: 'r2', group: 'g', start: '2026-02-10', end: '2026-02-15', content: 'r2', label: 'r2', title: '', type: 'range' },
  ];
  assignLaneSubgroups(ranges, GROUPS, new Map(), new Map(), opts(10));
  assert.equal(laneOf(ranges, 'r1'), laneOf(ranges, 'r2'));
});

// Hierarchy bands the track before anything else packs it: a summary bar that
// sat below one of its children would not read as summarizing them.
function range(id: string, start: string, end: string): TimelineItem {
  return { id, group: 'g', start, end, content: id, label: id, title: '', type: 'range' };
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

test('an unrelated root never lands between a parent and its children', () => {
  const items = [
    range('p', '2026-02-01', '2026-02-20'),
    range('x', '2026-02-01', '2026-02-20'),
    range('c1', '2026-02-02', '2026-02-05'),
    range('c2', '2026-02-10', '2026-02-15'),
  ];
  assignLaneSubgroups(items, GROUPS, new Map(), new Map([['c1', 'p'], ['c2', 'p']]));
  assert.equal(laneOf(items, 'p'), 0);
  assert.equal(laneOf(items, 'c1'), 1);
  assert.equal(laneOf(items, 'c2'), 1);
  assert.ok(laneOf(items, 'x')! > laneOf(items, 'c2')!);
});

test('folding a subtree does not move an unrelated item across its parent', () => {
  const parents = new Map([['hidden-child', 'p']]);
  const expanded = [
    range('x', '2026-02-01', '2026-02-20'),
    range('p', '2026-02-01', '2026-02-20'),
    range('hidden-child', '2026-02-02', '2026-02-05'),
  ];
  assignLaneSubgroups(expanded, GROUPS, new Map(), parents);
  assert.ok(laneOf(expanded, 'x')! < laneOf(expanded, 'p')!);

  const folded = expanded.filter((it) => it.id !== 'hidden-child');
  assignLaneSubgroups(folded, GROUPS, new Map(), parents);
  assert.ok(laneOf(folded, 'x')! < laneOf(folded, 'p')!);
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

test('a nested subtree finishes before its parent\'s next child starts', () => {
  const items = [
    range('root', '2026-02-01', '2026-02-20'),
    range('mid', '2026-02-02', '2026-02-18'),
    range('sibling', '2026-02-03', '2026-02-17'),
    range('leaf', '2026-02-04', '2026-02-16'),
  ];
  assignLaneSubgroups(
    items,
    GROUPS,
    new Map(),
    new Map([['mid', 'root'], ['sibling', 'root'], ['leaf', 'mid']]),
  );
  assert.ok(laneOf(items, 'root')! < laneOf(items, 'mid')!);
  assert.ok(laneOf(items, 'mid')! < laneOf(items, 'leaf')!);
  assert.ok(laneOf(items, 'leaf')! < laneOf(items, 'sibling')!);
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

// `withHierarchyMarks` stamps the class the fold caret keys off (itemCollapse.ts
// queries for `item-summary`), so getting it wrong costs the caret, not just a
// style.
const PARENTS = new Map([['c', 'p']]);
const identity = (id: string) => id;
const classOf = (items: TimelineItem[], id: string) => items.find((i) => i.id === id)!.className;

test('a parent and child are marked, a loner is left alone', () => {
  const items = [range('p', '2026-02-01', '2026-02-20'), range('c', '2026-02-02', '2026-02-05'), range('x', '2026-03-01', '2026-03-05')];
  const out = withHierarchyMarks(items, PARENTS, new Set(), identity);
  assert.equal(classOf(out, 'p'), 'item-summary');
  assert.equal(classOf(out, 'c'), 'item-child');
  // Untouched items are returned as-is, so the persist diff never sees a display
  // concern (same reason withStatusMarks copies only what it marks).
  assert.equal(out[2], items[2]);
});

test('the marks append to a lane class instead of replacing it', () => {
  const items = [{ ...range('p', '2026-02-01', '2026-02-20'), className: 'lane-3' }];
  const out = withHierarchyMarks(items, PARENTS, new Set(['p']), identity);
  assert.equal(classOf(out, 'p'), 'lane-3 item-summary is-collapsed');
  assert.equal(items[0].className, 'lane-3'); // the build's own item stays clean
});

// Grouped by tag or a custom field, one item renders once per lane it falls into
// and carries a clone id. Marking only ids that match the source would leave
// those clones without a caret while their children stay hidden.
test('a clone is marked through its real id', () => {
  const clone = { ...range('p::Release', '2026-02-01', '2026-02-20'), id: 'p::Release' };
  const out = withHierarchyMarks([clone], PARENTS, new Set(), (id) => id.split('::')[0]);
  assert.equal(out[0].className, 'item-summary');
});

test('no hierarchy at all leaves the list untouched', () => {
  const items = [range('a', '2026-02-01', '2026-02-05')];
  assert.equal(withHierarchyMarks(items, new Map(), new Set(), identity), items);
});

// A track's height must not depend on which items the current time window shows.
// vis-timeline derives it from the drawn items and only guarantees the group's
// label height as a floor, so the lane count travels to CSS as `--lanes` on the
// group and the label reserves `--lanes × lane pitch`. See LANE_COUNT_PROPERTY.
test('a track publishes the number of lanes it needs', () => {
  const groups: TimelineGroup[] = [{ id: 'g', content: 'g' }];
  // Three bars all overlapping Feb 3 → three lanes.
  const items = [
    range('a', '2026-02-01', '2026-02-10'),
    range('b', '2026-02-02', '2026-02-11'),
    range('c', '2026-02-03', '2026-02-12'),
  ];
  assignLaneSubgroups(items, groups, new Map(), new Map());
  assert.equal(groups[0].style, laneCountStyle(3));
});

test('a track with no items reserves no room', () => {
  const groups: TimelineGroup[] = [
    { id: 'g', content: 'g' },
    { id: 'empty', content: 'empty' },
  ];
  assignLaneSubgroups([range('a', '2026-02-01', '2026-02-05')], groups, new Map(), new Map());
  assert.equal(groups[0].style, laneCountStyle(1));
  assert.equal(groups[1].style, undefined);
});

test('a stale reservation is dropped when the track loses its last item', () => {
  const groups: TimelineGroup[] = [{ id: 'g', content: 'g' }];
  assignLaneSubgroups([range('a', '2026-02-01', '2026-02-05')], groups, new Map(), new Map());
  assert.equal(groups[0].style, laneCountStyle(1));
  // The same call with the item filtered away (milestones-only, a value filter).
  assignLaneSubgroups([], groups, new Map(), new Map());
  assert.equal(groups[0].style, undefined);
});

// Zooming changes the reserved label width of a few milestones, which re-packs the
// track. Every item that could stay where it was has to stay there, or the whole
// track reshuffles vertically over a change that concerned one label.
test('a re-pack leaves an item in its lane when the lane is still free', () => {
  const groups: TimelineGroup[] = [{ id: 'g', content: 'g' }];
  const items = [
    range('a', '2026-02-01', '2026-02-10'),
    range('b', '2026-02-02', '2026-02-04'),
    range('c', '2026-02-06', '2026-02-20'),
  ];
  assignLaneSubgroups(items, groups, new Map(), new Map());
  assert.deepEqual([laneOf(items, 'a'), laneOf(items, 'b'), laneOf(items, 'c')], [0, 1, 1]);

  // `a` gets shorter, which frees lane 0 where `c` starts. Best-fit alone would
  // pull `c` up into it; the remembered lane keeps it where the user sees it.
  items[0].end = '2026-02-05';
  assignLaneSubgroups(items, groups, new Map(), new Map());
  assert.equal(laneOf(items, 'c'), 1);

  // The contrast, packed from scratch: with no lane to remember, `c` lands in 0.
  const fresh = [
    range('a', '2026-02-01', '2026-02-05'),
    range('b', '2026-02-02', '2026-02-04'),
    range('c', '2026-02-06', '2026-02-20'),
  ];
  assignLaneSubgroups(fresh, groups, new Map(), new Map());
  assert.equal(laneOf(fresh, 'c'), 0);
});

test('remembering a lane never costs the track an extra lane', () => {
  const groups: TimelineGroup[] = [{ id: 'g', content: 'g' }];
  const items = [
    range('a', '2026-02-01', '2026-02-20'),
    range('b', '2026-02-02', '2026-02-04'),
    range('c', '2026-02-06', '2026-02-08'),
  ];
  assignLaneSubgroups(items, groups, new Map(), new Map());
  // b and c never overlap, so two lanes are enough, before and after a re-pack.
  assert.equal(groups[0].style, laneCountStyle(2));
  assignLaneSubgroups(items, groups, new Map(), new Map());
  assert.equal(groups[0].style, laneCountStyle(2));
  assert.equal(Math.max(...items.map((i) => i.subgroup ?? 0)) + 1, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { connector } from './arrows.ts';

type Anchor = Parameters<typeof connector>[0];

// A range: the box spans the duration, so its right edge is its finish and an
// incoming head lands on its left edge.
function range(left: number, right: number, midY: number): Anchor {
  return {
    left,
    right,
    top: midY - 12,
    bottom: midY + 12,
    midY,
    finishX: right,
    startX: left,
    point: false,
  };
}

// A milestone: `dotX` is the date, `right` is only where the caption happens to
// end. The gap between the two is what these tests are about. The 14px mark is
// centred on the date, so it overhangs the box (left = dotX - 7 + 6) to the left
// — exactly the overhang that used to swallow an incoming arrowhead.
const MARK_GAP = 4;
function milestone(dotX: number, right: number, midY: number): Anchor {
  return {
    left: dotX - 1,
    right,
    top: midY - 12,
    bottom: midY + 12,
    midY,
    finishX: dotX,
    startX: dotX - 7 - MARK_GAP,
    point: true,
  };
}

// The path is emitted as `M x y …`, so the first pair is where the arrow starts.
function startPoint(d: string): { x: number; y: number } {
  const m = /^M (-?[\d.]+) (-?[\d.]+)/.exec(d);
  assert.ok(m, `no move-to in ${d}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

// …and the trailing `L x y` is where the head lands.
function endPoint(d: string): { x: number; y: number } {
  const m = /L (-?[\d.]+) (-?[\d.]+)$/.exec(d);
  assert.ok(m, `no line-to at the end of ${d}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

test('a milestone departs at its dot, not at the end of its caption', () => {
  const src = milestone(100, 400, 50); // 300px of caption to the right of the dot
  const d = connector(src, range(500, 700, 100));
  assert.equal(startPoint(d).x, 100);
});

test('a milestone departs vertically, so the arrow never crosses its own caption', () => {
  const src = milestone(100, 400, 50);
  const down = connector(src, range(500, 700, 100));
  assert.equal(startPoint(down).y, src.bottom);

  // Successor above: mirrored, leaving the top edge.
  const up = connector(src, range(500, 700, 10));
  assert.equal(startPoint(up).y, src.top);
});

test('a range still takes the horizontal elbow out of its right edge', () => {
  const d = connector(range(100, 300, 50), range(500, 700, 100));
  assert.deepEqual(startPoint(d), { x: 300, y: 50 });
});

test('a caption reaching past the successor does not push the departure right', () => {
  // The overlapping-boxes branch: the caption ends well right of the target's
  // start, but the milestone itself is long done, so the arrow still leaves at
  // the dot rather than doubling back from the caption's end.
  const src = milestone(100, 600, 50);
  const d = connector(src, range(200, 400, 100));
  assert.deepEqual(startPoint(d), { x: 100, y: src.bottom });
});

test('an arrow into a milestone stops clear of the mark instead of inside it', () => {
  const target = milestone(500, 800, 100);
  const markLeft = 500 - 7;
  for (const [label, d] of [
    ['roomy elbow', connector(range(100, 300, 50), target)],
    ['vertical drop', connector(range(100, 460, 50), target)],
    ['overlapping boxes', connector(range(100, 700, 50), target)],
  ] as const) {
    const end = endPoint(d);
    assert.ok(end.x < markLeft, `${label}: head at ${end.x} is not left of the mark at ${markLeft}`);
    assert.equal(end.x, target.startX, `${label}: head is not on the milestone's entry point`);
  }
});

test('an arrow into a range still lands on the bar itself', () => {
  const target = range(500, 800, 100);
  assert.equal(endPoint(connector(range(100, 300, 50), target)).x, 500);
  assert.equal(endPoint(connector(range(100, 700, 50), target)).x, 500);
});

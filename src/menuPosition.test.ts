import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuPosition, submenuPosition } from './menuPosition';

const VIEWPORT = { width: 1280, height: 720 };
const MENU = { width: 170, height: 186 };
const PAD = 8;

const at = (x: number, y: number, size = MENU, viewport = VIEWPORT) =>
  menuPosition({ x, y }, size, viewport, PAD);

test('menuPosition: opens at the cursor when it fits', () => {
  assert.deepEqual(at(400, 100), { x: 400, y: 100 });
});

test('menuPosition: flips above the cursor when it would overflow the bottom', () => {
  // 600 + 186 + 8 = 794 > 720 → flip, so the menu's bottom lands on the cursor.
  assert.deepEqual(at(400, 600), { x: 400, y: 600 - MENU.height });
  // The boundary itself: exactly fitting must NOT flip.
  const exact = VIEWPORT.height - MENU.height - PAD;
  assert.deepEqual(at(400, exact), { x: 400, y: exact });
  assert.deepEqual(at(400, exact + 1), { x: 400, y: exact + 1 - MENU.height });
});

test('menuPosition: clamps to the right edge instead of overhanging it', () => {
  assert.deepEqual(at(1275, 100), { x: VIEWPORT.width - MENU.width - PAD, y: 100 });
});

test('menuPosition: never places the box past the left edge', () => {
  assert.deepEqual(at(2, 100), { x: PAD, y: 100 });
  // A viewport narrower than the menu pins it left rather than going negative.
  assert.deepEqual(at(50, 100, MENU, { width: 100, height: 720 }).x, PAD);
});

test('menuPosition: a box taller than the viewport is pinned to the top, not off-screen', () => {
  const tall = { width: 170, height: 900 };
  const p = at(400, 500, tall);
  assert.equal(p.y, PAD);
});

// ---- submenuPosition -------------------------------------------------------

const SUB = { width: 150, height: 120 };
const OVERLAP = 4;
const beside = (
  parent: { left: number; right: number },
  anchorTop: number,
  size = SUB,
  viewport = VIEWPORT,
) => submenuPosition(parent, anchorTop, size, viewport, PAD, OVERLAP);

test('submenuPosition: sits to the right of the parent, overlapping it slightly', () => {
  assert.deepEqual(beside({ left: 400, right: 570 }, 300), { x: 570 - OVERLAP, y: 300 });
});

test('submenuPosition: flips to the parent’s left when the right would overflow', () => {
  // Parent hugging the right edge: 1270 + 150 would run off, so flip.
  const p = beside({ left: 1100, right: 1270 }, 300);
  assert.equal(p.x, 1100 - SUB.width + OVERLAP);
});

test('submenuPosition: stays right when flipping would push it off the left edge', () => {
  // Narrow viewport: neither side fits, so it must not flip into negative x.
  const p = beside({ left: 10, right: 120 }, 100, SUB, { width: 200, height: 720 });
  assert.equal(p.x, 120 - OVERLAP);
});

test('submenuPosition: slides up when the anchor sits too low, and never above the pad', () => {
  // Anchor near the bottom: clamped so the whole panel stays visible.
  assert.equal(beside({ left: 400, right: 570 }, 700).y, VIEWPORT.height - SUB.height - PAD);
  // Taller than the viewport → pinned to the top rather than placed off-screen.
  assert.equal(beside({ left: 400, right: 570 }, 700, { width: 150, height: 900 }).y, PAD);
});

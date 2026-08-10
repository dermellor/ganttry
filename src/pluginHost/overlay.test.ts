// Placement of a host-owned layer.
//
// Pure geometry, so it is tested directly. The three behaviours here each exist
// because their absence is visible: a layer running off the bottom, a layer
// running off the right, and a layer flipping for no reason in a tab that has not
// been painted yet.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { placeLayer, type OverlayRect } from './overlay.ts';

const rect = (over: Partial<OverlayRect> = {}): OverlayRect => ({
  top: 100,
  left: 200,
  bottom: 120,
  right: 260,
  width: 60,
  height: 20,
  ...over,
});

/** A layer of a known size, recording what was written to its style. */
function layer(width: number, height: number) {
  return { offsetWidth: width, offsetHeight: height, style: {} as Record<string, string> } as unknown as HTMLElement;
}

const VIEWPORT = { width: 1000, height: 800 };

describe('placeLayer', () => {
  test('sits below the anchor, left-aligned with it', () => {
    const el = layer(150, 80);
    placeLayer(el, rect(), VIEWPORT);
    assert.equal(el.style.left, '200px');
    assert.equal(el.style.top, '128px', 'anchor bottom plus the gap');
  });

  test('flips above the anchor when it would run off the bottom', () => {
    const el = layer(150, 300);
    placeLayer(el, rect({ top: 700, bottom: 720 }), VIEWPORT);
    assert.equal(el.style.top, '392px', 'anchor top minus the gap and its own height');
  });

  test('clamps into the viewport at the right edge', () => {
    const el = layer(400, 80);
    placeLayer(el, rect({ left: 900 }), VIEWPORT);
    assert.equal(el.style.left, '592px', 'viewport width minus the gap and its own width');
  });

  test('clamps at the left edge rather than going negative', () => {
    const el = layer(400, 80);
    placeLayer(el, rect({ left: -50 }), VIEWPORT);
    assert.equal(el.style.left, '8px');
  });

  test('never places above the top edge, even after a flip', () => {
    // Taller than the room below (128 + 750 > 792), so it flips; and taller than
    // the room above (100 - 8 - 750 is negative), so the clamp is what keeps it
    // on screen at all.
    const el = layer(150, 750);
    placeLayer(el, rect({ top: 100, bottom: 120 }), VIEWPORT);
    assert.equal(el.style.top, '8px');
  });

  test('an unpainted viewport reports 0 and must not trigger a flip or a clamp', () => {
    // A tab that has not been painted reports 0 for both metrics. Unguarded, every
    // layer in it would flip above its anchor and be clamped to the left edge.
    const el = layer(150, 80);
    placeLayer(el, rect(), { width: 0, height: 0 });
    assert.equal(el.style.left, '200px');
    assert.equal(el.style.top, '128px');
  });
});

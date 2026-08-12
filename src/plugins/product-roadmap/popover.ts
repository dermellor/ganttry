// The pricing view's floating layers: the feature-description tooltip
// (pricingMatrix.ts) and the matrix cell editor (cellEditor.ts).
//
// Both used to be built here, on `document.body`, with their own capture
// listeners on `document` for dismissal. They now come from the HOST
// (`src/pluginHost/overlay.ts`), which owns the layer, its placement and its
// dismissal. The reasoning is over there; the short version is that reaching for
// the global document is a plugin assuming it shares a realm with the app, and
// this plugin is the yardstick the contract is measured against.
//
// What is left here is the plugin's own vocabulary: which layers exist, and the
// one line that turns an element into the rectangle the host wants.

import { overlays, type Overlay, type OverlayRect } from '../../pluginHost/api';

/** A layer, created once per id and reused across repaints. */
export function layerFor(id: string, className: string, role: string): Overlay {
  return overlays().open(id, { className, role });
}

/**
 * An element as an anchor.
 *
 * `DOMRect` already satisfies `OverlayRect`, so this is a cast with a name. It
 * exists to mark the boundary: everything the host is told about an anchor is
 * plain numbers, which is what would let this call survive a plugin moving out
 * of the app's realm.
 */
export function anchorRect(el: HTMLElement): OverlayRect {
  return el.getBoundingClientRect();
}

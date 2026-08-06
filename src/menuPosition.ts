// Where a popup anchored to the cursor actually gets placed.
//
// Split out of contextMenu.ts and kept free of any DOM reference for the same
// reason presenceModel.ts and phaseOverlap.ts are: it is the only part of the
// menu with edge cases worth asserting (a cursor near the right edge, near the
// bottom, a menu taller than the viewport), and the module it came from imports
// `state`, which touches `document` at load and so can't be pulled into a test.

export type Box = { width: number; height: number };
export type Point = { x: number; y: number };

/**
 * Place a box of `size` at `cursor` inside `viewport`, keeping `pad` clear of the
 * edges: clamped horizontally, and flipped to sit *above* the cursor when it
 * would otherwise run off the bottom.
 *
 * The box is never pushed up into a position that hides the cursor when it fits
 * below — flipping only happens on actual overflow — and a box too tall for the
 * viewport is pinned to the top rather than being placed off-screen.
 */
export function menuPosition(cursor: Point, size: Box, viewport: Box, pad: number): Point {
  // Math.min before Math.max, so a viewport narrower than the box yields `pad`
  // (pinned left) instead of a negative offset.
  const x = Math.max(pad, Math.min(cursor.x, viewport.width - size.width - pad));
  const overflowsBottom = cursor.y + size.height + pad > viewport.height;
  const y = overflowsBottom ? Math.max(pad, cursor.y - size.height) : cursor.y;
  return { x, y };
}

/**
 * Place a submenu beside its parent menu: to the **right** of `parent` normally,
 * flipped to its left when there is no room, with `overlap` px of the parent
 * covered so the two read as connected rather than as two loose panels.
 *
 * `anchorTop` is where the submenu's first row should line up (its parent row).
 * The result is clamped vertically to the viewport, which is why a submenu low on
 * screen slides up instead of being cut off — it does not flip like the root
 * menu, because a submenu's top edge is tied to the row it belongs to.
 */
export function submenuPosition(
  parent: { left: number; right: number },
  anchorTop: number,
  size: Box,
  viewport: Box,
  pad: number,
  overlap: number,
): Point {
  const toRight = parent.right - overlap;
  const flipped = parent.left - size.width + overlap;
  // Flip only when the right placement genuinely overflows AND the left one is
  // reachable; otherwise stay right and let the clamp below deal with it, since a
  // flip into negative x would be worse than a clipped edge.
  const overflowsRight = toRight + size.width + pad > viewport.width;
  const x = Math.max(pad, overflowsRight && flipped >= pad ? flipped : toRight);
  const y = Math.max(pad, Math.min(anchorTop, viewport.height - size.height - pad));
  return { x, y };
}

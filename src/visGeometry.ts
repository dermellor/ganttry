// The time→pixel mapping every hand-positioned overlay has to share with
// vis-timeline. Extracted because the phase ribbon and the milestone rail both
// need it and a second copy of the reasoning below is a second chance to get it
// subtly wrong.

import type { Timeline } from 'vis-timeline/standalone';
import { parseLocalDay } from './date';

// vis-timeline positions its items (including the phase background tints) with an
// internal time→pixel conversion, `body.util.toScreen`, applied over
// `body.domProps.center.width` — the panel's *content* width, which already
// subtracts a reserved vertical scrollbar (`verticalScroll`). Re-deriving the
// mapping ourselves from `getWindow()` + `getBoundingClientRect().width` (the
// border box, which still includes the scrollbar gutter) makes an overlay drift
// right of the items, growing toward the right edge. We therefore reuse vis's own
// conversion so overlay and item share one coordinate system.
// These internals aren't part of vis-timeline's public typings.
type VisInternals = {
  body: {
    util: { toScreen(time: Date): number };
    domProps: { center: { width: number } };
  };
  itemSet: {
    items: Record<
      string,
      {
        top: number;
        height: number;
        parent?: { dom?: { label?: HTMLElement } };
      }
    >;
  };
  // vis stores the vertical scroll as a *negative* offset, so reading and
  // writing both go through these rather than through the container's
  // `scrollTop` — see `scrollItemIntoView`.
  _getScrollTop(): number;
  _setScrollTop(value: number): void;
  redraw(): void;
};

// Breathing room left between a scrolled-to item and the edge it was hidden
// behind, so it does not end up flush against the head overlays or the bottom.
const SCROLL_GAP_PX = 6;

// How many corrective passes `scrollItemIntoView` will make. See the note there:
// a pass can be cut short by a stale scroll limit, so one is not enough, and an
// unreachable target must not loop.
const SCROLL_MAX_PASSES = 4;

// A move smaller than this counts as "arrived": sub-pixel rounding between the
// measured rect and vis's integer scroll offset would otherwise keep every pass
// reporting a move and burn all of them on nothing.
const SCROLL_EPSILON_PX = 1;

/**
 * Width of the center panel's *content* box, in px. Zero until vis has laid out
 * — an overlay must treat that as "not ready yet" rather than as an empty panel,
 * because positioning against a zero width places everything at x=0.
 */
export function centerWidth(timeline: Timeline): number {
  return (timeline as unknown as VisInternals).body.domProps.center.width;
}

/**
 * x position (px, relative to the center panel) of a point in time. Day strings
 * are parsed as *local* midnight, the way vis reads them — a UTC `new Date(iso)`
 * would offset the overlay from the items it annotates by the timezone offset.
 * See date.ts.
 */
export function timeToX(timeline: Timeline, time: number | string | Date): number {
  return (timeline as unknown as VisInternals).body.util.toScreen(parseLocalDay(time));
}

/**
 * Scroll the timeline vertically, by the smallest amount that brings `displayId`
 * fully into view. Leaves the time window alone, and does nothing when the item
 * is already visible.
 *
 * vis's own `focus()` does the vertical part of this, but it always runs
 * `range.setRange()` as well — even with `zoom: false`, which only preserves the
 * interval *width* — so it re-centres the window on the item. That is wrong for
 * anything the user clicked at a position it already occupies (the milestone
 * rail): every other mark would slide out from under the pointer.
 *
 * The item's own DOM is not usable here: vis only mounts items whose row is on
 * screen, so the one worth scrolling to is exactly the one with no box to
 * measure. Its **group label** is always mounted, though, and the left and centre
 * panels are kept in vertical lockstep — so the group's rendered top plus the
 * item's offset within the group is the item's rendered top, which is what this
 * measures. Verified against every mounted item: the prediction matches the real
 * box to the pixel.
 *
 * Measuring rather than re-deriving vis's `group.top + item.top` also keeps the
 * head overlays' row reserve out of the maths — it is a CSS padding vis knows
 * nothing about, so vis's own coordinates would land the item that far too high,
 * behind the phase ribbon.
 */
export function scrollItemIntoView(
  timeline: Timeline,
  displayId: string,
  container: HTMLElement,
): void {
  // One pass is not enough. `_setScrollTop` clamps against vis's own record of
  // how tall the content is, and that record is refreshed in a throttled redraw
  // — so a scroll issued right after a selection can be cut short by a stale
  // limit, landing part-way. It also cannot know about the head overlays' row
  // reserve, which is a CSS padding on an absolutely positioned element and
  // therefore invisible to vis's measurement. Re-checking after the redraw and
  // correcting is what absorbs both: each pass measures the *rendered* position
  // again and stops as soon as the item is in view. Bounded, so a limit that
  // genuinely cannot reach the item settles at the edge instead of looping.
  let passes = 0;
  const step = () => {
    if (!container.isConnected) return;
    if (!scrollStep(timeline, displayId, container)) return; // in view — done
    // A pending rAF resumes when a hidden tab is shown again, so this finishes
    // even if the user switches away mid-click.
    if (++passes < SCROLL_MAX_PASSES) requestAnimationFrame(step);
  };
  step();
}

/**
 * One corrective scroll toward `displayId`. Returns whether the item is still
 * out of view, i.e. whether another pass is worth making — a pass that was cut
 * short by a stale scroll limit reports `true` so the next one, after vis has
 * redrawn, can carry on from there.
 */
function scrollStep(timeline: Timeline, displayId: string, container: HTMLElement): boolean {
  const vis = timeline as unknown as VisInternals;
  const item = vis.itemSet?.items?.[displayId];
  const label = item?.parent?.dom?.label;
  if (!item || !label || !container.contains(label)) return false;

  const panel = container.querySelector('.vis-panel.vis-center');
  const foreground = container.querySelector('.vis-itemset > .vis-foreground');
  if (!panel || !foreground) return false;

  // The head overlays cover the top of the panel by exactly the reserve they are
  // padded onto the group set with, so that strip does not count as visible.
  const reserve = parseFloat(getComputedStyle(foreground).paddingTop) || 0;
  const view = panel.getBoundingClientRect();
  const viewTop = view.top + reserve + SCROLL_GAP_PX;
  const viewBottom = view.bottom - SCROLL_GAP_PX;

  const itemTop = label.getBoundingClientRect().top + item.top;
  const itemBottom = itemTop + item.height;

  let delta = 0;
  if (itemTop < viewTop) delta = itemTop - viewTop;
  // Never scroll an item *down* out of the top to satisfy its bottom edge: one
  // taller than the viewport would otherwise flip between the two corrections.
  else if (itemBottom > viewBottom) delta = Math.min(itemBottom - viewBottom, itemTop - viewTop);
  if (Math.abs(delta) < SCROLL_EPSILON_PX) return false;

  // vis keeps the offset negative, and `_setScrollTop` clamps it to the feasible
  // range — so an over-long delta at either end settles at the edge instead of
  // scrolling past it. The redraw is what mounts the rows that just came into
  // view and syncs the scrollbar containers.
  vis._setScrollTop(vis._getScrollTop() - delta);
  vis.redraw();
  return true;
}

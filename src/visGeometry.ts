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
};

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

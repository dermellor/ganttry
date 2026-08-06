// The overrun line — the dashed run-on that carries a late item from its own end
// date to "now".
//
// The rail's status mark says *that* an item is overdue (see itemRail.ts and the
// status-mark block in styles/timeline.css); this says *by how much*, which is the
// part you actually plan around. It is drawn as a pseudo-element of the item box
// (`.status-overdue::before`), so it travels with its bar for free — the same
// reason itemPresence/itemRail render into the item rather than into an overlay.
//
// What JS has to supply is its **length**: end→now is a duration, and how many
// pixels that is depends on the current zoom. So this module sets one custom
// property per overdue item (`--overrun`) and CSS does the rest. Everything else
// about the line — height, dash pattern, colour, opacity — stays in CSS.
//
// Ranges only. A milestone has no extent to overrun, and vis sizes a point item's
// box to its label, so `left: 100%` there would start the line a label-width right
// of the date it belongs to. Those items keep the mark alone.

import { parseLocalDay } from './date';
import { state } from './state';

// Timeline events the line re-measures on. Same set as the phase ribbon: a
// re-layout, plus the window-motion pair (continuous during pan/zoom, and on
// settle after the initial load), since every one of those changes px-per-ms.
const OVERRUN_EVENTS = ['changed', 'rangechange', 'rangechanged'] as const;

// vis-timeline's own time→pixel conversion. Re-deriving it from getWindow() plus
// a measured width drifts (see the note in phaseBand.ts), and here it would put
// the line's end somewhere other than vis's own current-time marker.
type VisInternals = { body: { util: { toScreen(time: Date): number } } };

// Below this the line is shorter than a single dash and reads as a speck of dirt
// against the bar's edge; the mark carries the state on its own.
const MIN_OVERRUN_PX = 4;

let paintTimer: ReturnType<typeof setTimeout> | null = null;

/** Hook a freshly created timeline instance up to the overrun lines. */
export function attachOverrunLines(timeline: {
  on: (event: string, cb: () => void) => void;
}): void {
  for (const event of OVERRUN_EVENTS) timeline.on(event, schedulePaint);
  schedulePaint();
}

// Coalesce through a timer rather than requestAnimationFrame — a hidden tab stops
// firing rAF, which would leave the "already scheduled" guard set forever and drop
// every later repaint (the same trap documented in itemPresence.ts).
function schedulePaint(): void {
  if (paintTimer != null) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paint();
  }, 0);
}

function paint(): void {
  const vis = state.timeline as unknown as VisInternals | null;
  const items = (state.timeline as any)?.itemSet?.items as Record<string, any> | undefined;
  if (!vis?.body?.util || !items) return;

  // One conversion of "now" for the whole pass, so every line in a repaint ends
  // at the same pixel as vis's current-time marker.
  const nowX = vis.body.util.toScreen(new Date());

  for (const displayId of Object.keys(items)) {
    const item = items[displayId];
    const box: HTMLElement | undefined = item?.dom?.box;
    if (!box || !box.classList.contains('status-overdue')) continue;
    const finish = item?.data?.end;
    if (!finish) {
      box.style.removeProperty('--overrun');
      continue;
    }
    const px = nowX - vis.body.util.toScreen(parseLocalDay(finish));
    if (px < MIN_OVERRUN_PX) box.style.removeProperty('--overrun');
    else box.style.setProperty('--overrun', `${Math.round(px)}px`);
  }
}

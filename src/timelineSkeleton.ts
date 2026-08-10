// The placeholder the timeline area carries while a source is loading.
//
// It draws the timeline's own furniture — label column, axis, staggered bars in
// the lane colours — rather than a spinner, because the state it replaces was an
// empty white area: indistinguishable from a timeline that genuinely has no
// items, with the only signal to the contrary sitting in the footer status line
// at the other end of the window.
//
// What it looks like is the `TimelineSkeleton` component; what is here is the
// geometry and the mount/unmount, because `renderTimeline()` clears its
// container when it destroys a previous timeline and the placeholder therefore
// has to be re-creatable at any point.

import { TimelineSkeleton, type SkeletonMark } from './design-system';

const CLASS = 'ds-Skeleton';

// Bar geometry per row, as percentages of the track width. Hand-picked rather
// than generated: a placeholder that reshuffles on every view switch draws
// attention to itself, and randomness in a paint path cannot be reproduced when
// something about the layout looks wrong.
const ROWS: readonly (readonly SkeletonMark[])[] = [
  [{ x: 4, w: 30 }, { x: 42, w: 17 }],
  [{ x: 10, w: 44 }, { x: 64, point: true }],
  [{ x: 6, w: 19 }, { x: 33, w: 27 }],
  [{ x: 24, w: 37 }, { x: 71, w: 15 }],
  [{ x: 14, point: true }, { x: 28, w: 33 }],
  [{ x: 40, w: 41 }],
];

export function showTimelineSkeleton(host: HTMLElement): void {
  if (host.querySelector(`.${CLASS}`)) return;
  host.appendChild(TimelineSkeleton({ rows: ROWS }));
}

export function hideTimelineSkeleton(host: HTMLElement): void {
  host.querySelector(`.${CLASS}`)?.remove();
}

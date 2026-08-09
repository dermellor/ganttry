// The placeholder the timeline area carries while a source is loading.
//
// It draws the timeline's own furniture — label column, axis, staggered bars in
// the lane colours — rather than a spinner, because the state it replaces was an
// empty white area: indistinguishable from a timeline that genuinely has no
// items, with the only signal to the contrary sitting in the footer status line
// at the other end of the window.
//
// The markup is built here instead of living in index.html because
// `renderTimeline()` clears its container when it destroys a previous timeline,
// so the placeholder has to be re-creatable at any point.

const CLASS = 'tl-skeleton';

type Mark = { x: number; w: number } | { x: number; point: true };

// Bar geometry per row, as percentages of the track width. Hand-picked rather
// than generated: a placeholder that reshuffles on every view switch draws
// attention to itself, and randomness in a paint path cannot be reproduced when
// something about the layout looks wrong.
const ROWS: readonly (readonly Mark[])[] = [
  [{ x: 4, w: 30 }, { x: 42, w: 17 }],
  [{ x: 10, w: 44 }, { x: 64, point: true }],
  [{ x: 6, w: 19 }, { x: 33, w: 27 }],
  [{ x: 24, w: 37 }, { x: 71, w: 15 }],
  [{ x: 14, point: true }, { x: 28, w: 33 }],
  [{ x: 40, w: 41 }],
];

// Tick stubs on the axis. Eight of them line up with the 12.5% grid the track
// paints, so the vertical rules read as this axis' ticks rather than as a
// second, unrelated grid.
const TICKS = 8;

function markHtml(mark: Mark): string {
  return 'point' in mark
    ? `<span class="tl-skeleton-point" style="left:${mark.x}%"></span>`
    : `<span class="tl-skeleton-bar" style="left:${mark.x}%;width:${mark.w}%"></span>`;
}

export function showTimelineSkeleton(host: HTMLElement): void {
  if (host.querySelector(`.${CLASS}`)) return;
  const el = document.createElement('div');
  el.className = CLASS;
  // Decorative: what is happening is already announced by the footer status
  // line, and six empty boxes tell a screen reader nothing.
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = [
    `<div class="tl-skeleton-axis">${'<span></span>'.repeat(TICKS)}</div>`,
    `<div class="tl-skeleton-labels">${ROWS.map(() => '<span></span>').join('')}</div>`,
    `<div class="tl-skeleton-track">${ROWS.map(
      (row) => `<div class="tl-skeleton-row">${row.map(markHtml).join('')}</div>`,
    ).join('')}</div>`,
  ].join('');
  host.appendChild(el);
}

export function hideTimelineSkeleton(host: HTMLElement): void {
  host.querySelector(`.${CLASS}`)?.remove();
}

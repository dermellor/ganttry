import './Skeleton.css';
import { classes, el, type Attrs } from './dom';

/**
 * The loading placeholder for the timeline area.
 *
 * It draws the chart's own furniture — a label column, an axis, staggered bars
 * in the lane colours — rather than a spinner, because the state it replaces is
 * an empty white area: indistinguishable from a timeline that genuinely has no
 * items, with the only signal to the contrary sitting in the footer at the far
 * end of the window.
 *
 * The geometry is a component prop rather than being generated, for two reasons:
 * a placeholder that reshuffles on every view switch draws attention to itself,
 * and randomness in a paint path cannot be reproduced when something about the
 * layout looks wrong.
 */

export type SkeletonMark = { x: number; w: number } | { x: number; point: true };

export type TimelineSkeletonOptions = {
  /** One entry per row, each a list of bars and points positioned in percent. */
  rows: readonly (readonly SkeletonMark[])[];
  /** Axis tick stubs. Eight line up with the 12.5% grid the track paints. */
  ticks?: number;
  className?: string;
  attrs?: Attrs;
};

export function TimelineSkeleton(options: TimelineSkeletonOptions): HTMLDivElement {
  const { rows, ticks = 8, className, attrs } = options;
  return el(
    'div',
    {
      class: classes('ds-Skeleton', className),
      // Decorative: what is happening is announced by the status line, and six
      // empty boxes tell a screen reader nothing.
      'aria-hidden': 'true',
      ...attrs,
    },
    [
      el(
        'div',
        { class: 'ds-Skeleton-axis' },
        Array.from({ length: ticks }, () => el('span')),
      ),
      el(
        'div',
        { class: 'ds-Skeleton-labels' },
        rows.map(() => el('span')),
      ),
      el(
        'div',
        { class: 'ds-Skeleton-track' },
        rows.map((row) =>
          el(
            'div',
            { class: 'ds-Skeleton-row' },
            row.map((mark) =>
              'point' in mark
                ? el('span', { class: 'ds-Skeleton-point', style: `left:${mark.x}%` })
                : el('span', { class: 'ds-Skeleton-bar', style: `left:${mark.x}%;width:${mark.w}%` }),
            ),
          ),
        ),
      ),
    ],
  );
}

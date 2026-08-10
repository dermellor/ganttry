import './SegmentedControl.css';
import { classes, data, el, on, type Attrs, type Listeners } from './dom';

/**
 * One choice out of two or three, shown as a joined row of icon buttons — the
 * header's Timeline/Liste switch.
 *
 * Distinct from `Tabs`, which it superficially resembles: tabs name their
 * sections and live above the thing they switch, a segmented control is a
 * setting that sits in a toolbar. It uses `aria-pressed` rather than
 * `role="tab"`, because nothing here is a tab panel.
 */

export type Segment = {
  value: string;
  /**
   * A mark instead of the label. Icon segments are square boxes, which is what
   * lets three of them fit in a toolbar; without one the label is shown as text
   * and the segment sizes to it. Mixing the two forms in one control gives a row
   * of uneven boxes, so pick one per control.
   */
  icon?: Element;
  /** Required: with an icon it is the segment's only accessible name. */
  label: string;
  selected?: boolean;
  attrs?: Attrs;
  on?: Listeners;
};

export type SegmentedControlOptions = {
  segments: Segment[];
  ariaLabel?: string;
  className?: string;
  attrs?: Attrs;
};

export function SegmentedControl(options: SegmentedControlOptions): HTMLDivElement {
  const { segments, ariaLabel, className, attrs } = options;
  return el(
    'div',
    { class: classes('ds-SegmentedControl', className), role: 'group', 'aria-label': ariaLabel, ...attrs },
    segments.map((segment) => {
      const node = el(
        'button',
        {
          type: 'button',
          class: 'ds-Segment',
          'data-value': segment.value,
          ...data({ text: !segment.icon }),
          'aria-pressed': String(!!segment.selected),
          // An icon segment needs the label as its accessible name; a text one
          // already has it, and repeating it produces a tooltip on every hover.
          'aria-label': segment.icon ? segment.label : undefined,
          title: segment.icon ? segment.label : undefined,
          ...segment.attrs,
        },
        segment.icon ?? segment.label,
      );
      on(node, segment.on);
      return node;
    }),
  );
}

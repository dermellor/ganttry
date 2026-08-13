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
  /**
   * A caption inside the control, before the first segment.
   *
   * For a control whose segments are icons that mean nothing on their own: a
   * plugin's views are „matrix, cards, board" of *that plugin*, and three
   * unexplained squares beside three more from the next plugin are unreadable.
   * The caption says whose segments these are, and it is inside the border rather
   * than beside it so the group reads as one control.
   *
   * It also becomes the group's accessible name, so `ariaLabel` is not needed
   * with it.
   */
  label?: string;
  /**
   * Makes the caption a button. Given, the caption is a target of its own — the
   * plugin's name is the largest thing in the control, so it reads as the way
   * into the plugin, and a click that does nothing reads as a broken control.
   * Without it the caption stays inert text and is hidden from assistive
   * technology, since it only repeats the group's name.
   */
  onLabelClick?: () => void;
  ariaLabel?: string;
  className?: string;
  attrs?: Attrs;
};

export function SegmentedControl(options: SegmentedControlOptions): HTMLDivElement {
  const { segments, label, onLabelClick, ariaLabel, className, attrs } = options;
  let caption: HTMLElement | undefined;
  if (label && onLabelClick) {
    caption = el(
      'button',
      { type: 'button', class: 'ds-SegmentedControl-label', 'data-action': 'true' },
      label,
    );
    on(caption, { click: onLabelClick });
  } else if (label) {
    caption = el('span', { class: 'ds-SegmentedControl-label', 'aria-hidden': 'true' }, label);
  }
  const children = segments.map((segment) => {
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
  });

  return el(
    'div',
    {
      class: classes('ds-SegmentedControl', className),
      role: 'group',
      'aria-label': ariaLabel ?? label,
      ...attrs,
    },
    caption ? [caption, ...children] : children,
  );
}

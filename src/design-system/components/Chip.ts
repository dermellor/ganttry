import './Chip.css';
import { classes, data, el, on, type Attrs, type Child, type Listeners } from './dom';

/**
 * A value that was picked and can be dropped again, and the bordered box such
 * values live in.
 *
 * Five widgets rendered their own chip before this — JIRA references, tags,
 * dependencies, custom-field values and the owner — as five near-identical
 * blocks joined by comma-separated selectors. The differences that survive are
 * the props below: what the leading slot holds, and whether the label is a
 * resolved value or a legacy string that matches nothing.
 */

export type ChipOptions = {
  label?: string;
  /** The leading slot: a coloured dot, an avatar, a monospace issue key. */
  mark?: Element;
  /** A prominent code before the label — a JIRA key. */
  code?: string;
  /** Free text from before this field linked to anything. Muted and italic. */
  unlinked?: boolean;
  /** Renders the remove button. Wire its click through `onRemove`. */
  removable?: boolean;
  removeLabel?: string;
  onRemove?: (event: MouseEvent) => void;
  title?: string;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function Chip(options: ChipOptions = {}): HTMLSpanElement {
  const {
    label,
    mark,
    code,
    unlinked,
    removable,
    removeLabel = 'Entfernen',
    onRemove,
    title,
    className,
    attrs,
    on: listeners,
  } = options;

  const remove =
    removable &&
    el(
      'button',
      { type: 'button', class: 'ds-Chip-remove', 'aria-label': removeLabel, title: removeLabel },
      '×',
    );
  if (remove && onRemove) remove.addEventListener('click', onRemove);

  const node = el(
    'span',
    { class: classes('ds-Chip', className), title: title ?? label, ...data({ unlinked }), ...attrs },
    [
      mark,
      code != null && el('span', { class: 'ds-Chip-code' }, code),
      label != null && el('span', { class: 'ds-Chip-label' }, label),
      remove,
    ],
  );
  on(node, listeners);
  return node;
}

export type ChipBoxOptions = {
  children?: Child;
  className?: string;
  attrs?: Attrs;
};

/**
 * Chips and the search field in one bordered box that reads as a single
 * control, rather than a chip row stacked above a full-width input. That
 * reclaims a whole row per field, which is what lets two of these sit side by
 * side at half width.
 */
export function ChipBox(options: ChipBoxOptions = {}): HTMLDivElement {
  const { children, className, attrs } = options;
  return el('div', { class: classes('ds-ChipBox', className), ...attrs }, children);
}

/**
 * A pass-through wrapper inside a ChipBox. The widgets re-render their chips
 * into a stable container, so the container has to be `display: contents` — its
 * children then flow as direct flex items of the box and the wrapper itself
 * takes up no space of its own.
 */
export function ChipBoxSlot(options: ChipBoxOptions = {}): HTMLDivElement {
  const { children, className, attrs } = options;
  return el('div', { class: classes('ds-ChipBoxSlot', className), ...attrs }, children);
}

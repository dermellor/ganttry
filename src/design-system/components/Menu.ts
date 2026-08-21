import './Menu.css';
import { append, classes, data, el, on, type Attrs, type Child, type Listeners } from './dom';

/**
 * Everything that floats over the interface anchored to something else.
 *
 * There were four of these before the component: the filter value checklist, the
 * item form's icon/type/status pickers, the item context menu, and its
 * submenus — four copies of the same surface (white, 1px border, 6px radius,
 * `0 8px 24px` shadow) in three stylesheets, already 2px and one shadow apart
 * from each other. They are the same kind of thing and now say so.
 */

export type PopoverPlacement =
  /** Absolutely positioned under its trigger; the trigger's box is the anchor. */
  | 'anchored'
  /** Placed in viewport coordinates by the caller — a menu that must escape a
   *  scroll pane, which is every context menu the timeline opens. */
  | 'fixed'
  /**
   * No positioning of its own: the surface only, because its container already
   * owns where it sits. That container is a host-provided overlay layer
   * (`src/pluginHost/overlay.ts`), which is `position: fixed`, carries the plugin
   * stacking level and has had its coordinates computed — or the playground,
   * showing a surface at rest.
   *
   * Both used to force `position: static` back off with a class of their own,
   * which is the tell that the variant was missing. A `fixed` popover nested in a
   * `fixed` layer does not merely double up: it resolves against the viewport
   * from its own static position, so the surface leaves its layer and the layer's
   * computed left/top stop meaning anything.
   */
  | 'static';

export type PopoverLayer = 'popover' | 'menu';

/**
 * Which side of the trigger the surface opens on. Only meaningful for `anchored`
 * placement; a `fixed` popover is placed by the caller.
 *
 * `top` exists for a trigger on the last row on screen — the footer's plugin list.
 * Opening downwards there puts the surface below the viewport, where it is clipped
 * rather than scrolled to, so the control appears to do nothing at all.
 */
export type PopoverSide = 'bottom' | 'top';

export type PopoverOptions = {
  children?: Child;
  placement?: PopoverPlacement;
  /**
   * Which stacking layer. `popover` sits above the detail panel; `menu` is the
   * topmost thing on screen and is what a context menu uses.
   */
  layer?: PopoverLayer;
  /** Which side of the trigger it opens on. `bottom` unless the trigger is the
   *  last row on screen — see `PopoverSide`. */
  side?: PopoverSide;
  /**
   * How much air the surface keeps around its content.
   *
   * `tight` (the default) is a hairline, because the surface's usual content is
   * `MenuItem`s and they bring their own padding — a menu row has to be able to
   * highlight all the way to the surface's edge. `roomy` is for a surface holding
   * *prose or a form* instead: a tooltip with a sentence in it at the menu padding
   * has its text almost touching the border.
   */
  pad?: 'tight' | 'roomy';
  /** Anchor to the trigger's right edge — for a popover wider than its trigger. */
  alignEnd?: boolean;
  /** Scrolls internally past this height rather than growing off-screen. */
  scroll?: boolean;
  /**
   * A floor on the width, in pixels. Worth setting when the rows are short
   * words: a menu that is exactly as wide as „Done" is hard to aim at, and one
   * that resizes as its rows change reads as a glitch.
   */
  minWidth?: number;
  /**
   * A ceiling on the width, in pixels, for a surface holding sentences rather
   * than single words. Without it a long line — the reason a plugin will not load
   * — stretches the surface across the viewport instead of wrapping.
   */
  maxWidth?: number;
  hidden?: boolean;
  role?: string;
  ariaLabel?: string;
  className?: string;
  attrs?: Attrs;
};

export function Popover(options: PopoverOptions = {}): HTMLDivElement {
  const {
    children,
    placement = 'anchored',
    layer = 'popover',
    side = 'bottom',
    pad = 'tight',
    alignEnd,
    scroll,
    minWidth,
    maxWidth,
    hidden,
    role,
    ariaLabel,
    className,
    attrs,
  } = options;
  const width = [
    minWidth ? `min-width:${minWidth}px` : '',
    maxWidth ? `max-width:${maxWidth}px` : '',
  ]
    .filter(Boolean)
    .join(';');
  return el(
    'div',
    {
      class: classes('ds-Popover', className),
      hidden,
      role,
      'aria-label': ariaLabel,
      style: width || undefined,
      ...data({ placement, layer, side, pad, 'align-end': alignEnd, scroll }),
      ...attrs,
    },
    children,
  );
}

export type MenuSectionOptions = {
  children?: Child;
  /** Names the group for assistive tech. Sections are separated by a rule, not
   *  by a visible caption: three bare words above „Löschen" would otherwise read
   *  as four actions, and the rule does that job without costing a line. */
  ariaLabel?: string;
  /**
   * A visible caption, for the case the rule alone cannot carry: a panel whose
   * sections hold *values* rather than actions. Stacked facets („Open, Doing,
   * Done" above „Free, Scale") are unreadable without saying which dimension
   * each belongs to. Labels the group too, so `ariaLabel` is not needed with it.
   */
  label?: string;
  /**
   * Flow the children as a wrapping row instead of stacking them, for a section
   * holding chips rather than full-width rows. The caption still takes a line of
   * its own. An empty one keeps its caption and its height, because a section
   * that vanishes when it empties makes the remaining ones jump under the pointer
   * that just emptied it.
   */
  wrap?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function MenuSection(options: MenuSectionOptions = {}): HTMLDivElement {
  const { children, ariaLabel, label, wrap, className, attrs } = options;
  const caption = label
    ? el('div', { class: 'ds-MenuSection-label', 'aria-hidden': 'true' }, label)
    : undefined;
  return el(
    'div',
    {
      class: classes('ds-MenuSection', className),
      role: 'group',
      'aria-label': ariaLabel ?? label,
      ...data({ wrap }),
      ...attrs,
    },
    caption ? [caption, children] : children,
  );
}

export type MenuItemOptions = {
  label?: string;
  /** The leading mark: a glyph, a status dot, a coloured dot. Boxed to a fixed
   *  width so labels line up whether the mark is 10px or 16px. */
  mark?: Element;
  /**
   * A quieter trailing phrase — a status, a date. Pushed to the far edge so the
   * labels stay scannable down the left. Mutually exclusive with `parent`, whose
   * chevron claims the same slot.
   */
  detail?: string;
  /** Current value in a single-choice list (`aria-checked`). */
  checked?: boolean;
  /** Current value in a picker grid (`aria-selected`). */
  selected?: boolean;
  /** Destructive. Tints the row and its mark. */
  danger?: boolean;
  /** „kein Wert" — the row that clears a field. */
  none?: boolean;
  /** Opens a submenu: adds the trailing chevron and the expanded state. */
  parent?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  /** Square cell in a `PickerGrid` rather than a full-width row. */
  cell?: boolean;
  title?: string;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function MenuItem(options: MenuItemOptions = {}): HTMLButtonElement {
  const {
    label,
    mark,
    detail,
    checked,
    selected,
    danger,
    none,
    parent,
    expanded,
    disabled,
    cell,
    title,
    className,
    attrs,
    on: listeners,
  } = options;

  const node = el(
    'button',
    {
      type: 'button',
      class: classes('ds-MenuItem', className),
      role: checked != null ? 'menuitemradio' : undefined,
      'aria-checked': checked == null ? undefined : String(checked),
      'aria-selected': selected == null ? undefined : String(selected),
      'aria-expanded': parent ? String(!!expanded) : undefined,
      'aria-haspopup': parent ? 'true' : undefined,
      disabled,
      title: title ?? (cell ? label : undefined),
      ...data({ danger, cell, none }),
      ...attrs,
    },
    [
      mark && el('span', { class: 'ds-MenuItem-mark' }, mark),
      label != null && !cell && el('span', { class: 'ds-MenuItem-label' }, label),
      detail != null && el('span', { class: 'ds-MenuItem-detail' }, detail),
      parent && el('span', { class: 'ds-MenuItem-chevron', 'aria-hidden': 'true' }, '›'),
    ],
  );
  on(node, listeners);
  return node;
}

export type MenuOptions = PopoverOptions & {
  /** Sections, items, or anything else — a checklist of Checkboxes, say. */
  children?: Child;
};

/** A Popover carrying menu semantics. */
export function Menu(options: MenuOptions = {}): HTMLDivElement {
  const { className, role = 'menu', ...rest } = options;
  return Popover({ ...rest, role, className: classes('ds-Menu', className) });
}

export type PickerGridOptions = {
  children?: Child;
  /** Cells per row. The icon picker uses six. */
  columns?: number;
  className?: string;
  attrs?: Attrs;
};

/**
 * A mark-only matrix, for a choice with too many values to list by name — the
 * nineteen item icons. A choice with a handful of values uses plain `MenuItem`
 * rows instead, because a name is more use there than a grid position.
 */
export function PickerGrid(options: PickerGridOptions = {}): HTMLDivElement {
  const { children, columns = 6, className, attrs } = options;
  const node = el('div', {
    class: classes('ds-PickerGrid', className),
    style: `--ds-picker-columns:${columns}`,
    ...attrs,
  });
  append(node, children);
  return node;
}

/** Vertical stack of `MenuItem` rows, for a picker with named values. */
export function PickerList(options: MenuSectionOptions = {}): HTMLDivElement {
  const { children, className, attrs } = options;
  return el('div', { class: classes('ds-PickerList', className), ...attrs }, children);
}

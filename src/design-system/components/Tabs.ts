import './Tabs.css';
import { classes, data, el, on, type Attrs, type Child, type Listeners } from './dom';

/**
 * An underline tabstrip and its panels — the item form's field groups.
 *
 * Inactive panels stay in the DOM (hidden) rather than being unmounted, so
 * `FormData` still sees every field in them. The tabs are a layout device, not a
 * way of conditionally submitting half a form, and a panel that unmounted itself
 * would drop edits the moment you looked at another tab.
 */

export type TabsOrientation = 'horizontal' | 'vertical';

export type TabsOptions = {
  children?: Child;
  ariaLabel?: string;
  /**
   * `vertical` turns the strip into a column beside its panel, which is what a
   * settings area's section list is.
   *
   * A variant rather than layout at the call site: the tabs would otherwise be a
   * row of buttons with a hand-written selected state, which is the second
   * tabstrip this codebase would have. `aria-orientation` travels with it, so
   * the arrow keys a screen reader announces match the direction they run in.
   */
  orientation?: TabsOrientation;
  className?: string;
  attrs?: Attrs;
};

export function Tabs(options: TabsOptions = {}): HTMLDivElement {
  const { children, ariaLabel, orientation = 'horizontal', className, attrs } = options;
  return el(
    'div',
    {
      class: classes('ds-Tabs', className),
      role: 'tablist',
      'aria-label': ariaLabel,
      'aria-orientation': orientation,
      ...data({ orientation }),
      ...attrs,
    },
    children,
  );
}

export type TabOptions = {
  label: string;
  /** A glyph before the label, kept a touch lighter than the text until active. */
  icon?: Element;
  selected?: boolean;
  /** `id` of the panel this controls. */
  controls?: string;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function Tab(options: TabOptions): HTMLButtonElement {
  const { label, icon, selected, controls, className, attrs, on: listeners } = options;
  const node = el(
    'button',
    {
      type: 'button',
      role: 'tab',
      class: classes('ds-Tab', className),
      'aria-selected': String(!!selected),
      'aria-controls': controls,
      tabindex: selected ? undefined : '-1',
      ...attrs,
    },
    [icon && el('span', { class: 'ds-Tab-icon', 'aria-hidden': 'true' }, icon), el('span', {}, label)],
  );
  on(node, listeners);
  return node;
}

export type TabPanelOptions = {
  children?: Child;
  id?: string;
  hidden?: boolean;
  /** Lays the panel out as the form's two-column grid, which is the usual case. */
  grid?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function TabPanel(options: TabPanelOptions = {}): HTMLDivElement {
  const { children, id, hidden, grid = true, className, attrs } = options;
  return el(
    'div',
    {
      class: classes('ds-TabPanel', grid && 'ds-FormGrid', className),
      role: 'tabpanel',
      id,
      hidden,
      ...data({ grid }),
      ...attrs,
    },
    children,
  );
}

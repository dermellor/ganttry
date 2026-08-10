import './Layout.css';
import { classes, data, el, type Attrs, type Child } from './dom';

/**
 * The frame the toolbars and the panel hang in: the main area, the column of
 * content inside it, and the sections that column switches between.
 *
 * `AppMain` is the positioning context for the detail panel, which is what lets
 * the panel be an overlay instead of a second grid column — see Panel.ts for why
 * that distinction is not cosmetic.
 */

export type AppMainOptions = {
  children?: Child;
  className?: string;
  attrs?: Attrs;
};

export function AppMain(options: AppMainOptions = {}): HTMLElement {
  const { children, className, attrs } = options;
  return el('main', { class: classes('ds-AppMain', className), ...attrs }, children);
}

export function ContentArea(options: AppMainOptions = {}): HTMLDivElement {
  const { children, className, attrs } = options;
  return el('div', { class: classes('ds-ContentArea', className), ...attrs }, children);
}

export type ViewSectionOptions = {
  children?: Child;
  hidden?: boolean;
  ariaLabel?: string;
  /**
   * `chart` gets the padding the timeline needs and becomes the positioning
   * context for its loading placeholder; `scroll` is the list view's own
   * scrolling body; `plain` claims the space and styles nothing, which is what a
   * plugin view gets — how it fills the box is the plugin's stylesheet's business.
   */
  tone?: 'chart' | 'scroll' | 'plain';
  className?: string;
  attrs?: Attrs;
};

/**
 * The scrolling body inside a `ViewSection` — the list view's table area. A
 * separate element rather than a scrolling section, because the section is the
 * flex column that gives it a bounded height to scroll within: making one
 * element do both leaves `min-height: auto` resolving to the content's height
 * and the page scrolls instead of the table.
 */
export function ScrollArea(options: AppMainOptions = {}): HTMLDivElement {
  const { children, className, attrs } = options;
  return el('div', { class: classes('ds-ScrollArea', className), ...attrs }, children);
}

export function ViewSection(options: ViewSectionOptions = {}): HTMLElement {
  const { children, hidden, ariaLabel, tone = 'plain', className, attrs } = options;
  return el(
    'section',
    {
      class: classes('ds-ViewSection', className),
      hidden,
      'aria-label': ariaLabel,
      ...data({ tone }),
      ...attrs,
    },
    children,
  );
}

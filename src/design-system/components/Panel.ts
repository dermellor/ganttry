import './Panel.css';
import { classes, el, on, type Attrs, type Child, type Listeners } from './dom';
import { IconButton } from './Button';

/**
 * The side panel: the detail/edit drawer, and anything else that wants to sit
 * over the content rather than beside it.
 *
 * Overlay, not a layout column, and that is load-bearing rather than a taste
 * call. A panel that took width away from the timeline would make vis-timeline
 * re-fit the same time window into less space, dropping the right-edge items and
 * visibly jumping the layout every time you opened an item. Floating over it
 * leaves the chart untouched; the cost is that an item can end up behind the
 * panel, which `revealBesidePanel` in state.ts pans out from under it.
 */

export type PanelOptions = {
  children?: Child;
  hidden?: boolean;
  ariaLabel?: string;
  className?: string;
  attrs?: Attrs;
};

export function Panel(options: PanelOptions = {}): HTMLElement {
  const { children, hidden, ariaLabel, className, attrs } = options;
  return el(
    'aside',
    { class: classes('ds-Panel', className), hidden, 'aria-label': ariaLabel, ...attrs },
    children,
  );
}

export type PanelHeaderOptions = {
  /** The headline. Usually a `Heading`, editable in the item form. */
  title?: Child;
  /** The row above the headline: the icon/type/status pickers. */
  tools?: Element;
  closeLabel?: string;
  onClose?: (event: MouseEvent) => void;
  className?: string;
  attrs?: Attrs;
};

/**
 * Sticky headline block. It casts a shadow only once the body has scrolled —
 * a scroll-driven animation rather than a permanent divider line, so a panel
 * whose content fits shows no rule at all.
 */
export function PanelHeader(options: PanelHeaderOptions = {}): HTMLDivElement {
  const { title, tools, closeLabel = 'Schließen', onClose, className, attrs } = options;
  const close = IconButton({
    icon: '×',
    ariaLabel: closeLabel,
    boxSize: 'lg',
    className: 'ds-Panel-close',
  });
  if (onClose) close.addEventListener('click', onClose);
  return el(
    'div',
    {
      class: classes('ds-Panel-header', className),
      // With a tools row present the close button belongs to *that* line rather
      // than to the headline, and the heading below gets the full width.
      'data-has-tools': tools ? '' : undefined,
      ...attrs,
    },
    [close, tools, title],
  );
}

export type PanelToolsOptions = {
  children?: Child;
  hidden?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * The picker row above the headline. It shares the close button's line, which is
 * why its minimum height is the close button's box: the two have to sit level or
 * the header looks like it has two rows when it has one.
 */
export function PanelTools(options: PanelToolsOptions = {}): HTMLDivElement {
  const { children, hidden, className, attrs } = options;
  return el('div', { class: classes('ds-Panel-tools', className), hidden, ...attrs }, children);
}

export type PanelBodyOptions = {
  children?: Child;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function PanelBody(options: PanelBodyOptions = {}): HTMLElement {
  const { children, className, attrs, on: listeners } = options;
  const node = el('article', { class: classes('ds-Panel-body', className), ...attrs }, children);
  on(node, listeners);
  return node;
}

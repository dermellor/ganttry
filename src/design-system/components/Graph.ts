import './Graph.css';
import { classes, data, el, on as listen, type Attrs, type Child, type Listeners } from './dom';
import { Icon, StatusDot } from './Marks';

/**
 * The box the relation graph draws one item as.
 *
 * It is a `<button>` and not a `<div>` with a click handler, and not an SVG
 * `<g>` either. The graph positions these absolutely over an SVG layer that
 * draws only the edges — nodes stay HTML so a long title wraps and truncates by
 * CSS rather than by counting characters, and so the box is reachable by keyboard
 * and announces itself. Drawing the node into the SVG too would mean
 * re-implementing text layout and focus handling for one presentation.
 */
export type GraphNodeOptions = {
  /** The item's title, as text. Truncated by CSS after two lines. */
  label: string;
  /** The line under it — the graph puts the item's dates there, or an em-dash. */
  meta?: string;
  /** An `ITEM_STATUSES` value, shown as the same dot the list and the form use. */
  status?: string;
  /** A key from `src/icons.ts`. */
  icon?: string;
  /** The item the detail panel is currently open for. */
  selected?: boolean;
  /** Faded out because something else is being hovered. */
  dimmed?: boolean;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function GraphNode(options: GraphNodeOptions): HTMLButtonElement {
  const { label, meta, status, icon, selected, dimmed, className, attrs, on } = options;
  const node = el(
    'button',
    {
      type: 'button',
      class: classes('ds-GraphNode', className),
      'aria-pressed': selected ? 'true' : undefined,
      ...data({ selected, dimmed }),
      ...attrs,
    },
    [
      el('span', { class: 'ds-GraphNode-head' }, [
        status ? StatusDot({ status }) : null,
        icon ? Icon({ name: icon }) : null,
        el('span', { class: 'ds-GraphNode-label' }, label),
      ]),
      meta ? el('span', { class: 'ds-GraphNode-meta' }, meta) : null,
    ] as Child,
  );
  listen(node, on);
  return node;
}

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
  /** The item's dates, when it has any. Omitted rather than dashed: a column of
   * em-dashes on a timeline where nothing is dated is a line of noise. */
  meta?: string;
  /**
   * Context that is a reference rather than a relation — the scenes a revelation
   * surfaces in. Drawn as one muted line under the title, because as edges the
   * same information is noise and disappears the moment the extent hides the other
   * end.
   */
  reference?: string;
  /**
   * The lane colour class the build stamped on the item (`lane-0` … `lane-5`),
   * which is one colour per group. Passed through rather than derived here: the
   * mapping from group to lane lives in `assignLanes` and must not exist twice.
   */
  lane?: string;
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
  const { label, meta, reference, status, icon, selected, dimmed, lane, className, attrs, on } =
    options;
  const node = el(
    'button',
    {
      type: 'button',
      class: classes('ds-GraphNode', lane, className),
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
      reference ? el('span', { class: 'ds-GraphNode-ref' }, reference) : null,
    ] as Child,
  );
  listen(node, on);
  return node;
}

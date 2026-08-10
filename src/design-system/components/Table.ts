import './Table.css';
import { classes, data, el, on, type Attrs, type Child, type Listeners } from './dom';

/**
 * The grouped, scrollable table behind the list view.
 *
 * Its header is sticky and its group rows are `<th>` spanning the full width, so
 * this is a real table rather than a grid of divs: the semantics are what let a
 * screen reader announce a cell's column, and the list view is the accessible
 * way to read a timeline.
 */

export type TableOptions = {
  children?: Child;
  className?: string;
  attrs?: Attrs;
};

export function Table(options: TableOptions = {}): HTMLTableElement {
  const { children, className, attrs } = options;
  return el('table', { class: classes('ds-Table', className), ...attrs }, children);
}

export type TableHeadOptions = {
  columns: string[];
  className?: string;
};

export function TableHead(options: TableHeadOptions): HTMLTableSectionElement {
  const { columns, className } = options;
  return el('thead', { class: className }, [
    el(
      'tr',
      {},
      columns.map((column) => el('th', { scope: 'col' }, column)),
    ),
  ]);
}

export type TableRowOptions = {
  children?: Child;
  selected?: boolean;
  /** Rows are clickable in the list view; this adds the affordance and a tabstop. */
  interactive?: boolean;
  /** Has rows under it. Reads as their heading, the way a summary bar does. */
  summary?: boolean;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function TableRow(options: TableRowOptions = {}): HTMLTableRowElement {
  const { children, selected, interactive, summary, className, attrs, on: listeners } = options;
  const node = el(
    'tr',
    {
      class: classes('ds-TableRow', className),
      tabindex: interactive ? '0' : undefined,
      'aria-selected': selected == null ? undefined : String(selected),
      ...data({ selected, interactive, summary }),
      ...attrs,
    },
    children,
  );
  on(node, listeners);
  return node;
}

export type TableCellOptions = {
  children?: Child;
  /** Keeps a date or a status on one line. */
  nowrap?: boolean;
  /** The quieter columns: date, type, status, owner. */
  muted?: boolean;
  /** The row's own name, carrying a touch more weight. */
  primary?: boolean;
  /**
   * Hierarchy level, as an indent. On the cell rather than on a wrapper, so the
   * indent moves the whole entry — marks, glyph and title alike — instead of
   * only the text after them.
   */
  depth?: number;
  colspan?: number;
  className?: string;
  attrs?: Attrs;
};

export function TableCell(options: TableCellOptions = {}): HTMLTableCellElement {
  const { children, nowrap, muted, primary, depth, colspan, className, attrs } = options;
  return el(
    'td',
    {
      class: classes('ds-TableCell', className),
      colspan,
      style: depth ? `--ds-depth:${depth}` : undefined,
      ...data({ nowrap, muted, primary, indented: depth != null }),
      ...attrs,
    },
    children,
  );
}

export type TreeToggleOptions = {
  /**
   * `true` open, `false` folded, `undefined` for a leaf — which renders the slot
   * empty rather than omitting it, so a leaf's title starts at the same x as its
   * siblings'. An indent only some rows reserve reads as a rendering bug.
   */
  expanded?: boolean;
  label?: string;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

/**
 * The fold control in front of a tree row.
 *
 * A real `<button>` inside a row that is itself activatable: only a nested
 * control keeps „open this entry" and „fold its children" apart for the
 * keyboard. One glyph for both states — folded rotates it a quarter turn rather
 * than swapping in a second icon, so the two states are visibly one control.
 */
export function TreeToggle(options: TreeToggleOptions = {}): HTMLSpanElement {
  const { expanded, label, className, attrs, on: listeners } = options;
  const slot = el('span', { class: classes('ds-TreeSlot', className) });
  if (expanded == null) return slot;

  const button = el('button', {
    type: 'button',
    class: 'ds-TreeToggle',
    'aria-expanded': String(expanded),
    'aria-label': label,
    title: label,
    ...data({ collapsed: !expanded }),
    ...attrs,
  });
  on(button, listeners);
  slot.appendChild(button);
  return slot;
}

export type TableGroupRowOptions = {
  title: string;
  /** Columns to span. Must match the head, or the row stops short. */
  colspan: number;
  /** An action beside the title — the per-group „+ Eintrag". */
  action?: Element;
  className?: string;
  attrs?: Attrs;
};

/**
 * A group heading inside the table. The action sits next to the title with a
 * comfortable gap rather than being pushed to the far right edge: at the width
 * of a full table those two would end up a screen apart, and the button would
 * read as belonging to the last column.
 */
export function TableGroupRow(options: TableGroupRowOptions): HTMLTableRowElement {
  const { title, colspan, action, className, attrs } = options;
  return el('tr', { class: classes('ds-TableGroupRow', className), ...attrs }, [
    el('th', { colspan, scope: 'colgroup' }, [
      el('span', { class: 'ds-TableGroupRow-title' }, title),
      action,
    ]),
  ]);
}

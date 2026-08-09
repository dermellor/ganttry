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
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function TableRow(options: TableRowOptions = {}): HTMLTableRowElement {
  const { children, selected, interactive, className, attrs, on: listeners } = options;
  const node = el(
    'tr',
    {
      class: classes('ds-TableRow', className),
      tabindex: interactive ? '0' : undefined,
      'aria-selected': selected == null ? undefined : String(selected),
      ...data({ selected, interactive }),
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
  colspan?: number;
  className?: string;
  attrs?: Attrs;
};

export function TableCell(options: TableCellOptions = {}): HTMLTableCellElement {
  const { children, nowrap, muted, primary, colspan, className, attrs } = options;
  return el(
    'td',
    { class: classes('ds-TableCell', className), colspan, ...data({ nowrap, muted, primary }), ...attrs },
    children,
  );
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

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

/**
 * `list` is a list of records: one subject per row, each column a property of it,
 * everything left-aligned and top-aligned so a wrapping title stays readable.
 *
 * `matrix` is a cross-tab: the cells are values at the intersection of a row and a
 * column, so they centre and sit on the row's middle, and the column heads are
 * *subjects* being compared rather than labels for what is under them — which is
 * why they keep the headline voice instead of a list header's uppercase caption.
 * The row header is the one thing that still reads left to right.
 */
export type TableLayout = 'list' | 'matrix';

export type TableOptions = {
  children?: Child;
  layout?: TableLayout;
  className?: string;
  attrs?: Attrs;
};

export function Table(options: TableOptions = {}): HTMLTableElement {
  const { children, layout = 'list', className, attrs } = options;
  return el(
    'table',
    { class: classes('ds-Table', className), ...data({ layout }), ...attrs },
    children,
  );
}

export type TableHeadOptions = {
  /** The simple case: one row of plain column captions. */
  columns?: string[];
  /**
   * The head as built markup, for a header that `columns` cannot express: cells
   * carrying their own classes or data attributes, or a second row beneath the
   * first. Wins over `columns` when both are given.
   */
  children?: Child;
  className?: string;
};

export function TableHead(options: TableHeadOptions): HTMLTableSectionElement {
  const { columns, children, className } = options;
  return el(
    'thead',
    { class: className },
    children ??
      el(
        'tr',
        {},
        (columns ?? []).map((column) => TableHeadCell({ children: column })),
      ),
  );
}

export type TableHeadCellOptions = {
  children?: Child;
  /**
   * A trailing column that takes only the width it needs — an indicator or a row
   * of actions. Without it the browser shares the table's width evenly and a column
   * holding one dot ends up as wide as one holding a sentence.
   */
  shrink?: boolean;
  /**
   * The corner of a cross-tab: the cell above the column that *names* each row.
   * It heads a column of names rather than one of values, so it reads left to right
   * like they do instead of centring with the rest of the header.
   */
  corner?: boolean;
  className?: string;
  attrs?: Attrs;
};

/**
 * One column head. Its own component rather than an `el('th')` inside `TableHead`,
 * because a head cell that carries a class, a title or a click target — a tier
 * column that opens its own form — had no way to be built from the layer at all.
 */
export function TableHeadCell(options: TableHeadCellOptions = {}): HTMLTableCellElement {
  const { children, shrink, corner, className, attrs } = options;
  return el(
    'th',
    {
      scope: 'col',
      class: classes('ds-TableHeadCell', className),
      ...data({ shrink, corner }),
      ...attrs,
    },
    children,
  );
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
  /**
   * Renders `<th scope="row">` instead of `<td>`: the cell that *names* the row
   * rather than carrying one of its values. In a cross-tab that is what lets a
   * screen reader say which feature a lone „✓" belongs to, so it is semantics
   * rather than styling.
   */
  header?: boolean;
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
  const { children, header, nowrap, muted, primary, depth, colspan, className, attrs } = options;
  return el(
    header ? 'th' : 'td',
    {
      class: classes('ds-TableCell', className),
      scope: header ? 'row' : undefined,
      colspan,
      style: depth ? `--ds-depth:${depth}` : undefined,
      ...data({ header, nowrap, muted, primary, indented: depth != null }),
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
  /**
   * The quiet form: a small tinted section label rather than a headline. For a
   * dense grid, where a group is a divider between bands of rows and the full
   * headline treatment would outweigh the rows it introduces.
   */
  dense?: boolean;
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
  const { title, colspan, action, dense, className, attrs } = options;
  return el('tr', { class: classes('ds-TableGroupRow', className), ...data({ dense }), ...attrs }, [
    el('th', { colspan, scope: 'colgroup' }, [
      el('span', { class: 'ds-TableGroupRow-title' }, title),
      action,
    ]),
  ]);
}

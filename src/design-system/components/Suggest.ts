import './Suggest.css';
import { classes, data, el, on, type Attrs, type Child, type Listeners } from './dom';

/**
 * The autosuggest dropdown under a ChipBox: JIRA issues, tags, dependencies,
 * custom-field values, users.
 *
 * Two row shapes, and the difference is real rather than cosmetic. A `stacked`
 * row carries an identifier over its description (an issue key over its summary)
 * because both matter and neither fits on one line; a `inline` row is a mark and
 * a name, optionally with a trailing detail pushed right. Everything else about
 * the five widgets' dropdowns was the same.
 */

export type SuggestListOptions = {
  children?: Child;
  hidden?: boolean;
  /** Anchor to the right edge — for a list wider than the field it belongs to. */
  alignEnd?: boolean;
  /** A floor on the width, so a list that may be wider does not jump per query. */
  minWidth?: number;
  ariaLabel?: string;
  className?: string;
  attrs?: Attrs;
};

export function SuggestList(options: SuggestListOptions = {}): HTMLUListElement {
  const { children, hidden, alignEnd, minWidth, ariaLabel, className, attrs } = options;
  return el(
    'ul',
    {
      class: classes('ds-SuggestList', className),
      role: 'listbox',
      'aria-label': ariaLabel,
      hidden,
      style: minWidth ? `--ds-suggest-min:${minWidth}px` : undefined,
      ...data({ 'align-end': alignEnd }),
      ...attrs,
    },
    children,
  );
}

export type SuggestItemOptions = {
  /** Inline: mark + label (+ trailing detail). Stacked: code over description. */
  layout?: 'inline' | 'stacked';
  label?: string;
  /** The identifier line of a stacked row, or the code before an inline label. */
  code?: string;
  /** The second line of a stacked row: an issue summary, an item id. */
  description?: string;
  /** Pushed to the trailing edge of an inline row: an email address. */
  detail?: string;
  /** A leading dot or avatar. */
  mark?: Element;
  /** Keyboard cursor. The pointer's hover state looks the same on purpose. */
  active?: boolean;
  className?: string;
  attrs?: Attrs;
  on?: Listeners;
};

export function SuggestItem(options: SuggestItemOptions = {}): HTMLLIElement {
  const { layout = 'inline', label, code, description, detail, mark, active, className, attrs, on: listeners } =
    options;

  const node = el(
    'li',
    {
      class: classes('ds-SuggestItem', className),
      role: 'option',
      'aria-selected': active ? 'true' : 'false',
      ...data({ layout, active }),
      ...attrs,
    },
    [
      mark,
      code != null && el('span', { class: 'ds-SuggestItem-code' }, code),
      label != null && el('span', { class: 'ds-SuggestItem-label' }, label),
      description != null && el('span', { class: 'ds-SuggestItem-description' }, description),
      detail != null && el('span', { class: 'ds-SuggestItem-detail' }, detail),
    ],
  );
  on(node, listeners);
  return node;
}

/**
 * Move the keyboard cursor to one row of a list, clearing it from the others.
 *
 * It lives here rather than in each widget because all four autosuggests do the
 * same thing and used to do it four times, each with its own selector — the kind
 * of duplication where the fix for a missed `aria-selected` lands in one copy.
 * An index outside the list clears the cursor entirely.
 */
export function highlightSuggestion(list: Element, index: number): void {
  list.querySelectorAll<HTMLElement>('.ds-SuggestItem').forEach((item, i) => {
    const active = i === index;
    item.toggleAttribute('data-active', active);
    item.setAttribute('aria-selected', String(active));
  });
}

export type SuggestEmptyOptions = {
  text: string;
  className?: string;
};

/**
 * Why there is nothing to pick — an unreachable directory, nobody signed in yet,
 * no match. Not an option: it is inert by construction, because a picker with an
 * empty candidate list has nothing for the arrow keys to move over. A dropdown
 * that silently refuses to open reads as a broken field instead.
 */
export function SuggestEmpty(options: SuggestEmptyOptions): HTMLLIElement {
  const { text, className } = options;
  return el('li', { class: classes('ds-SuggestEmpty', className), role: 'presentation' }, text);
}

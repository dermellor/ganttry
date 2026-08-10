import './DescriptionList.css';
import { classes, data, el, type Attrs, type Child } from './dom';

/**
 * Read-only term/value pairs: an item's metadata under the headline, and the
 * creation/update audit block at the foot of the form.
 *
 * The two differ only in density, which is the `compact` prop. Both were their
 * own grid definition before, and the audit block's had already drifted to a
 * different column gap.
 */

export type DescriptionListEntry = {
  term: string;
  /** A string, or a node — a link, a chip, a stack of them. */
  value: Child;
  /** Lets a long value (an id, a URL) break instead of forcing a scrollbar. */
  breakAll?: boolean;
};

export type DescriptionListOptions = {
  entries?: DescriptionListEntry[];
  children?: Child;
  /** The audit footer: smaller type, tighter rows. */
  compact?: boolean;
  className?: string;
  attrs?: Attrs;
};

export function DescriptionList(options: DescriptionListOptions = {}): HTMLDListElement {
  const { entries = [], children, compact, className, attrs } = options;
  return el('dl', { class: classes('ds-DescriptionList', className), ...data({ compact }), ...attrs }, [
    descriptionItems(entries),
    children,
  ]);
}

/**
 * The `dt`/`dd` pairs on their own, for a call site that owns the `<dl>` already
 * — the detail panel's meta list is part of the app frame and gets refilled per
 * item rather than rebuilt.
 */
export function descriptionItems(entries: DescriptionListEntry[]): HTMLElement[] {
  return entries.flatMap((entry) => [
    el('dt', {}, entry.term),
    el('dd', { ...data({ 'break-all': entry.breakAll }) }, entry.value),
  ]);
}

/** Replace a `<dl>`'s contents with these entries. */
export function setDescriptionList(list: HTMLElement, entries: DescriptionListEntry[]): void {
  list.replaceChildren(...descriptionItems(entries));
}

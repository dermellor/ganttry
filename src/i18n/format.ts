// Sorting, dates and numbers follow the reader's language, the same as the labels.
//
// This module exists because the alternative is what was here before it: German
// collation hardcoded at seven call sites (`localeCompare(name, 'de')`) and one
// `Intl.DateTimeFormat('de-DE')`, each a separate decision nobody made twice. A
// reader on English then got English labels over a German sort order, which is
// worse than either consistently — a list that is alphabetical in a way its
// labels do not explain reads as unsorted.
//
// Every formatter is **cached per locale**. `Intl.Collator` and
// `Intl.DateTimeFormat` are expensive to construct and these are called from
// inside comparators: building one per comparison turned a sort of a few hundred
// rows into the slowest thing on a repaint. One per locale for the life of the
// page is the whole optimisation, and it is why callers get a shared instance
// rather than a fresh one.
//
// Pure and DOM-free: `Intl` is on every runtime this ships to.

import { INTL_TAG, type Locale } from './locale.ts';

const collators = new Map<string, Intl.Collator>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

/**
 * The comparator for user-visible text in this locale.
 *
 * `sensitivity: 'base'` so „Ä" sorts with „A" and case does not split a list —
 * the behaviour `savedViews.ts` already asked for explicitly and the other six
 * call sites got by accident or not at all.
 *
 * Use it for anything a person reads in order: names, labels, group headings.
 * **Not** for ids and not for ISO date strings — those are sorted for the machine
 * and a locale-aware comparison over them is both slower and wrong (`localeCompare`
 * on `2026-01-02` happens to work and stops working the moment a value is not
 * zero-padded).
 */
export function collator(locale: Locale): Intl.Collator {
  let c = collators.get(locale);
  if (!c) {
    c = new Intl.Collator(INTL_TAG[locale], { sensitivity: 'base', numeric: true });
    collators.set(locale, c);
  }
  return c;
}

/** `compare` on its own, for handing straight to `Array.prototype.sort`. */
export function compareText(locale: Locale): (a: string, b: string) => number {
  return collator(locale).compare;
}

/**
 * A timestamp as this locale writes it, date and time.
 *
 * The one format the interface needs so far — the audit line under an item's
 * form. Kept as a function of the locale rather than a constant, because the
 * constant is what `itemForm.ts` had (`new Intl.DateTimeFormat('de-DE', …)` at
 * module scope) and a module-scope constant cannot follow a setting.
 */
export function dateTimeFormat(locale: Locale): Intl.DateTimeFormat {
  let f = dateFormats.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_TAG[locale], { dateStyle: 'medium', timeStyle: 'short' });
    dateFormats.set(locale, f);
  }
  return f;
}

/** A calendar day as this locale writes it, no time. */
export function dayFormat(locale: Locale): Intl.DateTimeFormat {
  const key = `${locale}:day`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_TAG[locale], { dateStyle: 'medium' });
    dateFormats.set(key, f);
  }
  return f;
}

/** A number as this locale writes it — the decimal mark and the group separator. */
export function numberFormat(locale: Locale): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(INTL_TAG[locale]);
    numberFormats.set(locale, f);
  }
  return f;
}

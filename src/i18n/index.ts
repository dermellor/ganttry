// The locale this page is rendering in, and `t()` — the only two things a
// rendering module needs from here.
//
// **Why there is module state at all.** Every other per-person preference in this
// app is passed down (the extent, the grouping), and this one is not, for a reason
// worth stating: the language is read by roughly three hundred call sites across
// every module that draws anything, including modules that take no options object
// today. Threading a locale through all of them would be the change rather than a
// consequence of it, and every module that forgot would silently render the
// default. One module-scope value that is set once at boot is the smaller thing.
//
// **The rule that keeps it honest: nothing calls `t()` at module scope.** A
// `const LABEL = t('form.save')` at the top of a file is evaluated on import, which
// is before `initLocale()` has run, so it freezes the default into a constant and
// no language change ever moves it. That is the one way to misuse this module and
// `i18n.test.ts` pins the behaviour that makes it visible.
//
// The DOM-free half — the locale union, the catalogues, the formatters — lives in
// the siblings, because the server needs those and must not import this file.

import { translate, type MessageKey, type MessageVars } from './catalogue.ts';
import { compareText, dateTimeFormat, dayFormat, numberFormat } from './format.ts';
import { DEFAULT_LOCALE, normalizeLocale, resolveLocale, type Locale } from './locale.ts';

export { LOCALES, DEFAULT_LOCALE, normalizeLocale, resolveLocale, type Locale } from './locale.ts';
export type { MessageKey } from './catalogue.ts';

/**
 * Where a locale is remembered when there is nobody to remember it for.
 *
 * A file-backed instance has no `app_users` table and therefore no profile to
 * hang a preference on — the deployment genuinely does not know who is looking.
 * `localStorage` is the honest store for that: it says „this device", which is
 * exactly as much as such an instance can know, instead of pretending to a profile
 * that does not exist. The interface says the same thing in the account section
 * („Nur auf diesem Gerät"), so nobody expects it to follow them to another browser.
 *
 * The `timelines.` prefix matches its siblings (`timelines.view`,
 * `timelines.viewPrefs`) rather than the product's current name. See „The name
 * covers the product, not its vocabulary or its instances" (AGENTS.md): the prefix
 * is a stored key, and a key rename without a read-both migration silently resets
 * everybody. A new key gets the prefix its neighbours have so there is one rename
 * to do rather than two.
 */
const STORAGE_KEY = 'timelines.language';

let current: Locale = DEFAULT_LOCALE;
let instanceDefault: Locale | null = null;

/** What `localStorage` remembers, or `null`. Never throws: Safari's private mode. */
function stored(): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function remember(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // A device that refuses storage still gets the language for this page; it
    // just cannot carry it to the next one. Refusing to switch would be worse.
  }
}

/**
 * The locale to render with, decided before the first paint.
 *
 * Synchronous and `localStorage`-first **on purpose**. The authoritative answer for
 * a signed-in person is their `app_users` row, which arrives with `/api/me` — one
 * round trip later. Waiting for it would mean either a blank app or a first paint
 * in the wrong language followed by a visible re-render, and the second is the one
 * users report as a bug. So the device's last known answer paints, and
 * `adoptServerLocale` reconciles when the row arrives, which is a no-op in the
 * overwhelmingly common case that they agree.
 */
export function initLocale(opts: { instanceDefault?: unknown } = {}): Locale {
  instanceDefault = normalizeLocale(opts.instanceDefault);
  current = resolveLocale({ chosen: stored(), instanceDefault });
  applyDocumentLang();
  return current;
}

/**
 * The locale the server holds for this person, once `/api/me` has answered.
 *
 * Returns whether anything changed, so the caller can repaint only when it did.
 * A `null` or unparseable value means „this person has never chosen", which is
 * not the same as „chose the default": the device's own answer then stands rather
 * than being overwritten by a fallback.
 */
export function adoptServerLocale(raw: unknown): boolean {
  const chosen = normalizeLocale(raw);
  if (!chosen || chosen === current) return false;
  current = chosen;
  remember(chosen);
  applyDocumentLang();
  return true;
}

/** The locale in force. */
export function locale(): Locale {
  return current;
}

/**
 * Switch language for this page and remember it on this device.
 *
 * Persisting to the profile is the caller's job (`PATCH /api/me`), and the split is
 * deliberate: the switch has to take effect on a file-backed instance that has no
 * profile to write to, so the device store is the part that always happens and the
 * request is the part that happens where there is somebody to write it for.
 */
export function setLocale(next: Locale): void {
  current = next;
  remember(next);
  applyDocumentLang();
}

/**
 * `<html lang>`, which is not cosmetic: it is what a screen reader picks a voice
 * from and what the browser hyphenates and spell-checks by. Getting the labels
 * right and leaving this saying `de` gives a screen-reader user English words read
 * with German phonetics, which is less usable than either language alone.
 */
function applyDocumentLang(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

/** The text for a key, in the locale in force. Never call this at module scope. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(current, key, vars);
}

/** The comparator for user-visible text, in the locale in force. */
export function compare(): (a: string, b: string) => number {
  return compareText(current);
}

/** A timestamp as the locale in force writes it. */
export function formatDateTime(value: Date | number): string {
  return dateTimeFormat(current).format(value);
}

/** A calendar day as the locale in force writes it. */
export function formatDay(value: Date | number): string {
  return dayFormat(current).format(value);
}

/** A number as the locale in force writes it. */
export function formatNumber(value: number): string {
  return numberFormat(current).format(value);
}

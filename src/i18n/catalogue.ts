// The message catalogues, and the lookup that turns a key into text.
//
// **English is the reference catalogue and German is checked against it.** That
// direction is not a preference for English: it is what makes a missing
// translation a compile error instead of a hole that renders as a key. `MessageKey`
// is derived from `messages.en.ts`, and `messages.de.ts` is typed as a total record
// over it, so a key added on one side and forgotten on the other does not build.
// `catalogue.test.ts` asserts the other direction too — a stale German key that no
// longer exists in English — because a total record cannot see a *surplus*.
//
// The keys are the interface's own vocabulary and they are flat and dotted
// (`form.save`, `settings.account.language`). Flat because a nested object buys
// nothing here and costs the one property that matters: `keyof` over a flat object
// is the complete key list, which is what both the type check and
// `check-ui-text.mjs` walk.
//
// **`check-ui-text.mjs` now runs over these catalogues rather than over call
// sites**, and that move is part of why this module exists. The rule „interface
// text is labels, headings and refusals" was enforced by finding string literals
// at rendering sites; a catalogue makes every one of those a `t('…')` call and
// would have retired the checker silently, leaving the rule to rot exactly the way
// „Interface text" (AGENTS.md) says prose rots. Checking the catalogue is strictly
// better: it is the complete list, in one place, in both languages.
//
// Pure and DOM-free. The browser renders with it, and the server resolves a
// settings label with it before serving — see „The label is resolved on the
// server" (docs/settings.md).

import { DEFAULT_LOCALE, type Locale } from './locale.ts';
import { EN } from './messages.en.ts';
import { DE } from './messages.de.ts';

/**
 * Every message the interface has. Derived, never hand-listed.
 *
 * A plural is two entries (`item.count.one`, `item.count.other`) and is *called*
 * by its base (`t('item.count', { count })`), so the base has to be a valid key
 * even though no entry carries it. Derived from the `.one` half rather than
 * declared, which keeps „add a plural" a two-line change in the catalogue and
 * nothing here.
 */
type PluralBase<K> = K extends `${infer B}.one` ? B : never;

export type MessageKey = keyof typeof EN | PluralBase<keyof typeof EN>;

export const CATALOGUES: Record<Locale, Record<string, string>> = { en: EN, de: DE };

/** What a message may be handed to fill its placeholders. */
export type MessageVars = Record<string, string | number>;

/**
 * `{name}` placeholders, filled from `vars`.
 *
 * A placeholder with nothing to fill it is **left standing** rather than replaced
 * with an empty string. An empty string produces „ items" and reads as a rendering
 * bug of unknown origin; `{count} items` names the variable that was not passed and
 * points at the call site.
 */
function interpolate(text: string, vars: MessageVars | undefined): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * The text for a key in a locale.
 *
 * **Plurals** are two keys, `<key>.one` and `<key>.other`, chosen by a numeric
 * `count` var. That covers German and English completely — both split exactly
 * one/other — and deliberately no further: a language with a dual or a paucal
 * needs a real plural-rule table, and building one now would be designed against
 * two languages that do not need it. A third language is the moment to replace
 * this, and the shape of the keys does not have to change when it happens.
 *
 * The fallback chain is requested locale → `DEFAULT_LOCALE` → the key itself. The
 * key is deliberately visible rather than swallowed: a blank where a label belongs
 * is indistinguishable from a layout bug, and a key on screen says both that
 * something is missing and exactly which line to fix. Typing means this cannot
 * happen for the core catalogue at all; it is reachable only for a plugin's, which
 * is data the host did not compile.
 */
export function translate(
  locale: Locale,
  key: string,
  vars?: MessageVars,
  catalogues: Record<string, Record<string, string>> = CATALOGUES,
): string {
  const count = vars?.count;
  const candidates =
    typeof count === 'number' ? [`${key}.${count === 1 ? 'one' : 'other'}`, key] : [key];

  for (const candidate of candidates) {
    const hit = catalogues[locale]?.[candidate] ?? catalogues[DEFAULT_LOCALE]?.[candidate];
    if (hit != null) return interpolate(hit, vars);
  }
  return key;
}

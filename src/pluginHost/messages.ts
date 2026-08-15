// How a plugin ships text in more than one language.
//
// A plugin's labels, its option labels and its warnings are literals in its own
// folder, so the core's catalogue cannot hold them: the host does not know a
// plugin exists until it is installed, and a third-party plugin is not in this
// repository at all. Nor can a plugin import the core catalogue — `MessageKey` is
// derived from `messages.en.ts` and a plugin's keys are not in it, and reaching
// past the contract is exactly what `check-plugin-isolation.mjs` forbids.
//
// So a plugin brings **its own catalogue** and gets back a lookup bound to
// whatever language the host is currently rendering in:
//
//   const t = pluginMessages('com.acme.sprints', {
//     en: { 'field.confidence': 'Confidence' },
//     de: { 'field.confidence': 'Zuversicht' },
//   });
//   t('field.confidence')
//
// **What must not go through it: anything stored.** A select field's `value` is an
// id that sits in item metadata, and running it through a translation would orphan
// every item carrying it the first time somebody switched language. Only `label`
// moves. That boundary is asserted in `src/i18n/storedValues.test.ts` rather than
// left to whoever writes the next plugin.
//
// ---- what this deliberately does not do -------------------------------------
//
// **No pluralisation of its own** and no date or number formatting: the host
// already exposes `formatDay`, `formatNumber` and `compare` through the contract,
// so a plugin that needs them takes the host's, and the reader gets one set of
// conventions across a screen that mixes core and plugin text.
//
// **No fallback to the core catalogue.** A plugin key that resolves to a core
// message would be an accident every time — the namespaces are unrelated, and a
// collision would silently render somebody else's word. A missing key renders as
// the key, which is visible and names the line to fix.

import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { locale } from '../i18n/index.ts';
import { translate, type MessageVars } from '../i18n/catalogue.ts';

/** What a plugin declares: a catalogue per language, none of them required. */
export type PluginCatalogues = Partial<Record<Locale, Record<string, string>>>;

/** The lookup a plugin gets back. Same shape as the core's `t`. */
export type PluginT = (key: string, vars?: MessageVars) => string;

/**
 * Every plugin's catalogues, by plugin id.
 *
 * Registered rather than passed around because a plugin's own modules — its view,
 * its fields, its tools — each need the lookup and are not handed a common context.
 * Keyed by id so two plugins declaring the same key never see each other's text,
 * which is the same isolation the data store gives their rows.
 */
const registered = new Map<string, PluginCatalogues>();

/**
 * Declare a plugin's catalogues and get its lookup.
 *
 * Idempotent per id: calling it from three modules of the same plugin registers
 * once and hands back three lookups over the same table. That is what lets a
 * plugin declare its text beside the code that uses it rather than in one file
 * every module has to import.
 *
 * The returned function reads `locale()` **on each call**, never at registration.
 * A lookup captured into a module-scope constant would otherwise freeze the
 * language the same way `t()` does at module scope in core — see the third check
 * in `scripts/ci/check-ui-text.mjs`.
 */
export function pluginMessages(id: string, catalogues: PluginCatalogues): PluginT {
  // Merged **per language**, not per catalogue. A shallow spread replaces the
  // whole `en` table when a second module declares one, so the first module's
  // keys disappear — and only for that language, which is how it would have been
  // found: one screen half-translated, in one language, long after the fact.
  const merged: PluginCatalogues = { ...registered.get(id) };
  for (const [lang, table] of Object.entries(catalogues) as [Locale, Record<string, string>][]) {
    merged[lang] = { ...merged[lang], ...table };
  }
  registered.set(id, merged);

  return (key, vars) => {
    const own = registered.get(id) ?? {};
    // The host's language first, then the language the plugin was written in,
    // then the key. The middle step is what makes a single-language plugin work
    // unchanged on a host rendering the other language: it shows its own text
    // rather than a row of keys, which is the difference between „not translated
    // yet" and „broken".
    const chain: Record<string, Record<string, string>> = {};
    const active = locale();
    if (own[active]) chain[active] = own[active]!;
    if (own[DEFAULT_LOCALE]) chain[DEFAULT_LOCALE] = own[DEFAULT_LOCALE]!;
    for (const [lang, table] of Object.entries(own)) {
      if (!chain[lang]) chain[lang] = table!;
    }
    const hit = translate(active, key, vars, chain);
    if (hit !== key) return hit;
    // `translate` already tried the active language and the product default. What
    // is left is a plugin that ships neither — a German-only plugin on an English
    // host — so any declared language is better than the key.
    for (const table of Object.values(chain)) {
      if (table[key] != null) return translate(active, key, vars, { [active]: table });
    }
    return key;
  };
}

/** Which languages a plugin declares. For the catalogue page and for tests. */
export function pluginLocales(id: string): Locale[] {
  return Object.keys(registered.get(id) ?? {}) as Locale[];
}

/** Test seam: forget every registration. */
export function resetPluginMessages(): void {
  registered.clear();
}

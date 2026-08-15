import assert from 'node:assert/strict';
import test from 'node:test';

import { CATALOGUES, translate } from './catalogue.ts';
import { collator, dateTimeFormat, dayFormat } from './format.ts';
import { EN } from './messages.en.ts';
import { DE } from './messages.de.ts';
import { DEFAULT_LOCALE, INTL_TAG, LOCALES, normalizeLocale, resolveLocale } from './locale.ts';

// ── The locale union ───────────────────────────────────────────────────────

test('a region tag resolves to its language, because that is what browsers send', () => {
  assert.equal(normalizeLocale('de-DE'), 'de');
  assert.equal(normalizeLocale('en-GB'), 'en');
  assert.equal(normalizeLocale('de_AT'), 'de');
  assert.equal(normalizeLocale('  DE  '), 'de');
});

test('anything that is not a language is null, not the default', () => {
  // `null` rather than a fallback is what lets `resolveLocale` fall through to the
  // next source. A function that answered „en" here could not tell „not set" from
  // „set to English", and the instance default would never be reached.
  for (const junk of ['', '   ', 'fr', 'xx-YY', 'null', 42, null, undefined, {}]) {
    assert.equal(normalizeLocale(junk), null, `${JSON.stringify(junk)} is not a locale`);
  }
});

test('a person’s own choice outranks the instance default, which outranks the product default', () => {
  assert.equal(resolveLocale({ chosen: 'en', instanceDefault: 'de' }), 'en');
  assert.equal(resolveLocale({ chosen: null, instanceDefault: 'de' }), 'de');
  assert.equal(resolveLocale({}), DEFAULT_LOCALE);
});

test('a deployment that set nothing speaks the product default', () => {
  // Pinned deliberately: this is the decision „a fresh instance starts in English",
  // and it is the one line to change if that is ever revisited.
  assert.equal(DEFAULT_LOCALE, 'en');
});

test('an unreadable instance default does not take a chooser’s answer away', () => {
  assert.equal(resolveLocale({ chosen: 'de', instanceDefault: 'nonsense' }), 'de');
  assert.equal(resolveLocale({ chosen: null, instanceDefault: 'nonsense' }), DEFAULT_LOCALE);
});

// ── The catalogues ─────────────────────────────────────────────────────────

test('both catalogues carry exactly the same keys', () => {
  // The type makes German total over English; nothing in the type system catches a
  // *surplus* German key left behind when an English one is deleted. It would
  // render for nobody and read as a translation that exists.
  assert.deepEqual(Object.keys(DE).sort(), Object.keys(EN).sort());
});

test('no message is empty in either language', () => {
  for (const locale of LOCALES) {
    for (const [key, text] of Object.entries(CATALOGUES[locale])) {
      assert.ok(text.trim(), `${locale}:${key} is empty`);
    }
  }
});

test('every language name is written in its own language', () => {
  // The one pair that must not be translated: somebody switching *away* from a
  // language they cannot read has to recognise the target in the list.
  for (const locale of LOCALES) {
    assert.equal(CATALOGUES[locale]['account.language.de'], 'Deutsch');
    assert.equal(CATALOGUES[locale]['account.language.en'], 'English');
  }
});

test('a placeholder is filled from the vars', () => {
  assert.equal(translate('en', 'filter.emptyBucket', { field: 'Owner' }), 'Without Owner');
  assert.equal(translate('de', 'filter.emptyBucket', { field: 'Owner' }), 'Ohne Owner');
});

test('a placeholder with nothing to fill it stays visible', () => {
  // An empty string produces „Without " and reads as a rendering bug of unknown
  // origin. The placeholder names the variable that was not passed.
  assert.equal(translate('en', 'filter.emptyBucket'), 'Without {field}');
});

test('a count picks the singular or the plural key', () => {
  assert.equal(translate('en', 'item.count', { count: 1 }), '1 entry');
  assert.equal(translate('en', 'item.count', { count: 8 }), '8 entries');
  assert.equal(translate('de', 'item.count', { count: 1 }), '1 Eintrag');
  assert.equal(translate('de', 'item.count', { count: 8 }), '8 Einträge');
  assert.equal(translate('en', 'item.count', { count: 0 }), '0 entries');
});

test('a key nothing has falls through to the key itself, visibly', () => {
  // Unreachable for the core catalogue, which is typed. It is the path a plugin's
  // own catalogue takes, and a blank there would be indistinguishable from a
  // layout bug.
  assert.equal(translate('en', 'nothing.defines.this'), 'nothing.defines.this');
});

test('a locale missing a key falls back to the default language, not to the key', () => {
  const partial = { en: { 'a.b': 'English' }, de: {} };
  assert.equal(translate('de', 'a.b', undefined, partial), 'English');
});

// ── Formatting follows the same setting ────────────────────────────────────

test('a date is written the way each language writes it', () => {
  const when = Date.UTC(2026, 0, 9, 13, 5);
  assert.notEqual(dayFormat('de').format(when), dayFormat('en').format(when));
  assert.match(dayFormat('de').format(when), /2026/);
  assert.match(dayFormat('en').format(when), /2026/);
});

test('a formatter is built once per locale, because comparators call it', () => {
  // Not a micro-optimisation: `collator()` is called from inside sort comparators,
  // and constructing an Intl.Collator per comparison made a few hundred rows the
  // slowest thing on a repaint.
  assert.equal(collator('de'), collator('de'));
  assert.equal(dateTimeFormat('en'), dateTimeFormat('en'));
  assert.notEqual(collator('de'), collator('en'));
});

test('sorting is case- and accent-insensitive, so a list is not split by capitals', () => {
  const names = ['Ökonomie', 'apfel', 'Zebra', 'Apfel'];
  const sorted = [...names].sort(collator('de').compare);
  assert.deepEqual(sorted.slice(0, 2).map((n) => n.toLowerCase()), ['apfel', 'apfel']);
  assert.equal(sorted.at(-1), 'Zebra');
});

test('every locale has an Intl tag with a region', () => {
  // A bare primary subtag lets a runtime choose its own date pattern, which is how
  // the same screenshot comes out `1.1.2026` on one machine and `01.01.2026` on
  // another.
  for (const locale of LOCALES) assert.match(INTL_TAG[locale], /^[a-z]{2}-[A-Z]{2}$/);
});

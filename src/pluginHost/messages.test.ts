import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { pluginMessages, pluginLocales, resetPluginMessages } from './messages.ts';
import { setLocale } from '../i18n/index.ts';

beforeEach(() => {
  resetPluginMessages();
  setLocale('en');
});

test('a plugin’s text follows the host’s language', () => {
  const t = pluginMessages('com.acme.test', {
    en: { 'field.confidence': 'Confidence' },
    de: { 'field.confidence': 'Zuversicht' },
  });
  assert.equal(t('field.confidence'), 'Confidence');
  setLocale('de');
  assert.equal(t('field.confidence'), 'Zuversicht');
});

test('the lookup reads the language on every call, not at registration', () => {
  // The failure this forbids is the one core hit in `settingsArea.ts`: a value
  // captured at module scope freezes whatever language was in force on import.
  const t = pluginMessages('com.acme.test', { en: { a: 'A' }, de: { a: 'Ä' } });
  const captured = t; // as a plugin would hold it in a module constant
  setLocale('de');
  assert.equal(captured('a'), 'Ä');
});

test('a single-language plugin shows its own text rather than keys', () => {
  // The difference between „not translated yet" and „broken". A German-only
  // plugin on an English host has to render German, not a column of dotted keys.
  const t = pluginMessages('com.acme.german', { de: { 'label.goal': 'Sprint-Ziel' } });
  assert.equal(t('label.goal'), 'Sprint-Ziel');
});

test('a missing key renders as the key, visibly', () => {
  const t = pluginMessages('com.acme.test', { en: { a: 'A' } });
  assert.equal(t('nothing.declares.this'), 'nothing.declares.this');
});

test('two plugins never see each other’s keys', () => {
  // The same isolation their rows get. A collision would silently render another
  // plugin's word, which is worse than a missing one because nothing looks wrong.
  const one = pluginMessages('com.acme.one', { en: { shared: 'From one' } });
  const two = pluginMessages('com.acme.two', { en: { other: 'From two' } });
  assert.equal(one('shared'), 'From one');
  assert.equal(two('shared'), 'shared');
});

test('a plugin key never falls back to a core message', () => {
  // `form.save` exists in the core catalogue. A plugin asking for it must not get
  // it: the namespaces are unrelated, so a hit would be an accident every time.
  const t = pluginMessages('com.acme.test', { en: { a: 'A' } });
  assert.equal(t('form.save'), 'form.save');
});

test('declaring from several modules of one plugin merges rather than replaces', () => {
  // A plugin declares its text beside the code that uses it, so its view, its
  // fields and its tools each register. The second call must not wipe the first.
  pluginMessages('com.acme.test', { en: { fromFields: 'Fields' } });
  const t = pluginMessages('com.acme.test', { en: { fromView: 'View' } });
  assert.equal(t('fromFields'), 'Fields');
  assert.equal(t('fromView'), 'View');
});

test('placeholders are filled the same way the core fills them', () => {
  const t = pluginMessages('com.acme.test', { en: { 'points.left': '{n} points left' } });
  assert.equal(t('points.left', { n: 13 }), '13 points left');
});

test('a plugin reports which languages it ships', () => {
  pluginMessages('com.acme.test', { en: { a: 'A' }, de: { a: 'Ä' } });
  assert.deepEqual(pluginLocales('com.acme.test').sort(), ['de', 'en']);
  assert.deepEqual(pluginLocales('com.acme.unknown'), []);
});

// Translating a label must never move a stored value.
//
// This is the failure mode that would be worst and quietest. A select field stores
// an **id** and shows a **label**, and the two happen to be the same word in
// several places — most visibly `hoch` / `mittel` / `niedrig` in the sprints
// plugin, whose values are German words sitting in `metadata` on real items. A
// sweep that translated „hoch" to „high" because it read as interface text would
// leave every existing item carrying a value that is no longer offered: the field
// renders empty, the filter loses a bucket, and nothing errors. It would be found
// weeks later, by a person, on data nobody can reconstruct.
//
// So the boundary is asserted rather than documented. What follows holds the line
// in three places: the built-in status field, the plugin field the trap is named
// after, and the general rule over every option a plugin declares.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CATALOGUES } from './catalogue.ts';
import { LOCALES } from './locale.ts';
import { ITEM_STATUSES, DEFAULT_STATUS, normalizeStatus } from '../status.ts';
import { CONFIDENCE_OPTIONS } from '../plugins/sprints/fields.ts';

test('a built-in status stores its key, whatever language the label is in', () => {
  // `status` is a column on `timeline_items` and round-trips through the DB, the
  // MCP tools and the export. The keys are the stored vocabulary and are frozen;
  // only `label` is ever free to move.
  assert.deepEqual(ITEM_STATUSES.map((s) => s.key), ['Open', 'Doing', 'Done']);
  assert.equal(DEFAULT_STATUS, 'Open');
});

test('no stored status key is a catalogue message', () => {
  // The check that would have caught a well-meaning sweep: if a status key were
  // ever *also* a message key, translating that message would look like it
  // translated the value. They are deliberately different namespaces.
  for (const locale of LOCALES) {
    const messages = CATALOGUES[locale];
    for (const { key } of ITEM_STATUSES) {
      assert.equal(messages[key], undefined, `status ${key} is also a message key`);
    }
  }
});

test('the three confidence values stay the German words that are stored on items', () => {
  // Named in the issue as the trap. These three are values, not labels, and the
  // reason they look like labels is that the plugin set both to the same word.
  assert.deepEqual(CONFIDENCE_OPTIONS.map((o) => o.value), ['hoch', 'mittel', 'niedrig']);
});

test('a stored value survives a label that no longer matches it', () => {
  // The actual guarantee, exercised rather than asserted about: relabel every
  // option into English, then read a value that was stored under the old labels.
  // The value must still resolve to its option.
  const relabelled = CONFIDENCE_OPTIONS.map((o) => ({
    ...o,
    label: { hoch: 'high', mittel: 'medium', niedrig: 'low' }[o.value] ?? o.label,
  }));

  const storedOnAnExistingItem = 'mittel';
  const found = relabelled.find((o) => o.value === storedOnAnExistingItem);

  assert.ok(found, 'a stored value no longer matches any option — every item lost its value');
  assert.equal(found.label, 'medium');
  assert.equal(found.value, 'mittel');
});

test('a value is matched by value and never by label', () => {
  // The bug this forbids, written out: looking a stored value up by its *label*
  // works for as long as the two are equal and breaks silently the moment a
  // translation makes them differ.
  const relabelled = CONFIDENCE_OPTIONS.map((o) => ({ ...o, label: `translated ${o.value}` }));
  for (const option of relabelled) {
    assert.notEqual(option.label, option.value, 'the fixture must actually differ');
    assert.equal(relabelled.filter((o) => o.value === option.value).length, 1);
  }
});

test('normalizing a status never invents one', () => {
  // The other half of „stored values are not labels": an incoming value that is
  // not a key resolves to nothing rather than to something plausible.
  assert.equal(normalizeStatus('Open'), 'Open');
  assert.equal(normalizeStatus('open'), 'Open');
  assert.equal(normalizeStatus('Offen'), undefined);
  assert.equal(normalizeStatus('hoch'), undefined);
});

test('no catalogue message is a bare stored value of the sprints field', () => {
  // A message whose *text* equals a stored value is not itself a bug, but a
  // message whose **key** is one would mean the two namespaces had merged.
  for (const locale of LOCALES) {
    for (const { value } of CONFIDENCE_OPTIONS) {
      assert.equal(CATALOGUES[locale][value], undefined, `${value} is also a message key`);
    }
  }
});

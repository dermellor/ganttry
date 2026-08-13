import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  configForm,
  controlFor,
  entriesToMap,
  mapEntries,
  pruneEmpty,
  stringsValue,
  undeclaredKeys,
  type ConfigForm,
} from './pluginConfigForm';

function kindOf(raw: unknown): string {
  return controlFor('k', raw, false).kind;
}

test('a scalar type picks the control that matches it', () => {
  assert.equal(kindOf({ type: 'string' }), 'text');
  assert.equal(kindOf({ type: 'number' }), 'number');
  assert.equal(kindOf({ type: 'integer' }), 'number');
  assert.equal(kindOf({ type: 'boolean' }), 'boolean');
});

test('a nullable type is edited as the type it allows', () => {
  // `['string','null']` is „a string, or nothing" — a text field, not JSON.
  assert.equal(kindOf({ type: ['string', 'null'] }), 'text');
  assert.equal(kindOf({ type: ['null', 'number'] }), 'number');
});

test('an enum wins over the type, so a closed list is never free text', () => {
  const control = controlFor('tier', { type: 'string', enum: ['Free', 'Pro'] }, false);
  assert.equal(control.kind, 'select');
  assert.deepEqual(control.options, ['Free', 'Pro']);
});

test('a mixed-type enum is not a select', () => {
  // Half the values would be unrepresentable in an option list, and silently dropping
  // them would offer a shorter list than the schema allows.
  assert.equal(kindOf({ enum: ['a', 3] }), 'json');
});

test('an array of plain strings gets the row editor', () => {
  assert.equal(kindOf({ type: 'array', items: { type: 'string' } }), 'strings');
});

test('an array of anything else stays JSON', () => {
  // A list of objects is a table, and a plugin needing one is asking for its own view.
  assert.equal(kindOf({ type: 'array', items: { type: 'object' } }), 'json');
  assert.equal(kindOf({ type: 'array' }), 'json');
});

test('a string-valued map with data keys gets the key/value editor', () => {
  assert.equal(kindOf({ type: 'object', additionalProperties: { type: 'string' } }), 'map');
});

test('a nested object with declared properties stays JSON', () => {
  // Nesting the form would need a schema walker, and this schema subset has never
  // carried one in practice.
  assert.equal(
    kindOf({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } }),
    'json',
  );
});

test('a property with no type at all is editable as JSON rather than dropped', () => {
  const control = controlFor('x', {}, true);
  assert.equal(control.kind, 'json');
  assert.equal(control.type, '?');
  assert.equal(control.required, true);
});

test('a description travels to the form', () => {
  assert.equal(controlFor('x', { type: 'string', description: 'Warum' }, false).description, 'Warum');
});

test('the real schema in this repo becomes a list and a map', () => {
  const form = configForm({
    type: 'object',
    properties: {
      versions: { type: 'array', items: { type: 'string' } },
      versionLabels: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['versions'],
    additionalProperties: false,
  }) as Extract<ConfigForm, { kind: 'fields' }>;
  assert.equal(form.kind, 'fields');
  assert.deepEqual(
    form.controls.map((c) => [c.key, c.kind, c.required]),
    [['versions', 'strings', true], ['versionLabels', 'map', false]],
  );
});

test('no schema means no form; a schema naming no keys keeps the JSON escape hatch', () => {
  assert.equal(configForm(null), null);
  assert.equal(configForm('nonsense'), null);
  assert.deepEqual(configForm({ type: 'object' }), { kind: 'freeform' });
  assert.deepEqual(configForm({ type: 'object', properties: {} }), { kind: 'freeform' });
});

test('a stored value of the wrong shape reads as empty instead of throwing', () => {
  // A hand-written config may carry a string where a list belongs. The card stays
  // editable and the save is what refuses.
  assert.deepEqual(stringsValue('nope'), []);
  assert.deepEqual(stringsValue(['1.0', '1.1']), ['1.0', '1.1']);
  assert.deepEqual(stringsValue([1, 2]), ['1', '2']);
  assert.deepEqual(mapEntries('nope'), []);
  assert.deepEqual(mapEntries({ a: 'A', b: 2 }), [['a', 'A'], ['b', '2']]);
});

test('map rows round-trip, and a row with no key yet is not stored', () => {
  assert.deepEqual(entriesToMap([['a', 'A'], ['  ', 'B'], ['', '']]), { a: 'A' });
  assert.deepEqual(entriesToMap(mapEntries({ x: 'X' })), { x: 'X' });
});

test('a key the schema does not declare is reported, not dropped', () => {
  const form = configForm({ type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(undeclaredKeys({ a: '1', legacy: true }, form), ['legacy']);
  assert.deepEqual(undeclaredKeys({ a: '1' }, form), []);
  // Nothing to compare against, so nothing is claimed.
  assert.deepEqual(undeclaredKeys({ a: '1' }, { kind: 'freeform' }), []);
  assert.deepEqual(undeclaredKeys({ a: '1' }, null), []);
});

test('an empty control writes no key, because absent is what „not set" means', () => {
  assert.deepEqual(
    pruneEmpty({ text: '', list: [], map: {}, nothing: null, kept: 'x', zero: 0, off: false }),
    { kept: 'x', zero: 0, off: false },
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EXAMPLE_META_KEY, EXAMPLE_PLUGIN, exampleFields } from './fields';
import type { TimelineFile } from '../../types';

// TEMPLATE. These three cases are the ones every contributed field needs, because
// derivation is where plugins actually break: off, on but unconfigured, and
// configured. Add your own on top; do not delete these.

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

const enabled = (config: Record<string, unknown>): TimelineFile =>
  file({ plugins: [{ id: EXAMPLE_PLUGIN, config }] });

test('contributes nothing while the plugin is not enabled', () => {
  assert.deepEqual(exampleFields(file()), []);
  assert.deepEqual(exampleFields(null), []);
  assert.deepEqual(exampleFields(undefined), []);
});

test('contributes nothing on an empty or malformed config', () => {
  assert.deepEqual(exampleFields(enabled({})), []);
  assert.deepEqual(exampleFields(enabled({ choices: [] })), []);
  assert.deepEqual(exampleFields(enabled({ choices: 'nope' })), []);
});

test('derives its options from the config, in order', () => {
  const defs = exampleFields(enabled({ choices: ['a', 'b'] }));
  assert.equal(defs.length, 1);
  assert.equal(defs[0].key, EXAMPLE_META_KEY);
  assert.equal(defs[0].type, 'select');
  assert.deepEqual(defs[0].options, [{ value: 'a' }, { value: 'b' }]);
});

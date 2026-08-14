import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXAMPLE_DERIVED_KEY,
  EXAMPLE_META_KEY,
  EXAMPLE_PLUGIN,
  exampleDerive,
  exampleFields,
} from './fields';
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
  assert.equal(defs[0].key, EXAMPLE_META_KEY);
  assert.equal(defs[0].type, 'select');
  assert.equal(defs[0].derived, undefined);
  assert.deepEqual(defs[0].options, [{ value: 'a' }, { value: 'b' }]);
});

test('the derived field is declared derived, and its value comes from derive', () => {
  const file = enabled({ choices: ['a', 'b'] });
  const derivedDef = exampleFields(file).find((d) => d.key === EXAMPLE_DERIVED_KEY);
  assert.equal(derivedDef?.derived, true);

  // The declaration and the values are two halves of one thing: a `derived` field
  // with no `derive` behind it is an empty read-only control, and values for a key
  // that was never declared derived are dropped by the host. Both halves belong in
  // the same test so neither can be removed alone.
  const derive = exampleDerive(file);
  assert.ok(derive);
  assert.equal(derive({ content: 'x', start: '2026-03-04' })[EXAMPLE_DERIVED_KEY], 'a');
  assert.equal(derive({ content: 'x' })[EXAMPLE_DERIVED_KEY], undefined);
});

test('no derive function while the plugin is off or unconfigured', () => {
  assert.equal(exampleDerive(file()), null);
  assert.equal(exampleDerive(enabled({})), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { register } from './registry';
import { derivedValuesFor, withDerived } from './derived';
import type { PluginDescriptor } from './registry';
import type { CustomFieldDef, TimelineFile, TimelineFileItem } from '../types';

// The host's half of a derived field: which keys a plugin is allowed to fill, and
// what happens when it fills them badly. The plugin's own rule (how a sprint
// follows from a date) is tested in that plugin's folder — what is pinned here is
// the boundary, because that is what protects the *other* plugins and the stored
// data from one plugin's bug.

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

const item = (over: Partial<TimelineFileItem> = {}): TimelineFileItem => ({
  id: 'i-1',
  content: 'Rollout',
  start: '2026-03-04',
  ...over,
});

/** A registered plugin, reduced to the two parts this seam reads. */
function plugin(
  id: string,
  fields: CustomFieldDef[],
  derive: PluginDescriptor['derive'],
): void {
  register({
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      apiVersion: '^1.5',
      capabilities: ['fields'],
    },
    matches: () => true,
    fields: () => fields,
    derive,
    load: () => Promise.reject(new Error('no view')),
  });
}

const derivedField = (key: string): CustomFieldDef => ({
  key,
  label: key,
  type: 'select',
  derived: true,
});

test('no plugin declares a derived field ⇒ no derive function at all', () => {
  // Null rather than an empty function: the merge runs per item on every build, so
  // the common case (no plugin) has to cost nothing.
  assert.equal(derivedValuesFor(file()), null);
});

test('a declared derived key is filled, an undeclared one is dropped', () => {
  plugin('com.example.sprints', [derivedField('sprint')], () => (it) => ({
    sprint: `S-${it.start?.slice(0, 7)}`,
    // Not declared derived by this plugin, so the host refuses it: a plugin that
    // could fill any key could overwrite another plugin's field, or a stored one.
    owner: 'someone@example.com',
  }));
  const derive = derivedValuesFor(file());
  assert.ok(derive);
  assert.deepEqual(derive(item()), { sprint: 'S-2026-03' });
});

test('a blank derived value is dropped, so the item lands in the „Ohne …" bucket', () => {
  plugin('com.example.blank', [derivedField('cohort')], () => () => ({ cohort: '   ' }));
  const derive = derivedValuesFor(file());
  assert.ok(derive);
  // Only this plugin's key is asserted: `register` is module state, so the plugins
  // from the tests above are still registered here — which is also what makes the
  // „one plugin's bug does not reach another's field" tests below realistic.
  assert.equal('cohort' in derive(item()), false);
});

test('a plugin whose derive throws loses its values, the others keep theirs', () => {
  plugin('com.example.broken', [derivedField('broken')], () => () => {
    throw new Error('bad raster');
  });
  plugin('com.example.sound', [derivedField('sound')], () => () => ({ sound: 'yes' }));
  const derive = derivedValuesFor(file());
  assert.ok(derive);
  const values = derive(item());
  // The build must survive one plugin's bug: an exception escaping here would
  // blank every item's fields rather than that plugin's one.
  assert.equal(values.sound, 'yes');
  assert.equal('broken' in values, false);
});

test('a plugin whose derive factory throws is skipped entirely', () => {
  plugin('com.example.factory', [derivedField('early')], () => {
    throw new Error('config unreadable');
  });
  plugin('com.example.late', [derivedField('late')], () => () => ({ late: 'ok' }));
  const derive = derivedValuesFor(file());
  assert.ok(derive);
  const values = derive(item());
  assert.equal(values.late, 'ok');
  assert.equal('early' in values, false);
});

test('two plugins on one key: the first registration owns it', () => {
  plugin('com.example.first', [derivedField('shared')], () => () => ({ shared: 'first' }));
  plugin('com.example.second', [derivedField('shared')], () => () => ({ shared: 'second' }));
  const derive = derivedValuesFor(file());
  assert.ok(derive);
  // Registration order deciding silently is the failure this prevents: the value
  // would show under the other plugin's label, and neither folder would say so.
  assert.equal(derive(item()).shared, 'first');
});

test('a derive that returns something other than an object contributes nothing', () => {
  plugin('com.example.junk', [derivedField('junk')], () => (() => 'nope') as never);
  const derive = derivedValuesFor(file());
  assert.ok(derive);
  assert.equal('junk' in derive(item()), false);
});

test('withDerived: the computed value wins over a stored leftover on the same key', () => {
  // The leftover is the reason the direction matters: a value stored before the
  // field became derived would otherwise contradict the plugin, with nothing in
  // the interface saying which of the two is current.
  assert.deepEqual(withDerived({ sprint: 'S-1', owner: 'a' }, { sprint: 'S-4' }), {
    sprint: 'S-4',
    owner: 'a',
  });
});

test('withDerived: nothing derived ⇒ the stored bag itself, not a copy', () => {
  const stored = { owner: 'a' };
  assert.equal(withDerived(stored, {}), stored);
  assert.equal(withDerived(stored, undefined), stored);
  assert.equal(withDerived(undefined, undefined), undefined);
});

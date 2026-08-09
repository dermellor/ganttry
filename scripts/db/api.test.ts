// Path parsing for the API dispatcher.
//
// The plugin routes are the reason this has its own suite: they add a segment
// that opens a NAMESPACE, and everything after it is named by the plugin rather
// than by us. Getting that wrong is not a parse error — it silently addresses a
// different resource, which is the class of bug a test finds and a reader does
// not.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { parseSourcePath } from './api.ts';

describe('parseSourcePath: the pre-existing sub-resources', () => {
  test('a bare id, with and without a namespace', () => {
    assert.deepEqual(parseSourcePath('/plan'), { id: 'plan' });
    assert.deepEqual(parseSourcePath('/acme/plan'), { id: 'acme/plan' });
  });

  test('a sub-resource with and without a child id', () => {
    assert.deepEqual(parseSourcePath('/plan/item'), { id: 'plan', sub: { kind: 'item', childId: undefined } });
    assert.deepEqual(parseSourcePath('/plan/item/i-7'), { id: 'plan', sub: { kind: 'item', childId: 'i-7' } });
  });

  test('an empty path has no id to serve', () => {
    assert.equal(parseSourcePath('/'), null);
  });
});

describe('parseSourcePath: the plugin namespace', () => {
  test('plugin id and collection are split out, not left as one child id', () => {
    assert.deepEqual(parseSourcePath('/plan/plugin/demo/tiers'), {
      id: 'plan',
      sub: { kind: 'plugin', childId: 'demo/tiers', plugin: { pluginId: 'demo', collection: 'tiers' } },
    });
  });

  test('a row id is the third part', () => {
    const parsed = parseSourcePath('/plan/plugin/demo/tiers/pro');
    assert.deepEqual(parsed?.sub?.plugin, { pluginId: 'demo', collection: 'tiers', rowId: 'pro' });
  });

  test('a collection named like a sub-resource is NOT read as one', () => {
    // Without the namespace rule the right-to-left scan finds `tier` first and
    // the timeline id swallows `plan/plugin/demo` — a write would then land on
    // the pricing tier of a timeline that does not exist.
    const parsed = parseSourcePath('/plan/plugin/demo/tier/pro');
    assert.equal(parsed?.sub?.kind, 'plugin');
    assert.deepEqual(parsed?.sub?.plugin, { pluginId: 'demo', collection: 'tier', rowId: 'pro' });
  });

  test('a namespaced timeline id keeps its slashes', () => {
    const parsed = parseSourcePath('/acme/plan/plugin/demo/tiers');
    assert.equal(parsed?.id, 'acme/plan');
  });

  test('a scoped plugin id survives as one percent-encoded segment', () => {
    const parsed = parseSourcePath('/plan/plugin/%40acme%2Fsprints/entries');
    assert.deepEqual(parsed?.sub?.plugin, { pluginId: '@acme/sprints', collection: 'entries' });
  });

  test('a row id decodes exactly once, so a composite key comes back intact', () => {
    // rowIdFor encodes each key part and joins with ":"; the client then encodes
    // the whole id for the path. A value that itself carried a ":" is therefore
    // double-encoded and must not decode into an extra separator.
    const parsed = parseSourcePath('/plan/plugin/demo/cells/pro%253Ax%3Acalls');
    assert.equal(parsed?.sub?.plugin?.rowId, 'pro%3Ax:calls');
  });

  test('a fourth segment is refused rather than joined into the row id', () => {
    // Accepting it would make `a/b` and `a%2Fb` two spellings of one row id.
    assert.equal(parseSourcePath('/plan/plugin/demo/tiers/pro/extra'), null);
  });

  test('the move verb arrives as the row id, for the dispatcher to recognise', () => {
    assert.equal(parseSourcePath('/plan/plugin/demo/tiers/move')?.sub?.plugin?.rowId, 'move');
  });

  test('a trailing `plugin` with nothing after it is not a plugin path', () => {
    // It carries no plugin id, so there is nothing to dispatch to; it falls back
    // to the ordinary scan, which finds the marker and leaves an empty child.
    const parsed = parseSourcePath('/plan/plugin');
    assert.equal(parsed?.sub?.plugin, undefined);
  });
});

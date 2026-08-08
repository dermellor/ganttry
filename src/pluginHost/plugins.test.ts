import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasPlugin, pluginConfig } from './plugins';
import {
  PRODUCT_ROADMAP_PLUGIN,
  productRoadmapRef,
  resolveWritePlugins,
  versionsFromConfig,
} from '../plugins/product-roadmap/plugin';
import type { TimelineFile } from '../types';

const base = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

test('hasPlugin / pluginConfig read the registry off a file', () => {
  const file = base({ plugins: [{ id: PRODUCT_ROADMAP_PLUGIN, config: { versions: ['v1'] } }] });
  assert.equal(hasPlugin(file, PRODUCT_ROADMAP_PLUGIN), true);
  assert.equal(hasPlugin(file, 'other'), false);
  assert.equal(hasPlugin(null, PRODUCT_ROADMAP_PLUGIN), false);
  assert.deepEqual(pluginConfig(file, PRODUCT_ROADMAP_PLUGIN), { versions: ['v1'] });
  assert.equal(pluginConfig(file, 'other'), undefined);
});

test('versionsFromConfig tolerates missing / malformed lists', () => {
  assert.deepEqual(versionsFromConfig({ versions: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(versionsFromConfig({}), []);
  assert.deepEqual(versionsFromConfig(undefined), []);
  assert.deepEqual(versionsFromConfig({ versions: 'nope' as unknown as string[] }), []);
});

test('resolveWritePlugins: a populated pricing model enables product-roadmap with its versions', () => {
  const file = base({ pricing: { versions: ['v1', 'v2'], features: [], tiers: [] } });
  const rows = resolveWritePlugins(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, PRODUCT_ROADMAP_PLUGIN);
  assert.deepEqual(rows[0].config, { versions: ['v1', 'v2'] });
});

test('resolveWritePlugins: pricing.versions is authoritative over an incoming plugin config', () => {
  const file = base({
    plugins: [{ id: PRODUCT_ROADMAP_PLUGIN, config: { versions: ['stale'], keep: 1 } }],
    pricing: { versions: ['fresh'], features: [], tiers: [] },
  });
  const rows = resolveWritePlugins(file);
  assert.equal(rows.length, 1);
  // pricing.versions wins, but other config keys are preserved.
  assert.deepEqual(rows[0].config, { keep: 1, versions: ['fresh'] });
});

test('resolveWritePlugins: pricing without versions falls back to existing plugin config versions', () => {
  const file = base({
    plugins: [{ id: PRODUCT_ROADMAP_PLUGIN, config: { versions: ['keep-me'] } }],
    pricing: { features: [], tiers: [] },
  });
  const rows = resolveWritePlugins(file);
  assert.deepEqual(rows[0].config, { versions: ['keep-me'] });
});

test('resolveWritePlugins: no pricing keeps the plugin set as-is (does not invent one)', () => {
  assert.deepEqual(resolveWritePlugins(base()), []);
  const file = base({ plugins: [{ id: 'some-other', config: { a: 1 } }] });
  assert.deepEqual(resolveWritePlugins(file), [{ id: 'some-other', config: { a: 1 } }]);
});

test('productRoadmapRef builds a canonical ref', () => {
  assert.deepEqual(productRoadmapRef(['v1']), { id: PRODUCT_ROADMAP_PLUGIN, config: { versions: ['v1'] } });
  assert.deepEqual(productRoadmapRef(undefined), { id: PRODUCT_ROADMAP_PLUGIN, config: { versions: [] } });
});

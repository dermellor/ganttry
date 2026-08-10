import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasPlugin, pluginConfig, pluginsForWrite } from './plugins';
import {
  PRODUCT_ROADMAP_PLUGIN,
  productRoadmapRef,
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

test('pluginsForWrite: a plugin with rows in the payload is enabled', () => {
  // Otherwise a bulk write stores rows nothing reads, and the timeline looks
  // empty while the data sits there.
  const file = base({ pluginData: { 'com.example.sprints': { entries: [{ id: 'e1', data: {} }] } } });
  const rows = pluginsForWrite(file);
  assert.deepEqual(rows, [{ id: 'com.example.sprints', config: {} }]);
});

test('pluginsForWrite: an already-listed plugin keeps its config and consent', () => {
  const file = base({
    plugins: [{ id: 'com.example.sprints', config: { keep: 1 }, public: true }],
    pluginData: { 'com.example.sprints': { entries: [] } },
  });
  const rows = pluginsForWrite(file);
  assert.equal(rows.length, 1, 'not added a second time');
  assert.deepEqual(rows[0].config, { keep: 1 });
  assert.equal(rows[0].public, true, 'publishing consent survives a bulk write');
});

test('pluginsForWrite: a plugin enabled without data stays enabled', () => {
  const file = base({ plugins: [{ id: 'com.example.sprints' }] });
  assert.deepEqual(pluginsForWrite(file), [{ id: 'com.example.sprints', config: {} }]);
});

test('pluginsForWrite: no plugins and no data is an empty list, not a guess', () => {
  assert.deepEqual(pluginsForWrite(base()), []);
});

test('productRoadmapRef builds a canonical ref', () => {
  assert.deepEqual(productRoadmapRef(['v1']), { id: PRODUCT_ROADMAP_PLUGIN, config: { versions: ['v1'] } });
  assert.deepEqual(productRoadmapRef(undefined), { id: PRODUCT_ROADMAP_PLUGIN, config: { versions: [] } });
});

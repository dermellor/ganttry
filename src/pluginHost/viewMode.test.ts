import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_VIEW_MODES,
  isBuiltinViewMode,
  isPluginViewMode,
  parsePluginViewMode,
  pluginViewMode,
  readViewMode,
} from './viewMode';

// The view mode is the one piece of app state that lives in three places at once:
// `state.viewMode`, the URL hash and localStorage. These tests pin the encoding
// and — more importantly — the migration of the pre-plugin value, because getting
// that wrong silently resets everybody's saved view and breaks shared deep links.

const legacy = (id: string) => (id === 'pricing' ? pluginViewMode('dev.zeitlines.product-roadmap', 'pricing') : null);

test('built-in modes stay bare', () => {
  assert.equal(readViewMode('timeline', legacy), 'timeline');
  assert.equal(readViewMode('list', legacy), 'list');
  assert.equal(parsePluginViewMode('list'), null);
  assert.equal(isPluginViewMode('list'), false);
});

test('a plugin view round-trips through its encoding', () => {
  const mode = pluginViewMode('com.example.sprints', 'board');
  assert.equal(mode, 'plugin:com.example.sprints:board');
  assert.deepEqual(parsePluginViewMode(mode), { pluginId: 'com.example.sprints', viewId: 'board' });
  assert.equal(readViewMode(mode, legacy), mode);
});

test('a view id may contain colons; the plugin id may not', () => {
  const mode = pluginViewMode('acme', 'a:b');
  assert.deepEqual(parsePluginViewMode(mode), { pluginId: 'acme', viewId: 'a:b' });
});

test('a pre-plugin mode resolves through the legacy lookup', () => {
  assert.equal(readViewMode('pricing', legacy), 'plugin:dev.zeitlines.product-roadmap:pricing');
});

test('unknown, empty and truncated values degrade to the timeline', () => {
  assert.equal(readViewMode('nope', legacy), 'timeline');
  assert.equal(readViewMode('', legacy), 'timeline');
  assert.equal(readViewMode(null, legacy), 'timeline');
  assert.equal(readViewMode(undefined, legacy), 'timeline');
  assert.equal(readViewMode('plugin:', legacy), 'timeline');
  assert.equal(readViewMode('plugin:com.example.sprints:', legacy), 'timeline');
  assert.equal(readViewMode('plugin::board', legacy), 'timeline');
});

test('the graph is a built-in mode, so #mode=graph addresses it', () => {
  assert.equal(readViewMode('graph', legacy), 'graph');
  assert.equal(isBuiltinViewMode('graph'), true);
  assert.equal(parsePluginViewMode('graph'), null);
  // The legacy lookup must not be consulted for a built-in name: a plugin that
  // claimed „graph" as an old mode id would otherwise take the built-in view's
  // address away from it.
  assert.equal(
    readViewMode('graph', () => 'plugin:acme:graph'),
    'graph',
  );
});

test('the built-in list is the one the readers share', () => {
  assert.deepEqual([...BUILTIN_VIEW_MODES], ['timeline', 'list', 'graph']);
  assert.equal(isBuiltinViewMode('plugin:acme:board'), false);
  assert.equal(isBuiltinViewMode('nope'), false);
});

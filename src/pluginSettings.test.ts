import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  configDraftText,
  configKeysOf,
  parseConfigDraft,
  pluginSettingsRows,
} from './pluginSettings';
import type { PluginManifest } from './pluginHost/manifest';
import type { PluginStatus } from './types';

const MANIFEST = {
  id: 'com.example.sprints',
  name: 'Sprints',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['views', 'data'],
  views: [{ id: 'board', label: 'Board' }, { id: 'burndown', label: '' }],
  configSchema: {
    type: 'object',
    properties: { length: { type: 'number' }, name: { type: 'string' }, tags: { type: ['array', 'null'] } },
    required: ['length'],
  },
  publicRead: { collections: ['sprints'] },
} as unknown as PluginManifest;

function status(over: Partial<PluginStatus> = {}): PluginStatus {
  return {
    id: 'com.example.sprints',
    version: '1.0.0',
    apiVersion: '^1',
    artifactKind: 'builtin',
    capabilities: ['views', 'data'],
    manifest: MANIFEST as unknown as Record<string, unknown>,
    enabled: true,
    loadable: true,
    ...over,
  } as PluginStatus;
}



test('an installed plugin is offered with what the manifest declares', () => {
  const [row] = pluginSettingsRows([status()], [], []);
  assert.equal(row.name, 'Sprints');
  assert.equal(row.offerable, true);
  assert.equal(row.enabledHere, false);
  assert.deepEqual(row.capabilities, ['views', 'data']);
  // A view with no label is listed by its id rather than as an empty line.
  assert.deepEqual(row.views, ['Board', 'burndown']);
  assert.equal(row.publishable, true);
});

test('a contract this host does not satisfy is listed with the reason, not offered', () => {
  const [row] = pluginSettingsRows(
    [status({ loadable: false, reason: 'api-version', problem: 'needs ^2' })],
    [],
    [],
  );
  assert.equal(row.offerable, false);
  assert.equal(row.reason, 'api-version');
  assert.equal(row.problem, 'needs ^2');
});

test('a plugin switched off for the instance is not offered here either', () => {
  const [row] = pluginSettingsRows(
    [status({ enabled: false, loadable: false, reason: 'disabled' })],
    [],
    [],
  );
  assert.equal(row.offerable, false);
  assert.equal(row.reason, 'disabled');
});

test('an artifact that failed to load this session stays offerable', () => {
  // Infrastructure, not a statement about the plugin: the row it would write is
  // still the right row, and its data rules are enforced regardless.
  const [row] = pluginSettingsRows(
    [status()],
    [],
    [{ pluginId: 'com.example.sprints', loaded: false, reason: 'unreachable', problem: '404' }],
  );
  assert.equal(row.running, false);
  assert.equal(row.reason, 'unreachable');
  assert.equal(row.offerable, true);
});

test('what this timeline stores is carried on the row', () => {
  const [row] = pluginSettingsRows(
    [status()],
    [{ id: 'com.example.sprints', config: { length: 14 }, public: true }],
    [],
  );
  assert.equal(row.enabledHere, true);
  assert.deepEqual(row.config, { length: 14 });
  assert.equal(row.public, true);
});

test('a timeline that enables it without config reads as the empty bag', () => {
  const [row] = pluginSettingsRows([status()], [{ id: 'com.example.sprints' }], []);
  assert.equal(row.enabledHere, true);
  assert.deepEqual(row.config, {});
  assert.equal(row.public, false);
});

test('a plugin nothing describes is still listed, with nothing claimed about it', () => {
  // The host resolves „this row carries no manifest, use the build's" before the
  // browser sees it (`installedPluginStatuses`), so an empty one here means the host
  // itself has nothing to describe the plugin by. Listing it as a bare id beats
  // hiding a plugin an operator installed.
  const [row] = pluginSettingsRows([status({ manifest: {} })], []);
  assert.equal(row.name, 'com.example.sprints');
  assert.deepEqual(row.capabilities, []);
  assert.deepEqual(row.views, []);
  assert.equal(row.configKeys, null);
  assert.equal(row.publishable, false);
});

test('the declared config keys are listed with their types', () => {
  assert.deepEqual(configKeysOf(MANIFEST.configSchema), [
    { key: 'length', type: 'number', required: true },
    { key: 'name', type: 'string', required: false },
    { key: 'tags', type: 'array | null', required: false },
  ]);
});

test('a schema that declares no properties is an empty legend, not a missing one', () => {
  // „There is a schema" and „the schema names no keys" are different answers: the
  // first still validates the bag, so the editor has to be offered.
  assert.deepEqual(configKeysOf({ type: 'object' }), []);
  assert.equal(configKeysOf(null), null);
  assert.equal(configKeysOf('nonsense'), null);
});

test('an untyped property is listed rather than dropped', () => {
  assert.deepEqual(configKeysOf({ properties: { x: {} } }), [
    { key: 'x', type: '?', required: false },
  ]);
});

test('empty text is the empty bag, which is what „no config" means', () => {
  assert.deepEqual(parseConfigDraft(''), { config: {} });
  assert.deepEqual(parseConfigDraft('   \n '), { config: {} });
});

test('a config draft must be an object, and says so in the interface language', () => {
  assert.deepEqual(parseConfigDraft('{"a":1}'), { config: { a: 1 } });
  assert.match((parseConfigDraft('[1,2]') as { error: string }).error, /JSON-Objekt/);
  assert.match((parseConfigDraft('"x"') as { error: string }).error, /JSON-Objekt/);
  assert.match((parseConfigDraft('{oops') as { error: string }).error, /Kein gültiges JSON/);
});

test('the editor starts empty for a plugin with no config', () => {
  assert.equal(configDraftText({}), '');
  assert.equal(configDraftText({ a: 1 }), '{\n  "a": 1\n}');
});

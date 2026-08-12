import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHostApi, type HostApiBackend } from './hostApi';
import type { PluginManifest } from './manifest';

// The capability gate has to be structural, not advisory: a plugin without
// `items:write` must find no item-write method at all. A check that only refuses
// at call time is one `try` away from being ignored.

const backend = (): HostApiBackend => ({
  timeline: async () => ({ items: [], name: 'T' }),
  subscribe: () => () => {},
  config: async () => ({ versions: ['1.0'] }),
  currentUser: async () => ({ email: 'x@example.com' }),
  items: {
    add: async (i) => i,
    update: async (_id, patch) => patch as never,
    remove: async () => {},
  },
  data: {
    list: async () => [],
    put: async (_c, row) => ({ id: row.id, data: row.data, version: 1 }),
    patch: async (_c, id, data, version) => ({ id, data, version: (version ?? 0) + 1 }),
    remove: async () => {},
    move: async () => [],
  },
  canWrite: async () => true,
  status: () => {},
  panel: { open: () => {}, close: () => {}, showItem: () => {} },
});

const manifest = (caps: PluginManifest['capabilities']): PluginManifest => ({
  id: 'p',
  name: 'P',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: caps,
});

test('without items:write there is no items surface at all', () => {
  const api = createHostApi(manifest(['items:read']), backend(), '1.0');
  assert.equal(api.items, undefined);
  assert.equal(api.data, undefined);
});

test('the drawer follows `views`, not a write capability', () => {
  // The first attempt gated it on `items:write`, which looks right until you notice
  // that the plugin needing the drawer most edits its own ROWS and never touches an
  // item — so its forms silently did nothing. The drawer grants no data access; a
  // view is just what gives a plugin somewhere to open a form from.
  assert.equal(createHostApi(manifest(['fields']), backend(), '1.0').panel, undefined);
  assert.ok(createHostApi(manifest(['views', 'data:own']), backend(), '1.0').panel);
  assert.ok(createHostApi(manifest(['views']), backend(), '1.0').panel);
});

test('asking about the host is never gated', async () => {
  // Both answer questions rather than doing anything, and gating them would leave a
  // plugin that draws its own affordances guessing at what a read-only source
  // allows — which is how an edit button that fails on click gets shipped.
  const api = createHostApi(manifest([]), backend(), '1.0');
  assert.equal(await api.canWrite(), true);
  assert.equal(typeof api.status, 'function');
});

test('a partial row update reaches the backend with its lock counter', async () => {
  // `patch` exists because `put` replaces the whole row: a form editing two fields
  // of six would have to read the row first and hope nothing changed in between.
  const api = createHostApi(manifest(['data:own']), backend(), '1.0');
  assert.deepEqual(await api.data!.patch('rows', 'r1', { a: 1 }, 3), {
    id: 'r1',
    data: { a: 1 },
    version: 4,
  });
});

test('granted capabilities hand through the backend', async () => {
  const api = createHostApi(manifest(['items:write', 'data:own']), backend(), '1.0');
  assert.ok(api.items);
  assert.ok(api.data);
  assert.deepEqual(await api.data!.put('rows', { id: 'r1', data: { a: 1 } }), {
    id: 'r1',
    data: { a: 1 },
    version: 1,
  });
});

test('without a read capability the timeline resolves to null rather than leaking items', async () => {
  const api = createHostApi(manifest(['views']), backend(), '1.0');
  assert.equal(await api.timeline(), null);
  // Config and identity are not item data and stay available: a view-only plugin
  // still has to know how it was configured.
  assert.deepEqual(await api.config(), { versions: ['1.0'] });
});

test('items:write implies read — a plugin that may change items may look at them', async () => {
  const api = createHostApi(manifest(['items:write']), backend(), '1.0');
  assert.equal((await api.timeline())?.name, 'T');
});

test('the api reports the contract version in force', () => {
  assert.equal(createHostApi(manifest([]), backend(), '1.4').apiVersion, '1.4');
});

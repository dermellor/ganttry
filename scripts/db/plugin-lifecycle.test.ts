// Installing a plugin on the instance, and switching it on per timeline.
//
// Two levels that must not be confusable: „off for this timeline" is reversible
// bookkeeping, „uninstalled with a purge" deletes data nothing can recover. Most
// of what is asserted here is the boundary between them.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { handlePluginApi, handlePluginLifecycle, handlePluginsApi, handlePublicPluginApi } from './plugin-api.ts';
import { makeManifestSource } from './plugin-manifests.ts';
import { makeMemoryStore, type MemoryStore } from './plugin-store-memory.ts';
import type { InstalledPlugin } from '../../src/types.ts';
import type { PluginManifest } from '../../src/pluginHost/manifest.ts';

const TL = 'plan';
const OPERATORS = ['alice@example.com'];

const DEMO: PluginManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.2.0',
  apiVersion: '^1',
  capabilities: ['items:read', 'data:own'],
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { versions: { type: 'array', items: { type: 'string' } } },
  },
  collections: [{ id: 'entries', ordered: true }],
  metadataKeys: ['demoKey'],
};

const installedRow = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: DEMO.id,
  version: DEMO.version,
  apiVersion: DEMO.apiVersion,
  artifact: { kind: 'builtin' },
  capabilities: [...(DEMO.capabilities ?? [])],
  manifest: DEMO as unknown as Record<string, unknown>,
  enabled: true,
  ...over,
});

function arrange(opts: { install?: boolean } = { install: true }) {
  const store = makeMemoryStore();
  store.seedTimeline(TL);
  if (opts.install !== false) store.seedInstalled(installedRow());

  const registry = (
    method: string,
    o: {
      pluginId?: string;
      body?: unknown;
      params?: Record<string, string>;
      caller?: { email?: string | null; mcp?: boolean };
      allowedOrigins?: string[];
    } = {},
  ) =>
    handlePluginsApi(store.repo, {
      method,
      pluginId: o.pluginId,
      body: o.body,
      params: o.params,
      caller: o.caller ?? { email: 'alice@example.com' },
      operators: OPERATORS,
      allowedOrigins: o.allowedOrigins,
    });

  const lifecycle = (method: string, pluginId: string, body?: unknown) =>
    handlePluginLifecycle(store.repo, makeManifestSource(store.repo), {
      method,
      timelineId: TL,
      path: { pluginId },
      body,
    });

  const data = (method: string, collection: string, body?: unknown) =>
    handlePluginApi(store.repo, makeManifestSource(store.repo), {
      method,
      timelineId: TL,
      path: { pluginId: DEMO.id, collection },
      body,
    });

  return { store, registry, lifecycle, data };
}

describe('the install registry: who may write to it', () => {
  test('reading is open past the auth gate — it is what the interface shows', async () => {
    const { registry } = arrange();
    const res = await registry('GET', { caller: { email: 'carol@example.com' } });
    assert.equal(res.status, 200);
    assert.equal((res.json as { plugins: unknown[] }).plugins.length, 1);
  });

  test('a signed-in non-operator cannot install', async () => {
    const { registry } = arrange({ install: false });
    const res = await registry('POST', { caller: { email: 'carol@example.com' }, body: { manifest: DEMO } });
    assert.equal(res.status, 403);
    assert.equal((res.json as { error: string }).error, 'forbidden');
  });

  test('the refusal names the variable to set, so it is actionable', async () => {
    const store = makeMemoryStore();
    const res = await handlePluginsApi(store.repo, {
      method: 'POST',
      body: { manifest: DEMO },
      caller: { email: 'alice@example.com' },
      operators: [],
    });
    assert.match((res.json as { message: string }).message, /PLUGIN_OPERATOR_EMAILS/);
  });

  test('the MCP token installs without being on any list', async () => {
    const { registry } = arrange({ install: false });
    const res = await registry('POST', { caller: { mcp: true }, body: { manifest: DEMO } });
    assert.equal(res.status, 201);
  });
});

describe('the install registry: what it refuses to store', () => {
  test('a manifest that does not validate never reaches the registry', async () => {
    const { registry } = arrange({ install: false });
    const res = await registry('POST', { body: { manifest: { id: 'demo' } } });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: string }).error, 'invalid_manifest');
    assert.equal((await registry('GET')).status, 200);
    assert.equal(((await registry('GET')).json as { plugins: unknown[] }).plugins.length, 1, 'built-in only');
  });

  test('a contract range this host cannot satisfy is refused at install, not at boot', async () => {
    const { registry } = arrange({ install: false });
    const res = await registry('POST', { body: { manifest: { ...DEMO, apiVersion: '^2' } } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /apiVersion/);
  });

  test('a fetched artifact has to say where from', async () => {
    const { registry } = arrange({ install: false });
    const res = await registry('POST', { body: { manifest: DEMO, artifact: { kind: 'vendored' } } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /needs a source/);
  });

  test('an artifact from an origin the CSP does not allow is refused at install', async () => {
    // Otherwise the row stores fine and the plugin is guaranteed never to load:
    // the only symptom is a CSP violation in the console of whoever opens the app
    // next, which is a place nobody looks. Found by installing one.
    const { registry } = arrange({ install: false });
    const res = await registry('POST', {
      allowedOrigins: ['https://plugins.example.com'],
      body: {
        manifest: DEMO,
        artifact: { kind: 'url', source: 'https://elsewhere.example/p.js', integrity: 'sha384-x' },
      },
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: string }).error, 'origin_not_allowed');
    // The message has to name the variable AND the origin: „not allowed" alone
    // sends an operator looking for a bug instead of a missing line of config.
    assert.match((res.json as { message: string }).message, /PLUGIN_ALLOWED_ORIGINS/);
    assert.match((res.json as { message: string }).message, /elsewhere\.example/);
  });

  test('an allowed origin installs, and a vendored artifact is never asked', async () => {
    const { registry } = arrange({ install: false });
    const allowed = await registry('POST', {
      allowedOrigins: ['https://plugins.example.com'],
      body: {
        manifest: DEMO,
        artifact: { kind: 'url', source: 'https://plugins.example.com/p.js', integrity: 'sha384-x' },
      },
    });
    assert.equal(allowed.status, 201);

    // Same-origin by construction, so the list does not apply to it.
    const vendored = await registry('POST', {
      allowedOrigins: [],
      body: { manifest: DEMO, artifact: { kind: 'vendored', source: '/plugins/demo/index.js' } },
    });
    assert.equal(vendored.status, 201);
  });

  test('a runtime that supplies no origin list has no installs refused by it', async () => {
    // „The runtime did not say" must not read as „nothing is allowed": a caller
    // that cannot supply the list would otherwise be refused by a rule it cannot
    // see or satisfy.
    const { registry } = arrange({ install: false });
    const res = await registry('POST', {
      body: {
        manifest: DEMO,
        artifact: { kind: 'url', source: 'https://elsewhere.example/p.js', integrity: 'sha384-x' },
      },
    });
    assert.equal(res.status, 201);
  });

  test('a url artifact without an integrity hash is refused: the version would name nothing', async () => {
    const { registry } = arrange({ install: false });
    const res = await registry('POST', {
      body: { manifest: DEMO, artifact: { kind: 'url', source: 'https://example.com/p.js' } },
    });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /integrity/);
  });

  test('granting less than the manifest declares is refused rather than silently narrowed', async () => {
    // A plugin running with less than it declared fails far from the cause, which
    // is the same reason register() refuses an invalid manifest.
    const { registry } = arrange({ install: false });
    const res = await registry('POST', { body: { manifest: DEMO, capabilities: ['items:read'] } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /data:own/);
  });

  test('omitting capabilities grants exactly what the manifest declares', async () => {
    const { registry } = arrange({ install: false });
    const res = await registry('POST', { body: { manifest: DEMO } });
    assert.deepEqual((res.json as { capabilities: string[] }).capabilities, ['items:read', 'data:own']);
  });

  test('re-installing keeps the date the plugin first arrived', async () => {
    const { registry } = arrange();
    const res = await registry('POST', { body: { manifest: { ...DEMO, version: '2.0.0' } } });
    assert.equal((res.json as { version: string }).version, '2.0.0');
    assert.equal((res.json as { installedAt?: string }).installedAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('the instance-level off switch', () => {
  test('switching off keeps the row and reports why the plugin is not loadable', async () => {
    const { registry } = arrange();
    assert.equal((await registry('PATCH', { pluginId: 'demo', body: { enabled: false } })).status, 200);
    const [status] = ((await registry('GET')).json as { plugins: { loadable: boolean; problem?: string }[] }).plugins;
    assert.equal(status.loadable, false);
    assert.match(status.problem!, /switched off/);
  });

  test('a plugin that is off keeps its data readable but refuses writes', async () => {
    const { registry, data } = arrange();
    await data('POST', 'entries', { id: 'e1', data: { a: 1 } });
    await registry('PATCH', { pluginId: 'demo', body: { enabled: false } });

    const read = await data('GET', 'entries');
    assert.equal(read.status, 200, 'an operator deciding about data has to be able to see it');
    const write = await data('POST', 'entries', { id: 'e2', data: {} });
    assert.equal(write.status, 403);
    assert.equal((write.json as { error: string }).error, 'plugin_disabled');
  });

  test('switching a plugin that is not installed is a 404', async () => {
    const { registry } = arrange({ install: false });
    assert.equal((await registry('PATCH', { pluginId: 'ghost', body: { enabled: false } })).status, 404);
  });

  test('a missing enabled flag is a 400, not a guess', async () => {
    const { registry } = arrange();
    assert.equal((await registry('PATCH', { pluginId: 'demo', body: {} })).status, 400);
  });
});

describe('uninstalling', () => {
  async function withRows(): Promise<{ store: MemoryStore; registry: ReturnType<typeof arrange>['registry'] }> {
    const { store, registry, data } = arrange();
    await data('POST', 'entries', { id: 'e1', data: { a: 1 } });
    return { store, registry };
  }

  test('it refuses without the plugin id echoed back', async () => {
    const { registry } = await withRows();
    const res = await registry('DELETE', { pluginId: 'demo' });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: string }).error, 'confirmation_required');
  });

  test('a wrong confirmation is refused too', async () => {
    const { registry } = await withRows();
    assert.equal((await registry('DELETE', { pluginId: 'demo', params: { confirm: 'demo2' } })).status, 400);
  });

  test('by default the rows are KEPT, and the answer says so', async () => {
    const { store, registry } = await withRows();
    const res = await registry('DELETE', { pluginId: 'demo', params: { confirm: 'demo' } });
    assert.equal(res.status, 200);
    assert.equal((res.json as { dataPurged: boolean }).dataPurged, false);
    assert.match((res.json as { note: string }).note, /were kept/);
    assert.equal(store.dump(TL, 'demo', 'entries').length, 1, 'an uninstall must not silently discard a model');
  });

  test('purging is opt-in and takes the rows with it', async () => {
    const { store, registry } = await withRows();
    const res = await registry('DELETE', { pluginId: 'demo', params: { confirm: 'demo', purgeData: 'true' } });
    assert.equal(res.status, 200);
    assert.equal((res.json as { dataPurged: boolean }).dataPurged, true);
    assert.equal(store.dump(TL, 'demo', 'entries').length, 0);
  });

  test('a non-operator cannot uninstall even with a correct confirmation', async () => {
    const { registry } = await withRows();
    const res = await registry('DELETE', {
      pluginId: 'demo',
      params: { confirm: 'demo', purgeData: 'true' },
      caller: { email: 'carol@example.com' },
    });
    assert.equal(res.status, 403);
  });
});

describe('enabling a plugin on one timeline', () => {
  test('a plugin that is not installed cannot be enabled anywhere', async () => {
    const { lifecycle } = arrange({ install: false });
    const res = await lifecycle('PUT', 'ghost', { config: {} });
    assert.equal(res.status, 404);
    assert.match((res.json as { message: string }).message, /install it before enabling/);
  });

  test('enable, read back, then disable', async () => {
    const { lifecycle } = arrange();
    assert.equal((await lifecycle('PUT', 'demo', { config: { versions: ['1.0'] } })).status, 200);
    const state = await lifecycle('GET', 'demo');
    assert.equal((state.json as { enabled: boolean }).enabled, true);
    assert.deepEqual((state.json as { config: unknown }).config, { versions: ['1.0'] });

    assert.equal((await lifecycle('DELETE', 'demo')).status, 200);
    assert.equal(((await lifecycle('GET', 'demo')).json as { enabled: boolean }).enabled, false);
  });

  test('disabling keeps every row, so enabling again is lossless', async () => {
    const { store, lifecycle, data } = arrange();
    await lifecycle('PUT', 'demo', { config: {} });
    await data('POST', 'entries', { id: 'e1', data: { a: 1 } });
    await lifecycle('DELETE', 'demo');
    assert.equal(store.dump(TL, 'demo', 'entries').length, 1);
    await lifecycle('PUT', 'demo', { config: {} });
    assert.deepEqual(((await data('GET', 'entries')).json as { rows: { id: string }[] }).rows.map((r) => r.id), ['e1']);
  });

  test('disabling twice is not an error: the second call describes the same state', async () => {
    const { lifecycle } = arrange();
    await lifecycle('PUT', 'demo', { config: {} });
    assert.equal((await lifecycle('DELETE', 'demo')).status, 200);
    assert.equal((await lifecycle('DELETE', 'demo')).status, 200);
  });

  test('a config the schema rejects fails here, not inside a render', async () => {
    const { lifecycle } = arrange();
    const res = await lifecycle('PUT', 'demo', { config: { versions: 'nope', typo: 1 } });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: string }).error, 'invalid_config');
    const message = (res.json as { message: string }).message;
    assert.match(message, /versions: expected array/);
    assert.match(message, /unknown property "typo"/);
  });

  test('a bare bag is accepted as the config, since sending it directly is not wrong', async () => {
    const { lifecycle } = arrange();
    assert.equal((await lifecycle('PUT', 'demo', { versions: ['2.0'] })).status, 200);
    assert.deepEqual(((await lifecycle('GET', 'demo')).json as { config: unknown }).config, { versions: ['2.0'] });
  });

  test('a plugin switched off instance-wide cannot be enabled on a timeline', async () => {
    const { registry, lifecycle } = arrange();
    await registry('PATCH', { pluginId: 'demo', body: { enabled: false } });
    const res = await lifecycle('PUT', 'demo', { config: {} });
    assert.equal(res.status, 403);
    assert.equal((res.json as { error: string }).error, 'plugin_disabled');
  });

  test('enabling on an unknown timeline is a 404 rather than a row for nothing', async () => {
    const store = makeMemoryStore();
    store.seedInstalled(installedRow());
    const res = await handlePluginLifecycle(store.repo, makeManifestSource(store.repo), {
      method: 'PUT',
      timelineId: 'nope',
      path: { pluginId: 'demo' },
      body: { config: {} },
    });
    assert.equal(res.status, 404);
  });
});

describe('the registry as the manifest source', () => {
  test('an empty registry falls back to what the build ships', async () => {
    // A filesystem-only instance has nowhere to record an install, so „the plugins
    // in this build" is the truthful installed set there — and the data routes of
    // a built-in plugin must keep working.
    const store = makeMemoryStore();
    const record = await makeManifestSource(store.repo)('product-roadmap');
    assert.equal(record?.manifest.id, 'product-roadmap');
    assert.equal(record?.enabled, true);
  });

  test('once the registry holds anything, it is authoritative', async () => {
    // Per-id fallback would make uninstalling a built-in impossible: it would
    // reappear the moment its row was gone.
    const store = makeMemoryStore();
    store.seedInstalled(installedRow());
    const source = makeManifestSource(store.repo);
    assert.equal((await source('demo'))?.manifest.id, 'demo');
    assert.equal(await source('product-roadmap'), null);
  });

  test('a seeded row carrying no manifest defers to the build', async () => {
    // What migration 0017 writes: installed, manifest known from the build. Its
    // data must stay writable rather than 404 as „not installed".
    const store = makeMemoryStore();
    store.seedInstalled({
      id: 'product-roadmap',
      version: '0.0.0',
      apiVersion: '^1',
      artifact: { kind: 'builtin' },
      capabilities: [],
      manifest: {},
      enabled: true,
    });
    const record = await makeManifestSource(store.repo)('product-roadmap');
    assert.equal(record?.manifest.name, 'Produkt');
  });

  test('a repo that cannot answer falls back rather than taking the data routes down', async () => {
    const broken = {
      async listInstalledPlugins() {
        throw new Error('relation "installed_plugins" does not exist');
      },
    } as unknown as Parameters<typeof makeManifestSource>[0];
    const record = await makeManifestSource(broken)('product-roadmap');
    assert.equal(record?.manifest.id, 'product-roadmap');
  });
});

describe('the public read', () => {
  const PUBLISHER: PluginManifest = {
    ...DEMO,
    capabilities: ['items:read', 'data:own', 'public:read'],
    collections: [{ id: 'entries', ordered: true }, { id: 'private' }],
    publicRead: { collections: ['entries'] },
  };

  function publisher() {
    const store = makeMemoryStore();
    store.seedTimeline(TL);
    store.seedInstalled({ ...installedRow(), manifest: PUBLISHER as unknown as Record<string, unknown> });
    store.seed(TL, 'demo', 'entries', [{ id: 'e1', data: { label: 'Sprint 1', note: 'intern' } }]);
    store.seed(TL, 'demo', 'private', [{ id: 'p1', data: { secret: true } }]);

    const publicGet = (o: { collection?: string; timelineId?: string; pluginId?: string } = {}) =>
      handlePublicPluginApi(store.repo, makeManifestSource(store.repo), {
        method: 'GET',
        pluginId: o.pluginId ?? 'demo',
        timelineId: o.timelineId ?? TL,
        collection: o.collection,
      });

    const consent = (value: boolean) =>
      handlePluginLifecycle(store.repo, makeManifestSource(store.repo), {
        method: 'PUT',
        timelineId: TL,
        path: { pluginId: 'demo' },
        body: { config: {}, public: value },
      });

    return { store, publicGet, consent };
  }

  test('without consent it is a 404, and so is a timeline that does not exist', async () => {
    // One status for both: this endpoint is reachable by anyone, so telling the
    // two apart would turn it into a probe for which timelines exist — and the id
    // is often a customer name.
    const { publicGet, consent } = publisher();
    await consent(false);
    assert.equal((await publicGet()).status, 404);
    assert.equal((await publicGet({ timelineId: 'nope' })).status, 404);
    assert.equal((await publicGet({ pluginId: 'ghost' })).status, 404);
  });

  test('with consent only the declared collections are served', async () => {
    const { publicGet, consent } = publisher();
    await consent(true);
    const res = await publicGet();
    assert.equal(res.status, 200);
    const body = res.json as any;
    assert.deepEqual(Object.keys(body.collections), ['entries']);
    assert.ok(!('private' in body.collections), 'an undeclared collection is absent, not empty');
  });

  test('host bookkeeping never reaches the public payload', async () => {
    // updatedBy is an e-mail address.
    const { publicGet, consent } = publisher();
    await consent(true);
    const row = (await publicGet()).json as any;
    assert.deepEqual(Object.keys(row.collections.entries[0]).sort(), ['data', 'id']);
  });

  test('withdrawing consent takes it offline again', async () => {
    const { publicGet, consent } = publisher();
    await consent(true);
    assert.equal((await publicGet()).status, 200);
    await consent(false);
    assert.equal((await publicGet()).status, 404);
  });

  test('reconfiguring without mentioning public does not change who may read it', async () => {
    // The trap: an upsert that writes every column would silently un-publish, or
    // silently publish, on an unrelated config edit.
    const { store, publicGet, consent } = publisher();
    await consent(true);
    await handlePluginLifecycle(store.repo, makeManifestSource(store.repo), {
      method: 'PUT',
      timelineId: TL,
      path: { pluginId: 'demo' },
      body: { config: { versions: ['2.0'] } },
    });
    assert.equal((await publicGet()).status, 200, 'still published');
  });

  test('a plugin that declares nothing public cannot be published', async () => {
    // Storing a flag that can never have an effect invites somebody to believe
    // their data is being served.
    const store = makeMemoryStore();
    store.seedTimeline(TL);
    store.seedInstalled(installedRow());
    const res = await handlePluginLifecycle(store.repo, makeManifestSource(store.repo), {
      method: 'PUT',
      timelineId: TL,
      path: { pluginId: 'demo' },
      body: { config: {}, public: true },
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as any).error, 'not_publishable');
  });

  test('a plugin switched off instance-wide publishes nothing', async () => {
    const { store, publicGet, consent } = publisher();
    await consent(true);
    await store.repo.setPluginInstalledEnabled('demo', false);
    assert.equal((await publicGet()).status, 404);
  });

  test('narrowing to a collection works, to an undeclared one does not', async () => {
    const { publicGet, consent } = publisher();
    await consent(true);
    assert.deepEqual(Object.keys(((await publicGet({ collection: 'entries' })).json as any).collections), ['entries']);
    assert.equal((await publicGet({ collection: 'private' })).status, 404);
  });

  test('only GET is served', async () => {
    const { store } = publisher();
    const res = await handlePublicPluginApi(store.repo, makeManifestSource(store.repo), {
      method: 'DELETE',
      pluginId: 'demo',
      timelineId: TL,
    });
    assert.equal(res.status, 405);
  });
});

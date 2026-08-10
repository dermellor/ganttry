// The rules the dispatcher enforces in front of the generic plugin store.
//
// These are the checks that used to be Postgres' job — column types, foreign
// keys, a composite primary key — and they moved up here because a plugin ships
// no DDL. Testing them at this level is what makes them true for all three
// backing stores at once; the stores' own suites cover storage, not rules.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { handlePluginApi, purgePlugin, MOVE_SEGMENT, type ManifestSource } from './plugin-api.ts';
import { makeMemoryStore } from './plugin-store-memory.ts';
import type { TimelineRepo } from './repo.ts';
import type { PluginManifest } from '../../src/pluginHost/manifest.ts';

const DEMO: PluginManifest = {
  id: 'com.example.demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['items:read', 'data:own'],
  metadataKeys: ['demoTier'],
  collections: [
    { id: 'tiers', ordered: true, schema: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, price: { type: 'string' } } } },
    { id: 'features', ordered: true },
    { id: 'cells', keyFields: ['tierId', 'featureId'] },
  ],
  references: [
    { from: 'cells', field: 'tierId', to: 'tiers', onDelete: 'cascade' },
    { from: 'cells', field: 'featureId', to: 'features', onDelete: 'cascade' },
  ],
};

/** A plugin that declares a collection but never asked to store anything. */
const NO_STORAGE: PluginManifest = {
  id: 'viewer',
  name: 'Viewer',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['items:read'],
};

const manifests: ManifestSource = async (id) => {
  const manifest = id === 'com.example.demo' ? DEMO : id === 'viewer' ? NO_STORAGE : null;
  return manifest ? { manifest, enabled: true } : null;
};

const TL = 'plan';

function arrange() {
  const store = makeMemoryStore();
  const call = (
    method: string,
    path: { pluginId?: string; collection?: string; rowId?: string },
    body?: unknown,
    ifMatch?: number,
  ) =>
    handlePluginApi(store.repo, manifests, {
      method,
      timelineId: TL,
      path: { pluginId: path.pluginId ?? 'com.example.demo', collection: path.collection, rowId: path.rowId },
      body,
      ifMatch,
    });
  return { store, call };
}

describe('handlePluginApi: what it refuses before touching the store', () => {
  test('a plugin the instance has not installed is 404, not an empty collection', async () => {
    const { call } = arrange();
    const res = await call('GET', { pluginId: 'nope', collection: 'x' });
    assert.equal(res.status, 404);
    assert.equal((res.json as { error: string }).error, 'unknown_plugin');
  });

  test('a plugin without data:own is 403 even though the request is well formed', async () => {
    const { call } = arrange();
    const res = await call('GET', { pluginId: 'viewer', collection: 'x' });
    assert.equal(res.status, 403);
    assert.equal((res.json as { error: string }).error, 'capability_missing');
  });

  test('a collection the manifest does not declare is 404, so a typo cannot create one', async () => {
    const { call, store } = arrange();
    const res = await call('POST', { collection: 'teirs' }, { data: { name: 'Pro' } });
    assert.equal(res.status, 404);
    assert.equal((res.json as { error: string }).error, 'unknown_collection');
    assert.equal(store.dump(TL, 'com.example.demo', 'teirs').length, 0);
  });
});

describe('handlePluginApi: shape', () => {
  test('a row matching the declared schema is stored and comes back with a version', async () => {
    const { call } = arrange();
    const res = await call('POST', { collection: 'tiers' }, { id: 'pro', data: { name: 'Pro', price: '49 €' } });
    assert.equal(res.status, 201);
    assert.deepEqual((res.json as { id: string }).id, 'pro');
    assert.equal((res.json as { version: number }).version, 1);
  });

  test('a row violating the schema is rejected with every problem named', async () => {
    const { call, store } = arrange();
    const res = await call('POST', { collection: 'tiers' }, { id: 'pro', data: { price: 5, typo: true } });
    assert.equal(res.status, 400);
    const message = (res.json as { message: string }).message;
    assert.match(message, /missing required "name"/);
    assert.match(message, /price: expected string/);
    assert.match(message, /unknown property "typo"/);
    assert.equal(store.dump(TL, 'com.example.demo', 'tiers').length, 0, 'a rejected write must store nothing');
  });

  test('a collection with no declared schema accepts any object', async () => {
    const { call } = arrange();
    const res = await call('POST', { collection: 'features' }, { id: 'calls', data: { whatever: [1, 2] } });
    assert.equal(res.status, 201);
  });

  test('a body without a data object is a 400 rather than an empty row', async () => {
    const { call } = arrange();
    assert.equal((await call('POST', { collection: 'features' }, { id: 'x' })).status, 400);
    assert.equal((await call('POST', { collection: 'features' }, 'nope')).status, 400);
  });

  test('a row with no id and no key fields is refused', async () => {
    const { call } = arrange();
    const res = await call('POST', { collection: 'features' }, { data: { a: 1 } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /needs an id/);
  });
});

describe('handlePluginApi: composite identity', () => {
  test('the row id is derived from the key fields, and the same pair updates one row', async () => {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro' } }]);
    store.seed(TL, 'com.example.demo', 'features', [{ id: 'calls', data: {} }]);

    const first = await call('POST', { collection: 'cells' }, { data: { tierId: 'pro', featureId: 'calls', value: true } });
    assert.equal((first.json as { id: string }).id, 'pro:calls');
    await call('POST', { collection: 'cells' }, { data: { tierId: 'pro', featureId: 'calls', value: '3.000' } });
    assert.equal(store.dump(TL, 'com.example.demo', 'cells').length, 1, 'the same coordinates are one row, not two');
  });

  test('a missing key field is refused: the row would have no address', async () => {
    const { call } = arrange();
    const res = await call('POST', { collection: 'cells' }, { data: { tierId: 'pro' } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /missing featureId/);
  });

  test('patching a key field is refused rather than silently making it a new row', async () => {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro' } }, { id: 'lite', data: { name: 'Lite' } }]);
    store.seed(TL, 'com.example.demo', 'features', [{ id: 'calls', data: {} }]);
    store.seed(TL, 'com.example.demo', 'cells', [{ id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls' } }]);

    const res = await call('PATCH', { collection: 'cells', rowId: 'pro:calls' }, { data: { tierId: 'lite' } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /identity/);
  });
});

describe('handlePluginApi: references', () => {
  test('a reference that resolves is accepted', async () => {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro' } }]);
    store.seed(TL, 'com.example.demo', 'features', [{ id: 'calls', data: {} }]);
    assert.equal((await call('POST', { collection: 'cells' }, { data: { tierId: 'pro', featureId: 'calls' } })).status, 201);
  });

  test('a dangling reference is refused — there is no foreign key left to catch it', async () => {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'features', [{ id: 'calls', data: {} }]);
    const res = await call('POST', { collection: 'cells' }, { data: { tierId: 'ghost', featureId: 'calls' } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /tierId „ghost" is not a row of "tiers"/);
  });

  test('deleting a parent takes its children with it', async () => {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro' } }]);
    store.seed(TL, 'com.example.demo', 'features', [{ id: 'calls', data: {} }, { id: 'sms', data: {} }]);
    store.seed(TL, 'com.example.demo', 'cells', [
      { id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls' } },
      { id: 'pro:sms', data: { tierId: 'pro', featureId: 'sms' } },
    ]);

    const res = await call('DELETE', { collection: 'features', rowId: 'calls' });
    assert.equal(res.status, 200);
    assert.deepEqual((res.json as { cascaded: unknown }).cascaded, [{ collection: 'cells', rowIds: ['pro:calls'] }]);
    assert.deepEqual(store.dump(TL, 'com.example.demo', 'cells').map((r) => r.id), ['pro:sms']);
  });

  test('a restrict reference blocks the delete and removes nothing', async () => {
    const restrictive: PluginManifest = {
      ...DEMO,
      references: [{ from: 'cells', field: 'tierId', to: 'tiers', onDelete: 'restrict' }],
    };
    const store = makeMemoryStore();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro' } }]);
    store.seed(TL, 'com.example.demo', 'cells', [{ id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls' } }]);

    const res = await handlePluginApi(store.repo, async () => ({ manifest: restrictive, enabled: true }), {
      method: 'DELETE',
      timelineId: TL,
      path: { pluginId: 'com.example.demo', collection: 'tiers', rowId: 'pro' },
    });
    assert.equal(res.status, 409);
    assert.equal((res.json as { error: string }).error, 'reference_restrict');
    assert.equal(store.dump(TL, 'com.example.demo', 'cells').length, 1, 'a blocked delete must not half-apply');
    assert.equal(store.dump(TL, 'com.example.demo', 'tiers').length, 1);
  });
});

describe('handlePluginApi: merge and locking', () => {
  function seeded() {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro', price: '49 €' } }]);
    return { call, store };
  }

  test('a patch merges into the stored object rather than replacing it', async () => {
    const { call } = seeded();
    const res = await call('PATCH', { collection: 'tiers', rowId: 'pro' }, { data: { price: '59 €' } });
    assert.equal(res.status, 200);
    assert.deepEqual((res.json as { data: unknown }).data, { name: 'Pro', price: '59 €' });
  });

  test('a null removes its key, which is the only way a merge write can clear one', async () => {
    const { call } = seeded();
    const res = await call('PATCH', { collection: 'tiers', rowId: 'pro' }, { data: { price: null } });
    assert.deepEqual((res.json as { data: unknown }).data, { name: 'Pro' });
  });

  test('the MERGED row is validated, not the patch: a legal patch can still break the row', async () => {
    const { call, store } = seeded();
    // `name` is required, so clearing it is what the schema exists to prevent —
    // and the patch itself, `{ name: null }`, is unremarkable in isolation.
    const res = await call('PATCH', { collection: 'tiers', rowId: 'pro' }, { data: { name: null } });
    assert.equal(res.status, 400);
    assert.match((res.json as { message: string }).message, /missing required "name"/);
    assert.deepEqual(store.dump(TL, 'com.example.demo', 'tiers')[0].data, { name: 'Pro', price: '49 €' });
  });

  test('a stale If-Match is a 409 instead of an overwrite', async () => {
    const { call } = seeded();
    await call('PATCH', { collection: 'tiers', rowId: 'pro' }, { data: { price: '59 €' } });
    const stale = await call('PATCH', { collection: 'tiers', rowId: 'pro' }, { data: { price: '69 €' } }, 1);
    assert.equal(stale.status, 409);
    assert.equal((stale.json as { error: string }).error, 'version_conflict');
  });

  test('patching a row that is not there is a 404', async () => {
    const { call } = seeded();
    assert.equal((await call('PATCH', { collection: 'tiers', rowId: 'ghost' }, { data: {} })).status, 404);
  });
});

describe('handlePluginApi: ordering', () => {
  function three() {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'features', [{ id: 'a', data: {} }, { id: 'b', data: {} }, { id: 'c', data: {} }]);
    return { call, store };
  }

  test('a list comes back in the collection order', async () => {
    const { call } = three();
    const res = await call('GET', { collection: 'features' });
    assert.deepEqual((res.json as { rows: { id: string }[] }).rows.map((r) => r.id), ['a', 'b', 'c']);
  });

  test('move repositions relative to another row and returns the new order', async () => {
    const { call, store } = three();
    const res = await call('POST', { collection: 'features', rowId: MOVE_SEGMENT }, { id: 'a', after: 'b' });
    assert.equal(res.status, 200);
    assert.deepEqual((res.json as { order: string[] }).order, ['b', 'a', 'c']);
    assert.deepEqual(store.dump(TL, 'com.example.demo', 'features').map((r) => r.id), ['b', 'a', 'c']);
  });

  test('a collection that did not declare an order refuses the move rather than inventing one', async () => {
    const { call, store } = arrange();
    store.seed(TL, 'com.example.demo', 'cells', [{ id: 'x', data: {} }, { id: 'y', data: {} }]);
    const res = await call('POST', { collection: 'cells', rowId: MOVE_SEGMENT }, { id: 'x', after: 'y' });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: string }).error, 'not_ordered');
  });

  test('move without an anchor, or naming a row that is gone, does not reorder', async () => {
    const { call, store } = three();
    assert.equal((await call('POST', { collection: 'features', rowId: MOVE_SEGMENT }, { id: 'a' })).status, 400);
    assert.equal((await call('POST', { collection: 'features', rowId: MOVE_SEGMENT }, { id: 'z', after: 'a' })).status, 404);
    assert.deepEqual(store.dump(TL, 'com.example.demo', 'features').map((r) => r.id), ['a', 'b', 'c']);
  });

  test('a rewrite keeps a row where it was instead of moving it to the end', async () => {
    const { call, store } = three();
    await call('POST', { collection: 'features' }, { id: 'a', data: { changed: true } });
    assert.deepEqual(store.dump(TL, 'com.example.demo', 'features').map((r) => r.id), ['a', 'b', 'c']);
  });

  test('a row whose id is "move" is still addressable — the segment shadows nothing', async () => {
    const { call, store } = three();
    await call('POST', { collection: 'features' }, { id: MOVE_SEGMENT, data: { real: true } });
    const res = await call('PATCH', { collection: 'features', rowId: MOVE_SEGMENT }, { data: { real: false } });
    assert.equal(res.status, 200);
    assert.deepEqual(store.dump(TL, 'com.example.demo', 'features').find((r) => r.id === 'move')?.data, { real: false });
  });
});

describe('purgePlugin', () => {
  test('an uninstall takes the rows and reports the items it cleaned', async () => {
    const store = makeMemoryStore();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro' } }]);
    store.seed('other', 'com.example.demo', 'tiers', [{ id: 'pro', data: { name: 'Pro' } }]);

    let strippedKeys: string[] | null = null;
    const repo = {
      ...store.repo,
      async purgeItemMetadata(keys: string[]) {
        strippedKeys = keys;
        return 2;
      },
    } as TimelineRepo;

    const result = await purgePlugin(repo, DEMO);
    assert.deepEqual(strippedKeys, ['demoTier'], 'the declared item keys go with the rows');
    assert.equal(result.metadataKeysStrippedFrom, 2);
    assert.equal(store.dump(TL, 'com.example.demo', 'tiers').length, 0);
    assert.equal(store.dump('other', 'com.example.demo', 'tiers').length, 0, 'no timeline id means instance-wide');
  });

  test('scoping to one timeline leaves the others alone', async () => {
    const store = makeMemoryStore();
    store.seed(TL, 'com.example.demo', 'tiers', [{ id: 'pro', data: {} }]);
    store.seed('other', 'com.example.demo', 'tiers', [{ id: 'pro', data: {} }]);
    await purgePlugin(store.repo, { ...DEMO, metadataKeys: [] }, TL);
    assert.equal(store.dump(TL, 'com.example.demo', 'tiers').length, 0);
    assert.equal(store.dump('other', 'com.example.demo', 'tiers').length, 1);
  });
});

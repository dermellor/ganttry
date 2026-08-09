// What leaves the building. Tested exhaustively because the failure mode is not a
// broken page, it is somebody's data on somebody else's website.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  isPublicCollection,
  mayPublish,
  projectCollections,
  projectRow,
  publicCollections,
  stripFileForPublication,
  stripForMaterialization,
} from './publicRead.ts';
import type { PluginManifest } from './manifest.ts';
import type { PluginCollectionData } from '../types.ts';

const base: PluginManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['data:own', 'public:read'],
  collections: [{ id: 'tiers' }, { id: 'features' }, { id: 'secrets' }],
  publicRead: { collections: ['tiers', 'features'] },
};

const row = (id: string, data: Record<string, unknown>) => ({
  id,
  data,
  version: 7,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'alice@example.com',
});

const stored: PluginCollectionData = {
  tiers: [row('pro', { name: 'Pro', price: '149', internalNote: 'margin 40%' })],
  features: [row('calls', { name: 'Anrufe' })],
  secrets: [row('s1', { token: 'nope' })],
};

describe('mayPublish', () => {
  test('needs both the granted capability and a declaration', () => {
    assert.equal(mayPublish(base), true);
    assert.equal(mayPublish({ ...base, capabilities: ['data:own'] }), false, 'capability missing');
    assert.equal(mayPublish({ ...base, publicRead: undefined }), false, 'nothing declared');
  });

  test('a declaration with no collections publishes nothing', () => {
    // „It may, but it did not ask to" is the correct reading.
    assert.equal(mayPublish({ ...base, publicRead: { collections: [] } }), false);
  });
});

describe('publicCollections', () => {
  test('only what was declared', () => {
    assert.deepEqual(publicCollections(base), ['tiers', 'features']);
    assert.equal(isPublicCollection(base, 'secrets'), false);
  });

  test('a declared collection the plugin no longer has is dropped', () => {
    // Otherwise a stale `publicRead` entry could open a collection that was
    // renamed away and later reappears under that name meaning something else.
    const stale = { ...base, publicRead: { collections: ['tiers', 'gone'] } };
    assert.deepEqual(publicCollections(stale), ['tiers']);
  });

  test('without the capability, nothing is public no matter what is declared', () => {
    assert.deepEqual(publicCollections({ ...base, capabilities: ['data:own'] }), []);
  });
});

describe('projectRow', () => {
  test('host bookkeeping never survives, declared or not', () => {
    const out = projectRow(base, 'tiers', stored.tiers[0]);
    assert.deepEqual(Object.keys(out), ['id', 'data']);
    // updatedBy is an e-mail: publishing it would leak who works on a timeline.
    assert.ok(!('updatedBy' in out.data));
    assert.ok(!('version' in out.data));
    assert.ok(!('updatedAt' in out.data));
  });

  test('with no field list the plugin\'s whole object is published', () => {
    assert.deepEqual(projectRow(base, 'tiers', stored.tiers[0]).data, {
      name: 'Pro',
      price: '149',
      internalNote: 'margin 40%',
    });
  });

  test('a field list is an ALLOWLIST, so a later-added field is not published', () => {
    // The point: a projection that only knew what to remove would publish
    // whatever the plugin starts storing next.
    const withFields = { ...base, publicRead: { collections: ['tiers'], fields: { tiers: ['name', 'price'] } } };
    assert.deepEqual(projectRow(withFields, 'tiers', stored.tiers[0]).data, { name: 'Pro', price: '149' });
  });

  test('a declared field the row does not carry is simply absent', () => {
    const withFields = { ...base, publicRead: { collections: ['tiers'], fields: { tiers: ['name', 'nope'] } } };
    assert.deepEqual(projectRow(withFields, 'tiers', stored.tiers[0]).data, { name: 'Pro' });
  });

  test('the projection copies rather than sharing the stored object', () => {
    const out = projectRow(base, 'tiers', stored.tiers[0]);
    (out.data as any).name = 'mutated';
    assert.equal(stored.tiers[0].data.name, 'Pro');
  });
});

describe('projectCollections', () => {
  test('undeclared collections are absent, not empty', () => {
    // An empty array would tell a reader the collection exists, and what exists is
    // itself something the declaration decides.
    const out = projectCollections(base, stored);
    assert.deepEqual(Object.keys(out).sort(), ['features', 'tiers']);
    assert.ok(!('secrets' in out));
  });

  test('a declared collection with nothing stored is an empty array', () => {
    const out = projectCollections(base, { tiers: [] });
    assert.deepEqual(out.tiers, []);
    assert.deepEqual(out.features, []);
  });

  test('nothing stored at all still yields the declared shape', () => {
    assert.deepEqual(projectCollections(base, undefined), { tiers: [], features: [] });
  });
});

describe('stripForMaterialization', () => {
  test('a timeline that does not publish loses the plugin data entirely', () => {
    // The inversion that matters: the file is served verbatim, so opting out has
    // to remove the data rather than merely decline to serve it.
    assert.equal(stripForMaterialization(base, stored, false), undefined);
  });

  test('publishing keeps only the declared collections', () => {
    const out = stripForMaterialization(base, stored, true)!;
    assert.deepEqual(Object.keys(out).sort(), ['features', 'tiers']);
    assert.ok(!('secrets' in out));
  });

  test('host fields go from the materialized copy too', () => {
    // A static deploy serves this file, so `updatedBy` in it is the same leak.
    const out = stripForMaterialization(base, stored, true)!;
    assert.deepEqual(Object.keys(out.tiers[0]).sort(), ['data', 'id']);
  });

  test('a field list narrows the materialized copy as well', () => {
    const withFields = { ...base, publicRead: { collections: ['tiers'], fields: { tiers: ['name'] } } };
    const out = stripForMaterialization(withFields, stored, true)!;
    assert.deepEqual(out.tiers[0].data, { name: 'Pro' });
  });

  test('a plugin that publishes nothing leaves no husk behind', () => {
    const out = stripForMaterialization({ ...base, publicRead: { collections: [] } }, stored, true);
    assert.equal(out, undefined);
  });

  test('nothing stored stays nothing', () => {
    assert.equal(stripForMaterialization(base, undefined, true), undefined);
  });
});

describe('stripFileForPublication', () => {
  const manifestFor = (id: string) => (id === 'demo' ? base : null);

  const file = {
    plugins: [{ id: 'demo', public: true }],
    pluginData: { demo: stored },
    items: [],
  } as any;

  test('a consenting timeline keeps only what the plugin declared', () => {
    const out = stripFileForPublication(file, manifestFor);
    assert.deepEqual(Object.keys(out.pluginData.demo).sort(), ['features', 'tiers']);
    assert.ok(!('secrets' in out.pluginData.demo));
  });

  test('without consent the plugin data leaves the materialized copy entirely', () => {
    // The per-timeline opt-in cannot be the only guard on a file that is served
    // verbatim: opting out has to REMOVE the rows, not merely decline to serve.
    const out = stripFileForPublication({ ...file, plugins: [{ id: 'demo' }] }, manifestFor);
    assert.equal(out.pluginData, undefined);
  });

  test('a plugin with no manifest is dropped rather than published', () => {
    // „We could not check" must not resolve to „ship it".
    const out = stripFileForPublication(
      { ...file, plugins: [{ id: 'ghost', public: true }], pluginData: { ghost: stored } },
      manifestFor,
    );
    assert.equal(out.pluginData, undefined);
  });

  test('host bookkeeping is gone from the copy', () => {
    const out = stripFileForPublication(file, manifestFor);
    assert.deepEqual(Object.keys(out.pluginData.demo.tiers[0]).sort(), ['data', 'id']);
  });

  test('a file with no plugin data is returned untouched', () => {
    const plain = { items: [{ id: 'a' }] } as any;
    assert.equal(stripFileForPublication(plain, manifestFor), plain);
  });

  test('the input file is not mutated', () => {
    const before = JSON.stringify(file);
    stripFileForPublication(file, manifestFor);
    assert.equal(JSON.stringify(file), before);
  });
});

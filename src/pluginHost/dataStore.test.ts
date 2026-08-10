import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  cascadeFor,
  collectionOf,
  missingKeyFields,
  referencesFrom,
  reorder,
  rowIdFor,
  type Row,
} from './dataStore.ts';
import type { PluginManifest } from './manifest.ts';

/**
 * A stand-in shaped like product-roadmap: two ordered parent collections, a
 * composite-keyed child with a cascade to each, and a third collection that
 * blocks its parent instead.
 */
const MANIFEST: PluginManifest = {
  id: 'com.example.demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['data:own'],
  collections: [
    { id: 'tiers', ordered: true },
    { id: 'features', ordered: true },
    { id: 'cells', keyFields: ['tierId', 'featureId'] },
    { id: 'pinned' },
    { id: 'bundles' },
  ],
  references: [
    { from: 'cells', field: 'tierId', to: 'tiers', onDelete: 'cascade' },
    { from: 'cells', field: 'featureId', to: 'features', onDelete: 'cascade' },
    { from: 'pinned', field: 'tierId', to: 'tiers', onDelete: 'restrict' },
    { from: 'bundles', field: 'featureIds', to: 'features', array: true, onDelete: 'unlink' },
  ],
};

const rows = (map: Record<string, Row[]>) => (collection: string) => map[collection] ?? [];

describe('rowIdFor', () => {
  test('without keyFields the row carries its own id', () => {
    assert.equal(rowIdFor({ id: 'tiers' }, { id: 'pro' }), 'pro');
    assert.equal(rowIdFor({ id: 'tiers' }, {}, 'explicit'), 'explicit');
  });

  test('with keyFields the id IS the coordinates, so the same pair addresses one row', () => {
    const decl = { id: 'cells', keyFields: ['tierId', 'featureId'] };
    const first = rowIdFor(decl, { tierId: 'pro', featureId: 'calls', value: true });
    const second = rowIdFor(decl, { tierId: 'pro', featureId: 'calls', value: 'other' });
    assert.equal(first, 'pro:calls');
    assert.equal(first, second, 'a rewrite of the same cell must not mint a second row');
  });

  test('a key value carrying the separator or a slash is encoded, not split', () => {
    const decl = { id: 'cells', keyFields: ['a', 'b'] };
    // Left unencoded, `a/b` would become two path segments and address a
    // different row; `x:y` would collide with a two-part key.
    assert.equal(rowIdFor(decl, { a: 'x/y', b: 'z' }), 'x%2Fy:z');
    assert.equal(rowIdFor(decl, { a: 'x:y', b: 'z' }), 'x%3Ay:z');
    assert.notEqual(rowIdFor(decl, { a: 'x', b: 'y:z' }), rowIdFor(decl, { a: 'x:y', b: 'z' }));
  });
});

describe('missingKeyFields', () => {
  const decl = { id: 'cells', keyFields: ['tierId', 'featureId'] };
  test('names every key the data does not supply', () => {
    assert.deepEqual(missingKeyFields(decl, { tierId: 'pro' }), ['featureId']);
  });
  test('an empty string is missing, not a key', () => {
    assert.deepEqual(missingKeyFields(decl, { tierId: '', featureId: 'x' }), ['tierId']);
  });
  test('a collection without keyFields is never missing one', () => {
    assert.deepEqual(missingKeyFields({ id: 'tiers' }, {}), []);
  });
});

describe('collectionOf / referencesFrom', () => {
  test('an undeclared collection is null rather than an empty declaration', () => {
    assert.equal(collectionOf(MANIFEST, 'nope'), null);
    assert.equal(collectionOf(MANIFEST, 'tiers')?.ordered, true);
  });
  test('referencesFrom lists what a write on that collection has to resolve', () => {
    assert.deepEqual(referencesFrom(MANIFEST, 'cells').map((r) => r.field), ['tierId', 'featureId']);
    assert.deepEqual(referencesFrom(MANIFEST, 'tiers'), []);
  });
});

describe('cascadeFor', () => {
  test('deleting a parent takes the rows that reference it', () => {
    const { remove, blockedBy } = cascadeFor(
      MANIFEST,
      'features',
      'calls',
      rows({
        cells: [
          { id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls' } },
          { id: 'lite:calls', data: { tierId: 'lite', featureId: 'calls' } },
          { id: 'pro:sms', data: { tierId: 'pro', featureId: 'sms' } },
        ],
      }),
    );
    assert.deepEqual(blockedBy, []);
    assert.deepEqual(remove, [{ collection: 'cells', rowIds: ['pro:calls', 'lite:calls'] }]);
  });

  test('a parent nothing references cascades to nothing', () => {
    assert.deepEqual(cascadeFor(MANIFEST, 'features', 'calls', rows({})).remove, []);
  });

  test('a restrict reference blocks instead of removing, and blocks the whole delete', () => {
    const { remove, blockedBy } = cascadeFor(
      MANIFEST,
      'tiers',
      'pro',
      rows({
        pinned: [{ id: 'p1', data: { tierId: 'pro' } }],
        cells: [{ id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls' } }],
      }),
    );
    assert.equal(blockedBy.length, 1);
    assert.equal(blockedBy[0].reference.from, 'pinned');
    // The cascade is still computed, but the caller must not apply it while a
    // restrict is outstanding — which is why both come back from one call.
    assert.deepEqual(remove, [{ collection: 'cells', rowIds: ['pro:calls'] }]);
  });

  test('an array reference unlinks the one id and leaves the row standing', () => {
    const { remove, unlink } = cascadeFor(
      MANIFEST,
      'features',
      'calls',
      rows({
        bundles: [
          { id: 'volume', data: { featureIds: ['calls', 'sms'] } },
          { id: 'other', data: { featureIds: ['sms'] } },
        ],
      }),
    );
    // Deleting one of a bundle's features must shorten the list, not delete the
    // bundle — a tile that loses one of five features is still a tile.
    assert.deepEqual(remove, []);
    assert.deepEqual(unlink, [{ collection: 'bundles', rowId: 'volume', field: 'featureIds', value: ['sms'] }]);
  });

  test('a scalar unlink clears the field rather than removing an entry', () => {
    const scalar: PluginManifest = {
      ...MANIFEST,
      references: [{ from: 'pinned', field: 'tierId', to: 'tiers', onDelete: 'unlink' }],
    };
    const { unlink } = cascadeFor(scalar, 'tiers', 'pro', rows({ pinned: [{ id: 'p1', data: { tierId: 'pro' } }] }));
    assert.deepEqual(unlink, [{ collection: 'pinned', rowId: 'p1', field: 'tierId', value: null }]);
  });

  test('an array field holding no matching id is left alone', () => {
    const { unlink } = cascadeFor(MANIFEST, 'features', 'calls', rows({ bundles: [{ id: 'b', data: { featureIds: ['sms'] } }] }));
    assert.deepEqual(unlink, []);
  });

  test('a reference cycle terminates instead of hanging the request', () => {
    const cyclic: PluginManifest = {
      id: 'cyclic',
      name: 'Cyclic',
      version: '1.0.0',
      apiVersion: '^1',
      capabilities: ['data:own'],
      collections: [{ id: 'a' }, { id: 'b' }],
      references: [
        { from: 'a', field: 'bId', to: 'b', onDelete: 'cascade' },
        { from: 'b', field: 'aId', to: 'a', onDelete: 'cascade' },
      ],
    };
    const { remove } = cascadeFor(
      cyclic,
      'a',
      'a1',
      rows({ a: [{ id: 'a1', data: { bId: 'b1' } }], b: [{ id: 'b1', data: { aId: 'a1' } }] }),
    );
    assert.deepEqual(remove, [{ collection: 'b', rowIds: ['b1'] }]);
  });
});

describe('reorder', () => {
  const ids = ['a', 'b', 'c'];
  test('after and before place the row on the named side', () => {
    assert.deepEqual(reorder(ids, 'a', { after: 'b' }), ['b', 'a', 'c']);
    assert.deepEqual(reorder(ids, 'c', { before: 'a' }), ['c', 'a', 'b']);
  });
  test('after wins when both are given', () => {
    assert.deepEqual(reorder(ids, 'a', { after: 'b', before: 'c' }), ['b', 'a', 'c']);
  });
  test('an unknown row, an unknown anchor or itself as anchor returns null', () => {
    assert.equal(reorder(ids, 'z', { after: 'a' }), null);
    assert.equal(reorder(ids, 'a', { after: 'z' }), null);
    assert.equal(reorder(ids, 'a', { after: 'a' }), null);
    assert.equal(reorder(ids, 'a', {}), null);
  });
});

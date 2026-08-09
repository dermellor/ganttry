// The acceptance criterion of issue #12, executed rather than argued.
//
// „product-roadmap must be expressible: its four normalised tables, their foreign
// keys, their ordering and their per-row locking, without one line of plugin code
// on the server." This suite drives the REAL manifest — the same object the app
// registers — through the generic store and checks each of those four claims.
//
// It runs against both source kinds, because the second criterion is that a
// plugin must not depend on one: the same sequence of calls on the DB-shaped
// store and on a real file on disk, with the ONE documented difference asserted
// rather than glossed over (per-row locking versus per-file locking).
//
// If this suite has to be weakened to keep passing, the contract is short of
// what its most demanding plugin needs, and that is a gap to close in the
// contract — see docs/plugin-storage.md → „Proof against product-roadmap".

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';

import { handlePluginApi, MOVE_SEGMENT, purgePlugin, type ManifestSource } from './plugin-api.ts';
import { makeMemoryStore } from './plugin-store-memory.ts';
import { validateManifest } from '../../src/pluginHost/manifest.ts';
import { productRoadmapManifest, PRICING_COLLECTIONS } from '../../src/plugins/product-roadmap/manifest.ts';
import { makeFileRepo, type FileRepoDirs } from '../local/file-repo.ts';
import type { TimelineRepo } from './repo.ts';

const PLUGIN = productRoadmapManifest.id;
const manifests: ManifestSource = async (id) =>
  id === PLUGIN ? { manifest: productRoadmapManifest, enabled: true } : null;

/** The four tables, as the manifest claims to express them. */
const { features, tiers, tierValues, highlights } = PRICING_COLLECTIONS;

type Call = (
  method: string,
  collection: string,
  opts?: { rowId?: string; body?: unknown; ifMatch?: number },
) => Promise<{ status: number; json: any }>;

function callerFor(repo: TimelineRepo, timelineId: string): Call {
  return (method, collection, opts = {}) =>
    handlePluginApi(repo, manifests, {
      method,
      timelineId,
      path: { pluginId: PLUGIN, collection, rowId: opts.rowId },
      body: opts.body,
      ifMatch: opts.ifMatch,
    });
}

/** Seed a model the real one is shaped like: two tiers, three features, cells. */
async function seedModel(call: Call): Promise<void> {
  for (const [id, name] of [['lite', 'Lite'], ['pro', 'Pro']]) {
    const res = await call('POST', tiers, { body: { id, data: { name, price: `${name} price` } } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  for (const [id, name] of [['calls', 'Anrufe'], ['sms', 'SMS'], ['rag', 'RAG']]) {
    const res = await call('POST', features, { body: { id, data: { name, group: 'Funktionen' } } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  for (const [tierId, featureId, value] of [
    ['pro', 'calls', '3.000'],
    ['pro', 'sms', true],
    ['lite', 'calls', '500'],
  ] as const) {
    const res = await call('POST', tierValues, { body: { data: { tierId, featureId, value } } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  const hl = await call('POST', highlights, {
    body: { id: 'volumen', data: { label: 'Inkludiertes Volumen', section: 'Inkludiert', featureIds: ['calls', 'sms'] } },
  });
  assert.equal(hl.status, 201, JSON.stringify(hl.json));
}

const ids = (res: { json: any }) => res.json.rows.map((r: { id: string }) => r.id);

describe('product-roadmap: the manifest itself is coherent', () => {
  test('the shipped manifest validates, including its schemas and references', () => {
    const result = validateManifest(productRoadmapManifest);
    assert.equal(result.ok, true, result.ok ? '' : result.problems.join('\n'));
  });

  test('all four pricing tables are declared as collections', () => {
    const declared = (productRoadmapManifest.collections ?? []).map((c) => c.id).sort();
    assert.deepEqual(declared, [features, highlights, tierValues, tiers].sort());
  });

  test('the ordered tables are the ones that carry a sort column today', () => {
    const ordered = (productRoadmapManifest.collections ?? []).filter((c) => c.ordered).map((c) => c.id).sort();
    // pricing_features, pricing_tiers and pricing_highlights have `sort`;
    // pricing_tier_values does not — a cell's position comes from its coordinates.
    assert.deepEqual(ordered, [features, highlights, tiers].sort());
  });

  test('a matrix cell is keyed by its coordinates, like its composite primary key', () => {
    const cell = (productRoadmapManifest.collections ?? []).find((c) => c.id === tierValues);
    assert.deepEqual(cell?.keyFields, ['tierId', 'featureId']);
  });

  test('all three relations are declared, including the one Postgres never enforced', () => {
    const declared = (productRoadmapManifest.references ?? []).map((r) => `${r.from}.${r.field}→${r.to}:${r.onDelete}`);
    assert.deepEqual(declared, [
      `${tierValues}.tierId→${tiers}:cascade`,
      `${tierValues}.featureId→${features}:cascade`,
      `${highlights}.featureIds→${features}:unlink`,
    ]);
  });
});

/**
 * The behavioural half, run once per backing store. `perRowLocking` is the one
 * documented difference between them and is asserted, not skipped.
 */
function behaviour(label: string, make: () => Promise<{ call: Call; repo: TimelineRepo }>, perRowLocking: boolean) {
  describe(`product-roadmap on a ${label} source`, () => {
    test('the whole model round-trips through the generic store', async () => {
      const { call } = await make();
      await seedModel(call);
      assert.deepEqual(ids(await call('GET', tiers)), ['lite', 'pro']);
      assert.deepEqual(ids(await call('GET', features)), ['calls', 'sms', 'rag']);
      assert.deepEqual(ids(await call('GET', tierValues)).sort(), ['lite:calls', 'pro:calls', 'pro:sms']);
      assert.deepEqual(ids(await call('GET', highlights)), ['volumen']);
    });

    test('a cell is addressed by its coordinates: writing it twice updates one row', async () => {
      const { call } = await make();
      await seedModel(call);
      await call('POST', tierValues, { body: { data: { tierId: 'pro', featureId: 'calls', value: 'unbegrenzt' } } });
      const rows = (await call('GET', tierValues)).json.rows;
      assert.equal(rows.length, 3, 'still three cells');
      assert.equal(rows.find((r: any) => r.id === 'pro:calls').data.value, 'unbegrenzt');
    });

    test('a cell naming a tier that does not exist is refused — the foreign key still holds', async () => {
      const { call } = await make();
      await seedModel(call);
      const res = await call('POST', tierValues, { body: { data: { tierId: 'ghost', featureId: 'calls' } } });
      assert.equal(res.status, 400);
      assert.match(res.json.message, /tierId „ghost"/);
    });

    test('deleting a tier takes its cells, exactly as the FK cascade does', async () => {
      const { call } = await make();
      await seedModel(call);
      const res = await call('DELETE', tiers, { rowId: 'pro' });
      assert.equal(res.status, 200);
      assert.deepEqual(ids(await call('GET', tierValues)), ['lite:calls']);
    });

    test('deleting a feature takes its cells AND unlinks it from the highlights', async () => {
      const { call } = await make();
      await seedModel(call);
      const res = await call('DELETE', features, { rowId: 'calls' });
      assert.equal(res.status, 200);
      assert.deepEqual(ids(await call('GET', tierValues)), ['pro:sms']);
      const tile = (await call('GET', highlights)).json.rows[0];
      // The hand-written strip in deleteFeature, now a declaration. The tile
      // survives with one feature fewer rather than disappearing.
      assert.deepEqual(tile.data.featureIds, ['sms']);
    });

    test('a highlight naming a feature that does not exist is refused', async () => {
      const { call } = await make();
      await seedModel(call);
      const res = await call('POST', highlights, {
        body: { id: 'bad', data: { label: 'X', featureIds: ['calls', 'ghost'] } },
      });
      assert.equal(res.status, 400);
      assert.match(res.json.message, /featureIds „ghost"/);
    });

    test('matrix row order is maintained and repositioned, like moveFeature', async () => {
      const { call } = await make();
      await seedModel(call);
      const res = await call('POST', features, { rowId: MOVE_SEGMENT, body: { id: 'rag', after: 'calls' } });
      assert.equal(res.status, 200);
      assert.deepEqual(ids(await call('GET', features)), ['calls', 'rag', 'sms']);
    });

    test('a cell cannot be moved: the collection declares no order, and it has none', async () => {
      const { call } = await make();
      await seedModel(call);
      const res = await call('POST', tierValues, { rowId: MOVE_SEGMENT, body: { id: 'pro:calls', after: 'pro:sms' } });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'not_ordered');
    });

    test('a stale conditional write is refused rather than overwriting', async () => {
      const { call } = await make();
      await seedModel(call);
      const stale = (await call('GET', tiers)).json.rows.find((r: any) => r.id === 'pro').version;
      await call('PATCH', tiers, { rowId: 'pro', body: { data: { price: '59 €' } } });
      const res = await call('PATCH', tiers, { rowId: 'pro', body: { data: { price: '69 €' } }, ifMatch: stale });
      assert.equal(res.status, 409);
    });

    test(
      perRowLocking
        ? 'two cells lock independently, the way the per-row version does'
        : 'the whole file is the lock, so a neighbouring write is a conflict too',
      async () => {
        const { call } = await make();
        await seedModel(call);
        const before = (await call('GET', tierValues)).json.rows.find((r: any) => r.id === 'pro:calls').version;
        // Somebody edits a DIFFERENT cell.
        await call('PATCH', tierValues, { rowId: 'lite:calls', body: { data: { value: '600' } } });
        const res = await call('PATCH', tierValues, {
          rowId: 'pro:calls',
          body: { data: { value: '4.000' } },
          ifMatch: before,
        });
        if (perRowLocking) {
          assert.equal(res.status, 200, 'a per-row store must let two people edit two cells at once');
        } else {
          assert.equal(res.status, 409, 'a file has one version; the header means „the file has not changed"');
        }
      },
    );

    test('uninstalling takes the rows of all four collections', async () => {
      const { call, repo } = await make();
      await seedModel(call);
      await purgePlugin(repo, productRoadmapManifest);
      for (const collection of [features, tiers, tierValues, highlights]) {
        assert.deepEqual(ids(await call('GET', collection)), [], `${collection} survived the uninstall`);
      }
    });
  });
}

behaviour(
  'db-shaped',
  async () => {
    const store = makeMemoryStore();
    return { call: callerFor(store.repo, 'plan'), repo: store.repo };
  },
  true,
);

let dirs: FileRepoDirs;
before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeitlines-pr-proof-'));
  dirs = { root, scope: root };
});

let n = 0;
behaviour(
  'local file',
  async () => {
    const id = `proof-${n++}`;
    await mkdir(dirs.root, { recursive: true });
    await writeFile(join(dirs.root, `${id}.json`), JSON.stringify({ name: id, items: [] }, null, 2), 'utf8');
    const repo = makeFileRepo(dirs);
    return { call: callerFor(repo, id), repo };
  },
  false,
);

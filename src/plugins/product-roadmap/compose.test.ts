// The pricing model as generic rows, and back.
//
// The round trip is the point: the migration in #17 moves four tables into the
// generic store, and „rows → model → rows is a fixed point" is what says nothing
// was lost. A mismatch here is a mismatch that would otherwise surface in
// somebody's published price list.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { cellId, collectionsFromPricing, pricingFromCollections } from './compose.ts';
import { PRICING_COLLECTIONS } from './manifest.ts';
import type { Pricing } from '../../types.ts';

const { features: FEATURES, tiers: TIERS, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

/** A model exercising every field the plugin stores, including the awkward ones. */
const MODEL: Pricing = {
  versions: ['1.0', '2.0'],
  features: [
    {
      id: 'calls',
      name: 'Anrufe',
      group: 'Funktionen',
      description: 'Eingehende Anrufe.',
      version: '1.0',
      nameByVersion: { '2.0': 'Anrufe und Rückrufe' },
      descriptionByVersion: { '2.0': 'Jetzt mit Rückrufwunsch.' },
    },
    { id: 'sms', name: 'SMS' },
  ],
  tiers: [
    {
      id: 'lite',
      name: 'Lite',
      price: 'ab 49 €',
      tagline: 'Micro',
      useCase: 'Verpasste Anrufe auffangen',
      targetGroup: 'Kleine Unternehmen',
      values: { calls: '500', sms: true },
    },
    {
      id: 'pro',
      name: 'Pro',
      price: 'ab 149 €',
      values: { calls: '3.000', sms: true },
      valueVersions: { calls: '2.0' },
    },
  ],
  highlights: [
    { id: 'volumen', label: 'Volumen', section: 'Inkludiert', featureIds: ['calls', 'sms'], labelByVersion: { '2.0': 'Mehr Volumen' } },
  ],
};

describe('collectionsFromPricing', () => {
  test('each entity becomes a row whose id is the row id, not a field', () => {
    // Keeping a copy of the id inside `data` would give every row two ids that
    // can disagree; identity is the host's column.
    const out = collectionsFromPricing(MODEL);
    assert.deepEqual(out[FEATURES].map((r) => r.id), ['calls', 'sms']);
    assert.ok(!('id' in out[FEATURES][0].data));
    assert.equal(out[FEATURES][0].data.name, 'Anrufe');
  });

  test('a tier keeps no values: those become cells', () => {
    const out = collectionsFromPricing(MODEL);
    const lite = out[TIERS].find((r) => r.id === 'lite')!;
    assert.ok(!('values' in lite.data));
    assert.ok(!('valueVersions' in lite.data));
    assert.deepEqual(
      out[CELLS].map((r) => r.id).sort(),
      ['lite:calls', 'lite:sms', 'pro:calls', 'pro:sms'].sort(),
    );
  });

  test('a per-cell version rides along on its cell', () => {
    const cell = collectionsFromPricing(MODEL)[CELLS].find((r) => r.id === 'pro:calls')!;
    assert.equal(cell.data.availableFrom, '2.0');
    assert.equal(cell.data.value, '3.000');
  });

  test('a falsy value produces no cell, matching what the old storage did', () => {
    // The server cleared a cell on a falsy write, so `false` was never a row.
    const out = collectionsFromPricing({
      features: [{ id: 'a', name: 'A' }],
      tiers: [{ id: 't', name: 'T', price: '', values: { a: false } }],
    });
    assert.deepEqual(out[CELLS], []);
  });

  test('the server-managed rowVersion never becomes stored data', () => {
    const out = collectionsFromPricing({
      features: [{ id: 'a', name: 'A', rowVersion: 7 }],
      tiers: [{ id: 't', name: 'T', price: '', values: {}, rowVersion: 3 }],
      highlights: [{ id: 'h', label: 'H', featureIds: [], rowVersion: 2 }],
    });
    assert.ok(!('rowVersion' in out[FEATURES][0].data));
    assert.ok(!('rowVersion' in out[TIERS][0].data));
    assert.ok(!('rowVersion' in out[HIGHLIGHTS][0].data));
  });

  test('an absent model yields the four empty collections rather than nothing', () => {
    const out = collectionsFromPricing(undefined);
    assert.deepEqual(Object.keys(out).sort(), [CELLS, FEATURES, HIGHLIGHTS, TIERS].sort());
  });
});

describe('pricingFromCollections', () => {
  test('cells are folded back into their tier', () => {
    const back = pricingFromCollections(collectionsFromPricing(MODEL), MODEL.versions);
    assert.deepEqual(back.tiers.find((t) => t.id === 'lite')!.values, { calls: '500', sms: true });
    assert.deepEqual(back.tiers.find((t) => t.id === 'pro')!.valueVersions, { calls: '2.0' });
  });

  test('versions come from the config, not from a collection', () => {
    const data = collectionsFromPricing(MODEL);
    assert.equal(pricingFromCollections(data, []).versions, undefined);
    assert.deepEqual(pricingFromCollections(data, ['9.9']).versions, ['9.9']);
  });

  test('a cell naming a tier that is gone contributes nothing', () => {
    // The host cascades those away, but a hand-written row must not crash a render.
    const back = pricingFromCollections({
      [FEATURES]: [{ id: 'a', data: { name: 'A' } }],
      [TIERS]: [],
      [CELLS]: [{ id: 'ghost:a', data: { tierId: 'ghost', featureId: 'a', value: true } }],
      [HIGHLIGHTS]: [],
    });
    assert.deepEqual(back.tiers, []);
  });

  test('a malformed cell is skipped rather than thrown on', () => {
    const back = pricingFromCollections({
      [TIERS]: [{ id: 't', data: { name: 'T', price: '' } }],
      [CELLS]: [{ id: 'x', data: { value: true } }, { id: 'y', data: { tierId: 't', value: true } }],
    } as any);
    assert.deepEqual(back.tiers[0].values, {});
  });

  test('no highlights means the key is absent, as the renderer expects', () => {
    const back = pricingFromCollections({ [FEATURES]: [], [TIERS]: [], [CELLS]: [], [HIGHLIGHTS]: [] });
    assert.equal(back.highlights, undefined);
  });

  test('nothing stored at all is an empty model, not a crash', () => {
    assert.deepEqual(pricingFromCollections(undefined), { features: [], tiers: [] });
  });
});

describe('the round trip is a fixed point', () => {
  test('model → rows → model returns the model', () => {
    // This is what the migration relies on. A drift here is data loss that only
    // shows up in a published price list.
    const back = pricingFromCollections(collectionsFromPricing(MODEL), MODEL.versions);
    assert.deepEqual(back, MODEL);
  });

  test('rows → model → rows returns the rows', () => {
    const once = collectionsFromPricing(MODEL);
    const twice = collectionsFromPricing(pricingFromCollections(once, MODEL.versions));
    assert.deepEqual(twice, once);
  });

  test('it survives a model with nothing optional set', () => {
    const bare: Pricing = {
      features: [{ id: 'a', name: 'A' }],
      tiers: [{ id: 't', name: 'T', price: '9 €', values: {} }],
    };
    assert.deepEqual(pricingFromCollections(collectionsFromPricing(bare)), bare);
  });
});

describe('cellId', () => {
  test('is the two coordinates, encoded', () => {
    assert.equal(cellId('pro', 'calls'), 'pro:calls');
  });

  test('an id carrying a separator cannot collide with a two-part key', () => {
    // Left raw, `a:b` + `c` and `a` + `b:c` would be the same row.
    assert.notEqual(cellId('a:b', 'c'), cellId('a', 'b:c'));
    assert.equal(cellId('a/b', 'c'), 'a%2Fb:c');
  });
});

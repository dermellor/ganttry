// The in-memory mirror, and the bug it was written for.
//
// `currentPricing` composes a fresh model on every call, so the old habit of
// mutating the composed object after a successful write updated a copy that was
// discarded on the next line: the server had the change, the file on disk had it,
// and the matrix kept showing the old value until a reload. Nothing threw.
//
// These tests pin the mirror in ROW space, which is where the state actually is.
// The last one is the regression test proper: it goes through `currentPricing`,
// because that is what the views read, and a mirror that updates rows nobody
// composes from is the same bug in a new place.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyRow, dropRow, dropRowsWhere, orderRows, patchRows } from './store';
import { currentPricing } from './compose';
import { PRICING_COLLECTIONS } from './manifest';
import { PRODUCT_ROADMAP_PLUGIN } from './plugin';
import type { TimelineFile } from '../../types';

const { features: FEATURES, tiers: TIERS, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

const file = (rows: Record<string, { id: string; data: Record<string, unknown> }[]> = {}): TimelineFile => ({
  items: [],
  plugins: [{ id: PRODUCT_ROADMAP_PLUGIN, config: { versions: ['1.0'] } }],
  pluginData: { [PRODUCT_ROADMAP_PLUGIN]: rows },
});

const ids = (f: TimelineFile, collection: string) =>
  (f.pluginData?.[PRODUCT_ROADMAP_PLUGIN]?.[collection] ?? []).map((r) => r.id);

describe('applyRow', () => {
  test('a new row is appended, where the host puts it too', () => {
    const f = file({ [FEATURES]: [{ id: 'a', data: { name: 'A' } }] });
    applyRow(f, FEATURES, { id: 'b', data: { name: 'B' } });
    assert.deepEqual(ids(f, FEATURES), ['a', 'b']);
  });

  test('an existing row is replaced in place, so its position holds', () => {
    const f = file({ [FEATURES]: [{ id: 'a', data: { name: 'A' } }, { id: 'b', data: { name: 'B' } }] });
    applyRow(f, FEATURES, { id: 'a', data: { name: 'A neu' }, version: 3 });
    assert.deepEqual(ids(f, FEATURES), ['a', 'b'], 'not moved to the end');
    assert.deepEqual(f.pluginData![PRODUCT_ROADMAP_PLUGIN][FEATURES][0].data, { name: 'A neu' });
  });

  test('replacing drops a field the patch cleared', () => {
    // The whole reason a row is replaced rather than merged: the server already
    // decided what the row is now, and a merge would keep a key it deleted.
    const f = file({ [FEATURES]: [{ id: 'a', data: { name: 'A', group: 'Alt' } }] });
    applyRow(f, FEATURES, { id: 'a', data: { name: 'A' } });
    assert.ok(!('group' in f.pluginData![PRODUCT_ROADMAP_PLUGIN][FEATURES][0].data));
  });

  test('the first write creates the plugin and the collection', () => {
    const f: TimelineFile = { items: [] };
    applyRow(f, TIERS, { id: 't', data: { name: 'T' } });
    assert.deepEqual(ids(f, TIERS), ['t']);
  });
});

describe('dropRow / dropRowsWhere / patchRows', () => {
  test('dropping a row that is not there is a no-op, not an error', () => {
    const f = file({ [FEATURES]: [{ id: 'a', data: {} }] });
    dropRow(f, FEATURES, 'ghost');
    assert.deepEqual(ids(f, FEATURES), ['a']);
  });

  test('a cascade takes exactly the matching rows', () => {
    const f = file({
      [CELLS]: [
        { id: 'p:a', data: { tierId: 'p', featureId: 'a' } },
        { id: 'p:b', data: { tierId: 'p', featureId: 'b' } },
        { id: 'q:a', data: { tierId: 'q', featureId: 'a' } },
      ],
    });
    dropRowsWhere(f, CELLS, (d) => d.featureId === 'a');
    assert.deepEqual(ids(f, CELLS), ['p:b']);
  });

  test('an unlink edits the rows that survive', () => {
    const f = file({ [HIGHLIGHTS]: [{ id: 'h', data: { label: 'H', featureIds: ['a', 'b'] } }] });
    patchRows(f, HIGHLIGHTS, (d) => ({ ...d, featureIds: (d.featureIds as string[]).filter((id) => id !== 'a') }));
    assert.deepEqual(f.pluginData![PRODUCT_ROADMAP_PLUGIN][HIGHLIGHTS][0].data.featureIds, ['b']);
  });
});

describe('orderRows', () => {
  test('the host order wins', () => {
    const f = file({ [FEATURES]: [{ id: 'a', data: {} }, { id: 'b', data: {} }, { id: 'c', data: {} }] });
    orderRows(f, FEATURES, ['c', 'a', 'b']);
    assert.deepEqual(ids(f, FEATURES), ['c', 'a', 'b']);
  });

  test('a row the host did not mention keeps its place at the end rather than vanishing', () => {
    // The host returns the full list, so a missing id means the two sides
    // disagree about what exists. Dropping the row over that would turn a
    // disagreement into data loss on screen.
    const f = file({ [FEATURES]: [{ id: 'a', data: {} }, { id: 'b', data: {} }] });
    orderRows(f, FEATURES, ['b']);
    assert.deepEqual(ids(f, FEATURES), ['b', 'a']);
  });
});

describe('the regression: a mirrored write reaches what the views read', () => {
  test('a cell written into the rows shows up in the composed model', () => {
    const f = file({
      [FEATURES]: [{ id: 'calls', data: { name: 'Anrufe' } }],
      [TIERS]: [{ id: 'pro', data: { name: 'Pro', price: '' } }],
      [CELLS]: [{ id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls', value: 'alt' } }],
    });
    applyRow(f, CELLS, { id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls', value: 'neu' } });
    assert.deepEqual(currentPricing(f).tiers[0].values, { calls: 'neu' });
  });

  test('a cleared cell disappears from the composed model', () => {
    const f = file({
      [FEATURES]: [{ id: 'calls', data: { name: 'Anrufe' } }],
      [TIERS]: [{ id: 'pro', data: { name: 'Pro', price: '' } }],
      [CELLS]: [{ id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls', value: 'alt' } }],
    });
    dropRow(f, CELLS, 'pro:calls');
    assert.deepEqual(currentPricing(f).tiers[0].values, {});
  });

  test('mutating the composed model changes nothing — which is why this module exists', () => {
    const f = file({
      [FEATURES]: [{ id: 'calls', data: { name: 'Anrufe' } }],
      [TIERS]: [{ id: 'pro', data: { name: 'Pro', price: '' } }],
    });
    currentPricing(f).tiers[0].values.calls = 'geschrieben';
    assert.deepEqual(currentPricing(f).tiers[0].values, {}, 'the model is derived, so a write to it is lost');
  });
});

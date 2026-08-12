// The pure planner of the version-id migration (issue #110). It proves the
// re-key covers every one of the six reference sites, that unknown strings are
// left alone, and that a re-run finds nothing to do.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planVersionIdMigration } from './migrate-version-ids.ts';
import { PRICING_COLLECTIONS } from '../../src/plugins/product-roadmap/manifest.ts';

const { features: FEATURES, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

const LABELS = ['1.0', '2.0'];
// "1.0" → "1-0", "2.0" → "2-0" (slugId of the label).
const V1 = '1-0';
const V2 = '2-0';

function collections() {
  return {
    [FEATURES]: [
      {
        id: 'calls',
        data: {
          name: 'Anrufe',
          version: '1.0',
          nameByVersion: { '2.0': 'Anrufe und Rückrufe' },
          descriptionByVersion: { '2.0': 'Jetzt mit Rückruf.' },
        },
      },
      { id: 'sms', data: { name: 'SMS' } }, // no version → untouched
    ],
    [CELLS]: [
      { id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls', value: true, availableFrom: '2.0' } },
      { id: 'pro:sms', data: { tierId: 'pro', featureId: 'sms', value: '100' } }, // no availableFrom
    ],
    [HIGHLIGHTS]: [
      { id: 'h1', data: { label: 'Telefonie', featureIds: ['calls'], labelByVersion: { '2.0': 'Telefonie+' } } },
    ],
  };
}

const items = [
  { id: 'i1', version: 3, metadata: { featureIds: ['calls'], featureVersion: '1.0' } },
  { id: 'i2', version: 5, metadata: { featureIds: ['calls'], featureVersion: '2.0' } },
  { id: 'i3', version: 1, metadata: { featureIds: ['sms'] } }, // no featureVersion → untouched
];

test('the plan re-keys all six reference sites label → id', () => {
  const plan = planVersionIdMigration(LABELS, collections(), items);
  assert.deepEqual(plan.ids, [V1, V2]);
  assert.deepEqual(plan.versionLabels, { [V1]: '1.0', [V2]: '2.0' });
  assert.equal(plan.valid, true);

  // feature.version, nameByVersion key, descriptionByVersion key
  const feat = plan.featurePatches.find((p) => p.rowId === 'calls')!;
  assert.equal(feat.patch.version, V1);
  assert.deepEqual(feat.patch.nameByVersion, { [V2]: 'Anrufe und Rückrufe' });
  assert.deepEqual(feat.patch.descriptionByVersion, { [V2]: 'Jetzt mit Rückruf.' });

  // cell availableFrom
  assert.deepEqual(plan.cellPatches, [{ rowId: 'pro:calls', patch: { availableFrom: V2 } }]);

  // highlight labelByVersion key
  assert.deepEqual(plan.highlightPatches, [{ rowId: 'h1', patch: { labelByVersion: { [V2]: 'Telefonie+' } } }]);

  // item featureVersion
  assert.deepEqual(
    plan.itemPatches.map((p) => ({ itemId: p.itemId, fv: p.metadata.featureVersion, version: p.version })),
    [
      { itemId: 'i1', fv: V1, version: 3 },
      { itemId: 'i2', fv: V2, version: 5 },
    ],
  );
});

test('rows without a version reference produce no patch', () => {
  const plan = planVersionIdMigration(LABELS, collections(), items);
  assert.equal(plan.featurePatches.find((p) => p.rowId === 'sms'), undefined);
  assert.equal(plan.cellPatches.find((p) => p.rowId === 'pro:sms'), undefined);
  assert.equal(plan.itemPatches.find((p) => p.itemId === 'i3'), undefined);
});

test('item metadata is preserved except the remapped key', () => {
  const plan = planVersionIdMigration(LABELS, collections(), items);
  const i1 = plan.itemPatches.find((p) => p.itemId === 'i1')!;
  assert.deepEqual(i1.metadata, { featureIds: ['calls'], featureVersion: V1 });
});

test('a re-run over already-id data is a no-op (ids slug to themselves)', () => {
  // Simulate the post-migration state: values are already ids. `planVersionIdMigration`
  // is only reached when versionLabels is empty, but even then it must not churn.
  const idCollections = {
    [FEATURES]: [{ id: 'calls', data: { name: 'Anrufe', version: V1 } }],
    [CELLS]: [{ id: 'pro:calls', data: { tierId: 'pro', featureId: 'calls', value: true, availableFrom: V2 } }],
    [HIGHLIGHTS]: [],
  };
  const idItems = [{ id: 'i1', version: 3, metadata: { featureVersion: V1 } }];
  const plan = planVersionIdMigration([V1, V2], idCollections, idItems);
  assert.equal(plan.refs, 0);
  assert.deepEqual(plan.featurePatches, []);
  assert.deepEqual(plan.cellPatches, []);
  assert.deepEqual(plan.itemPatches, []);
});

test('an unknown reference string is left in place and does not fail validity', () => {
  // A stray label nobody declared (e.g. a typo) is not in the map, so it is not
  // remapped — and because it is never turned into a patch, the plan stays valid.
  const coll = {
    [FEATURES]: [{ id: 'calls', data: { name: 'Anrufe', version: 'ghost' } }],
    [CELLS]: [],
    [HIGHLIGHTS]: [],
  };
  const plan = planVersionIdMigration(LABELS, coll, []);
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.featurePatches, []); // 'ghost' untouched
});

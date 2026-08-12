// Version identity (issue #110): a version is a stable id plus a renamable label.
// These tests pin the property the whole change exists for — renaming a version
// touches only `versionLabels`, so nothing that references the id by string
// (featureVersion, feature.version, valueVersions, *ByVersion keys) is disturbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { versionConfigFromEntries, versionLabel } from './pricing.ts';
import {
  productRoadmapRef,
  versionLabelsFromConfig,
  versionsFromConfig,
} from './plugin.ts';
import { currentPricing, pricingFromCollections } from './compose.ts';
import { PRICING_COLLECTIONS } from './manifest.ts';

const { features: FEATURES } = PRICING_COLLECTIONS;

test('versionLabel resolves id → label, falling back to the id', () => {
  const labels = { '1-0': 'MVP', '2-0': '2.0' };
  assert.equal(versionLabel(labels, '1-0'), 'MVP');
  assert.equal(versionLabel(labels, '2-0'), '2.0');
  assert.equal(versionLabel(labels, '3-0'), '3-0'); // unlabelled → id
  assert.equal(versionLabel(undefined, '1-0'), '1-0'); // no map → id
  assert.equal(versionLabel({ '1-0': '' }, '1-0'), '1-0'); // blank label → id
});

test('versionConfigFromEntries mints slugs for new versions and keeps given ids', () => {
  const { versions, versionLabels } = versionConfigFromEntries([
    { label: '1.0' },
    { label: '2.0' },
    { label: 'MVP', id: 'kept' },
  ]);
  assert.deepEqual(versions, ['1-0', '2-0', 'kept']);
  assert.deepEqual(versionLabels, { '1-0': '1.0', '2-0': '2.0', kept: 'MVP' });
});

test('versionConfigFromEntries uniquifies colliding slugs', () => {
  const { versions } = versionConfigFromEntries([{ label: 'Beta' }, { label: 'Beta' }]);
  assert.deepEqual(versions, ['beta', 'beta-2']);
});

test('a rename is the same id with a new label — ids stay put', () => {
  const before = versionConfigFromEntries([{ label: '1.0' }, { label: '2.0' }]);
  // Rename "1.0" → "MVP" by feeding its id back with a new label.
  const after = versionConfigFromEntries([
    { label: 'MVP', id: before.versions[0] },
    { label: '2.0', id: before.versions[1] },
  ]);
  assert.deepEqual(after.versions, before.versions); // ids unchanged → no reference breaks
  assert.equal(after.versionLabels[before.versions[0]], 'MVP');
});

test('config helpers round-trip through productRoadmapRef', () => {
  const ref = productRoadmapRef(['1-0'], { '1-0': 'MVP' });
  assert.deepEqual(ref.config, { versions: ['1-0'], versionLabels: { '1-0': 'MVP' } });
  assert.deepEqual(versionsFromConfig(ref.config), ['1-0']);
  assert.deepEqual(versionLabelsFromConfig(ref.config), { '1-0': 'MVP' });
  // Empty labels are omitted, so a freshly-seeded ref carries versions only.
  assert.deepEqual(productRoadmapRef(['1-0']).config, { versions: ['1-0'] });
});

test('compose threads only declared versions labels into the model', () => {
  const pricing = pricingFromCollections(
    { [FEATURES]: [{ id: 'calls', data: { name: 'Anrufe', version: '1-0' } }] },
    ['1-0', '2-0'],
    { '1-0': 'MVP', '2-0': '2.0', 'gone': 'stale' }, // 'gone' is not a declared version
  );
  assert.deepEqual(pricing.versions, ['1-0', '2-0']);
  assert.deepEqual(pricing.versionLabels, { '1-0': 'MVP', '2-0': '2.0' }); // 'gone' dropped
});

test('currentPricing reads versions + labels off the plugin config', () => {
  const file = {
    plugins: [productRoadmapRef(['1-0'], { '1-0': 'MVP' })],
    pluginData: {
      'dev.zeitlines.product-roadmap': {
        [FEATURES]: [{ id: 'calls', data: { name: 'Anrufe', version: '1-0' } }],
      },
    },
  };
  const pricing = currentPricing(file);
  assert.deepEqual(pricing.versions, ['1-0']);
  assert.deepEqual(pricing.versionLabels, { '1-0': 'MVP' });
  assert.equal(pricing.features[0].version, '1-0');
});

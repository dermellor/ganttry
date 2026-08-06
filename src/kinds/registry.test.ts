import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeFieldDefs, pluginFieldDefs } from './registry';
import { PRODUCT_ROADMAP_PLUGIN } from '../plugins';
import {
  PRICING_FEATURE_META_KEY,
  PRICING_ITEM_VERSION_META_KEY,
  PRICING_TIER_META_KEY,
  type CustomFieldDef,
  type Pricing,
  type TimelineFile,
} from '../types';

// pluginFieldDefs is the seam the generic custom-field machinery reads plugin
// fields through: each enabled kind's `fields(file)`, stamped with the kind's
// label so the item form can section them under a plugin heading. These tests
// pin the gating (plugin enabled? data present?), the stamping and the layout the
// plugin declares — the parts a second plugin would rely on — without the DOM.

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

const pricing = (over: Partial<Pricing> = {}): Pricing => ({
  features: [{ id: 'f-1', name: 'Anrufannahme' }],
  tiers: [{ id: 'free', name: 'Free', price: '0 €', values: {} }],
  versions: ['1.0', '2.0'],
  ...over,
});

const enabled = (over: Partial<Pricing> = {}): TimelineFile =>
  file({ plugins: [{ id: PRODUCT_ROADMAP_PLUGIN }], pricing: pricing(over) });

test('no plugin enabled ⇒ no contributed fields', () => {
  assert.deepEqual(pluginFieldDefs(file({ pricing: pricing() })), []);
  assert.deepEqual(pluginFieldDefs(file()), []);
  assert.deepEqual(pluginFieldDefs(null), []);
});

test('product-roadmap contributes its fields under the "Produkt" group', () => {
  const defs = pluginFieldDefs(enabled());
  // The array order IS the render order and `width` decides who shares a row:
  // the two compact pickers pair up, the chip field spans both columns below.
  assert.deepEqual(
    defs.map((d) => [d.key, d.label, d.type, d.group, d.width]),
    [
      [PRICING_ITEM_VERSION_META_KEY, 'Version', 'select', 'Produkt', undefined],
      [PRICING_TIER_META_KEY, 'Tier', 'multi-select', 'Produkt', undefined],
      [PRICING_FEATURE_META_KEY, 'Features', 'multi-select', 'Produkt', 'full'],
    ],
  );
  // Options are derived from the pricing model, not hand-maintained. Tier values
  // are ids (like features), so renaming a tier doesn't orphan stored values.
  assert.deepEqual(defs[0].options, [{ value: '1.0' }, { value: '2.0' }]);
  assert.deepEqual(
    defs[1].options?.map((o) => [o.value, o.label]),
    [['free', 'Free']],
  );
  assert.deepEqual(defs[2].options, [{ value: 'f-1', label: 'Anrufannahme' }]);
});

test('tier colours are derived from the id, so they survive renames and reordering', () => {
  const one = pluginFieldDefs(
    enabled({ tiers: [{ id: 'scale', name: 'Scale', price: 'x', values: {} }] }),
  );
  const renamed = pluginFieldDefs(
    enabled({
      tiers: [
        { id: 'free', name: 'Free', price: '0', values: {} },
        { id: 'scale', name: 'Scale Plus', price: 'y', values: {} },
      ],
    }),
  );
  const colourOf = (defs: CustomFieldDef[], id: string) =>
    defs.find((d) => d.key === PRICING_TIER_META_KEY)?.options?.find((o) => o.value === id)?.color;
  assert.ok(colourOf(one, 'scale'));
  assert.equal(colourOf(one, 'scale'), colourOf(renamed, 'scale'));
  assert.notEqual(colourOf(renamed, 'free'), colourOf(renamed, 'scale'));
});

test('a field is only offered once its data exists', () => {
  assert.deepEqual(
    pluginFieldDefs(enabled({ features: [], tiers: [] })).map((d) => d.key),
    [PRICING_ITEM_VERSION_META_KEY],
  );
  assert.deepEqual(
    pluginFieldDefs(enabled({ tiers: [], versions: [] })).map((d) => d.key),
    [PRICING_FEATURE_META_KEY],
  );

  // Plugin enabled but no pricing model at all: nothing to derive from. The
  // *view* gate (`matches`) additionally demands features/tiers — fields are
  // independent of it, so an item form can offer the version field before any
  // tier exists.
  assert.deepEqual(pluginFieldDefs(file({ plugins: [{ id: PRODUCT_ROADMAP_PLUGIN }] })), []);
});

test('a contributed field supersedes a stored definition on the same key', () => {
  const storedTier: CustomFieldDef = {
    key: PRICING_TIER_META_KEY,
    label: 'Tier',
    type: 'multi-select',
    options: [{ value: 'Free', color: '#64748B' }],
  };
  const own: CustomFieldDef = { key: 'risk', label: 'Risiko', type: 'text' };
  const merged = mergeFieldDefs([own, storedTier], pluginFieldDefs(enabled()));

  // One def per key, the derived one — a second control on the same key would
  // write the same metadata and share its multi-select state bucket.
  assert.equal(merged.filter((d) => d.key === PRICING_TIER_META_KEY).length, 1);
  assert.equal(merged.find((d) => d.key === PRICING_TIER_META_KEY)?.group, 'Produkt');
  // Unrelated stored fields keep their place ahead of the contributed ones.
  assert.equal(merged[0], own);
});

// Round-trip test for the pricing normalization (issue #21): a Pricing model
// mapped to normalized rows (the same way replacePricingRows / the 0009 backfill
// build them) and reassembled via rowsToPricing must reproduce the original,
// modulo the documented normalization rules:
//   - server-managed rowVersion is not part of the content,
//   - falsy / empty matrix cells are not stored (they render as "–" anyway),
//   - a value cell referencing a non-existent feature (dangling) is dropped.
// This proves the storage split is lossless for everything that matters.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rowsToPricing,
  featureToRow,
  tierToRow,
  highlightToRow,
  stripRowVersions,
  reorderIds,
} from '../../../scripts/db/timeline-repo.ts';
import type { Pricing } from '../../types';

const ID = 'acme/test';

// Build the normalized rows exactly as replacePricingRows / the backfill do,
// then reassemble. Returns the round-tripped Pricing.
function roundTrip(pricing: Pricing): Pricing {
  const featureRows = pricing.features.map((f, i) => featureToRow(ID, f, i));
  const tierRows = pricing.tiers.map((t, i) => tierToRow(ID, t, i));
  const highlightRows = (pricing.highlights ?? []).map((h, i) => highlightToRow(ID, h, i));

  const featureIds = new Set(pricing.features.map((f) => f.id));
  const valueRows: { tier_id: string; feature_id: string; value: string | boolean; available_from?: string | null }[] =
    [];
  for (const t of pricing.tiers) {
    const vv = t.valueVersions ?? {};
    for (const [featureId, value] of Object.entries(t.values ?? {})) {
      if (value === false || value == null || value === '') continue; // falsy → not stored
      if (!featureIds.has(featureId)) continue; // dangling → dropped
      valueRows.push({ tier_id: t.id, feature_id: featureId, value, available_from: vv[featureId] ?? null });
    }
  }

  return rowsToPricing(featureRows, tierRows, valueRows, highlightRows, pricing.versions ?? []);
}

// Normalize a Pricing the same way storage does, so the "expected" side matches
// what a lossless round-trip can reproduce: drop falsy/dangling value cells.
function normalizeExpected(pricing: Pricing): Pricing {
  const featureIds = new Set(pricing.features.map((f) => f.id));
  const clone: Pricing = JSON.parse(JSON.stringify(pricing));
  for (const t of clone.tiers) {
    const kept: Record<string, string | boolean> = {};
    const keptVersions: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.values ?? {})) {
      if (v === false || v == null || v === '') continue;
      if (!featureIds.has(k)) continue;
      kept[k] = v;
      // valueVersions only survive for cells that are actually stored.
      const af = t.valueVersions?.[k];
      if (af != null) keptVersions[k] = af;
    }
    t.values = kept;
    if (Object.keys(keptVersions).length) t.valueVersions = keptVersions;
    else delete t.valueVersions;
  }
  return clone;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as any)[k]);
    return out;
  }
  return v;
}
const canon = (v: unknown) => JSON.stringify(sortDeep(v));

const FIXTURE: Pricing = {
  versions: ['1.0', '2.0', '3.0'],
  features: [
    { id: 'minutes', name: 'Inkludierte Minuten', group: 'Nutzung' }, // pre-existing (no version)
    { id: 'crm', name: 'CRM', group: 'Integrationen', version: '2.0', description: 'CRM-Anbindung' },
    {
      id: 'termine',
      name: 'Termine vereinbaren',
      version: '1.0',
      nameByVersion: { '3.0': 'Termine vereinbaren und ändern' },
      // Additive version-scoped description notes (PR #22) must survive the round-trip too.
      descriptionByVersion: { '2.0': 'Jetzt mit Slot-Filling.', '3.0': 'Auch Absagen.' },
    },
  ],
  tiers: [
    { id: 'free', name: 'Free', price: '0 €', values: { minutes: '500', crm: false } }, // false → dropped
    {
      id: 'scale',
      name: 'Scale',
      price: 'ab 199 €',
      tagline: 'Micro',
      useCase: 'Wachstum',
      targetGroup: 'KMU',
      values: { minutes: '3.000', crm: true, termine: true, ghost: true }, // ghost = dangling → dropped
      // Per-cell availability gate: CRM is in Scale only from v3 (the feature
      // itself is v2). ghost's gate must die with its dangling cell.
      valueVersions: { crm: '3.0', ghost: '2.0' },
    },
  ],
  highlights: [
    { id: 'h-min', label: 'Freiminuten', section: 'Inkludiert', featureIds: ['minutes'] },
    {
      id: 'h-crm',
      label: 'CRM',
      featureIds: ['crm', 'termine'],
      labelByVersion: { '3.0': 'CRM & Termine' },
    },
  ],
};

test('pricing round-trip: rows → model reproduces the content', () => {
  const out = roundTrip(FIXTURE);
  stripRowVersions(out); // rowVersion is server-managed, never present after a pure round-trip anyway
  assert.equal(canon(out), canon(normalizeExpected(FIXTURE)));
});

test('pricing round-trip: falsy and dangling matrix cells are not resurrected', () => {
  const out = roundTrip(FIXTURE);
  const free = out.tiers.find((t) => t.id === 'free')!;
  const scale = out.tiers.find((t) => t.id === 'scale')!;
  assert.equal('crm' in free.values, false, 'false cell dropped');
  assert.equal('ghost' in scale.values, false, 'dangling cell dropped');
  assert.equal(scale.values.crm, true);
  assert.equal(scale.values.minutes, '3.000');
});

test('pricing round-trip: pre-existing feature keeps no version; versioned keeps its label', () => {
  const out = roundTrip(FIXTURE);
  assert.equal(out.features.find((f) => f.id === 'minutes')!.version, undefined);
  assert.equal(out.features.find((f) => f.id === 'crm')!.version, '2.0');
  assert.deepEqual(out.features.find((f) => f.id === 'termine')!.nameByVersion, {
    '3.0': 'Termine vereinbaren und ändern',
  });
  assert.deepEqual(out.features.find((f) => f.id === 'termine')!.descriptionByVersion, {
    '2.0': 'Jetzt mit Slot-Filling.',
    '3.0': 'Auch Absagen.',
  });
});

test('pricing round-trip: per-cell valueVersions survive; dangling/false gates are dropped', () => {
  const out = roundTrip(FIXTURE);
  const scale = out.tiers.find((t) => t.id === 'scale')!;
  // The stored CRM cell keeps its "ab 3.0" gate.
  assert.deepEqual(scale.valueVersions, { crm: '3.0' });
  // The dangling ghost cell (and thus its gate) is gone.
  assert.equal('ghost' in (scale.valueVersions ?? {}), false);
  // A tier with no gated cells has no valueVersions map at all.
  const free = out.tiers.find((t) => t.id === 'free')!;
  assert.equal(free.valueVersions, undefined);
});

test('pricing round-trip: highlights and versions survive', () => {
  const out = roundTrip(FIXTURE);
  assert.deepEqual(out.versions, ['1.0', '2.0', '3.0']);
  assert.equal(out.highlights?.length, 2);
  assert.deepEqual(out.highlights?.find((h) => h.id === 'h-crm')!.labelByVersion, { '3.0': 'CRM & Termine' });
});

test('reorderIds: move after an anchor', () => {
  assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], 'a', { after: 'c' }), ['b', 'c', 'a', 'd']);
});

test('reorderIds: move before an anchor', () => {
  assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], 'd', { before: 'b' }), ['a', 'd', 'b', 'c']);
});

test('reorderIds: after wins when both anchors are given', () => {
  assert.deepEqual(reorderIds(['a', 'b', 'c'], 'a', { after: 'b', before: 'c' }), ['b', 'a', 'c']);
});

test('reorderIds: moving next to its current neighbour is a no-op-ish stable result', () => {
  // "a after b" when order is already a,b,c → a lands right after b.
  assert.deepEqual(reorderIds(['a', 'b', 'c'], 'a', { after: 'b' }), ['b', 'a', 'c']);
});

test('reorderIds: throws on missing move id, missing anchor, or self-anchor', () => {
  assert.throws(() => reorderIds(['a', 'b'], 'x', { after: 'a' }));
  assert.throws(() => reorderIds(['a', 'b'], 'a', { after: 'x' }));
  assert.throws(() => reorderIds(['a', 'b'], 'a', {}));
  assert.throws(() => reorderIds(['a', 'b'], 'a', { after: 'a' }));
});

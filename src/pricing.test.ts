import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingToMarkdown, featureVisibleForVersion, type PricingDoc } from './pricing';

const doc: PricingDoc = {
  timelineId: 'acme/timeline-example-timeline-v1',
  name: 'Example Timeline',
  type: 'product',
  pricing: {
    features: [
      { id: 'minutes', name: 'Inkludierte Minuten', group: 'Nutzung & Volumen' },
      { id: 'voices', name: 'Natürliche Stimmen', group: 'Funktionen' },
      { id: 'outbound', name: 'Outbound-Anrufe', group: 'Funktionen' },
      { id: 'am', name: 'Account Manager' }, // ungrouped
    ],
    tiers: [
      { id: 'medium', name: 'Medium', price: '74,95 €/Monat', values: { minutes: '300', voices: true } },
      {
        id: 'ent',
        name: 'Enterprise',
        price: 'ab 449,95 €',
        values: { minutes: 'ab 2.500', voices: true, outbound: true, am: true },
      },
    ],
  },
};

test('renders frontmatter with generated marker + timeline id', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  assert.match(md, /^---\ngenerated: true\nsource: timelines\ntimeline: Acme\/timeline-example-timeline-v1\nupdated: 2026-07-15\n---/);
  assert.match(md, /Automatisch generiert/);
});

test('matrix header lists tiers and a price row', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  assert.match(md, /\| Feature \| Medium \| Enterprise \|/);
  assert.match(md, /\| \*\*Preis\*\* \| 74,95 €\/Monat \| ab 449,95 € \|/);
});

test('per-tier string values render verbatim in the cell', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  assert.match(md, /\| Inkludierte Minuten \| 300 \| ab 2\.500 \|/);
});

test('boolean values render ✓ (true) / blank (false or absent)', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  assert.match(md, /\| Natürliche Stimmen \| ✓ \| ✓ \|/);
  // outbound only in Enterprise; Medium has no value → blank.
  assert.match(md, /\| Outbound-Anrufe \|  \| ✓ \|/);
  assert.match(md, /\| Account Manager \|  \| ✓ \|/);
});

test('features grouped by group label, ungrouped last, group header row present', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  const iVol = md.indexOf('**Nutzung & Volumen**');
  const iFunk = md.indexOf('**Funktionen**');
  const iAm = md.indexOf('Account Manager');
  assert.ok(iVol > -1 && iFunk > iVol, 'group headers in first-seen order');
  assert.ok(iAm > iFunk, 'ungrouped feature rendered last');
});

test('machine-readable JSON block round-trips the model', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  const m = md.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, 'json block present');
  assert.deepEqual(JSON.parse(m![1]), doc.pricing);
});

test('pipes in names and values are escaped inside cells', () => {
  const md = pricingToMarkdown(
    {
      timelineId: 't',
      pricing: {
        features: [{ id: 'x', name: 'A | B' }],
        tiers: [{ id: 't1', name: 'T', price: '1 €', values: { x: 'ja | nein' } }],
      },
    },
    { updated: '2026-07-15' },
  );
  assert.match(md, /A \\\| B/);
  assert.match(md, /ja \\\| nein/);
});

test('with versions: adds an "Ab Version" column carrying per-feature version', () => {
  const md = pricingToMarkdown(
    {
      timelineId: 't',
      pricing: {
        versions: ['1.0', '2.0'],
        features: [
          { id: 'a', name: 'Basis', version: '1.0' },
          { id: 'b', name: 'Neu', version: '2.0' },
          { id: 'c', name: 'Immer' }, // no version
        ],
        tiers: [{ id: 't1', name: 'T', price: '1 €', values: { a: true, b: true, c: true } }],
      },
    },
    { updated: '2026-07-15' },
  );
  assert.match(md, /\| Feature \| T \| Ab Version \|/);
  assert.match(md, /\| Basis \| ✓ \| 1\.0 \|/);
  assert.match(md, /\| Neu \| ✓ \| 2\.0 \|/);
  assert.match(md, /\| Immer \| ✓ \|  \|/); // no version → blank cell
});

test('without versions: no "Ab Version" column', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  assert.doesNotMatch(md, /Ab Version/);
});

test('featureVisibleForVersion: "Alle" (null) shows everything', () => {
  const V = ['1.0', '2.0', '3.0'];
  assert.equal(featureVisibleForVersion({ id: 'a', name: 'A', version: '3.0' }, V, null), true);
});

test('featureVisibleForVersion: cumulative — selected shows its version and earlier', () => {
  const V = ['1.0', '2.0', '3.0'];
  const v1 = { id: 'a', name: 'A', version: '1.0' };
  const v2 = { id: 'b', name: 'B', version: '2.0' };
  const v3 = { id: 'c', name: 'C', version: '3.0' };
  // selecting 2.0 → 1.0 and 2.0 visible, 3.0 hidden
  assert.equal(featureVisibleForVersion(v1, V, '2.0'), true);
  assert.equal(featureVisibleForVersion(v2, V, '2.0'), true);
  assert.equal(featureVisibleForVersion(v3, V, '2.0'), false);
});

test('featureVisibleForVersion: feature without version is always visible', () => {
  const V = ['1.0', '2.0'];
  assert.equal(featureVisibleForVersion({ id: 'x', name: 'X' }, V, '1.0'), true);
});

test('featureVisibleForVersion: unknown version never hides', () => {
  const V = ['1.0', '2.0'];
  assert.equal(featureVisibleForVersion({ id: 'x', name: 'X', version: '9.9' }, V, '1.0'), true);
});

test('empty pricing renders a placeholder, no matrix', () => {
  const md = pricingToMarkdown(
    { timelineId: 't', pricing: { features: [], tiers: [] } },
    { updated: '2026-07-15' },
  );
  assert.match(md, /Kein Preismodell/);
  assert.doesNotMatch(md, /Feature-Matrix/);
});

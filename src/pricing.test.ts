import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingToMarkdown, type PricingDoc } from './pricing';

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

test('empty pricing renders a placeholder, no matrix', () => {
  const md = pricingToMarkdown(
    { timelineId: 't', pricing: { features: [], tiers: [] } },
    { updated: '2026-07-15' },
  );
  assert.match(md, /Kein Preismodell/);
  assert.doesNotMatch(md, /Feature-Matrix/);
});

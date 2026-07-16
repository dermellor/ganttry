import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pricingToMarkdown,
  featureVisibleForVersion,
  referenceVersion,
  isNewFeature,
  isModifiedFeature,
  needsWorkWarning,
  itemsForFeature,
  aggregateWorkState,
  resolveHighlight,
  resolveVersionedText,
  resolveFeatureName,
  resolveHighlightLabel,
  type PricingDoc,
} from './pricing';
import type { PricingFeature, PricingTier } from './types';
import type { TimelineFileItem } from './types';

const doc: PricingDoc = {
  timelineId: 'acme/example-roadmap',
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
  assert.match(md, /^---\ngenerated: true\nsource: timelines\ntimeline: Acme\/example-roadmap\nupdated: 2026-07-15\n---/);
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

test('no machine-readable JSON block — the .md is a human-readable mirror only', () => {
  const md = pricingToMarkdown(doc, { updated: '2026-07-15' });
  assert.doesNotMatch(md, /```json/);
  assert.doesNotMatch(md, /## Rohdaten/);
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

const workItems: TimelineFileItem[] = [
  { id: 'a', content: 'A', status: 'Doing', metadata: { featureIds: ['crm'], featureVersion: '2.0' } },
  { id: 'b', content: 'B', status: 'Open', metadata: { featureIds: ['crm'], featureVersion: '2.0' } },
  { id: 'c', content: 'C', status: 'Done', metadata: { featureIds: ['voice'], featureVersion: '3.0' } },
  { id: 'd', content: 'D', status: 'Done', metadata: { featureIds: ['crm'], featureVersion: '1.0' } },
];

test('itemsForFeature: filters by feature id and exact version (or all when null)', () => {
  assert.deepEqual(itemsForFeature('crm', workItems, '2.0').map((i) => i.id), ['a', 'b']);
  assert.deepEqual(itemsForFeature('crm', workItems, null).map((i) => i.id), ['a', 'b', 'd']);
  assert.deepEqual(itemsForFeature('voice', workItems, '2.0').map((i) => i.id), []);
});

const mk = (id: string, status: 'Open' | 'Doing' | 'Done'): TimelineFileItem => ({ id, content: id, status });

test('aggregateWorkState: majority wins; empty → none', () => {
  assert.equal(aggregateWorkState([mk('a', 'Open'), mk('b', 'Open'), mk('c', 'Doing')]), 'open');
  assert.equal(aggregateWorkState([mk('a', 'Done'), mk('b', 'Done'), mk('c', 'Doing')]), 'done');
  assert.equal(aggregateWorkState([mk('a', 'Doing'), mk('b', 'Doing'), mk('c', 'Open')]), 'doing');
  assert.equal(aggregateWorkState([mk('x', 'Open')]), 'open');
  assert.equal(aggregateWorkState([]), 'none');
});

test('aggregateWorkState: ties broken Doing > Open > Done', () => {
  assert.equal(aggregateWorkState([mk('a', 'Doing'), mk('b', 'Open')]), 'doing'); // 1:1 → Doing
  assert.equal(aggregateWorkState([mk('a', 'Open'), mk('b', 'Done')]), 'open'); // 1:1 → Open
  assert.equal(aggregateWorkState([mk('a', 'Doing'), mk('b', 'Done')]), 'doing'); // 1:1 → Doing
});

const hFeatures: PricingFeature[] = [
  { id: 'min', name: 'Inkludierte Minuten', version: '1.0' },
  { id: 'crm', name: 'CRM', version: '2.0' },
  { id: 'ticket', name: 'Ticketsysteme', version: '2.0' },
];
const tierFree: PricingTier = { id: 'free', name: 'Free', price: '0 €', values: { min: '500' } };
const tierScale: PricingTier = { id: 'scale', name: 'Scale', price: '199 €', values: { min: '3.000', crm: true, ticket: true } };

test('resolveHighlight: value-feature → value string; boolean → included, no value', () => {
  const hMin = { id: 'h1', label: 'Freiminuten', featureIds: ['min'] };
  const hInteg = { id: 'h2', label: 'Integrationen', featureIds: ['crm', 'ticket'] };
  assert.deepEqual(resolveHighlight(hMin, tierScale, hFeatures, [], null), {
    included: true,
    value: '3.000',
    isNew: false,
    introducedVersion: '1.0',
  });
  assert.deepEqual(resolveHighlight(hInteg, tierScale, hFeatures, [], null), {
    included: true,
    value: '',
    isNew: false,
    introducedVersion: '2.0',
  });
});

test('resolveHighlight: not included when the tier has none of the features', () => {
  const hInteg = { id: 'h2', label: 'Integrationen', featureIds: ['crm', 'ticket'] };
  assert.deepEqual(resolveHighlight(hInteg, tierFree, hFeatures, [], null), {
    included: false,
    value: '',
    isNew: false,
    introducedVersion: undefined,
  });
});

test('resolveHighlight: version filter drops features beyond the selected version', () => {
  const hInteg = { id: 'h2', label: 'Integrationen', featureIds: ['crm', 'ticket'] };
  // At version 1.0, the 2.0 features are ignored → not included on Scale.
  assert.deepEqual(resolveHighlight(hInteg, tierScale, hFeatures, ['1.0', '2.0', '3.0'], '1.0'), {
    included: false,
    value: '',
    isNew: false,
    introducedVersion: undefined,
  });
});

test('resolveHighlight: isNew only when the switcher is pinned to the exact feature version', () => {
  const hInteg = { id: 'h2', label: 'Integrationen', featureIds: ['crm', 'ticket'] };
  const V = ['1.0', '2.0'];
  // "Alle" (null) never marks anything New, even though crm/ticket are the newest version.
  assert.deepEqual(resolveHighlight(hInteg, tierScale, hFeatures, V, null), {
    included: true,
    value: '',
    isNew: false,
    introducedVersion: '2.0',
  });
  // Pinning the switcher to 2.0 (their exact version) → New.
  assert.deepEqual(resolveHighlight(hInteg, tierScale, hFeatures, V, '2.0'), {
    included: true,
    value: '',
    isNew: true,
    introducedVersion: '2.0',
  });
  // Pinning the switcher to 1.0 hides the 2.0 features entirely → not included, not new.
  assert.deepEqual(resolveHighlight(hInteg, tierScale, hFeatures, V, '1.0'), {
    included: false,
    value: '',
    isNew: false,
    introducedVersion: undefined,
  });
});

test('resolveHighlight: introducedVersion = earliest contributing version; pre-existing → undefined', () => {
  const V = ['1.0', '2.0', '3.0'];
  const feats: PricingFeature[] = [
    { id: 'old', name: 'Alt' }, // pre-existing, no version
    { id: 'v2', name: 'Zwei', version: '2.0' },
    { id: 'v3', name: 'Drei', version: '3.0' },
  ];
  const tier: PricingTier = { id: 't', name: 'T', price: '0', values: { old: true, v2: true, v3: true } };
  // Bundle of 2.0 + 3.0 features → earliest (2.0) wins.
  assert.equal(
    resolveHighlight({ id: 'h', label: 'H', featureIds: ['v3', 'v2'] }, tier, feats, V, null).introducedVersion,
    '2.0',
  );
  // Any pre-existing feature in the bundle → available from the start, no chip.
  assert.equal(
    resolveHighlight({ id: 'h', label: 'H', featureIds: ['v2', 'old'] }, tier, feats, V, null).introducedVersion,
    undefined,
  );
});

test('referenceVersion: selected version wins; "Alle" falls back to the newest declared version', () => {
  const V = ['1.0', '2.0', '3.0'];
  assert.equal(referenceVersion(V, '2.0'), '2.0');
  assert.equal(referenceVersion(V, null), '3.0');
  assert.equal(referenceVersion([], null), undefined);
});

test('isNewFeature: true only when the switcher is pinned to the exact feature version', () => {
  const V = ['1.0', '2.0'];
  assert.equal(isNewFeature({ id: 'a', name: 'A', version: '2.0' }, V, null), false, '"Alle" never shows New');
  assert.equal(isNewFeature({ id: 'a', name: 'A', version: '1.0' }, V, null), false, '"Alle" never shows New');
  assert.equal(isNewFeature({ id: 'a', name: 'A', version: '2.0' }, V, '2.0'), true, 'exact selected match');
  assert.equal(isNewFeature({ id: 'a', name: 'A', version: '2.0' }, V, '1.0'), false, 'pinned to an earlier version');
  assert.equal(isNewFeature({ id: 'a', name: 'A' }, V, '1.0'), false, 'no version at all');
});

test('isNewFeature: the baseline (first) version never badges, even on an exact match', () => {
  const V = ['1.0', '2.0', '3.0'];
  assert.equal(
    isNewFeature({ id: 'a', name: 'A', version: '1.0' }, V, '1.0'),
    false,
    'v1 is the baseline — nothing is "new" relative to it',
  );
  assert.equal(isNewFeature({ id: 'a', name: 'A', version: '2.0' }, V, '2.0'), true, '2.0 is a real increment');
});

test('isModifiedFeature: feature from an earlier version, work targeting the pinned version', () => {
  const V = ['1.0', '2.0', '3.0'];
  const f = { id: 'crm', name: 'CRM', version: '1.0' };
  const work2: TimelineFileItem[] = [
    { id: 'x', content: 'X', status: 'Doing', metadata: { featureIds: ['crm'], featureVersion: '2.0' } },
  ];
  assert.equal(isModifiedFeature(f, work2, V, '2.0'), true, '1.0 feature + work for 2.0 → modified');
  assert.equal(isModifiedFeature(f, work2, V, '1.0'), false, 'introduced in 1.0 → not modified at 1.0');
  assert.equal(isModifiedFeature(f, work2, V, null), false, '"Alle" never badges');
  assert.equal(isModifiedFeature(f, [], V, '2.0'), false, 'no work → not modified');
  assert.equal(
    isModifiedFeature({ id: 'crm', name: 'CRM', version: '2.0' }, work2, V, '2.0'),
    false,
    'new-in-2.0 is "New", not "Modified"',
  );
  const work3: TimelineFileItem[] = [
    { id: 'y', content: 'Y', status: 'Doing', metadata: { featureIds: ['crm'], featureVersion: '3.0' } },
  ];
  assert.equal(isModifiedFeature(f, work3, V, '2.0'), false, 'work targets a different version → not modified for 2.0');
});

test('isModifiedFeature: pre-existing feature (no version) is modifiable even at the baseline', () => {
  const V = ['1.0', '2.0', '3.0'];
  const pre = { id: 'faq', name: 'FAQ-Editor' }; // no version → existed before 1.0
  const work1: TimelineFileItem[] = [
    { id: 'p1', content: 'P1', status: 'Open', metadata: { featureIds: ['faq'], featureVersion: '1.0' } },
  ];
  assert.equal(isModifiedFeature(pre, work1, V, '1.0'), true, 'pre-existing + work for 1.0 → modified at baseline');
  assert.equal(isModifiedFeature(pre, work1, V, '2.0'), false, 'work is for 1.0, not the pinned 2.0');
  assert.equal(isModifiedFeature(pre, work1, V, null), false, '"Alle" never badges');
  const work2: TimelineFileItem[] = [
    { id: 'p2', content: 'P2', status: 'Doing', metadata: { featureIds: ['faq'], featureVersion: '2.0' } },
  ];
  assert.equal(isModifiedFeature(pre, work2, V, '2.0'), true, 'pre-existing + work for 2.0 → modified at 2.0');
});

test('needsWorkWarning: New feature at the pinned version with no linked work', () => {
  const V = ['1.0', '2.0'];
  const f = { id: 'crm', name: 'CRM', version: '2.0' };
  assert.equal(needsWorkWarning(f, [], V, '2.0'), true, 'new at 2.0, no work at all → warn');
  const workOther: TimelineFileItem[] = [
    { id: 'x', content: 'X', status: 'Doing', metadata: { featureIds: ['crm'], featureVersion: '1.0' } },
  ];
  assert.equal(needsWorkWarning(f, workOther, V, '2.0'), true, 'work exists but not for the pinned version → warn');
  const work2: TimelineFileItem[] = [
    { id: 'y', content: 'Y', status: 'Doing', metadata: { featureIds: ['crm'], featureVersion: '2.0' } },
  ];
  assert.equal(needsWorkWarning(f, work2, V, '2.0'), false, 'work targets the pinned version → no warning');
  assert.equal(needsWorkWarning(f, [], V, '1.0'), false, 'not new at 1.0 → no warning');
  assert.equal(needsWorkWarning(f, [], V, null), false, '"Alle" never warns');
  const pre = { id: 'faq', name: 'FAQ-Editor' }; // pre-existing, never "New"
  assert.equal(needsWorkWarning(pre, [], V, '2.0'), false, 'pre-existing feature is never New, so never warns');
});

test('resolveVersionedText: no overrides → base text unchanged', () => {
  const V = ['1.0', '2.0', '3.0'];
  assert.equal(resolveVersionedText('Termine vereinbaren', undefined, V, '1.0'), 'Termine vereinbaren');
  assert.equal(resolveVersionedText('Termine vereinbaren', {}, V, null), 'Termine vereinbaren');
});

test('resolveVersionedText: cumulative — override applies from its version onward', () => {
  const V = ['1.0', '2.0', '3.0'];
  const overrides = { '3.0': 'Termine vereinbaren und ändern' };
  assert.equal(resolveVersionedText('Termine vereinbaren', overrides, V, '1.0'), 'Termine vereinbaren');
  assert.equal(resolveVersionedText('Termine vereinbaren', overrides, V, '2.0'), 'Termine vereinbaren');
  assert.equal(resolveVersionedText('Termine vereinbaren', overrides, V, '3.0'), 'Termine vereinbaren und ändern');
});

test('resolveVersionedText: "Alle" (null) resolves against the newest declared version', () => {
  const V = ['1.0', '2.0', '3.0'];
  const overrides = { '3.0': 'Termine vereinbaren und ändern' };
  assert.equal(resolveVersionedText('Termine vereinbaren', overrides, V, null), 'Termine vereinbaren und ändern');
});

test('resolveVersionedText: later override wins when multiple thresholds are at/before selected', () => {
  const V = ['1.0', '2.0', '3.0'];
  const overrides = { '2.0': 'B', '3.0': 'C' };
  assert.equal(resolveVersionedText('A', overrides, V, '2.0'), 'B');
  assert.equal(resolveVersionedText('A', overrides, V, '3.0'), 'C');
});

test('resolveFeatureName / resolveHighlightLabel: delegate to resolveVersionedText', () => {
  const V = ['1.0', '2.0', '3.0'];
  const feature: PricingFeature = {
    id: 'skill-termine',
    name: 'Termine vereinbaren',
    nameByVersion: { '3.0': 'Termine vereinbaren und ändern' },
  };
  assert.equal(resolveFeatureName(feature, V, '2.0'), 'Termine vereinbaren');
  assert.equal(resolveFeatureName(feature, V, '3.0'), 'Termine vereinbaren und ändern');

  const highlight = {
    id: 'h-termine',
    label: 'Termine vereinbaren',
    featureIds: ['skill-termine'],
    labelByVersion: { '3.0': 'Termine vereinbaren und ändern' },
  };
  assert.equal(resolveHighlightLabel(highlight, V, '2.0'), 'Termine vereinbaren');
  assert.equal(resolveHighlightLabel(highlight, V, '3.0'), 'Termine vereinbaren und ändern');
});

test('pricingToMarkdown: feature row shows the resolved (fully-evolved) name', () => {
  const md = pricingToMarkdown(
    {
      timelineId: 't',
      pricing: {
        versions: ['1.0', '3.0'],
        features: [
          { id: 'a', name: 'Termine vereinbaren', nameByVersion: { '3.0': 'Termine vereinbaren und ändern' } },
        ],
        tiers: [{ id: 't1', name: 'T', price: '1 €', values: { a: true } }],
      },
    },
    { updated: '2026-07-15' },
  );
  assert.match(md, /\| Termine vereinbaren und ändern \| ✓ \|  \|/);
});

test('empty pricing renders a placeholder, no matrix', () => {
  const md = pricingToMarkdown(
    { timelineId: 't', pricing: { features: [], tiers: [] } },
    { updated: '2026-07-15' },
  );
  assert.match(md, /Kein Preismodell/);
  assert.doesNotMatch(md, /Feature-Matrix/);
});

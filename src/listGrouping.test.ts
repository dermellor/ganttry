import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSections,
  dimensionLabel,
  groupByOptions,
  toValues,
  type SectionContext,
} from './listGrouping';
import type { TimelineItem } from './buildItems';
import type { CustomFieldDef } from './types';

// The list view groups entries by a selectable dimension: the item's own group
// (default), its tags, or a custom field (e.g. "Tier"). computeSections is the
// pure core — these tests pin the bucketing, ordering, and the "Ohne …"
// fallback without needing the DOM or app state.

function item(id: string, start: string, extra: Partial<TimelineItem> = {}): TimelineItem {
  return { id, start, content: id, title: '', type: 'range', ...extra };
}

const GROUPS = [
  { id: '1-a', content: 'Alpha' },
  { id: '2-b', content: 'Beta' },
];

const TIER: CustomFieldDef = {
  key: 'tier',
  label: 'Tier',
  type: 'multi-select',
  options: [
    { value: 'Free' },
    { value: 'Starter' },
    { value: 'Scale' },
    { value: 'Enterprise' },
  ],
};

// Build a context whose metadata comes from an id→metadata map.
function ctx(meta: Record<string, Record<string, unknown>> = {}): SectionContext {
  return {
    groups: GROUPS,
    customFields: [TIER],
    metaOf: (id) => meta[id],
  };
}

test('toValues normalises scalars, arrays, trims and de-dupes', () => {
  assert.deepEqual(toValues('Free'), ['Free']);
  assert.deepEqual(toValues(['Free', 'Scale', 'Free']), ['Free', 'Scale']);
  assert.deepEqual(toValues([' Free ', '', null, 'Scale']), ['Free', 'Scale']);
  assert.deepEqual(toValues(undefined), []);
});

test('groupByOptions offers Tag only when something is tagged, plus custom fields', () => {
  const untagged = groupByOptions([item('a', '2026-01-01')], [TIER]);
  assert.deepEqual(untagged.map((o) => o.key), ['group', 'cf:tier']);

  const tagged = groupByOptions([item('a', '2026-01-01', { tags: ['X'] })], [TIER]);
  assert.deepEqual(tagged.map((o) => o.key), ['group', 'tag', 'cf:tier']);
  assert.equal(tagged.find((o) => o.key === 'cf:tier')?.label, 'Tier');
});

test('groupByOptions offers Status only when an item actually carries one', () => {
  const none = groupByOptions([item('a', '2026-01-01')], []);
  assert.deepEqual(none.map((o) => o.key), ['group']);

  const some = groupByOptions([item('a', '2026-01-01', { status: 'Doing' })], []);
  assert.deepEqual(some.map((o) => o.key), ['group', 'status']);
  assert.equal(some.find((o) => o.key === 'status')?.label, 'Status');
});

test('status dimension orders sections Open → Doing → Done, then "Ohne Status"', () => {
  const entries = [
    item('a', '2026-01-01', { status: 'Done' }),
    item('b', '2026-01-02'), // no stored status → Ohne Status, not Open
    item('c', '2026-01-03', { status: 'Open' }),
    item('d', '2026-01-04', { status: 'Doing' }),
    item('e', '2026-01-05', { status: 'Done' }),
  ];
  const opts = groupByOptions(entries, []);
  const { sections, grouped } = computeSections(entries, 'status', opts, ctx());
  assert.equal(grouped, true);
  assert.deepEqual(
    sections.map((s) => [s.label, s.empty, s.items.map((i) => i.id)]),
    [
      ['Open', false, ['c']],
      ['Doing', false, ['d']],
      ['Done', false, ['a', 'e']],
      ['Ohne Status', true, ['b']],
    ],
  );
});

test('a grouped field is listed under its section title, so same-named fields stay tellable apart', () => {
  const pluginVersion: CustomFieldDef = {
    key: 'featureVersion',
    label: 'Version',
    type: 'select',
    group: 'Produkt',
  };
  const ownVersion: CustomFieldDef = { key: 'ver', label: 'Version', type: 'text' };
  assert.equal(dimensionLabel(pluginVersion), 'Produkt · Version');
  assert.equal(dimensionLabel(ownVersion), 'Version');

  const opts = groupByOptions([item('a', '2026-01-01')], [ownVersion, pluginVersion]);
  assert.deepEqual(
    opts.map((o) => o.label),
    ['Gruppe', 'Version', 'Produkt · Version'],
  );
});

test('group dimension keeps the build group order and appends "Ohne Gruppe"', () => {
  const entries = [
    item('a', '2026-01-01', { group: '2-b' }),
    item('b', '2026-01-02', { group: '1-a' }),
    item('c', '2026-01-03', { group: 'missing' }), // unknown group → ungrouped
  ];
  const { sections, grouped } = computeSections(entries, 'group', groupByOptions(entries, [TIER]), ctx());
  assert.equal(grouped, true);
  assert.deepEqual(
    sections.map((s) => [s.label, s.empty, s.items.map((i) => i.id)]),
    [
      ['Alpha', false, ['b']],
      ['Beta', false, ['a']],
      ['Ohne Gruppe', true, ['c']],
    ],
  );
});

test('a timeline without groups renders flat (grouped=false)', () => {
  const entries = [item('a', '2026-01-01'), item('b', '2026-01-02')];
  const { sections, grouped } = computeSections(entries, 'group', groupByOptions(entries, []), {
    groups: [],
    customFields: [],
    metaOf: () => undefined,
  });
  assert.equal(grouped, false);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0].items.map((i) => i.id), ['a', 'b']);
});

test('tag dimension puts a multi-tagged item in every tag section', () => {
  const entries = [
    item('a', '2026-01-01', { tags: ['X', 'Y'] }),
    item('b', '2026-01-02', { tags: ['Y'] }),
    item('c', '2026-01-03'), // untagged
  ];
  const opts = groupByOptions(entries, []);
  const { sections } = computeSections(entries, 'tag', opts, ctx());
  const map = Object.fromEntries(sections.map((s) => [s.label, s.items.map((i) => i.id)]));
  assert.deepEqual(map['X'], ['a']);
  assert.deepEqual(map['Y'], ['a', 'b']);
  assert.deepEqual(map['Ohne Tag'], ['c']);
});

test('custom-field dimension orders sections by declared options, then "Ohne Tier"', () => {
  const entries = [
    item('a', '2026-01-01'), // no tier → Ohne Tier
    item('b', '2026-01-02'),
    item('c', '2026-01-03'),
    item('d', '2026-01-04'),
  ];
  const meta = {
    b: { tier: 'Scale' },
    c: { tier: ['Free', 'Enterprise'] }, // multi-select → two buckets
    d: { tier: 'Free' },
  };
  const opts = groupByOptions(entries, [TIER]);
  const { sections, grouped } = computeSections(entries, 'cf:tier', opts, ctx(meta));
  assert.equal(grouped, true);
  assert.deepEqual(
    sections.map((s) => [s.label, s.items.map((i) => i.id)]),
    [
      ['Free', ['c', 'd']],
      ['Scale', ['b']],
      ['Enterprise', ['c']],
      ['Ohne Tier', ['a']],
    ],
  );
});

test('custom-field dimension with no values still shows a single "Ohne Tier" header', () => {
  const entries = [item('a', '2026-01-01'), item('b', '2026-01-02')];
  const opts = groupByOptions(entries, [TIER]);
  const { sections, grouped } = computeSections(entries, 'cf:tier', opts, ctx());
  assert.equal(grouped, true);
  assert.deepEqual(sections.map((s) => s.label), ['Ohne Tier']);
  assert.equal(sections[0].empty, true);
  assert.deepEqual(sections[0].items.map((i) => i.id), ['a', 'b']);
});

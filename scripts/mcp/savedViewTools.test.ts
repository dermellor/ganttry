import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NO_BUCKET, savedViewDimensions } from './savedViewTools.ts';
import { register } from '../../src/pluginHost/registry.ts';
import type { TimelineFile } from '../../src/types.ts';

// What an agent is told a timeline can be grouped and filtered by.
//
// The property under test is that this answer matches the interface's. It did not:
// the context was built from `file.customFields` alone, so a plugin's fields — the
// whole reason a timeline carries a plugin — were invisible to `describe_view_
// dimensions`. A filter naming a value the report does not know narrows nothing and
// reports success, which is the worst shape a wrong answer can take here.

const PLUGIN = 'com.example.sprints';

register({
  manifest: {
    id: PLUGIN,
    name: 'Sprints',
    version: '1.0.0',
    apiVersion: '^1.5',
    capabilities: ['fields'],
  },
  matches: (file) => !!file?.plugins?.some((p) => p.id === PLUGIN),
  fields: (file) =>
    file?.plugins?.some((p) => p.id === PLUGIN)
      ? [
          { key: 'sprint', label: 'Sprint', type: 'select', derived: true, group: 'Sprints' },
          { key: 'estimate', label: 'Story Points', type: 'select', options: [{ value: '3' }] },
        ]
      : [],
  // The rule itself is trivial here on purpose: what is being pinned is that the
  // report goes through it at all.
  derive: (file) =>
    file?.plugins?.some((p) => p.id === PLUGIN)
      ? (item) => ({ sprint: item.start ? `S-${item.start.slice(0, 7)}` : undefined })
      : null,
  load: () => Promise.reject(new Error('no view')),
});

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

const enabled = (): TimelineFile =>
  file({
    plugins: [{ id: PLUGIN, config: {} }],
    items: [
      { id: 'a', content: 'Rollout', start: '2026-03-04', metadata: { estimate: '3' } },
      { id: 'b', content: 'Nachlauf', start: '2026-04-02' },
      { id: 'c', content: 'Ohne Datum' },
    ],
  });

const dimension = (f: TimelineFile, key: string) => savedViewDimensions(f).find((d) => d.key === key);

test('a plugin contributes dimensions, alongside the timeline\'s stored fields', () => {
  const keys = savedViewDimensions(enabled()).map((d) => d.key);
  assert.ok(keys.includes('cf:sprint'));
  assert.ok(keys.includes('cf:estimate'));
});

test('a derived dimension reports the computed values', () => {
  const dim = dimension(enabled(), 'cf:sprint');
  const values = dim?.values.map((v) => v.value) ?? [];
  // Nothing stores `sprint` on any item: these values exist only because the
  // report ran the plugin's rule.
  assert.ok(values.includes('S-2026-03'));
  assert.ok(values.includes('S-2026-04'));
  // The item with no date has no sprint, so it is selectable as „without a value"
  // rather than sitting in a bucket with an empty name.
  assert.ok(values.includes(NO_BUCKET));
});

test('the dimension is labelled with the plugin it came from', () => {
  assert.equal(dimension(enabled(), 'cf:sprint')?.label, 'Sprints · Sprint');
});

test('the plugin off ⇒ neither of its dimensions is offered', () => {
  const keys = savedViewDimensions(file({ items: [{ id: 'a', content: 'Rollout' }] })).map((d) => d.key);
  assert.equal(keys.includes('cf:sprint'), false);
  assert.equal(keys.includes('cf:estimate'), false);
});

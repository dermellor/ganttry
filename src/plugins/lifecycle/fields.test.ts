import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lifecycleDerive, lifecycleFields } from './fields';
import {
  CUTOVER_KEY,
  END_OF_SUPPORT_KEY,
  EXTENDED_UNTIL_KEY,
  LATEST_START_KEY,
  LEAD_TIME_KEY,
  LIFECYCLE_PLUGIN,
  SHUTDOWN_KEY,
  SUPPORT_WINDOWS,
  SUPPORT_WINDOW_KEY,
  SYSTEM_KEY,
} from './lifecycle';
import type { TimelineFile, TimelineFileItem } from '../../types';

// Derivation is where plugins actually break, so the cases here are the empty and the
// malformed ones rather than the happy path: no config, a config that is not an object,
// an item with no dates, and an item whose dates are typed in the wrong format.

const item = (id: string, metadata: Record<string, unknown> = {}, start?: string): TimelineFileItem =>
  ({ id, content: id, ...(start ? { start } : {}), metadata }) as TimelineFileItem;

const file = (items: TimelineFileItem[], config?: unknown, enabled = true): TimelineFile =>
  ({
    id: 't',
    plugins: enabled ? [{ id: LIFECYCLE_PLUGIN, ...(config === undefined ? {} : { config })  }] : [],
    items,
  }) as unknown as TimelineFile;

test('no fields at all while the plugin is off', () => {
  assert.deepEqual(lifecycleFields(file([item('a')], undefined, false)), []);
  assert.deepEqual(lifecycleFields(null), []);
  assert.deepEqual(lifecycleFields(undefined), []);
});

test('all eight fields appear with no config, because a date field offers no choices', () => {
  // The difference from a plugin whose fields are options: there is nothing to derive the
  // controls from. A timeline that has just switched the plugin on needs somewhere to type
  // the first end-of-support date, so gating on config would leave the user with no way to
  // produce the data the config is about.
  const defs = lifecycleFields(file([]));
  assert.deepEqual(defs.map((d) => d.key), [
    SYSTEM_KEY,
    END_OF_SUPPORT_KEY,
    EXTENDED_UNTIL_KEY,
    LEAD_TIME_KEY,
    CUTOVER_KEY,
    SHUTDOWN_KEY,
    LATEST_START_KEY,
    SUPPORT_WINDOW_KEY,
  ]);
  assert.deepEqual(lifecycleFields(file([], 'not an object')).length, 8);
});

test('every date is a text field, because the core has no date type', () => {
  const defs = lifecycleFields(file([]));
  for (const key of [END_OF_SUPPORT_KEY, EXTENDED_UNTIL_KEY, CUTOVER_KEY, SHUTDOWN_KEY, LATEST_START_KEY]) {
    assert.equal(defs.find((d) => d.key === key)?.type, 'text', key);
  }
  // The one select is the field the domain groups by, and it offers every window rather
  // than only the occupied ones: three fixed states, so an empty bucket is a real answer
  // („nothing is unsupported") rather than a lane out to the end of a raster.
  const window = defs.find((d) => d.key === SUPPORT_WINDOW_KEY);
  assert.equal(window?.type, 'select');
  assert.deepEqual(window?.options?.map((o) => o.value), [...SUPPORT_WINDOWS]);
});

test('the stored support-window ids stay English, whatever the labels say', () => {
  // The ids are what a grouping dimension keys on. A translated bucket id would split one
  // lane in two the first time somebody switched language.
  const options = lifecycleFields(file([])).find((d) => d.key === SUPPORT_WINDOW_KEY)?.options ?? [];
  assert.deepEqual(options.map((o) => o.value), ['standard', 'extended', 'unsupported']);
  for (const option of options) {
    assert.ok(option.label, `no label for ${option.value}`);
  }
});

test('relabelling every option leaves the values a saved view refers to untouched', () => {
  // The playbook's „stored option values are untouched by a label change", and here the
  // thing that stores them is not an item — this field is derived, so nothing is ever
  // written to it. What stores them is a **saved view**: the committed example ships
  // `groupBy: "cf:supportWindow"`, and a filter narrows on the bucket value. Translating
  // an id would therefore not orphan an item, it would orphan a saved view — which reads
  // as the view being empty rather than as a rename.
  const options = lifecycleFields(file([])).find((d) => d.key === SUPPORT_WINDOW_KEY)?.options ?? [];
  const relabelled = options.map((o) => ({ ...o, label: `übersetzt ${o.value}` }));
  const storedInASavedView = 'unsupported';
  const found = relabelled.find((o) => o.value === storedInASavedView);
  assert.ok(found, 'a value a saved view refers to no longer matches any option');
  assert.equal(found.label, 'übersetzt unsupported');
  assert.equal(found.value, 'unsupported');
  // And a value is matched by value, never by label: looking one up by its label works
  // for exactly as long as the two happen to be equal.
  for (const option of relabelled) {
    assert.notEqual(option.label, option.value, 'the fixture must actually differ');
    assert.equal(relabelled.filter((o) => o.value === option.value).length, 1);
  }
});

test('no field is on the context menu, because none of them has a short fixed list', () => {
  // Six free-text dates and two read-only values: a submenu of any of them would be a
  // „quick action" that opens a text prompt, and the two computed ones cannot be set at all.
  for (const def of lifecycleFields(file([]))) {
    assert.equal(def.contextMenu, undefined, def.key);
  }
});

test('derive yields nothing for an item with no vendor date', () => {
  const derive = lifecycleDerive(file([item('a')]));
  assert.ok(derive);
  // `{}` rather than keys holding `undefined`: the host drops absent values, so the item
  // lands in the „Ohne …" bucket instead of one with no name.
  assert.deepEqual(derive(item('a')), {});
  assert.deepEqual(derive(item('a', { system: 'Exchange' })), {});
});

test('derive computes the latest start and the window the shutdown falls in', () => {
  const derive = lifecycleDerive(file([], { minParallelRunDays: 30, defaultLeadTimeDays: 180 }));
  assert.ok(derive);
  assert.deepEqual(
    derive(item('a', { endOfSupport: '2026-10-14', shutdown: '2026-10-01' })),
    { [LATEST_START_KEY]: '2026-04-17', [SUPPORT_WINDOW_KEY]: 'standard' },
  );
  // Past end of support with nothing bought: the plan ends unsupported.
  assert.deepEqual(
    derive(item('a', { endOfSupport: '2026-10-14', shutdown: '2026-12-01' })),
    { [LATEST_START_KEY]: '2026-04-17', [SUPPORT_WINDOW_KEY]: 'unsupported' },
  );
  // …and extended support, taken as input, moves both answers.
  assert.deepEqual(
    derive(item('a', { endOfSupport: '2026-10-14', extendedUntil: '2029-10-09', shutdown: '2026-12-01' })),
    { [LATEST_START_KEY]: '2029-04-12', [SUPPORT_WINDOW_KEY]: 'extended' },
  );
});

test('the window is measured at the shutdown, falling back to the cutover', () => {
  // „Will the old system still be supported when we finally switch it off" is what a
  // migration plan is trying to answer. Measuring at the item's start would report every
  // plan as safe on the day it was written.
  const derive = lifecycleDerive(file([]));
  assert.ok(derive);
  assert.equal(
    derive(item('a', { endOfSupport: '2026-10-14', cutover: '2026-12-01' }))[SUPPORT_WINDOW_KEY],
    'unsupported',
  );
  // With neither date the window is absent, and the latest start still is not: the two
  // answers do not depend on each other.
  const onlyVendor = derive(item('a', { endOfSupport: '2026-10-14', leadTimeDays: 90 }), );
  assert.equal(onlyVendor[SUPPORT_WINDOW_KEY], undefined);
  assert.equal(onlyVendor[LATEST_START_KEY], '2026-07-16');
});

test('derive takes the lead time off the item before the config default', () => {
  const derive = lifecycleDerive(file([], { defaultLeadTimeDays: 180 }));
  assert.ok(derive);
  assert.equal(derive(item('a', { endOfSupport: '2026-10-14', leadTimeDays: 90 }))[LATEST_START_KEY], '2026-07-16');
  assert.equal(derive(item('a', { endOfSupport: '2026-10-14' }))[LATEST_START_KEY], '2026-04-17');
});

test('derive yields no latest start without a lead time anywhere', () => {
  const derive = lifecycleDerive(file([]));
  assert.ok(derive);
  const values = derive(item('a', { endOfSupport: '2026-10-14', shutdown: '2026-10-01' }));
  assert.equal(values[LATEST_START_KEY], undefined);
  // The window is still answered: one missing input must not blank the other value.
  assert.equal(values[SUPPORT_WINDOW_KEY], 'standard');
});

test('a malformed date derives nothing rather than a date nobody wrote', () => {
  const derive = lifecycleDerive(file([], { defaultLeadTimeDays: 180 }));
  assert.ok(derive);
  // „14.10.2026" read by `new Date()` would land the latest start months from where the
  // author meant it, with nothing on screen saying so.
  assert.deepEqual(derive(item('a', { endOfSupport: '14.10.2026' })), {});
  assert.deepEqual(derive(item('a', { endOfSupport: '2026-02-30' })), {});
});

test('derive returns null while the plugin is off', () => {
  assert.equal(lifecycleDerive(file([item('a')], undefined, false)), null);
  assert.equal(lifecycleDerive(null), null);
});

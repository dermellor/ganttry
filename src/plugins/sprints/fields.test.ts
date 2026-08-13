import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIDENCE_KEY,
  CONFIDENCE_OPTIONS,
  SPRINTS_PLUGIN,
  SPRINT_KEY,
  STORY_POINTS_KEY,
  sprintsDerive,
  sprintsFields,
} from './fields';
import { DEFAULT_SCALE } from './raster';
import type { TimelineFile } from '../../types';

// Derivation is where plugins actually break, so the three cases every contributed
// field needs are here: off, on but unconfigured, and configured. The rest are the
// boundaries the README names.

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

const enabled = (config: Record<string, unknown>, items: TimelineFile['items'] = []): TimelineFile =>
  file({ plugins: [{ id: SPRINTS_PLUGIN, config }], items });

const RASTER = { start: '2026-01-05', lengthDays: 14, velocity: 20 };

test('contributes nothing while the plugin is not enabled', () => {
  assert.deepEqual(sprintsFields(file()), []);
  assert.deepEqual(sprintsFields(null), []);
  assert.deepEqual(sprintsFields(undefined), []);
});

test('contributes nothing without an anchor, and nothing on a malformed config', () => {
  // `start` is required: without it there is no raster, and a sprint field with no
  // anchor behind it is a control that can never hold a value.
  assert.deepEqual(sprintsFields(enabled({})), []);
  assert.deepEqual(sprintsFields(enabled({ lengthDays: 14, velocity: 20 })), []);
  assert.deepEqual(sprintsFields(enabled({ start: 'bald' })), []);
  assert.deepEqual(sprintsFields(enabled({ start: '2026-01-05', lengthDays: 0 })), []);
});

test('the two chosen fields appear without any item being in a sprint', () => {
  // Estimating an item that starts before the anchor is legitimate, so these two do
  // not depend on the raster having anything in it.
  const defs = sprintsFields(enabled(RASTER));
  assert.deepEqual(defs.map((d) => d.key), [STORY_POINTS_KEY, CONFIDENCE_KEY]);

  const [storyPoints, confidence] = defs;
  assert.equal(storyPoints.label, 'Story Points');
  assert.equal(storyPoints.contextMenu, true);
  assert.equal(storyPoints.derived, undefined);
  assert.deepEqual(storyPoints.options, DEFAULT_SCALE.map((value) => ({ value })));

  assert.equal(confidence.label, 'Confidence');
  assert.equal(confidence.contextMenu, true);
  assert.deepEqual(confidence.options, CONFIDENCE_OPTIONS);
  // The stored values are the German words themselves; changing one orphans every
  // item that carries it (see AGENTS.md in this folder).
  assert.deepEqual(CONFIDENCE_OPTIONS.map((o) => o.value), ['hoch', 'mittel', 'niedrig']);
});

test('the estimate options come from `scale` when the config names one', () => {
  const defs = sprintsFields(enabled({ ...RASTER, scale: ['S', 'M', 'L'] }));
  assert.deepEqual(defs.find((d) => d.key === STORY_POINTS_KEY)?.options, [
    { value: 'S' },
    { value: 'M' },
    { value: 'L' },
  ]);
});

test('the sprint field offers the sprints the items occupy, chronologically', () => {
  const defs = sprintsFields(
    enabled(RASTER, [
      { id: 'c', content: 'Sprint 3', start: '2026-02-02' },
      { id: 'a', content: 'Sprint 1', start: '2026-01-05' },
      { id: 'd', content: 'Sprint 7', start: '2026-03-30' },
      { id: 'b', content: 'ohne Datum' },
      { id: 'e', content: 'vor dem Anker', start: '2025-12-15' },
    ]),
  );
  const sprint = defs.find((d) => d.key === SPRINT_KEY);
  assert.equal(sprint?.label, 'Sprint');
  assert.equal(sprint?.type, 'select');
  assert.equal(sprint?.derived, true);
  // Read-only, so it stays out of the right-click menu: there is nothing to set.
  assert.equal(sprint?.contextMenu, undefined);
  // Sprints 4 to 6 hold nothing and therefore offer no option and get no lane.
  assert.deepEqual(sprint?.options, [
    { value: 'sprint-1', label: 'Sprint 1' },
    { value: 'sprint-3', label: 'Sprint 3' },
    { value: 'sprint-7', label: 'Sprint 7' },
  ]);
  // And it is the first field, ahead of the two chosen ones.
  assert.equal(defs[0].key, SPRINT_KEY);
});

test('no sprint field while no item falls into a sprint', () => {
  // A select with no options is a control the user cannot use, and an empty dimension
  // in „Gruppieren" is a choice that does nothing.
  const defs = sprintsFields(enabled(RASTER, [{ id: 'a', content: 'vor dem Anker', start: '2025-12-15' }]));
  assert.equal(defs.some((d) => d.key === SPRINT_KEY), false);
});

test('the derived value follows from the item, and is absent when there is no sprint', () => {
  // The declaration and the values are two halves of one thing: a `derived` field with
  // no `derive` behind it is an empty read-only control, and a value on a key nothing
  // declared derived is dropped by the host. Both halves belong in one test.
  const timeline = enabled(RASTER, [{ id: 'a', content: 'x', start: '2026-02-02' }]);
  assert.equal(sprintsFields(timeline).find((d) => d.key === SPRINT_KEY)?.derived, true);

  const derive = sprintsDerive(timeline);
  assert.ok(derive);
  assert.equal(derive({ content: 'x', start: '2026-01-05' })[SPRINT_KEY], 'sprint-1');
  assert.equal(derive({ content: 'x', start: '2026-02-02' })[SPRINT_KEY], 'sprint-3');
  // An item that moves changes sprint by itself: same item, one day later, one sprint on.
  assert.equal(derive({ content: 'x', start: '2026-01-18' })[SPRINT_KEY], 'sprint-1');
  assert.equal(derive({ content: 'x', start: '2026-01-19' })[SPRINT_KEY], 'sprint-2');
  // No start, and a start before the anchor: no value, so the host drops the key and
  // the item lands in the „Ohne …" bucket rather than in one with no name.
  assert.equal(derive({ content: 'x' })[SPRINT_KEY], undefined);
  assert.equal(derive({ content: 'x', start: '2025-12-15' })[SPRINT_KEY], undefined);
});

test('the derived value ignores whatever the item happens to store on the key', () => {
  // The point of the derived seam: a stale copy survives the item moving out of the
  // sprint it names, and a stale bucket is indistinguishable from a chosen one.
  const derive = sprintsDerive(enabled(RASTER, [{ id: 'a', content: 'x', start: '2026-02-02' }]));
  assert.equal(
    derive?.({ content: 'x', start: '2026-02-02', metadata: { [SPRINT_KEY]: 'sprint-99' } })[SPRINT_KEY],
    'sprint-3',
  );
});

test('no derive function while the plugin is off or has no anchor', () => {
  assert.equal(sprintsDerive(file()), null);
  assert.equal(sprintsDerive(null), null);
  assert.equal(sprintsDerive(enabled({})), null);
  assert.equal(sprintsDerive(enabled({ start: '2026-01-05', lengthDays: -1 })), null);
});

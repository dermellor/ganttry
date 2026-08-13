import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIDENCE_KEY,
  CONFIDENCE_OPTIONS,
  SPRINTS_PLUGIN,
  SPRINT_BY_DATE_KEY,
  SPRINT_KEY,
  STORY_POINTS_KEY,
  sprintsDerive,
  sprintsFields,
} from './fields';
import { SPRINT_COLLECTIONS } from './manifest';
import { DEFAULT_SCALE } from './raster';
import type { TimelineFile } from '../../types';

// Two fields carry the sprint now, and the pair is what these cases are about: the
// ASSIGNMENT is stored and choosable, the SUGGESTION is computed and read-only. Getting
// either half wrong is invisible in the interface: a stored field that looks derived
// cannot be set, a derived one that looks stored offers a control with nothing behind
// it, so both halves are asserted together.
//
// The three cases every contributed field needs are here as well: off, on but
// unconfigured, and configured.

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

const RASTER = { start: '2026-01-05', lengthDays: 14, velocity: 20 };

const sprintRow = (id: string, data: Record<string, unknown>) => ({ id, data });

/** The plugin enabled, with an optional set of sprint rows. */
const enabled = (
  config: Record<string, unknown>,
  items: TimelineFile['items'] = [],
  sprints: { id: string; data: Record<string, unknown> }[] = [],
): TimelineFile =>
  ({
    items,
    plugins: [{ id: SPRINTS_PLUGIN, config }],
    ...(sprints.length ? { pluginData: { [SPRINTS_PLUGIN]: { [SPRINT_COLLECTIONS.sprints]: sprints } } } : {}),
  }) as unknown as TimelineFile;

const DATED = [
  sprintRow('s1', { name: 'Sprint 1', state: 'closed', start: '2026-01-05', end: '2026-01-18' }),
  sprintRow('s2', { name: 'Sprint 2', state: 'active', start: '2026-01-19', end: '2026-02-01' }),
];

test('contributes nothing while the plugin is not enabled', () => {
  assert.deepEqual(sprintsFields(file()), []);
  assert.deepEqual(sprintsFields(null), []);
  assert.deepEqual(sprintsFields(undefined), []);
});

test('contributes nothing with neither a raster nor a single sprint row', () => {
  // With no cadence and no sprints there is nothing to assign to and no window to fall
  // into, so every control would be one the user cannot use and every dimension in
  // „Gruppieren" a choice that does nothing.
  assert.deepEqual(sprintsFields(enabled({})), []);
  assert.deepEqual(sprintsFields(enabled({ lengthDays: 14, velocity: 20 })), []);
  assert.deepEqual(sprintsFields(enabled({ start: 'bald' })), []);
  assert.deepEqual(sprintsFields(enabled({ start: '2026-01-05', lengthDays: 0 })), []);
});

test('the two estimate fields appear on the raster alone, with no sprint in existence', () => {
  // Estimating work before the first sprint row exists is legitimate, so these two do
  // not depend on there being any.
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
  // The stored values are the German words themselves; changing one orphans every item
  // that carries it (see AGENTS.md in this folder).
  assert.deepEqual(CONFIDENCE_OPTIONS.map((o) => o.value), ['hoch', 'mittel', 'niedrig']);
});

test('the estimate options come from `scale`, with or without an anchor', () => {
  const scale = [{ value: 'S' }, { value: 'M' }, { value: 'L' }];
  assert.deepEqual(
    sprintsFields(enabled({ ...RASTER, scale: ['S', 'M', 'L'] })).find((d) => d.key === STORY_POINTS_KEY)?.options,
    scale,
  );
  // No anchor, but sprints that carry their own dates: the ladder is a property of how
  // the team estimates, so it does not depend on a raster being configured.
  assert.deepEqual(
    sprintsFields(enabled({ scale: ['S', 'M', 'L'] }, [], DATED)).find((d) => d.key === STORY_POINTS_KEY)?.options,
    scale,
  );
});

test('the assignment offers every sprint row, in row order, by id', () => {
  const defs = sprintsFields(
    enabled(RASTER, [], [
      sprintRow('s2', { name: 'Sprint 2', state: 'active' }),
      sprintRow('s1', { name: 'Sprint 1', state: 'closed' }),
      // Holds nothing, and is offered anyway: assigning the first item to an empty
      // sprint is the whole planning act.
      sprintRow('s3', { name: 'Sprint 3', state: 'planned' }),
    ]),
  );
  const sprint = defs.find((d) => d.key === SPRINT_KEY);
  assert.equal(sprint?.label, 'Sprint');
  assert.equal(sprint?.type, 'select');
  // Stored, so it is neither derived nor read-only, and it is in the right-click menu:
  // because retargeting an item into another sprint is the action planning consists of.
  assert.equal(sprint?.derived, undefined);
  assert.equal(sprint?.contextMenu, true);
  // The value is the row id and the label its name, so renaming „Sprint 3" orphans
  // nothing: the order is the collection's, which is also the order the lanes get.
  assert.deepEqual(sprint?.options, [
    { value: 's2', label: 'Sprint 2' },
    { value: 's1', label: 'Sprint 1' },
    { value: 's3', label: 'Sprint 3' },
  ]);
  // And it is the first field, ahead of the suggestion and the two estimates.
  assert.equal(defs[0].key, SPRINT_KEY);
});

test('the suggestion offers only the sprints some item falls into', () => {
  const defs = sprintsFields(
    enabled(
      RASTER,
      [
        { id: 'a', content: 'in Sprint 1', start: '2026-01-06' },
        { id: 'b', content: 'vor dem Anker', start: '2025-12-15' },
        { id: 'c', content: 'ohne Datum' },
      ],
      [...DATED, sprintRow('s3', { name: 'Sprint 3', state: 'planned', start: '2026-02-02', end: '2026-02-15' })],
    ),
  );
  const byDate = defs.find((d) => d.key === SPRINT_BY_DATE_KEY);
  // Labelled apart from the assignment on purpose: the core prefixes the plugin name,
  // so the two dimensions read „Sprints · Sprint" and „Sprints · Sprint nach Datum",
  // and calling both „Sprint" would make them indistinguishable in the one menu a user
  // picks between them in.
  assert.equal(byDate?.label, 'Sprint nach Datum');
  assert.equal(byDate?.derived, true);
  // Read-only, so it stays out of the right-click menu: there is nothing to set,
  // because the item's own start decides the value.
  assert.equal(byDate?.contextMenu, undefined);
  // An option here is a bucket that exists rather than a choice somebody can make, so
  // sprints 2 and 3 hold nothing and get no lane.
  assert.deepEqual(byDate?.options, [{ value: 's1', label: 'Sprint 1' }]);
  assert.equal(defs[1].key, SPRINT_BY_DATE_KEY);
});

test('no suggestion field while no item falls into any window', () => {
  const defs = sprintsFields(
    enabled(RASTER, [{ id: 'a', content: 'vor dem Anker', start: '2025-12-15' }], DATED),
  );
  assert.equal(defs.some((d) => d.key === SPRINT_BY_DATE_KEY), false);
  // The assignment survives that case: an item that starts before the cadence can still
  // be committed to a sprint.
  assert.equal(defs.some((d) => d.key === SPRINT_KEY), true);
});

test('no sprint field at all without rows, however well configured the raster is', () => {
  // The raster is the suggestion, not the truth: with no sprint rows there is no sprint
  // to be in, and a lane named after a number nobody created is the stale bucket this
  // model was rewritten to remove.
  const defs = sprintsFields(enabled(RASTER, [{ id: 'a', content: 'x', start: '2026-01-06' }]));
  assert.deepEqual(defs.map((d) => d.key), [STORY_POINTS_KEY, CONFIDENCE_KEY]);
});

test('the derived value is the sprint whose window contains the start', () => {
  // The declaration and the values are two halves of one thing: a `derived` field with
  // no `derive` behind it is an empty read-only control, and a value on a key nothing
  // declared derived is dropped by the host. Both halves belong in one test.
  const timeline = enabled(RASTER, [{ id: 'a', content: 'x', start: '2026-01-06' }], DATED);
  assert.equal(sprintsFields(timeline).find((d) => d.key === SPRINT_BY_DATE_KEY)?.derived, true);

  const derive = sprintsDerive(timeline);
  assert.ok(derive);
  const at = (start?: string) => derive({ content: 'x', start })[SPRINT_BY_DATE_KEY];
  assert.equal(at('2026-01-05'), 's1');
  assert.equal(at('2026-01-18'), 's1');
  // An item that moves changes its suggestion by itself: one day later, one sprint on.
  assert.equal(at('2026-01-19'), 's2');
  assert.equal(at('2026-02-01'), 's2');
  // No start, a start before every window and a start after every window: no value, so
  // the host drops the key and the item lands in the „Ohne …" bucket rather than in one
  // with no name.
  assert.equal(at(undefined), undefined);
  assert.equal(at('2025-12-15'), undefined);
  assert.equal(at('2026-02-02'), undefined);
  // And nothing is ever filled in for the assignment: it is stored, and a plugin may
  // only fill keys it declared derived.
  assert.equal(SPRINT_KEY in derive({ content: 'x', start: '2026-01-06' }), false);
});

test('an undated sprint takes its window from the raster, at its position', () => {
  // Which is what keeps the raster useful after the model change: the config still dates
  // the sprints nobody has dated yet, and the boundaries are the raster's own.
  const derive = sprintsDerive(
    enabled(RASTER, [], [
      sprintRow('s1', { name: 'Sprint 1', state: 'closed' }),
      sprintRow('s2', { name: 'Sprint 2', state: 'active' }),
    ]),
  );
  assert.ok(derive);
  const at = (start: string) => derive({ content: 'x', start })[SPRINT_BY_DATE_KEY];
  assert.equal(at('2026-01-05'), 's1');
  assert.equal(at('2026-01-18'), 's1');
  assert.equal(at('2026-01-19'), 's2');
  assert.equal(at('2026-02-01'), 's2');
  assert.equal(at('2026-02-02'), undefined);
  // The boundary the raster tests pin across a clock change, read through a row: the day
  // arithmetic counts calendar days, so an item after 2026-03-29 must not shift a sprint.
  const later = sprintsDerive(
    enabled({ start: '2026-03-16', lengthDays: 14 }, [], [sprintRow('s1', { name: 'Sprint 1', state: 'active' })]),
  );
  assert.equal(later?.({ content: 'x', start: '2026-03-29' })[SPRINT_BY_DATE_KEY], 's1');
  assert.equal(later?.({ content: 'x', start: '2026-03-30' })[SPRINT_BY_DATE_KEY], undefined);
});

test('the derived value ignores whatever the item happens to store on the key', () => {
  // The point of the derived seam: a stored copy survives the item moving out of the
  // window it names, and a stale bucket is indistinguishable from a chosen one.
  const derive = sprintsDerive(enabled(RASTER, [], DATED));
  assert.equal(
    derive?.({ content: 'x', start: '2026-01-06', metadata: { [SPRINT_BY_DATE_KEY]: 's99' } })[SPRINT_BY_DATE_KEY],
    's1',
  );
  // And it does not read the assignment either: the two answer different questions, and
  // a suggestion that echoed the assignment could never disagree with it.
  assert.equal(
    derive?.({ content: 'x', start: '2026-01-06', metadata: { [SPRINT_KEY]: 's2' } })[SPRINT_BY_DATE_KEY],
    's1',
  );
});

test('no derive function while the plugin is off or has no sprint rows', () => {
  assert.equal(sprintsDerive(file()), null);
  assert.equal(sprintsDerive(null), null);
  assert.equal(sprintsDerive(enabled({})), null);
  // A raster with no rows makes no suggestion: there are no windows to fall into.
  assert.equal(sprintsDerive(enabled(RASTER, [{ id: 'a', content: 'x', start: '2026-01-06' }])), null);
});

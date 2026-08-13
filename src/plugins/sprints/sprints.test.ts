import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPACITY_UNITS,
  SPRINTS_PLUGIN,
  SPRINT_KEY,
  SPRINT_STATES,
  activeSprint,
  activeSprints,
  assignedSprintId,
  capacityUnitOf,
  carriedInto,
  closeIncomplete,
  closeObjection,
  estimateOf,
  figuresSource,
  isDone,
  itemsOfSprint,
  nextSprint,
  passesOfSprint,
  rasterWindow,
  readEstimateUnit,
  readPasses,
  readReports,
  readSprints,
  recordableItems,
  reportOfSprint,
  reportUnitOf,
  sprintById,
  sprintEditPatch,
  sprintWarnings,
  sprintWindow,
  suggestedCapacity,
  suggestedSprintId,
  timelineScope,
  windowContains,
  type Sprint,
  type SprintEdit,
} from './sprints';
import { MIN_CAPACITY } from './manifest';
import { frozenSeries, sprintDays } from './burndown';
import { rasterFrom, readSprintConfig } from './raster';
import type { TimelineFile, TimelineFileItem } from '../../types';

// Two things are tested here, and they fail in different ways.
//
// The READING is defensive because the rows are user-editable data: a JSON file
// somebody maintains, an MCP write, a hand-edited local source. `fields.ts` runs on the
// item form's path and `derive` runs over every item on every build, so a throw here
// would cost the plugin its values everywhere. Every malformed shape below therefore
// asserts „dropped", never „raised".
//
// The RULES are tested as data. Both consumers word a warning differently, so what has
// to be pinned is which warnings exist and when, not how they read.

const RASTER = { start: '2026-01-05', lengthDays: 14, velocity: 20 };
const raster = rasterFrom(readSprintConfig(RASTER));

/**
 * The day the clock-free warnings are asked for, chosen to be before every window in this
 * file.
 *
 * `sprintWarnings` takes the day because one of its findings compares a window against it
 * („sprint-window-past"), and a rule that read the clock itself would answer differently in
 * a test than in the app. A reference day before every window keeps the other assertions
 * about exactly the warnings they were written for; the day-dependent one has its own tests.
 */
const BEFORE_ANY_WINDOW = '2026-01-01';

/** A timeline with this plugin enabled and these rows in its own section. */
const withRows = (
  collections: Record<string, unknown>,
  over: Partial<TimelineFile> = {},
  config: Record<string, unknown> = RASTER,
): TimelineFile =>
  ({
    items: [],
    plugins: [{ id: SPRINTS_PLUGIN, config }],
    pluginData: { [SPRINTS_PLUGIN]: collections },
    ...over,
  }) as unknown as TimelineFile;

// `data` is deliberately `unknown`: half the point of these cases is a row whose `data`
// is not an object at all, which is what a hand-edited file produces.
const row = (id: string, data: unknown) => ({ id, data });

const sprintRow = (id: string, over: Record<string, unknown> = {}) =>
  row(id, { name: id.toUpperCase(), state: 'planned', ...over });

const item = (over: Partial<TimelineFileItem> = {}): TimelineFileItem => ({ content: 'x', ...over });

/** An untouched sprint form: every field as an input hands it over, which is a string. */
const FORM: SprintEdit = {
  name: '',
  goal: '',
  start: '',
  end: '',
  state: 'planned',
  capacity: '',
  capacityUnit: '',
  note: '',
};

const assigned = (id: string, sprintId: string, over: Partial<TimelineFileItem> = {}): TimelineFileItem =>
  item({ id, ...over, metadata: { [SPRINT_KEY]: sprintId, ...(over.metadata ?? {}) } });

test('no rows at all while the plugin is not enabled on the timeline', () => {
  // The host only folds in an enabled plugin's data, but a hand-edited file can carry a
  // section for a plugin nobody switched on. Reading it would show sprints on a
  // timeline that has none.
  const orphan = { items: [], pluginData: { [SPRINTS_PLUGIN]: { sprints: [sprintRow('s1')] } } } as unknown as TimelineFile;
  assert.deepEqual(readSprints(orphan), []);
  assert.deepEqual(readSprints(null), []);
  assert.deepEqual(readSprints(undefined), []);
  assert.deepEqual(readPasses(null), []);
  assert.deepEqual(readReports(null), []);
});

test('a malformed section is read as no rows rather than raised', () => {
  for (const section of ['nope', 42, [], null, { sprints: 'nope' }, { sprints: {} }] as unknown[]) {
    const file = { items: [], plugins: [{ id: SPRINTS_PLUGIN, config: RASTER }], pluginData: section } as unknown as TimelineFile;
    assert.deepEqual(readSprints(file), [], JSON.stringify(section));
  }
  // And a collection whose entries are not rows: no id, an id of whitespace, `data`
  // that is not an object. Each would produce a row nothing can address again.
  const file = withRows({
    sprints: [42, null, [], { data: { name: 'A', state: 'planned' } }, row('  ', { name: 'B', state: 'planned' }), row('s1', 'nope'), sprintRow('s2')],
  });
  assert.deepEqual(readSprints(file).map((s) => s.id), ['s2']);
});

test('a sprint row is read field by field, and an unusable value is absent', () => {
  const file = withRows({
    sprints: [
      row('s1', {
        name: '  Sprint 1  ',
        goal: '   ',
        start: '2026-01-05',
        end: 'bald',
        state: 'CLOSED',
        closedOn: '2026-01-16',
        capacity: '20',
        capacityUnit: 'Hours',
        note: 'Retro',
      }),
      row('s2', { name: 'Sprint 2', state: 'erfunden', capacity: 0, capacityUnit: 'bananas' }),
      row('s3', { name: 'Sprint 3', state: 'planned', capacity: 0.005 }),
    ],
  });
  const [first, second, third] = readSprints(file);
  assert.equal(first.name, 'Sprint 1');
  // An empty goal is „no goal", one case instead of three, which is what lets the
  // warning be a single test.
  assert.equal(first.goal, undefined);
  assert.equal(first.start, '2026-01-05');
  assert.equal(first.end, undefined);
  assert.equal(first.state, 'closed');
  assert.equal(first.closedOn, '2026-01-16');
  // A numeric string is accepted: nothing checks a hand-written file against the
  // collection schema, so `"20"` would otherwise read as no capacity with nothing
  // saying why.
  assert.equal(first.capacity, 20);
  assert.equal(first.capacityUnit, 'hours');
  assert.equal(first.note, 'Retro');

  // An unreadable state is `planned`, the state that claims the least: it must not
  // become the active sprint and must not let frozen figures be read as current.
  assert.equal(second.state, 'planned');
  // Zero is not a capacity a rule may divide by, so it is absent rather than 0.
  assert.equal(second.capacity, undefined);
  assert.equal(second.capacityUnit, undefined);

  // …and the floor is the schema's (`minimum: 0.01`), not a bare „greater than zero".
  // Nothing checks a hand-written file against the schema, and this reader accepted
  // 0.005 and had it printed as „von 0.01 Punkten": a capacity nobody wrote, rounded
  // into existence by the note that states it.
  assert.equal(third.capacity, undefined);
  const atTheFloor = readSprints(withRows({ sprints: [row('s1', { name: 'S', state: 'planned', capacity: 0.01 })] }));
  assert.equal(atTheFloor[0].capacity, 0.01);
});

test('a repeated id keeps its first row, and the position counts what was kept', () => {
  // Two rows under one id cannot both be addressed, and taking the later one would make
  // a reference target depend on read order.
  const file = withRows({ sprints: [sprintRow('s1', { name: 'first' }), sprintRow('s1', { name: 'second' }), sprintRow('s2')] });
  const sprints = readSprints(file);
  assert.deepEqual(sprints.map((s) => [s.id, s.name, s.position]), [
    ['s1', 'first', 1],
    ['s2', 'S2', 2],
  ]);
});

test('a row with no name is labelled by its id instead of being dropped', () => {
  // Dropping it would orphan every item assigned to a row that is still there.
  const file = withRows({ sprints: [row('s1', { state: 'planned' })] });
  assert.equal(readSprints(file)[0].name, 's1');
});

test('a pass needs both ids and one of the four outcomes', () => {
  const file = withRows({
    passes: [
      row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18', estimateAtClose: 8 }),
      row('b:s1', { itemId: 'b', sprintId: 's1', outcome: 'CARRIED', recordedOn: 'irgendwann' }),
      row('c:s1', { itemId: 'c', sprintId: 's1', outcome: 'erledigt', recordedOn: '2026-01-18' }),
      row(':s1', { sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' }),
      row('d:', { itemId: 'd', outcome: 'done', recordedOn: '2026-01-18' }),
    ],
  });
  const passes = readPasses(file);
  // An outcome that is none of the four is dropped rather than defaulted: the outcome is
  // the whole content of the record, and guessing it puts a figure into a report.
  assert.deepEqual(passes.map((p) => [p.itemId, p.outcome, p.recordedOn]), [
    ['a', 'done', '2026-01-18'],
    ['b', 'carried', undefined],
  ]);
  assert.equal(passes[0].estimateAtClose, 8);
  assert.equal(passes[1].estimateAtClose, undefined);
});

test('a pass pointing at no sprint survives the read and is yielded for no sprint', () => {
  // The host refuses such a write and cascades a delete, so this only reaches us from a
  // hand-edited file. Dropping it would hide a dangling reference instead of leaving it
  // where somebody can see it.
  const file = withRows({
    passes: [
      row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' }),
      row('b:geloescht', { itemId: 'b', sprintId: 'geloescht', outcome: 'carried', recordedOn: '2026-01-18' }),
    ],
    sprints: [sprintRow('s1')],
  });
  const passes = readPasses(file);
  assert.equal(passes.length, 2);
  assert.deepEqual(passesOfSprint(passes, 's1').map((p) => p.itemId), ['a']);
  assert.deepEqual(passesOfSprint(passes, 'geloescht').map((p) => p.itemId), ['b']);
  assert.equal(sprintById(readSprints(file), 'geloescht'), null);
});

test('a report needs a sprint, and its curve reaches its one reader untouched', () => {
  const stored = [
    { day: '2026-01-06', remaining: 13 },
    { day: '2026-01-05', remaining: 13 },
    { day: 'Montag', remaining: 8 },
    { day: '2026-01-07', remaining: -1 },
    'nope',
  ];
  const file = withRows({
    reports: [
      row('s1', {
        sprintId: 's1',
        scopeAtStart: 13,
        scopeAtClose: 13,
        completed: 13,
        carried: 0,
        unit: 'Hours',
        series: stored,
      }),
      row('ohne', { scopeAtStart: 5 }),
    ],
  });
  const reports = readReports(file);
  assert.deepEqual(reports.map((r) => r.sprintId), ['s1']);
  // Not filtered and not sorted here: `frozenSeries` is the single reader of a frozen
  // curve. While this reader filtered first, the two disagreed over one row — the point
  // with a negative `remaining` was dropped here and accepted there, so the view drew
  // „no record" for a day that has one and the count of damaged entries stayed 0.
  assert.deepEqual(reports[0].series, stored);
  const days = sprintDays('2026-01-05', '2026-01-07');
  const read = frozenSeries(days, reports[0].series);
  assert.deepEqual(read.points, [
    { day: '2026-01-05', remaining: 13 },
    { day: '2026-01-06', remaining: 13 },
    { day: '2026-01-07', remaining: -1 },
  ]);
  assert.equal(read.malformed, 2, 'the two unreadable entries are countable');
  // Zero is a legitimate frozen figure, so `carried: 0` has to survive the read.
  assert.equal(reports[0].carried, 0);
  assert.equal(reports[0].unit, 'hours');
  assert.equal(reportOfSprint(reports, 's1')?.completed, 13);
  assert.equal(reportOfSprint(reports, 's2'), null);
});

test('a frozen report is labelled in the unit it was frozen in, not the sprint\'s current one', () => {
  // Editing a closed sprint's `capacityUnit` relabelled the frozen figures and the
  // curve: 21 points shown as „21 Einträge", same numbers, nothing saying they had been
  // reinterpreted — the rewriting of history the freeze exists to prevent.
  const sprint = (over: Partial<Sprint> = {}): Sprint =>
    ({ id: 's1', position: 1, name: 'S1', state: 'closed', ...over }) as Sprint;
  const file = withRows({}, {}, { ...RASTER, estimateUnit: 'hours' });
  const frozen = { id: 's1', sprintId: 's1', unit: 'points' as const, series: [] };
  assert.equal(reportUnitOf(frozen, sprint({ capacityUnit: 'items' }), file), 'points');
  // A report from before the field existed carries none, and then the live chain is the
  // best available answer.
  assert.equal(reportUnitOf({ ...frozen, unit: undefined }, sprint({ capacityUnit: 'items' }), file), 'items');
  assert.equal(reportUnitOf({ ...frozen, unit: undefined }, sprint(), file), 'hours');
  assert.equal(reportUnitOf(null, sprint(), null), 'points');
});

test('the window is the row when it carries both dates, and says so', () => {
  const file = withRows({
    sprints: [
      sprintRow('s1', { start: '2026-01-05', end: '2026-01-18' }),
      // Position 2: the raster's second window.
      sprintRow('s2'),
    ],
  });
  const sprints = readSprints(file);
  assert.deepEqual(sprintWindow(sprints[0], raster), {
    start: '2026-01-05',
    end: '2026-01-18',
    source: 'row',
  });
  assert.deepEqual(sprintWindow(sprints[1], raster), {
    start: '2026-01-19',
    end: '2026-02-01',
    source: 'cadence',
  });
  // No raster and no dates: nothing says what the window is, and inventing one would
  // date a sprint the team has not dated.
  assert.equal(sprintWindow(sprints[1], null), null);
  assert.equal(sprintWindow(null, raster), null);
  assert.equal(rasterWindow(raster, 0), null);
  assert.equal(rasterWindow(null, 1), null);
});

test('a written start is never discarded, and the end it did not write is marked as computed', () => {
  // The bug this reverses: a row with `start: 2026-05-01` and no end fell back to the
  // cadence window at its position, so it was tested against 2026-01-05 to 2026-01-18 —
  // and an item starting 2026-05-04, inside the only window anybody had written, was
  // reported as contradicting its assignment.
  const file = withRows({
    sprints: [
      sprintRow('s1', { start: '2026-05-01' }),
      // An end before its start: the two cannot both be right, and the start is the half
      // a plan is built forward from.
      sprintRow('s2', { start: '2026-02-28', end: '2026-02-16' }),
    ],
  });
  const sprints = readSprints(file);
  assert.deepEqual(sprintWindow(sprints[0], raster), {
    start: '2026-05-01',
    end: '2026-05-14',
    source: 'end-from-cadence',
  });
  assert.deepEqual(sprintWindow(sprints[1], raster), {
    start: '2026-02-28',
    end: '2026-03-13',
    source: 'end-from-cadence',
  });
  // Which is what stops the false alarm, over the very data that produced it.
  const healthy = withRows(
    { sprints: [sprintRow('s1', { state: 'active', goal: 'A', start: '2026-05-01' })] },
    { items: [assigned('a', 's1', { start: '2026-05-04', metadata: { storyPoints: '5' } })] },
  );
  assert.deepEqual(sprintWarnings(healthy, BEFORE_ANY_WINDOW), []);

  // Without a cadence there is no length to compute with, and `lengthDays` is never
  // guessed: a fourteen-day window nobody configured is worse than none.
  assert.equal(sprintWindow(sprints[0], null), null);
});

test('a window contains both of its boundaries, and reads a zone the way the lanes do', () => {
  const window = { start: '2026-02-02', end: '2026-02-15' };
  assert.equal(windowContains(window, '2026-02-02'), true);
  assert.equal(windowContains(window, '2026-02-15'), true);
  assert.equal(windowContains(window, '2026-02-01'), false);
  assert.equal(windowContains(window, '2026-02-16'), false);
  // Not a day at all is not „the first day": `""`, `"heute"` and a missing value all
  // have to answer false, or an item with no date lands in whatever window comes first.
  for (const value of ['', 'heute', '2026-13-40', null, undefined, 5]) {
    assert.equal(windowContains(window, value), false, String(value));
  }
  // The zone is honoured, because the viewer draws this instant on Feb 16 in
  // Europe/Berlin (the tests are pinned to it). A second date parser here would put the
  // bar in one window and the sum in another, and both halves would look right.
  assert.equal(windowContains(window, '2026-02-15T23:00:00Z'), false);
  assert.equal(windowContains({ start: '2026-02-16', end: '2026-03-01' }, '2026-02-15T23:00:00Z'), true);
});

test('the suggestion is the sprint whose window contains the start, boundaries included', () => {
  const file = withRows({
    sprints: [
      sprintRow('s1', { start: '2026-01-05', end: '2026-01-18' }),
      sprintRow('s2', { start: '2026-01-19', end: '2026-02-01' }),
      // Undated: its window is the raster's third, 2026-02-02 to 2026-02-15.
      sprintRow('s3'),
    ],
  });
  const sprints = readSprints(file);
  const suggest = (start?: string) => suggestedSprintId(sprints, raster, item({ start }));
  assert.equal(suggest('2026-01-05'), 's1');
  assert.equal(suggest('2026-01-18'), 's1');
  assert.equal(suggest('2026-01-19'), 's2');
  assert.equal(suggest('2026-02-02'), 's3');
  assert.equal(suggest('2026-02-15'), 's3');
  // Before every window and after every window: no suggestion rather than the nearest
  // one, and there is no „Sprint 0".
  assert.equal(suggest('2025-12-15'), null);
  assert.equal(suggest('2026-02-16'), null);
  assert.equal(suggest(undefined), null);
  assert.equal(suggest('bald'), null);
  assert.equal(suggestedSprintId(sprints, null, item({ start: '2026-02-02' })), null);
});

test('overlapping windows resolve to the earlier row', () => {
  // Impossible in data the host wrote, reachable by hand. „The earlier row" is at least
  // an order a reader can predict; picking the shorter or the later one would make the
  // lane an item sits in depend on a rule nobody can see.
  const sprints = readSprints(
    withRows({
      sprints: [
        sprintRow('s1', { start: '2026-01-05', end: '2026-01-31' }),
        sprintRow('s2', { start: '2026-01-19', end: '2026-02-01' }),
      ],
    }),
  );
  assert.equal(suggestedSprintId(sprints, raster, item({ start: '2026-01-20' })), 's1');
});

test('the assignment is a trimmed row id, and nothing else', () => {
  assert.equal(assignedSprintId(item({ metadata: { [SPRINT_KEY]: '  s1 ' } })), 's1');
  assert.equal(assignedSprintId(item({ metadata: { [SPRINT_KEY]: '   ' } })), null);
  assert.equal(assignedSprintId(item({ metadata: { [SPRINT_KEY]: 3 } })), null);
  assert.equal(assignedSprintId(item()), null);
  assert.equal(assignedSprintId(null), null);

  const items = [assigned('a', 's1'), assigned('b', 's2'), assigned('c', 's1'), item({ id: 'd' })];
  assert.deepEqual(itemsOfSprint(items, 's1').map((i) => i.id), ['a', 'c']);
  assert.deepEqual(itemsOfSprint(null, 's1'), []);
});

test('„done" is the core item status, with its own defaulting', () => {
  assert.equal(isDone(item({ status: 'Done' })), true);
  // Case-insensitive on input, because that is what the core accepts; an absent status
  // is `Open`, and the plugin must not decide that differently from the item form.
  assert.equal(isDone(item({ status: 'done' as never })), true);
  assert.equal(isDone(item({ status: 'Doing' })), false);
  assert.equal(isDone(item()), false);
  assert.equal(isDone(null), false);
});

test('a usable estimate is a plain positive decimal, and nothing Number() also reads', () => {
  const estimate = (raw: unknown) => estimateOf(item({ metadata: { storyPoints: raw } }));
  assert.equal(estimate('8'), 8);
  assert.equal(estimate('8.5'), 8.5);
  assert.equal(estimate(13), 13);
  // `"0x10"` and `"1e3"` are what bare `Number()` reads as 16 and 1000, which turns a
  // typo into a capacity figure. Zero cannot move a sum, so counting it would only take
  // the item out of the notes.
  for (const raw of ['', ' ', 'XL', '0x10', '1e3', 0, -3, '0', ['8'], null, {}]) {
    assert.equal(estimate(raw), null, JSON.stringify(raw));
  }
  assert.equal(estimateOf(item()), null);
});

test('the capacity unit falls back to the config, and the config to points', () => {
  const sprint = (over: Partial<Sprint> = {}): Sprint =>
    ({ id: 's1', position: 1, name: 'S1', state: 'planned', ...over }) as Sprint;
  const hours = withRows({}, {}, { ...RASTER, estimateUnit: 'hours' });
  assert.equal(readEstimateUnit(hours), 'hours');
  assert.equal(readEstimateUnit(withRows({})), 'points');
  assert.equal(readEstimateUnit(withRows({}, {}, { ...RASTER, estimateUnit: 'bananas' })), 'points');
  assert.equal(readEstimateUnit(null), 'points');
  assert.equal(capacityUnitOf(sprint({ capacityUnit: 'items' }), hours), 'items');
  assert.equal(capacityUnitOf(sprint(), hours), 'hours');
  assert.equal(capacityUnitOf(sprint(), null), 'points');
  assert.deepEqual([...CAPACITY_UNITS], ['points', 'hours', 'items']);
});

test('the active sprint is the single one, and null when there is none or several', () => {
  const of = (...states: string[]) =>
    readSprints(withRows({ sprints: states.map((state, i) => sprintRow(`s${i + 1}`, { state })) }));

  assert.equal(activeSprint(of('closed', 'active', 'planned'))?.id, 's2');
  assert.deepEqual(activeSprints(of('closed', 'planned')), []);
  assert.equal(activeSprint(of('closed', 'planned')), null);
  // Two actives: „which one" has no answer, and picking one hides the fault that the
  // warning is about.
  assert.deepEqual(activeSprints(of('active', 'active')).map((s) => s.id), ['s1', 's2']);
  assert.equal(activeSprint(of('active', 'active')), null);
});

test('a capacity is suggested from the last three closed reports, or not at all', () => {
  const closed = (id: string) => sprintRow(id, { state: 'closed' });
  const report = (id: string, completed: number) =>
    row(id, { sprintId: id, scopeAtStart: completed, scopeAtClose: completed, completed, carried: 0 });
  const file = withRows({
    sprints: [closed('s1'), closed('s2'), closed('s3'), closed('s4'), sprintRow('s5', { state: 'active' })],
    reports: [report('s1', 40), report('s2', 10), report('s3', 20), report('s4', 30)],
  });
  // The last three, so a team that changed pace is not averaged against a quarter ago.
  assert.equal(suggestedCapacity(readSprints(file), readReports(file)), 20);

  // No closed sprint with a report is no evidence, and a suggestion out of none is a
  // guess wearing a figure's clothes.
  const nothing = withRows({ sprints: [sprintRow('s1', { state: 'active' })], reports: [report('s1', 30)] });
  assert.equal(suggestedCapacity(readSprints(nothing), readReports(nothing)), null);
  assert.equal(suggestedCapacity([], []), null);
});

test('an active sprint with no goal is warned about, a planned one is not', () => {
  // Canon requires a goal and no product enforces one, so it is nullable in storage and
  // named while it is the change-control criterion. Demanding it at write time would
  // make the row impossible to create before the planning meeting.
  const file = withRows({
    sprints: [sprintRow('s1', { state: 'active' }), sprintRow('s2', { state: 'planned' })],
  });
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), [{ kind: 'active-sprint-without-goal', sprintId: 's1' }]);

  const withGoal = withRows({ sprints: [sprintRow('s1', { state: 'active', goal: 'Die Suche steht' })] });
  assert.deepEqual(sprintWarnings(withGoal, BEFORE_ANY_WINDOW), []);
});

test('no active sprint at all warns about nothing', () => {
  // Deliberately not a warning: nothing in the host fires at a sprint boundary, so the
  // plugin cannot know whether a sprint should have started, and a plan whose first
  // sprint has not begun is the normal state of a plan.
  const file = withRows({
    sprints: [sprintRow('s1', { state: 'closed' }), sprintRow('s2', { state: 'planned' })],
    reports: [row('s1', { sprintId: 's1', scopeAtStart: 8, scopeAtClose: 8, completed: 8, carried: 0 })],
  });
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), []);
  // And a timeline with no sprint rows at all says nothing either, rather than
  // complaining about a plugin somebody has only just switched on.
  assert.deepEqual(sprintWarnings(withRows({}), BEFORE_ANY_WINDOW), []);
  assert.deepEqual(sprintWarnings(null, BEFORE_ANY_WINDOW), []);
});

test('a second active sprint is reported once, with both ids', () => {
  // „A new Sprint starts immediately after the conclusion of the previous Sprint": one
  // at a time. The host enforces no cross-row rule, so this is where the violation
  // becomes visible.
  const file = withRows({
    sprints: [
      sprintRow('s1', { state: 'active', goal: 'A' }),
      sprintRow('s2', { state: 'active', goal: 'B' }),
      sprintRow('s3', { state: 'active' }),
    ],
  });
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), [
    { kind: 'active-sprint-without-goal', sprintId: 's3' },
    { kind: 'several-active-sprints', sprintIds: ['s1', 's2', 's3'] },
  ]);
});

test('an item whose dates fall outside its assigned sprint is named, not moved', () => {
  // Both silent fixes are wrong: re-dating the item edits a plan the user made, dropping
  // the assignment edits a commitment the team made.
  const file = withRows(
    {
      sprints: [
        sprintRow('s1', { state: 'closed', start: '2026-01-05', end: '2026-01-18' }),
        sprintRow('s2', { state: 'active', goal: 'A', start: '2026-01-19', end: '2026-02-01' }),
      ],
    },
    {
      items: [
        // Inside, including on the last day.
        assigned('a', 's2', { start: '2026-02-01', metadata: { storyPoints: '3' } }),
        // Starts before its sprint: carried over without being re-dated.
        assigned('b', 's2', { start: '2026-01-14', metadata: { storyPoints: '5' } }),
        // Starts inside but carries an end past the window.
        assigned('c', 's2', { start: '2026-01-26', end: '2026-02-09', metadata: { storyPoints: '8' } }),
        // No dates at all: nothing to disagree with, so no warning.
        assigned('d', 's2', { metadata: { storyPoints: '2' } }),
      ],
    },
  );
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), [
    {
      kind: 'item-outside-sprint-window',
      itemId: 'b',
      content: 'x',
      sprintId: 's2',
      window: { start: '2026-01-19', end: '2026-02-01', source: 'row' },
    },
    {
      kind: 'item-outside-sprint-window',
      itemId: 'c',
      content: 'x',
      sprintId: 's2',
      window: { start: '2026-01-19', end: '2026-02-01', source: 'row' },
    },
  ]);
});

test('an item in a sprint with no usable estimate is named, whatever the sprint state', () => {
  const file = withRows(
    { sprints: [sprintRow('s1', { state: 'active', goal: 'A', start: '2026-01-05', end: '2026-01-18' })] },
    {
      items: [
        assigned('a', 's1', { start: '2026-01-06', metadata: { storyPoints: '5' } }),
        assigned('b', 's1', { start: '2026-01-06' }),
        assigned('c', 's1', { start: '2026-01-06', metadata: { storyPoints: 'XL' } }),
        // Unassigned: an estimate is a question for work somebody committed to.
        item({ id: 'd', start: '2026-01-06' }),
      ],
    },
  );
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), [
    { kind: 'item-without-estimate', itemId: 'b', content: 'x', sprintId: 's1' },
    { kind: 'item-without-estimate', itemId: 'c', content: 'x', sprintId: 's1' },
  ]);
});

test('an assignment naming no row is left to the field, not reported as a sprint problem', () => {
  // The sprint may have been deleted; the item then carries a value that resolves to
  // nothing, which the select shows as a value with no option. Warning about it here
  // would name a sprint that does not exist.
  const file = withRows({ sprints: [sprintRow('s1', { state: 'planned' })] }, { items: [assigned('a', 'geloescht')] });
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), []);
});

test('two windows covering the same days are a warning that names both sprints', () => {
  // Nothing else can see it: the item below sits inside its OWN sprint's window, so
  // „outside the window" stays silent, while the derived `sprintByDate` names the
  // earlier row, because the first match wins. The two dimensions then disagree with no
  // fault anywhere to read.
  const file = withRows(
    {
      sprints: [
        sprintRow('s1', { start: '2026-01-05', end: '2026-01-25' }),
        sprintRow('s2', { start: '2026-01-19', end: '2026-02-01' }),
      ],
    },
    { items: [assigned('a', 's2', { start: '2026-01-20', metadata: { storyPoints: '5' } })] },
  );
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), [
    {
      kind: 'overlapping-sprint-windows',
      sprintIds: ['s1', 's2'],
      overlap: { start: '2026-01-19', end: '2026-01-25' },
    },
  ]);
  // The disagreement the warning is about, so the two statements stay side by side.
  assert.equal(assignedSprintId(file.items![0]), 's2');
  assert.equal(suggestedSprintId(readSprints(file), raster, file.items![0]), 's1');

  // Touching windows are not overlapping ones: a sprint begins when the previous ends.
  const touching = withRows({
    sprints: [
      sprintRow('s1', { start: '2026-01-05', end: '2026-01-18' }),
      sprintRow('s2', { start: '2026-01-19', end: '2026-02-01' }),
    ],
  });
  assert.deepEqual(sprintWarnings(touching, BEFORE_ANY_WINDOW), []);
});

test('a close before the sprint began is a warning, with both dates', () => {
  // One of the two is wrong and no figure here can say which, so both are handed over:
  // the frozen curve then lies outside the window it would be drawn in.
  const file = withRows({
    sprints: [sprintRow('s1', { state: 'closed', start: '2026-02-02', end: '2026-02-15', closedOn: '2026-01-30' })],
  });
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), [
    { kind: 'closed-before-start', sprintId: 's1', start: '2026-02-02', closedOn: '2026-01-30' },
  ]);
  // Closed early but after the start is the normal case, and canon allows it.
  const early = withRows({
    sprints: [sprintRow('s1', { state: 'closed', start: '2026-02-02', end: '2026-02-15', closedOn: '2026-02-11' })],
  });
  assert.deepEqual(sprintWarnings(early, BEFORE_ANY_WINDOW), []);
});

test('a row id twice in one collection is a warning, in every collection', () => {
  // The first row wins, deterministically, and the second then exists in the file and in
  // nothing else: not in the options, not in a sum, not in the report a sprint reads.
  const file = withRows({
    sprints: [sprintRow('s1'), sprintRow('s1', { name: 'zweite' })],
    passes: [
      row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' }),
      row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'carried', recordedOn: '2026-01-18' }),
    ],
    reports: [
      row('s1', { sprintId: 's1', scopeAtStart: 8, scopeAtClose: 8, completed: 8, carried: 0 }),
      row('s1', { sprintId: 's1', scopeAtStart: 3, scopeAtClose: 3, completed: 3, carried: 0 }),
    ],
  });
  // Filtered to the kind under test: these rows also describe a close that stopped
  // halfway, which is its own warning, and asserting the whole list would make this test
  // fail on a finding it is not about.
  assert.deepEqual(
    sprintWarnings(file, BEFORE_ANY_WINDOW).filter((w) => w.kind === 'duplicate-row-id'),
    [
      { kind: 'duplicate-row-id', collection: 'sprints', rowId: 's1' },
      { kind: 'duplicate-row-id', collection: 'passes', rowId: 'a:s1' },
      { kind: 'duplicate-row-id', collection: 'reports', rowId: 's1' },
    ],
  );

  // Two reports for one sprint under DIFFERENT row ids is the other half: `keyFields`
  // makes the host replace a report rather than add one, so this only arrives by hand,
  // and `reportOfSprint` then takes the first of two sets of frozen figures.
  const twoReports = withRows({
    sprints: [sprintRow('s1', { state: 'closed' })],
    reports: [
      row('s1', { sprintId: 's1', scopeAtStart: 8, scopeAtClose: 8, completed: 8, carried: 0 }),
      row('s1-alt', { sprintId: 's1', scopeAtStart: 3, scopeAtClose: 3, completed: 3, carried: 0 }),
    ],
  });
  assert.deepEqual(sprintWarnings(twoReports, BEFORE_ANY_WINDOW), [
    { kind: 'several-reports-for-one-sprint', sprintId: 's1', rowIds: ['s1', 's1-alt'] },
  ]);
});

test('a history row pointing at no sprint is finally read by something', () => {
  // `readPasses` keeps such a row „so it stays visible", which is only true once
  // something looks at it. This is that something.
  const file = withRows({
    sprints: [sprintRow('s1')],
    passes: [
      row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' }),
      row('b:geloescht', { itemId: 'b', sprintId: 'geloescht', outcome: 'carried', recordedOn: '2026-01-18' }),
    ],
  });
  const warnings = sprintWarnings(file, BEFORE_ANY_WINDOW);
  assert.deepEqual(
    warnings.filter((w) => w.kind === 'pass-without-sprint'),
    [{ kind: 'pass-without-sprint', rowId: 'b:geloescht', itemId: 'b', sprintId: 'geloescht' }],
  );
  // The pass that DOES point at a sprint is a close that stopped halfway, and that is
  // reported too: history rows for a sprint still calling itself open.
  assert.deepEqual(
    warnings.filter((w) => w.kind === 'close-incomplete'),
    [{ kind: 'close-incomplete', sprintId: 's1', state: 'planned', passes: 1, report: false }],
  );
});

test('an item carried out of an earlier sprint is readable on the sprint that holds it now', () => {
  // The other half of giving `passes` a reader: part of this sprint's scope was already
  // committed once, and no current figure says so.
  const file = withRows(
    {
      sprints: [
        sprintRow('s1', { state: 'closed', start: '2026-01-05', end: '2026-01-18' }),
        sprintRow('s2', { state: 'closed', start: '2026-01-19', end: '2026-02-01' }),
        sprintRow('s3', { state: 'active', goal: 'A', start: '2026-02-02', end: '2026-02-15' }),
      ],
      passes: [
        row('q:s1', { itemId: 'q', sprintId: 's1', outcome: 'carried', recordedOn: '2026-01-18', estimateAtClose: 5 }),
        row('q:s2', { itemId: 'q', sprintId: 's2', outcome: 'carried', recordedOn: '2026-02-01' }),
        row('d:s2', { itemId: 'd', sprintId: 's2', outcome: 'done', recordedOn: '2026-02-01' }),
      ],
    },
    {
      items: [
        assigned('q', 's3', { start: '2026-01-28', metadata: { storyPoints: '5' } }),
        assigned('d', 's3', { start: '2026-02-03', metadata: { storyPoints: '3' } }),
      ],
    },
  );
  const sprints = readSprints(file);
  const passes = readPasses(file);
  assert.deepEqual(carriedInto(sprints, passes, file.items, 's3'), [
    { itemId: 'q', fromSprintId: 's1', recordedOn: '2026-01-18', estimateAtClose: 5 },
    { itemId: 'q', fromSprintId: 's2', recordedOn: '2026-02-01', estimateAtClose: undefined },
  ]);
  // „done" is not „carried", and a sprint that received nothing says nothing.
  assert.deepEqual(carriedInto(sprints, passes, file.items, 's1'), []);
  assert.deepEqual(carriedInto(sprints, passes, file.items, 'weg'), []);
  // A `carried` row of a LATER sprint is not something this one received: history does
  // not run backwards.
  const later = withRows(
    {
      sprints: [sprintRow('s1', { start: '2026-01-05', end: '2026-01-18' }), sprintRow('s2')],
      passes: [row('q:s2', { itemId: 'q', sprintId: 's2', outcome: 'carried', recordedOn: '2026-02-01' })],
    },
    { items: [assigned('q', 's1', { start: '2026-01-06' })] },
  );
  assert.deepEqual(carriedInto(readSprints(later), readPasses(later), later.items, 's1'), []);
});

test('an item with no id is still nameable in a warning', () => {
  // `id` is optional in this data model, so a warning that could only carry one would
  // silently skip exactly the items a list view creates.
  const file = withRows(
    { sprints: [sprintRow('s1', { state: 'planned', start: '2026-01-05', end: '2026-01-18' })] },
    { items: [item({ content: 'Ohne Id', start: '2026-02-02', metadata: { [SPRINT_KEY]: 's1' } })] },
  );
  assert.deepEqual(sprintWarnings(file, BEFORE_ANY_WINDOW), [
    {
      kind: 'item-outside-sprint-window',
      itemId: null,
      content: 'Ohne Id',
      sprintId: 's1',
      window: { start: '2026-01-05', end: '2026-01-18', source: 'row' },
    },
    { kind: 'item-without-estimate', itemId: null, content: 'Ohne Id', sprintId: 's1' },
  ]);
});

// ---- the window that has passed ---------------------------------------------

test('an active sprint whose window has ended is a warning, against the day it is asked for', () => {
  // The one finding here that needs a day, and the reason `sprintWarnings` takes one.
  // Nothing in this product fires at a sprint boundary, so this is the state a plan drifts
  // into: the shipped example's active sprint ended in February and the page said „aktiv"
  // and nothing else, while `sprint_status` said it precisely — the one question the view
  // and the verb answered differently.
  const file = withRows({
    sprints: [sprintRow('s1', { state: 'active', goal: 'A', start: '2026-02-02', end: '2026-02-15' })],
  });
  assert.deepEqual(sprintWarnings(file, '2026-02-15'), [], 'the last day is still inside the window');
  assert.deepEqual(sprintWarnings(file, '2026-02-16'), [
    {
      kind: 'sprint-window-past',
      sprintId: 's1',
      state: 'active',
      window: { start: '2026-02-02', end: '2026-02-15', source: 'row' },
      days: 1,
      day: '2026-02-16',
    },
  ]);
  // The count is whole days and comes from the same arithmetic every other date question
  // here goes through, clock change included (`raster.test.ts` pins that).
  const late = sprintWarnings(file, '2026-08-13');
  assert.equal(late.length, 1);
  assert.equal(late[0].kind === 'sprint-window-past' && late[0].days, 179);
});

test('a planned sprint whose window is past is the same warning, a closed one is not', () => {
  // Two states reach it and two do not: a closed or cancelled sprint is MEANT to be over,
  // so reporting its window as passed would warn about every finished sprint forever.
  const rows = (state: string) => withRows({ sprints: [sprintRow('s1', { state, start: '2026-02-02', end: '2026-02-15' })] });
  assert.equal(sprintWarnings(rows('planned'), '2026-03-01').filter((w) => w.kind === 'sprint-window-past').length, 1);
  assert.deepEqual(sprintWarnings(rows('closed'), '2026-03-01'), []);
  assert.deepEqual(sprintWarnings(rows('cancelled'), '2026-03-01'), []);
});

test('a window nobody wrote is not late, and a day nobody can read asks nothing', () => {
  // A row with no dates takes the cadence window at its position, and that is the raster's
  // *suggestion* rather than a date the team committed to. Quoting it back as a deadline
  // they missed is the false alarm this function has already been fixed for once, on the
  // window side — and „the plan has not started" is the normal state of a plan, which is
  // why „no active sprint" is not a warning either.
  const cadence = withRows({ sprints: [sprintRow('s1', { state: 'planned' })] });
  assert.deepEqual(sprintWarnings(cadence, '2026-08-13'), []);
  // A written start with a computed end IS late: half of that window is the team's own.
  const half = withRows({ sprints: [sprintRow('s1', { state: 'planned', start: '2026-02-02' })] });
  const found = sprintWarnings(half, '2026-08-13');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind === 'sprint-window-past' && found[0].window.source, 'end-from-cadence');
  // Every other warning is clock-free, so an unusable day drops this finding and keeps them.
  const both = withRows({
    sprints: [sprintRow('s1', { state: 'active', start: '2026-02-02', end: '2026-02-15' })],
  });
  for (const day of ['', '   ', 'heute', '2026-13-40']) {
    assert.deepEqual(sprintWarnings(both, day), [{ kind: 'active-sprint-without-goal', sprintId: 's1' }], day);
  }
});

// ---- what the view asks this module -----------------------------------------

test('a past sprint without a report has no figures rather than live ones', () => {
  // Setting the status to „abgeschlossen" in the form was enough to reach a live
  // recomputation: the boxes then showed recomputed numbers beside an empty plot, which is
  // the freeze rule quietly not holding. It is a fault in the data, not a source of
  // figures, so it is a third answer rather than a fallback to the first.
  const sprint = (state: string): Sprint => readSprints(withRows({ sprints: [sprintRow('s1', { state })] }))[0];
  const report = { id: 's1', sprintId: 's1', series: [] };
  assert.equal(figuresSource(sprint('active'), null), 'live');
  assert.equal(figuresSource(sprint('active'), report), 'live');
  assert.equal(figuresSource(sprint('closed'), report), 'frozen');
  assert.equal(figuresSource(sprint('closed'), null), 'report-missing');
  assert.equal(figuresSource(sprint('cancelled'), null), 'report-missing');
});

test('the close refuses when the row it re-reads is no longer the one it decided to close', () => {
  // The close re-reads the row's version immediately before the state patch, because on a
  // local file source the version is the FILE's mtime: its own six writes invalidate the
  // one read at page load. Re-reading must not become a way around the lock, so the fresh
  // row has to prove it is still the same sprint — the state, the window and the capacity
  // are what the frozen report was computed from.
  const decided = readSprints(
    withRows({ sprints: [sprintRow('s1', { state: 'active', start: '2026-02-02', end: '2026-02-15', capacity: 20 })] }),
  )[0];
  const changed = (over: Record<string, unknown>) =>
    readSprints(
      withRows({
        sprints: [
          sprintRow('s1', { state: 'active', start: '2026-02-02', end: '2026-02-15', capacity: 20, ...over }),
        ],
      }),
    )[0];
  assert.equal(closeObjection(decided, changed({})), null, 'an untouched row is closed');
  assert.deepEqual(closeObjection(decided, null), { kind: 'sprint-gone' });
  assert.deepEqual(closeObjection(decided, changed({ state: 'closed' })), { kind: 'state-changed', state: 'closed' });
  assert.deepEqual(closeObjection(decided, changed({ end: '2026-02-22' })), { kind: 'window-changed' });
  assert.deepEqual(closeObjection(decided, changed({ start: '2026-02-03' })), { kind: 'window-changed' });
  assert.deepEqual(closeObjection(decided, changed({ capacity: 25 })), { kind: 'capacity-changed' });
  // The unit too: it decides what the frozen figures count, so a changed one makes the
  // report about to be written a report about something else.
  assert.deepEqual(closeObjection(decided, changed({ capacityUnit: 'hours' })), { kind: 'capacity-changed' });
});

test('an unfinished close stays unfinished until the state moves', () => {
  // What decides how long a notice about a half-finished close stays on screen. Cleared on
  // the next render, it was a partial close recorded nowhere while its `passes` rows sat on
  // the server and the sprint still said „aktiv".
  const half = withRows({
    sprints: [sprintRow('s1', { state: 'active', goal: 'A', start: '2026-01-05', end: '2026-01-18' })],
    passes: [row('s1:a', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' })],
  });
  const read = (file: TimelineFile) =>
    closeIncomplete(readSprints(file), readPasses(file), readReports(file), 's1');
  assert.equal(read(half), true);
  // The report alone counts as well: a sprint with no items writes no history row, so the
  // report is the only thing a stopped close leaves behind.
  assert.equal(
    read(
      withRows({
        sprints: [sprintRow('s1', { state: 'active', goal: 'A' })],
        reports: [row('r1', { sprintId: 's1', completed: 0 })],
      }),
    ),
    true,
  );
  // Resolved by the STATE, not by the rows: a retry is idempotent, so the rows of a
  // finished close are the record rather than damage.
  assert.equal(
    read(
      withRows({
        sprints: [sprintRow('s1', { state: 'closed', start: '2026-01-05', end: '2026-01-18' })],
        passes: [row('s1:a', { itemId: 'a', sprintId: 's1', outcome: 'done' })],
      }),
    ),
    false,
  );
  // Nothing written yet, and a sprint that is gone entirely: neither is a situation to
  // keep a notice about.
  assert.equal(read(withRows({ sprints: [sprintRow('s1', { state: 'active', goal: 'A' })] })), false);
  assert.equal(read(withRows({ sprints: [sprintRow('s2')] })), false);
});

test('a close records every item that can be recorded and names the ones that cannot', () => {
  // `passes` is keyed on the item id, so an item without one has no row: two of them would
  // collide under one key. The close skipped them silently while `members.length` stayed the
  // denominator of every sentence it printed.
  const items = [item({ id: 'a' }), item({ content: 'Ohne Id' }), item({ id: '   ' })];
  const { recordable, skipped } = recordableItems(items);
  assert.deepEqual(recordable.map((i) => i.id), ['a']);
  assert.deepEqual(skipped.map((i) => i.content), ['Ohne Id', 'x']);
  assert.deepEqual(recordableItems([]), { recordable: [], skipped: [] });
});

test('a new sprint takes its id and its name from one counter', () => {
  // Two counters — the first free `sprint-N` for the id, `sprints.length + 1` for the name —
  // wrote `id: sprint-2` named „Sprint 3" on a timeline holding `sprint-1` and `sprint-5`.
  assert.deepEqual(nextSprint([]), { id: 'sprint-1', name: 'Sprint 1' });
  assert.deepEqual(nextSprint(['sprint-1', 'sprint-5']), { id: 'sprint-2', name: 'Sprint 2' });
  assert.deepEqual(nextSprint(['sprint-1', 'sprint-2', 'sprint-3']), { id: 'sprint-4', name: 'Sprint 4' });
});

test('the reader state of one timeline is keyed on that timeline', () => {
  // Sprint ids are minted per timeline (`sprint-1…N`), so one instance-wide key made a
  // selection in one timeline resolve in the next — the class of key the root AGENTS.md
  // flags. The host API hands a plugin no timeline id, so the identity comes out of the
  // snapshot.
  assert.equal(timelineScope(withRows({ sprints: [sprintRow('s1')] }, { name: 'Lieferplan' })), 'Lieferplan');
  assert.equal(timelineScope(withRows({ sprints: [sprintRow('s1'), sprintRow('s2')] })), 's1|s2');
  // No name and no rows is no identity at all, and the empty string says so: a caller
  // stores nothing under it, because an instance-wide bucket is the bug.
  assert.equal(timelineScope(withRows({})), '');
  assert.equal(timelineScope(null), '');
});

// ---- the edit form's rules --------------------------------------------------

test('the form accepts exactly the capacities the schema and the row reader accept', () => {
  // The view invented „greater than 0" of its own, so `0.005` passed the form and came back
  // as `400 row.capacity: below 0.01` — an English field path in a German interface. And a
  // `number` input hands `.value` back as "" for anything it cannot parse, so „0x10" was
  // saved as `capacity: null` with nothing said.
  const sprint = readSprints(withRows({ sprints: [sprintRow('s1', { state: 'planned' })] }))[0];
  const save = (capacity: string) =>
    sprintEditPatch(sprint, [sprint], { ...FORM, name: 'Sprint 1', capacity });
  assert.equal(save('20').patch?.capacity, 20);
  assert.equal(save(' 20.5 ').patch?.capacity, 20.5);
  assert.equal(save('0.01').patch?.capacity, MIN_CAPACITY);
  // An empty field clears the value, which is what `null` means in a patch.
  assert.equal(save('').patch?.capacity, null);
  assert.deepEqual(save('0.005').refusal, { kind: 'capacity-below-minimum', value: 0.005 });
  assert.deepEqual(save('0').refusal, { kind: 'capacity-below-minimum', value: 0 });
  assert.deepEqual(save('-5').refusal, { kind: 'capacity-below-minimum', value: -5 });
  // The FORMAT is what is wrong with these two, and 1000 is a perfectly good capacity:
  // „muss eine Zahl größer als 0 sein" described neither.
  assert.deepEqual(save('0x10').refusal, { kind: 'capacity-not-a-decimal', value: '0x10' });
  assert.deepEqual(save('1e3').refusal, { kind: 'capacity-not-a-decimal', value: '1e3' });
  assert.deepEqual(save('zwanzig').refusal, { kind: 'capacity-not-a-decimal', value: 'zwanzig' });
});

test('a state the schema does not know is refused rather than replaced', () => {
  // It used to fall back to the sprint's current state and report „gespeichert", which is a
  // write that lies about what it wrote.
  const sprint = readSprints(withRows({ sprints: [sprintRow('s1', { state: 'planned' })] }))[0];
  assert.deepEqual(sprintEditPatch(sprint, [sprint], { ...FORM, name: 'A', state: 'erledigt' }).refusal, {
    kind: 'unknown-state',
    value: 'erledigt',
  });
  assert.deepEqual(sprintEditPatch(sprint, [sprint], { ...FORM, name: 'A', state: '' }).refusal, {
    kind: 'unknown-state',
    value: '',
  });
  for (const state of SPRINT_STATES) {
    const edit = { ...FORM, name: 'A', state, start: '2026-01-05', end: '2026-01-18' };
    assert.equal(sprintEditPatch(sprint, [sprint], edit).patch?.state, state);
  }
});

test('the form refuses what a sprint may not be: nameless, second active, or running without a window', () => {
  const file = withRows({
    sprints: [sprintRow('s1', { state: 'planned' }), sprintRow('s2', { state: 'active', goal: 'A' })],
  });
  const sprints = readSprints(file);
  const edit = (over: Partial<typeof FORM>) => sprintEditPatch(sprints[0], sprints, { ...FORM, name: 'A', ...over });
  assert.deepEqual(edit({ name: '  ' }).refusal, { kind: 'name-missing' });
  // At most one active sprint per timeline, and the refusal names the other one: the host
  // enforces no rule across rows, so this is the plugin's own.
  assert.deepEqual(edit({ state: 'active', start: '2026-01-05', end: '2026-01-18' }).refusal, {
    kind: 'second-active-sprint',
    sprintId: 's2',
  });
  // The sprint that IS the active one may be saved while staying active.
  assert.equal(
    sprintEditPatch(sprints[1], sprints, { ...FORM, name: 'B', state: 'active', start: '2026-01-05', end: '2026-01-18' })
      .patch?.state,
    'active',
  );
  assert.deepEqual(edit({ start: '2026-01-18', end: '2026-01-05' }).refusal, { kind: 'end-before-start' });
  // A fixed window is what makes a sprint one, and it is the precondition for the axis, so
  // „aktiv" and „ohne Zeitraum" never coexist in stored data. Asked of the sprint that is
  // already active, so the „second active" refusal above is not what answers.
  assert.deepEqual(
    sprintEditPatch(sprints[1], sprints, { ...FORM, name: 'B', state: 'active', start: '2026-01-05' }).refusal,
    { kind: 'active-without-window' },
  );
});

test('an emptied field clears its key rather than storing an empty string', () => {
  // The host's rule for a patch: `null` removes. Storing "" instead is a value every reader
  // then has to special-case.
  const sprint = readSprints(withRows({ sprints: [sprintRow('s1', { state: 'planned' })] }))[0];
  const { patch } = sprintEditPatch(sprint, [sprint], { ...FORM, name: 'A' });
  assert.deepEqual(patch, {
    name: 'A',
    state: 'planned',
    goal: null,
    start: null,
    end: null,
    capacity: null,
    capacityUnit: null,
    note: null,
  });
  const filled = sprintEditPatch(sprint, [sprint], {
    name: ' A ',
    goal: ' Ziel ',
    start: '2026-01-05',
    end: '2026-01-18',
    state: 'planned',
    capacity: '18',
    capacityUnit: 'hours',
    note: ' Retro ',
  });
  assert.deepEqual(filled.patch, {
    name: 'A',
    state: 'planned',
    goal: 'Ziel',
    start: '2026-01-05',
    end: '2026-01-18',
    capacity: 18,
    capacityUnit: 'hours',
    note: 'Retro',
  });
  // A unit the schema does not know clears the field instead of being stored: the config's
  // default is then what the figures are counted in, which is a defined answer.
  assert.equal(
    sprintEditPatch(sprint, [sprint], { ...FORM, name: 'A', capacityUnit: 'bananen' }).patch?.capacityUnit,
    null,
  );
});

test('a close that stopped halfway is readable from the rows, not only from the session that saw it', () => {
  // The situation this reports outlives the page that produced it: the rows sit on the
  // server, the sprint still says it is running, and before this warning existed only the
  // notice in that one browser tab said so. A reload, another machine or an agent saw
  // nothing at all.
  const started = withRows({
    sprints: [sprintRow('s1', { state: 'active' })],
    passes: [row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' })],
  });
  assert.deepEqual(
    sprintWarnings(started, BEFORE_ANY_WINDOW).filter((w) => w.kind === 'close-incomplete'),
    [{ kind: 'close-incomplete', sprintId: 's1', state: 'active', passes: 1, report: false }],
  );

  // The report landed and the state did not: the count says which of the three steps are
  // done, because that is what tells the reader what a retry will find.
  const reported = withRows({
    sprints: [sprintRow('s1', { state: 'active' })],
    passes: [row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' })],
    reports: [row('s1', { sprintId: 's1', scopeAtStart: 8, scopeAtClose: 8, completed: 8, carried: 0 })],
  });
  assert.deepEqual(
    sprintWarnings(reported, BEFORE_ANY_WINDOW).filter((w) => w.kind === 'close-incomplete'),
    [{ kind: 'close-incomplete', sprintId: 's1', state: 'active', passes: 1, report: true }],
  );

  // A finished close is not a fault. Neither is a cancelled sprint carrying its history.
  for (const state of ['closed', 'cancelled'] as const) {
    const done = withRows({
      sprints: [sprintRow('s1', { state })],
      passes: [row('a:s1', { itemId: 'a', sprintId: 's1', outcome: 'done', recordedOn: '2026-01-18' })],
      reports: [row('s1', { sprintId: 's1', scopeAtStart: 8, scopeAtClose: 8, completed: 8, carried: 0 })],
    });
    assert.deepEqual(sprintWarnings(done, BEFORE_ANY_WINDOW).filter((w) => w.kind === 'close-incomplete'), []);
  }
});

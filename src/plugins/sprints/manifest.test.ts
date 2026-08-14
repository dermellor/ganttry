import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPRINT_COLLECTIONS, sprintsManifest } from './manifest';
import { CONFIDENCE_KEY, SPRINT_BY_DATE_KEY, SPRINT_KEY, STORY_POINTS_KEY, sprintsFields } from './fields';
import { validateManifest, validateToolArgs } from '../../pluginHost/api';
// `viewAccessories` is not on the contract barrel (nothing a plugin writes calls it,
// the host does), so the test reaches for it where it lives. Asserting against the
// function `main.ts` asks is the point: an assertion on the declaration alone would
// restate it.
import { viewAccessories } from '../../pluginHost/manifest';
// The checks `scripts/db/plugin-api.ts` runs before it stores anything. Reaching past
// the contract barrel is allowed here and nowhere else: tests are exempt from the
// plugin-isolation check (`scripts/ci/check-plugin-isolation.mjs`), and asserting a
// declaration against the very functions the host applies is the point: an assertion
// on the schema's own keywords would only restate what is written above it.
import { unsupportedKeywords, validateRow } from '../../pluginHost/dataSchema';
import { rowIdFor } from '../../pluginHost/dataStore';

// Cheap, and it catches the one failure that is not local to this plugin: `register()`
// validates a manifest and THROWS at module load, so an invalid one here does not
// produce a plugin that fails to appear. It takes the whole app down, for everyone, on
// the first import.

const collection = (id: string) => {
  const found = (sprintsManifest.collections ?? []).find((c) => c.id === id);
  assert.ok(found, `no collection "${id}" declared`);
  return found;
};

test('the manifest validates, so the plugin can be registered', () => {
  const result = validateManifest(sprintsManifest);
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join('\n'));
});

test('the catalogue entry is complete enough to publish', () => {
  const entry = sprintsManifest.catalogue;
  assert.ok(entry, 'a plugin without a catalogue entry cannot be published');
  assert.ok(entry.summary.trim().length > 0);
  assert.ok(entry.keywords.length > 0);
  // A domain is a slug, so it has to be one here: a space would only fail at
  // `register()`, which is at module load and takes the app with it.
  assert.match(entry.domain, /^[a-z][a-z0-9-]*$/);
  assert.equal(entry.example, 'src:example-sprint-planung');
});

test('a velocity of 0 is refused by the schema, not stored as a configured plugin', () => {
  // `minimum: 0` let `configure_plugin` succeed for a value every verb then treats as
  // absent: a plugin that looks configured and is not, with nothing in the interface to
  // say so. An operator gets the rejected call instead.
  const schema = sprintsManifest.configSchema;
  assert.deepEqual(validateRow(schema, { start: '2026-01-05', velocity: 20 }, 'config'), []);
  assert.deepEqual(validateRow(schema, { start: '2026-01-05', velocity: 0.5 }, 'config'), []);
  for (const velocity of [0, -3]) {
    assert.equal(
      validateRow(schema, { start: '2026-01-05', velocity }, 'config').length > 0,
      true,
      `velocity ${velocity}`,
    );
  }
  // And the bound has to be one the host actually enforces: `exclusiveMinimum` is not in
  // the supported subset, so declaring it would be a constraint nothing checks and an
  // author would read it as one that is.
  assert.deepEqual(unsupportedKeywords(schema), []);
});

test('the estimate unit is a fixed set, because a sprint\'s capacity falls back to it', () => {
  const schema = sprintsManifest.configSchema;
  assert.deepEqual(validateRow(schema, { start: '2026-01-05', estimateUnit: 'hours' }, 'config'), []);
  assert.equal(validateRow(schema, { start: '2026-01-05', estimateUnit: 'bananas' }, 'config').length > 0, true);
});

test('the assignment is owned by the items, the suggestion by the code', () => {
  // `metadataKeys` is the list an uninstall purges off items, and the two sprint fields
  // are on opposite sides of it. The assignment IS stored, so leaving it behind would
  // leave every item carrying a row id whose rows were purged with the plugin. The
  // suggestion is computed on every build, so listing it would promise a cleanup that
  // has nothing to clean, and would suggest the value is stored, which is the exact
  // misunderstanding the derived seam exists to prevent.
  assert.deepEqual(sprintsManifest.metadataKeys, [SPRINT_KEY, STORY_POINTS_KEY, CONFIDENCE_KEY]);
  assert.equal(sprintsManifest.metadataKeys?.includes(SPRINT_BY_DATE_KEY), false);

  // The other half of the same statement: both fields ARE declared, and exactly one of
  // them is declared derived.
  const defs = sprintsFields({
    items: [{ id: 'a', content: 'x', start: '2026-01-05' }],
    plugins: [{ id: sprintsManifest.id, config: { start: '2026-01-05' } }],
    pluginData: {
      [sprintsManifest.id]: {
        [SPRINT_COLLECTIONS.sprints]: [{ id: 's1', data: { name: 'Sprint 1', state: 'active' } }],
      },
    },
  });
  assert.equal(defs.find((d) => d.key === SPRINT_KEY)?.derived, undefined);
  assert.equal(defs.find((d) => d.key === SPRINT_BY_DATE_KEY)?.derived, true);
});

test('the declared contract is the newest thing the plugin actually uses', () => {
  // 1.5 for the `derived` field (on an older host it renders as an editable control with
  // nothing filling it), 1.6 for the core's `durationToMs` + `endFromDuration`, which the
  // burndown resolves an item's real end with. On a 1.5 host that import does not resolve
  // at all, so anything below `^1.6` is a range this plugin cannot keep.
  assert.equal(sprintsManifest.apiVersion, '^1.6');
});

test('the cadence anchor is checked as a day, or a European date shifts every window', () => {
  // Without the pattern `configure_plugin` accepted `start: "01.05.2026"`: the anchor was
  // read as 2026-01-05, every window of the cadence sat four months from the day the
  // caller wrote, and the call returned success.
  const schema = sprintsManifest.configSchema;
  assert.deepEqual(validateRow(schema, { start: '2026-01-05' }, 'config'), []);
  for (const start of ['01.05.2026', '05/01/2026', '2026-5-1', 'Anfang Mai', '']) {
    assert.equal(validateRow(schema, { start }, 'config').length > 0, true, start);
  }
});

test('a report freezes the unit its figures are counted in', () => {
  // Reading the unit off the sprint row instead let an edit to a closed sprint's
  // `capacityUnit` relabel figures and a curve that nothing recomputes: 21 points shown
  // as „21 Einträge", same numbers, nothing saying they had been reinterpreted.
  const schema = collection(SPRINT_COLLECTIONS.reports).schema;
  const figures = { sprintId: 's1', scopeAtStart: 13, scopeAtClose: 13, completed: 13, carried: 0 };
  assert.deepEqual(validateRow(schema, { ...figures, unit: 'items' }), []);
  assert.equal(validateRow(schema, { ...figures, unit: 'bananas' }).length > 0, true);
  // Optional: a report written before the field existed carries none, and refusing it
  // would lose four frozen figures over a label.
  assert.deepEqual(validateRow(schema, figures), []);
  assert.equal((schema?.required as string[] | undefined)?.includes('unit'), false);
});

test('the three collections are declared with the identity each one has', () => {
  // `ordered` on the sprints is not presentation: an undated sprint takes the raster
  // window at its POSITION in that list, so the order is data the reader depends on.
  assert.equal(collection(SPRINT_COLLECTIONS.sprints).ordered, true);
  assert.equal(collection(SPRINT_COLLECTIONS.sprints).keyFields, undefined);
  // A pass IS its (item, sprint) pair and a report IS its sprint, so both derive their
  // row id from those fields: closing is several writes and may be retried, and a retry
  // that duplicated a row would double the completed points in a frozen report.
  assert.deepEqual(collection(SPRINT_COLLECTIONS.passes).keyFields, ['itemId', 'sprintId']);
  assert.deepEqual(collection(SPRINT_COLLECTIONS.reports).keyFields, ['sprintId']);
  // …which also fixes what the row id looks like, so a hand-written example carries the
  // id the host would derive rather than a second one beside it.
  assert.equal(
    rowIdFor(collection(SPRINT_COLLECTIONS.passes), { itemId: 'Q-1', sprintId: 'sprint-2', outcome: 'carried' }),
    'Q-1:sprint-2',
  );
  assert.equal(rowIdFor(collection(SPRINT_COLLECTIONS.reports), { sprintId: 'sprint-2' }), 'sprint-2');
});

test('every collection schema is one the host can actually apply', () => {
  // The load-bearing half of the subset: a keyword the host does not implement makes the
  // MANIFEST invalid rather than being skipped on every write, because an author who
  // reads `pattern` in the manifest believes every write is checked against it.
  for (const c of sprintsManifest.collections ?? []) {
    assert.deepEqual(unsupportedKeywords(c.schema), [], c.id);
  }
});

test('a sprint row needs a name and a state, and takes nothing else', () => {
  const schema = collection(SPRINT_COLLECTIONS.sprints).schema;
  assert.deepEqual(
    validateRow(schema, {
      name: 'Sprint 3',
      goal: 'Die Rechteprüfung greift',
      start: '2026-02-02',
      end: '2026-02-15',
      state: 'active',
      closedOn: '2026-02-13',
      capacity: 20,
      capacityUnit: 'points',
      note: 'Retro',
    }),
    [],
  );
  // A goal is nullable in storage although canon requires one: a row that cannot be
  // saved without a goal is a row nobody creates before the planning meeting, so the
  // plugin warns while the sprint is active instead.
  assert.deepEqual(validateRow(schema, { name: 'Sprint 3', state: 'planned' }), []);
  for (const bad of [
    {},
    { name: 'Sprint 3' },
    { state: 'planned' },
    { name: '', state: 'planned' },
    { name: 'S', state: 'begonnen' },
    // „Anfang März" is the failure the pattern exists for: a window that covers nothing
    // and no error to see. `format: 'date'` is not in the enforced subset.
    { name: 'S', state: 'planned', start: 'Anfang März' },
    { name: 'S', state: 'planned', end: '2026-2-15' },
    { name: 'S', state: 'closed', closedOn: '15.02.2026' },
    { name: 'S', state: 'planned', capacity: 0 },
    { name: 'S', state: 'planned', capacityUnit: 'bananas' },
    { name: 'S', state: 'planned', sprintGoal: 'getippt' },
  ]) {
    assert.equal(validateRow(schema, bad).length > 0, true, JSON.stringify(bad));
  }
});

test('a pass records what became of one item at one close', () => {
  const schema = collection(SPRINT_COLLECTIONS.passes).schema;
  for (const outcome of ['done', 'carried', 'removed', 'cancelled']) {
    assert.deepEqual(validateRow(schema, { itemId: 'Q-1', sprintId: 's2', outcome, recordedOn: '2026-02-01' }), []);
  }
  // The estimate at close is optional, because an item can pass through a sprint
  // without ever having been estimated, which is named rather than counted as zero.
  assert.deepEqual(
    validateRow(schema, { itemId: 'Q-1', sprintId: 's2', outcome: 'done', recordedOn: '2026-02-01', estimateAtClose: 13 }),
    [],
  );
  for (const bad of [
    { sprintId: 's2', outcome: 'done', recordedOn: '2026-02-01' },
    { itemId: 'Q-1', outcome: 'done', recordedOn: '2026-02-01' },
    { itemId: 'Q-1', sprintId: 's2', recordedOn: '2026-02-01' },
    { itemId: 'Q-1', sprintId: 's2', outcome: 'erledigt', recordedOn: '2026-02-01' },
    { itemId: 'Q-1', sprintId: 's2', outcome: 'done' },
    { itemId: 'Q-1', sprintId: 's2', outcome: 'done', recordedOn: 'gestern' },
    { itemId: 'Q-1', sprintId: 's2', outcome: 'done', recordedOn: '2026-02-01', estimateAtClose: -1 },
  ]) {
    assert.equal(validateRow(schema, bad).length > 0, true, JSON.stringify(bad));
  }
});

test('a report carries its figures and the curve as it stood', () => {
  const schema = collection(SPRINT_COLLECTIONS.reports).schema;
  const figures = { sprintId: 's1', scopeAtStart: 13, scopeAtClose: 13, completed: 13, carried: 0 };
  const series = [
    { day: '2026-01-05', remaining: 13 },
    { day: '2026-01-18', remaining: 0 },
  ];
  assert.deepEqual(validateRow(schema, { ...figures, series }), []);
  // The series is optional: a sprint can be closed by something that has no daily
  // figures, and refusing the report over that would lose the four numbers as well.
  // Omitted rather than set to `undefined`, because a present key holding `undefined` is
  // a value of the wrong type here and would make the test pass for the wrong reason.
  assert.deepEqual(validateRow(schema, figures), []);
  for (const bad of [
    { ...figures, sprintId: '' },
    // Each figure is required: „scope at close" cannot be read off the item list later,
    // which is the whole reason the report is frozen.
    { sprintId: 's1', scopeAtStart: 13, scopeAtClose: 13, carried: 0 },
    { sprintId: 's1', completed: 13, carried: 0 },
    { ...figures, carried: -1 },
    { ...figures, series: [{ day: '2026-01-05' }] },
    { ...figures, series: [{ day: 'Montag', remaining: 3 }] },
    { ...figures, series: [{ day: '2026-01-05', remaining: 3, note: 'x' }] },
    { ...figures, velocity: 20 },
  ]) {
    assert.equal(validateRow(schema, bad).length > 0, true, JSON.stringify(bad));
  }
});

test('both references point into the sprints and cascade', () => {
  // There is no foreign key left to catch a dangling id: the host checks a write against
  // these and applies the declared outcome on delete. `cascade` because neither row
  // means anything without its sprint: a pass with no sprint is a record of nothing.
  assert.deepEqual(sprintsManifest.references, [
    { from: SPRINT_COLLECTIONS.passes, field: 'sprintId', to: SPRINT_COLLECTIONS.sprints, onDelete: 'cascade' },
    { from: SPRINT_COLLECTIONS.reports, field: 'sprintId', to: SPRINT_COLLECTIONS.sprints, onDelete: 'cascade' },
  ]);
});

test('all three collections are publishable, and that alone publishes nothing', () => {
  // On a static local deploy the declaration decides what SURVIVES materialization, so
  // a collection missing here would leave the committed example showing a timeline with
  // no sprints at all. The per-timeline consent is the separate gate, off by default.
  assert.deepEqual(sprintsManifest.publicRead?.collections, [
    SPRINT_COLLECTIONS.sprints,
    SPRINT_COLLECTIONS.passes,
    SPRINT_COLLECTIONS.reports,
  ]);
  assert.equal(sprintsManifest.capabilities?.includes('public:read'), true);
  assert.equal(sprintsManifest.publicRead?.fields, undefined);
});

test('the one view claims none of the item list\'s controls', () => {
  const views = sprintsManifest.views ?? [];
  assert.equal(views.length, 1);
  const [view] = views;
  assert.ok(view.icon.startsWith('<svg'), 'a view needs an icon for the header toggle');
  // The page renders one sprint rather than the item list, so the perspective, the
  // extent and „+ Eintrag" would all be controls with nothing to act on. Absent and
  // `false` mean the same thing to the host; what must not happen is a declaration that
  // says „all of them" by accident.
  assert.equal(view.accessories, undefined);
  assert.equal(view.toolbar, undefined);
  assert.deepEqual(viewAccessories(view), { grouping: false, filter: false, create: false, export: false });
  assert.equal(sprintsManifest.capabilities?.includes('views'), true);
});

// **„Every declared tool has a handler" is asserted in `tools.test.ts`, not here.**
// It is the same assertion in both directions, it needs the handler map, and it already
// exists twice: once per plugin beside the handlers, and once generically for every
// installed plugin in `src/pluginHost/pluginTools.test.ts`. A third copy in this file
// would be the one that keeps passing after somebody changes what „declared" means.
// What is left below is what only the manifest can say.

test('a verb that writes items says so, and the capability covers it', () => {
  // A tool that declares no writes and returns changes is refused by the host, which is
  // what keeps `writes` from being decoration.
  const writing = (sprintsManifest.tools ?? []).filter((t) => t.writes === 'items');
  if (writing.length) assert.equal(sprintsManifest.capabilities?.includes('items:write'), true);
  for (const tool of sprintsManifest.tools ?? []) {
    assert.ok(tool.writes === undefined || tool.writes === 'items', tool.name);
  }
});

test('the timeline is never an argument: `id` is the host\'s', () => {
  for (const tool of sprintsManifest.tools ?? []) {
    assert.equal('id' in ((tool.inputSchema?.properties as Record<string, unknown>) ?? {}), false, tool.name);
    if (!tool.inputSchema) continue;
    // An unknown argument is refused rather than ignored, so a misspelled one is
    // reported instead of silently changing which sprint is touched.
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(validateToolArgs(tool, { sprnt: 3 }).length > 0, true, tool.name);
  }
});

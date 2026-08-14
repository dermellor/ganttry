import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planSprint, rollOver, sprintStatus, sprintsTools } from './tools';
import { sprintsManifest } from './manifest';
import { validateToolArgs, validateToolPlan, type ToolPlan } from '../../pluginHost/api';
import type { PluginDataRow, TimelineFile, TimelineFileItem } from '../../types';

// One test per rule, and one per boundary the domain cares about: no sprint at all, a
// sprint id nobody created, work that is finished, a roll-over with no target, a date
// that disagrees with its assignment, and `now` on each side of the window. „It works
// on the happy path" is not what these are for: a plausible-looking wrong rule is worse
// than a missing one, because it gets trusted.
//
// Every plan is also checked against `validateToolPlan`, which is the frame the host
// puts around a rule: ids that exist, no rename, nothing host-managed. Cheaper to
// assert here than to discover through a refused call.

type Decl = NonNullable<typeof sprintsManifest.tools>[number];

/**
 * The declaration a plan is validated against.
 *
 * From the manifest, because that is what an operator approves on install and where
 * `validateToolPlan` reads `writes`. The fallback covers exactly one situation and is
 * not meant to survive it: while the manifest still declares the previous verb set,
 * every rule below would fail for a reason that has nothing to do with the rule. The
 * parity test at the bottom is what keeps the fallback from becoming permanent.
 */
const FALLBACK: Decl[] = [
  { name: 'plan_sprint', title: 'plan_sprint', description: 'fallback', writes: 'items' },
  { name: 'roll_over', title: 'roll_over', description: 'fallback', writes: 'items' },
  { name: 'sprint_status', title: 'sprint_status', description: 'fallback' },
];
const decl = (name: string): Decl =>
  sprintsManifest.tools?.find((t) => t.name === name) ?? FALLBACK.find((t) => t.name === name)!;

const NOW = '2026-02-04'; // inside the window of S-3

type ItemSpec = {
  content?: string;
  start?: string;
  end?: string;
  status?: TimelineFileItem['status'];
  /** The assignment key, the one thing membership follows from. */
  sprint?: string;
  storyPoints?: unknown;
  dependsOn?: unknown;
};

const item = (id: string, spec: ItemSpec = {}): TimelineFileItem => {
  const metadata: Record<string, unknown> = {};
  if (spec.sprint !== undefined) metadata.sprint = spec.sprint;
  if (spec.storyPoints !== undefined) metadata.storyPoints = spec.storyPoints;
  if (spec.dependsOn !== undefined) metadata.dependsOn = spec.dependsOn;
  return {
    id,
    content: spec.content ?? id,
    ...(spec.start ? { start: spec.start } : {}),
    ...(spec.end ? { end: spec.end } : {}),
    ...(spec.status ? { status: spec.status } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
};

const row = (id: string, data: Record<string, unknown>): PluginDataRow => ({ id, data });

/**
 * A timeline carrying this plugin's sprint rows, the way the host hands them over.
 *
 * The `plugins` entry is not decoration: every reader in `sprints.ts` goes through
 * `hasPlugin` first, so rows on a timeline the plugin is not enabled on are correctly
 * invisible. Leaving it out here would make every case below read as „no sprints".
 */
const timeline = (
  items: TimelineFileItem[],
  sprints: PluginDataRow[],
  config?: Record<string, unknown>,
): TimelineFile => ({
  items,
  plugins: [{ id: sprintsManifest.id, ...(config ? { config } : {}) }],
  pluginData: { [sprintsManifest.id]: { sprints } },
});

const S2 = row('S-2', { name: 'Sprint 2', state: 'closed', start: '2026-01-19', end: '2026-02-01', capacity: 20 });
const S3 = row('S-3', {
  name: 'Sprint 3',
  state: 'active',
  goal: 'Checkout live',
  start: '2026-02-02',
  end: '2026-02-15',
  capacity: 20,
});
const S4 = row('S-4', { name: 'Sprint 4', state: 'planned', start: '2026-02-16', end: '2026-03-01', capacity: 20 });

const SPRINTS = [S2, S3, S4];

const notes = (plan: ToolPlan) => plan.notes ?? [];
const says = (plan: ToolPlan, needle: string) => notes(plan).some((note) => note.includes(needle));
const said = (plan: ToolPlan, needle: string) =>
  assert.equal(says(plan, needle), true, `no note said "${needle}": ${notes(plan).join(' | ')}`);
const didNotSay = (plan: ToolPlan, needle: string) =>
  assert.equal(says(plan, needle), false, `a note said "${needle}": ${notes(plan).join(' | ')}`);

/** No verb in this file may rewrite a date, so no patch may carry one. */
const movedNoDates = (plan: ToolPlan) => {
  for (const change of plan.changes ?? []) {
    if (change.op !== 'update') continue;
    for (const key of ['start', 'end', 'duration']) {
      assert.equal(key in change.patch, false, `patch for ${change.itemId} carries "${key}"`);
    }
  }
};

// The plugin config reaches these verbs through the file (`readEstimateUnit`,
// `rasterOf`), the same way the view and the fields read it, so `config` on the context
// stays empty here rather than carrying a second copy of it.
const plan = (args: Record<string, unknown>, file: TimelineFile) => planSprint({ file, config: {}, args, now: NOW });
const roll = (args: Record<string, unknown>, file: TimelineFile) => rollOver({ file, config: {}, args, now: NOW });
const status = (args: Record<string, unknown>, file: TimelineFile, now = NOW) =>
  sprintStatus({ file, config: {}, args, now });

// ---- no sprints, and ids that name nothing -----------------------------------

test('without a single sprint row the writing verbs refuse and say what is missing', () => {
  // „Nothing to do" is what an empty plan says, and „this timeline has no sprints" is
  // not that. Only the agent can create one, so the message has to reach it.
  const bare: TimelineFile = { items: [item('A-1', { start: '2026-02-03' })] };
  assert.throws(() => plan({ sprint: 'S-3', items: ['A-1'] }, bare), /kein Sprint angelegt/);
  assert.throws(() => roll({ sprint: 'S-3', toBacklog: true }, bare), /kein Sprint angelegt/);
  // Also when the plugin section exists and is empty, which is what an enabled plugin
  // with no rows yet looks like.
  const empty = timeline([item('A-1', { start: '2026-02-03' })], []);
  assert.throws(() => plan({ sprint: 'S-3', items: ['A-1'] }, empty), /kein Sprint angelegt/);
});

test('with no sprints the status verb answers instead of failing', () => {
  // It writes nothing, so the note is the entire result and „there are none yet" is the
  // true one. An error here would be a refusal to answer a question that has an answer.
  const file = timeline([item('A-1', { start: '2026-02-03', storyPoints: '8' })], []);
  const result = status({}, file);
  said(result, 'kein Sprint angelegt');
  said(result, 'Ohne Sprint-Zuordnung und daher in keiner Sprint-Summe: 1 Eintrag mit 8 Punkten (A-1)');
  assert.equal(result.changes, undefined);
  assert.deepEqual(validateToolPlan(decl('sprint_status'), file, result), []);
});

test('a sprint id that does not exist is refused with the ids that do', () => {
  const file = timeline([item('A-1', { start: '2026-02-03' })], SPRINTS);
  assert.throws(
    () => plan({ sprint: 'S-9', items: ['A-1'] }, file),
    /Kein Sprint mit der Id "S-9"\. Vorhanden: S-2 \(„Sprint 2"\), S-3 \(„Sprint 3"\), S-4 \(„Sprint 4"\)\./,
  );
  assert.throws(() => roll({ sprint: 'S-9', toBacklog: true }, file), /Kein Sprint mit der Id "S-9"/);
  assert.throws(() => roll({ sprint: 'S-3', toSprint: 'S-9' }, file), /Kein Sprint mit der Id "S-9"/);
  assert.throws(() => status({ sprint: 'S-9' }, file), /Kein Sprint mit der Id "S-9"/);
  assert.throws(() => plan({ items: ['A-1'] }, file), /`sprint` fehlt/);
});

test('a rejected sprint argument is quoted so it cannot look like valid input', () => {
  // `String(["S-3"])` is „S-3", so an array came back quoted as the id it is not: an
  // agent reading „„S-3" ist keine Sprint-Id" sees a valid id being refused and has
  // nothing to correct. JSON keeps the brackets, the quotes and the type.
  const file = timeline([item('A-1', { start: '2026-02-03' })], SPRINTS);
  assert.throws(() => plan({ sprint: ['S-3'], items: ['A-1'] }, file), /^Error: \["S-3"\] ist keine Sprint-Id/);
  assert.throws(() => plan({ sprint: 3, items: ['A-1'] }, file), /^Error: 3 ist keine Sprint-Id/);
  assert.throws(() => plan({ sprint: '  ', items: ['A-1'] }, file), /^Error: "  " ist keine Sprint-Id/);
});

// ---- plan_sprint -------------------------------------------------------------

test('planning assigns the named items and touches nothing else', () => {
  const file = timeline(
    [item('A-1', { start: '2026-02-03', storyPoints: '8' }), item('A-2', { start: '2026-02-04', storyPoints: '5' })],
    SPRINTS,
  );
  const result = plan({ sprint: 'S-3', items: ['A-1', 'A-2'] }, file);
  assert.deepEqual(result.changes, [
    { op: 'update', itemId: 'A-1', patch: { metadata: { sprint: 'S-3' } } },
    { op: 'update', itemId: 'A-2', patch: { metadata: { sprint: 'S-3' } } },
  ]);
  // The patch carries one metadata key, not the whole object: the host shallow-merges
  // it, so a full object would drop the estimate the item already has.
  said(result, '„Sprint 3" (S-3): 2 Einträge zugeordnet („A-1", „A-2")');
  movedNoDates(result);
  assert.deepEqual(validateToolPlan(decl('plan_sprint'), file, result), []);
});

test('an item id that names nothing is reported instead of poisoning the plan', () => {
  // `validateToolPlan` refuses the WHOLE plan over one unknown `itemId`, so a typo in a
  // list of five would otherwise assign none of the four that exist. The same reasoning
  // as the whitespace-id rule: one bad entry must not block everything else, and an
  // entry that is silently dropped is the other half of that bug.
  const file = timeline([item('A-1', { start: '2026-02-03' }), item('  ', { start: '2026-02-05' })], SPRINTS);
  const result = plan({ sprint: 'S-3', items: ['A-1', 'A-99', '  ', 42] }, file);
  assert.deepEqual(result.changes, [{ op: 'update', itemId: 'A-1', patch: { metadata: { sprint: 'S-3' } } }]);
  said(result, 'Nicht auf dieser Timeline und daher nicht zugeordnet: "A-99", "  ", 42');
  assert.deepEqual(validateToolPlan(decl('plan_sprint'), file, result), []);
});

test('an assignment the item already carries is not written again', () => {
  // A patch that writes the value already there is a write with no effect, and a plan
  // reporting it looks like a change happened.
  const file = timeline([item('A-1', { start: '2026-02-03', sprint: 'S-3' })], SPRINTS);
  const result = plan({ sprint: 'S-3', items: ['A-1', 'A-1'] }, file);
  assert.deepEqual(result.changes, []);
  said(result, 'Bereits „Sprint 3" (S-3) zugeordnet und daher nicht erneut geschrieben: „A-1"');
  assert.deepEqual(validateToolPlan(decl('plan_sprint'), file, result), []);
});

test('planning needs items, and an empty list is refused rather than answered', () => {
  const file = timeline([item('A-1', { start: '2026-02-03' })], SPRINTS);
  assert.throws(() => plan({ sprint: 'S-3' }, file), /`items` fehlt/);
  assert.throws(() => plan({ sprint: 'S-3', items: [] }, file), /`items` ist leer/);
  assert.throws(() => plan({ sprint: 'S-3', items: 'A-1' }, file), /"A-1" ist keine Liste von Item-Ids/);
});

test('dates that disagree with the assignment are named, and neither side is changed', () => {
  // The rule the model turns on: moving the dates overwrites a plan a person made,
  // dropping the assignment overwrites a commitment a team made. So the disagreement is
  // shown and nothing is resolved.
  const file = timeline(
    [
      item('früh', { start: '2026-01-20', storyPoints: '5' }),
      item('spät', { start: '2026-03-10', storyPoints: '5' }),
      item('lang', { start: '2026-02-10', end: '2026-02-25', storyPoints: '3' }),
      item('ohne-datum', { storyPoints: '2' }),
    ],
    SPRINTS,
  );
  const result = plan({ sprint: 'S-3', items: ['früh', 'spät', 'lang', 'ohne-datum'] }, file);
  assert.equal(result.changes?.length, 4);
  movedNoDates(result);
  // „Outside" means what `sprintWarnings` means by it, because both read the same
  // `windowContains`: the start counts, and so does an end that leaves the window („lang"
  // ends after the sprint). Two definitions of „is this item in its sprint" is how one of
  // them ends up fixed.
  said(
    result,
    'Die eigenen Daten widersprechen der Zuordnung zu „Sprint 3" (S-3) (2026-02-02 bis 2026-02-15): „früh", „spät", „lang"',
  );
  said(result, 'Weder die Daten noch die Zuordnung werden geändert');
  said(result, 'Ohne Startdatum und daher an keiner Stelle des Fensters: „ohne-datum"');
  assert.deepEqual(validateToolPlan(decl('plan_sprint'), file, result), []);
});

test('a sprint with no window cannot be checked against, and says so', () => {
  // A row with no dates takes the window of the raster sprint at its position, so „no
  // window" needs both to be absent: no dates on the row, and no raster in the config.
  const file = timeline([item('A-1', { start: '2026-02-03' })], [row('S-x', { name: 'Sprint X', state: 'planned' })]);
  const result = plan({ sprint: 'S-x', items: ['A-1'] }, file);
  said(result, '„Sprint X" (S-x) hat kein Fenster');
  didNotSay(result, 'widersprechen der Zuordnung');

  // With a raster configured the same row does have one, and the check runs against it:
  // sprint 1 of a raster anchored at 2026-01-05 covers 2026-01-05 to 2026-01-18.
  const withRaster = timeline([item('A-1', { start: '2026-02-03' })], [row('S-x', { name: 'Sprint X', state: 'planned' })], {
    start: '2026-01-05',
    lengthDays: 14,
  });
  said(
    plan({ sprint: 'S-x', items: ['A-1'] }, withRaster),
    'Die eigenen Daten widersprechen der Zuordnung zu „Sprint X" (S-x) (2026-01-05 bis 2026-01-18): „A-1"',
  );
});

test('a padded item id is matched trimmed and written back as the item carries it', () => {
  // Ids are unconstrained strings and the core does not trim them, so a plan carrying the
  // TRIMMED id is „no item on this timeline" to `validateToolPlan` — which refuses the
  // whole plan, so one padded id blocked the assignment of every other item in the call.
  const file = timeline(
    [item(' A-1 ', { start: '2026-02-03', storyPoints: '5' }), item('A-2', { start: '2026-02-04', storyPoints: '5' })],
    SPRINTS,
  );
  const result = plan({ sprint: 'S-3', items: ['A-1', 'A-2'] }, file);
  assert.deepEqual(result.changes, [
    { op: 'update', itemId: ' A-1 ', patch: { metadata: { sprint: 'S-3' } } },
    { op: 'update', itemId: 'A-2', patch: { metadata: { sprint: 'S-3' } } },
  ]);
  didNotSay(result, 'Nicht auf dieser Timeline');
  assert.deepEqual(validateToolPlan(decl('plan_sprint'), file, result), []);

  // The same on the way out: an item stored with a padded id and rolled over.
  const rolling = timeline([item(' B-1 ', { start: '2026-02-03', storyPoints: '5', sprint: 'S-3' })], SPRINTS);
  const rolled = roll({ sprint: 'S-3', toSprint: 'S-4' }, rolling);
  assert.deepEqual(rolled.changes, [{ op: 'update', itemId: ' B-1 ', patch: { metadata: { sprint: 'S-4' } } }]);
  assert.deepEqual(validateToolPlan(decl('roll_over'), rolling, rolled), []);
});

test('an entry of only whitespace reaches the handler, which is why it is named there', () => {
  // `minLength: 1` counts characters, not non-blank ones (`validateRow` in
  // src/pluginHost/dataSchema.ts), so the host accepts `"  "` and the branch that names
  // it is reachable rather than dead. Without it the entry would vanish from a plan the
  // caller believes covered its whole list.
  const declaration = decl('plan_sprint');
  assert.deepEqual(validateToolArgs(declaration, { sprint: 'S-3', items: ['  '] }), []);
  const file = timeline([item('A-1', { start: '2026-02-03' })], SPRINTS);
  const result = plan({ sprint: 'S-3', items: ['A-1', '  '] }, file);
  said(result, 'Nicht auf dieser Timeline und daher nicht zugeordnet: "  "');
});

test('planning into a closed or cancelled sprint is refused, the way rolling into one is', () => {
  // Assigning work to a sprint that is over changes nothing about what was delivered,
  // while the live scope it then appears in contradicts the frozen report that holds
  // that sprint's figures — and no note said a report existed.
  const cancelled = row('S-5', { name: 'Sprint 5', state: 'cancelled' });
  const file = timeline([item('A-1', { start: '2026-01-20', storyPoints: '5' })], [...SPRINTS, cancelled]);
  assert.throws(() => plan({ sprint: 'S-2', items: ['A-1'] }, file), /„Sprint 2" \(S-2\) ist abgeschlossen/);
  assert.throws(() => plan({ sprint: 'S-2', items: ['A-1'] }, file), /eingefrorenen Bericht/);
  assert.throws(() => plan({ sprint: 'S-5', items: ['A-1'] }, file), /ist abgebrochen/);
  // A planned and an active sprint are unaffected.
  assert.equal(plan({ sprint: 'S-3', items: ['A-1'] }, file).changes?.length, 1);
  assert.equal(plan({ sprint: 'S-4', items: ['A-1'] }, file).changes?.length, 1);
});

test('finished work assigned along is named, and no date is written for it either', () => {
  const file = timeline([item('fertig', { start: '2026-01-20', status: 'Done', storyPoints: '8' })], SPRINTS);
  const result = plan({ sprint: 'S-3', items: ['fertig'] }, file);
  said(result, 'Auch abgeschlossene Arbeit wurde zugeordnet („fertig")');
  movedNoDates(result);
});

// ---- roll_over ---------------------------------------------------------------

const rollFile = () =>
  timeline(
    [
      item('offen-1', { start: '2026-02-03', storyPoints: '8', sprint: 'S-3' }),
      item('offen-2', { start: '2026-02-05', storyPoints: '5', status: 'Doing', sprint: 'S-3' }),
      item('fertig', { start: '2026-02-04', storyPoints: '13', status: 'Done', sprint: 'S-3' }),
      item('fremd', { start: '2026-02-20', storyPoints: '3', sprint: 'S-4' }),
    ],
    SPRINTS,
  );

test('a roll-over without a target is refused, because there is no default', () => {
  // Canon puts unfinished work back into the Product Backlog; Jira, Azure DevOps and
  // Linear default to the next sprint. Picking one silently would pick a philosophy on
  // the caller's behalf, on a write.
  const file = rollFile();
  assert.throws(() => roll({ sprint: 'S-3' }, file), /Ohne Ziel wird nichts verschoben/);
  assert.throws(() => roll({ sprint: 'S-3' }, file), /kein Standardziel/);
  // „not the backlog" is not a target either.
  assert.throws(() => roll({ sprint: 'S-3', toBacklog: false }, file), /Ohne Ziel wird nichts verschoben/);
  // Two targets are no target: which one won would not be visible in the answer.
  assert.throws(() => roll({ sprint: 'S-3', toSprint: 'S-4', toBacklog: true }, file), /nicht beides/);
  assert.throws(() => roll({ sprint: 'S-3', toBacklog: 'ja' }, file), /"ja" ist kein Wahrheitswert/);
  // The same sprint is a write with no effect.
  assert.throws(() => roll({ sprint: 'S-3', toSprint: 'S-3' }, file), /derselbe Sprint/);
});

test('rolling into a sprint that is over is refused rather than performed', () => {
  // Unfinished work cannot be worked on in a closed sprint, so the write could not help
  // and would look exactly like a roll-over that succeeded.
  const file = rollFile();
  assert.throws(() => roll({ sprint: 'S-3', toSprint: 'S-2' }, file), /ist abgeschlossen/);
  const cancelled = timeline(rollFile().items!, [...SPRINTS, row('S-5', { name: 'Sprint 5', state: 'cancelled' })]);
  assert.throws(() => roll({ sprint: 'S-3', toSprint: 'S-5' }, cancelled), /ist abgebrochen/);
});

test('rolling over to a sprint moves the unfinished work and nothing else', () => {
  const file = rollFile();
  const result = roll({ sprint: 'S-3', toSprint: 'S-4' }, file);
  assert.deepEqual(result.changes, [
    { op: 'update', itemId: 'offen-1', patch: { metadata: { sprint: 'S-4' } } },
    { op: 'update', itemId: 'offen-2', patch: { metadata: { sprint: 'S-4' } } },
  ]);
  said(result, '„Sprint 3" (S-3): 2 offene Einträge nach „Sprint 4" (S-4) verschoben („offen-1", „offen-2")');
  said(result, 'Kein Datum wurde dabei geändert.');
  // A tool returns item changes and cannot write the plugin's own rows, so „rolled over"
  // must not be read as „closed": the state stays, and no `passes` row records the move.
  said(result, 'der Status des Sprints bleibt, und es entsteht kein Verlaufseintrag');
  // The item of another sprint is not touched by a call about this one.
  didNotSay(result, '„fremd"');
  movedNoDates(result);
  assert.deepEqual(validateToolPlan(decl('roll_over'), file, result), []);
});

test('rolling over to the backlog clears the assignment instead of naming a fake sprint', () => {
  // A metadata value of null removes the key (`mergeMetadata`), which is what „no
  // sprint" is. An assignment to something called „backlog" would be a sprint row that
  // does not exist.
  const file = rollFile();
  const result = roll({ sprint: 'S-3', toBacklog: true }, file);
  assert.deepEqual(result.changes, [
    { op: 'update', itemId: 'offen-1', patch: { metadata: { sprint: null } } },
    { op: 'update', itemId: 'offen-2', patch: { metadata: { sprint: null } } },
  ]);
  said(result, 'nach das Backlog verschoben');
  said(result, 'Im Backlog gilt kein Fenster');
  movedNoDates(result);
  assert.deepEqual(validateToolPlan(decl('roll_over'), file, result), []);
});

test('finished work keeps the sprint it was finished in', () => {
  // Its scope stays in that sprint's sum, because the capacity really was consumed, and
  // re-assigning it would rewrite the record of where it was done. No date of it is
  // touched either, which is the older half of the same rule.
  const file = rollFile();
  const result = roll({ sprint: 'S-3', toSprint: 'S-4' }, file);
  assert.equal(
    result.changes?.some((change) => change.op === 'update' && change.itemId === 'fertig'),
    false,
  );
  said(result, 'Abgeschlossene Arbeit bleibt in „Sprint 3" (S-3) („fertig")');
});

test('a sprint holding nothing has nothing to roll over', () => {
  const file = timeline([item('A-1', { start: '2026-02-03' })], SPRINTS);
  const result = roll({ sprint: 'S-3', toBacklog: true }, file);
  assert.deepEqual(result.changes, []);
  said(result, '„Sprint 3" (S-3) hält keinen Eintrag: es gibt nichts zu verschieben.');
});

test('an item whose id is only whitespace is named rather than written into a refused plan', () => {
  // `if (!item.id)` let `"  "` through, and `validateToolPlan` then rejected the WHOLE
  // plan over the blank `itemId` — so one whitespace id made a sprint impossible to roll
  // over at all.
  const file = timeline(
    [
      item('  ', { content: 'namenlos', start: '2026-02-03', storyPoints: '5', sprint: 'S-3' }),
      item('echt', { start: '2026-02-04', storyPoints: '5', sprint: 'S-3' }),
    ],
    SPRINTS,
  );
  const result = roll({ sprint: 'S-3', toSprint: 'S-4' }, file);
  assert.deepEqual(result.changes, [{ op: 'update', itemId: 'echt', patch: { metadata: { sprint: 'S-4' } } }]);
  said(result, 'Ohne verwendbare Id und daher nicht verschoben: „namenlos"');
  assert.deepEqual(validateToolPlan(decl('roll_over'), file, result), []);
});

test('an item something else depends on moves, and what waits for it is named', () => {
  // The old rule refused to MOVE such an item, and the reason was a date: shifting a
  // predecessor by a sprint length put its successor's start before the predecessor's
  // end, which the relation graph then drew backwards. This verb changes no date, so
  // that failure cannot happen; what remains is a dependency now pointing back across a
  // sprint boundary, and that is reported. Refusing instead would leave unfinished work
  // in a sprint that is over, which is the thing roll_over exists to prevent.
  const file = timeline(
    [
      item('BIG', { start: '2026-02-03', storyPoints: '8', sprint: 'S-3' }),
      item('SUCC', { start: '2026-02-12', storyPoints: '2', sprint: 'S-3', dependsOn: ['BIG'], status: 'Done' }),
      item('ANDERS', { start: '2026-02-14', storyPoints: '1', sprint: 'S-4', dependsOn: 'BIG' }),
    ],
    SPRINTS,
  );
  const result = roll({ sprint: 'S-3', toSprint: 'S-4' }, file);
  assert.deepEqual(result.changes, [{ op: 'update', itemId: 'BIG', patch: { metadata: { sprint: 'S-4' } } }]);
  said(result, 'Hängt an verschobener Arbeit und ist selbst nicht mitverschoben worden');
  said(result, '„SUCC"');
  // A single id written as a bare string is the other shape `extractDependsOn` accepts,
  // so this rule has to read it too.
  said(result, '„ANDERS"');
  movedNoDates(result);
  assert.deepEqual(validateToolPlan(decl('roll_over'), file, result), []);
});

test('a dependent is claimed exactly where the relation graph draws an edge', () => {
  // `extractDependsOn` (src/buildItems.ts) trims a single id written as a bare string and
  // does NOT trim the entries of a list, so `[" BIG "]` names no item and no arrow is
  // drawn. Trimming both here made this verb report a stranded successor that nothing on
  // the page corresponds to.
  const file = timeline(
    [
      item('BIG', { start: '2026-02-03', storyPoints: '8', sprint: 'S-3' }),
      item('LOSE', { start: '2026-02-20', storyPoints: '2', sprint: 'S-4', dependsOn: [' BIG '] }),
      item('ECHT', { start: '2026-02-13', storyPoints: '2', sprint: 'S-4', dependsOn: ' BIG ' }),
    ],
    SPRINTS,
  );
  const result = roll({ sprint: 'S-3', toSprint: 'S-4' }, file);
  // „ECHT" waits for BIG in the graph (the single-string form is trimmed), „LOSE" does
  // not (a list entry is not).
  said(result, '„ECHT"');
  didNotSay(result, '„LOSE"');
});

test('the target window is compared against, and the dates still are not moved', () => {
  const file = timeline([item('offen', { start: '2026-02-03', storyPoints: '5', sprint: 'S-3' })], SPRINTS);
  const result = roll({ sprint: 'S-3', toSprint: 'S-4' }, file);
  said(result, 'Die eigenen Daten widersprechen der Zuordnung zu „Sprint 4" (S-4) (2026-02-16 bis 2026-03-01): „offen"');
  movedNoDates(result);
});

// ---- sprint_status -----------------------------------------------------------

const statusFile = () =>
  timeline(
    [
      item('offen-1', { start: '2026-02-03', storyPoints: '13', sprint: 'S-3' }),
      item('fertig', { start: '2026-02-04', storyPoints: '8', status: 'Done', sprint: 'S-3' }),
      item('backlog', { start: '2026-04-01', storyPoints: '5' }),
    ],
    SPRINTS,
  );

test('the status reports scope, remaining and the days left of the active sprint', () => {
  const file = statusFile();
  const result = status({}, file);
  said(result, '„Sprint 3" (S-3), aktiv: 2 Einträge, Umfang 21 von 20 Punkten (überbucht), davon offen 13 Punkte.');
  said(result, '12 Tage bis zum Ende am 2026-02-15, den Stichtag 2026-02-04 eingeschlossen.');
  // The scope no sprint accounts for, so the sums above cannot be read as the whole
  // timeline.
  said(result, 'Ohne Sprint-Zuordnung und daher in keiner Sprint-Summe: 1 Eintrag mit 5 Punkten (backlog)');
  // A velocity figure and a „committed versus completed" pair are what this plugin
  // refuses to print; `docs/model.md` carries the sources.
  didNotSay(result, 'velocity');
  didNotSay(result, 'Velocity');
  assert.equal(result.changes, undefined);
  assert.deepEqual(validateToolPlan(decl('sprint_status'), file, result), []);
});

test('the status can be asked about one sprint, including a closed one', () => {
  const file = statusFile();
  const result = status({ sprint: 'S-4' }, file);
  said(result, '„Sprint 4" (S-4), geplant: kein Eintrag zugeordnet.');
  didNotSay(result, '„Sprint 3" (S-3), aktiv');
  said(status({ sprint: 'S-2' }, file), '„Sprint 2" (S-2), abgeschlossen');
});

test('now before, inside and after the window are three different answers', () => {
  const file = statusFile();
  said(status({ sprint: 'S-4' }, file, '2026-02-04'), '„Sprint 4" (S-4) beginnt erst am 2026-02-16, in 12 Tagen');
  said(status({ sprint: 'S-3' }, file, '2026-02-15'), '1 Tag bis zum Ende am 2026-02-15');
  const late = status({ sprint: 'S-3' }, file, '2026-02-20');
  said(late, 'endete am 2026-02-15, vor 5 Tagen');
  // Nothing fires at a sprint boundary in this product, so an active sprint whose window
  // is over stays active until somebody says otherwise. Saying it is the whole point — and
  // it is a `SprintWarning` now rather than a sentence only this verb could reach, which is
  // what lets the page say it too.
  said(late, '„Sprint 3" (S-3) steht auf „active", das Fenster endete am 2026-02-15 (vor 5 Tagen');
  said(late, 'wird nicht verlängert');
  // A sprint that is over and says so gets neither: „the window has passed" is only a
  // finding while the row has not moved with it.
  didNotSay(status({ sprint: 'S-2' }, file, '2026-02-20'), 'wird nicht verlängert');
});

test('a planned sprint whose window is entirely past is the same finding', () => {
  // The other branch into it: nobody activated it, and its window went by. Reported for the
  // same reason as the active one — nothing in this product moves a sprint's dates or its
  // state, so a plan that stopped being followed says nothing until this warning does.
  const file = statusFile();
  const late = status({ sprint: 'S-4' }, file, '2026-03-10');
  said(late, '„Sprint 4" (S-4) steht auf „planned", das Fenster endete am 2026-03-01 (vor 9 Tagen');
  didNotSay(status({ sprint: 'S-4' }, file, '2026-03-01'), 'steht auf „planned", das Fenster endete');
});

test('an unusable now leaves the remaining time unanswered instead of counting from nothing', () => {
  // „Before the window" and „not a date at all" are two different answers, and a count
  // over a value nobody could read is a confident number over nothing.
  const file = statusFile();
  for (const now of ['', '   ', 'heute', '2026-13-40']) {
    const result = status({ sprint: 'S-3' }, file, now);
    said(result, 'ist kein Datum, deshalb bleibt „wie viel Zeit bleibt" unbeantwortet');
    didNotSay(result, 'Tage bis zum Ende');
  }
  // A real day outside the window is the other case, and gets no such note.
  didNotSay(status({ sprint: 'S-3' }, file, '2026-02-20'), 'ist kein Datum');
});

test('an active sprint without a goal is a warning, and only while it is active', () => {
  // Canon requires the goal and no product enforces one, so it is nullable in storage
  // and warned about exactly while the sprint runs.
  const noGoal = row('S-3', { ...(S3.data as Record<string, unknown>), goal: '   ' });
  const file = timeline([item('offen', { start: '2026-02-03', storyPoints: '5', sprint: 'S-3' })], [noGoal, S4]);
  said(status({}, file), '„Sprint 3" (S-3) ist aktiv und hat kein Sprint-Ziel.');
  // S-4 is planned and carries no goal either, and that is not yet a problem.
  didNotSay(status({ sprint: 'S-4' }, file), 'kein Sprint-Ziel');
  said(status({}, statusFile()), '„Sprint 3" (S-3), aktiv');
  didNotSay(status({}, statusFile()), 'kein Sprint-Ziel');
});

test('a second active sprint is reported, because nothing else can refuse it', () => {
  // „A new Sprint starts immediately after the conclusion of the previous Sprint", and
  // the host enforces no rule across rows, so the violation has to be visible here.
  const alsoActive = row('S-4', { ...(S4.data as Record<string, unknown>), state: 'active' });
  const file = timeline(statusFile().items!, [S2, S3, alsoActive]);
  const result = status({}, file);
  said(result, '2 Sprints sind gleichzeitig aktiv („Sprint 3" (S-3), „Sprint 4" (S-4))');
  said(result, 'Es kann nur einen aktiven Sprint geben');
  // Both are reported, rather than one being picked silently.
  said(result, '„Sprint 3" (S-3), aktiv');
  said(result, '„Sprint 4" (S-4), aktiv');
});

test('no active sprint at all is an answer with the ids to ask about', () => {
  const file = timeline(statusFile().items!, [S2, S4]);
  const result = status({}, file);
  said(result, 'Kein Sprint ist aktiv (2 Sprints angelegt: S-2 („Sprint 2"), S-4 („Sprint 4"))');
  // No sprint is reported in place of the active one: a closed sprint's numbers would be
  // an answer to a question nobody asked.
  didNotSay(result, 'aktiv:');
  didNotSay(result, 'abgeschlossen:');
});

test('items with no usable estimate are named rather than counted as zero', () => {
  // A missing key, an empty string, a word, a stray array, zero, a hex and an exponent
  // string are one case: none of them can be summed. `Number()` would have read the last
  // two as 16 and 1000, which turns a typo into a capacity figure.
  const file = timeline(
    [
      item('mit', { start: '2026-02-03', storyPoints: '8', sprint: 'S-3' }),
      item('ohne', { start: '2026-02-03', sprint: 'S-3' }),
      item('leer', { start: '2026-02-03', storyPoints: '', sprint: 'S-3' }),
      item('wort', { start: '2026-02-03', storyPoints: 'XL', sprint: 'S-3' }),
      item('liste', { start: '2026-02-03', storyPoints: ['8'], sprint: 'S-3' }),
      item('null', { start: '2026-02-03', storyPoints: 0, sprint: 'S-3' }),
      item('hex', { start: '2026-02-03', storyPoints: '0x10', sprint: 'S-3' }),
      item('exponent', { start: '2026-02-03', storyPoints: '1e3', sprint: 'S-3' }),
      item('bruch', { start: '2026-02-03', storyPoints: '2.5', sprint: 'S-3' }),
    ],
    SPRINTS,
  );
  const result = status({ sprint: 'S-3' }, file);
  said(result, 'Umfang 10.5 von 20 Punkten (im Rahmen)');
  said(result, 'ohne verwertbare Schätzung: „ohne", „leer", „wort", „liste", „null", „hex", „exponent"');
  said(result, 'Eine Summe, in der 7 Einträge fehlen, ist keine Kapazitätsaussage.');
});

test('the verdict cannot contradict the numbers printed beside it', () => {
  // „0.1" + „0.2" is 0.30000000000000004 in binary floating point, so against a capacity
  // of 0.3 the check printed „0.3 von 0.3 Punkten (überbucht)": the verdict said the
  // opposite of the two numbers in front of it.
  const sprint = row('S-3', { ...(S3.data as Record<string, unknown>), capacity: 0.3 });
  const file = timeline(
    [
      item('a', { start: '2026-02-03', storyPoints: '0.1', sprint: 'S-3' }),
      item('b', { start: '2026-02-04', storyPoints: '0.2', sprint: 'S-3' }),
    ],
    [sprint],
  );
  said(status({ sprint: 'S-3' }, file), 'Umfang 0.3 von 0.3 Punkten (im Rahmen)');
});

test('a sum that is no longer a representable number is refused, not printed as Infinity', () => {
  // `points()` multiplied by 100 before rounding, and that product overflows: a finite
  // total of 2e307 printed „Infinity", which is not a number anybody can check.
  const big = timeline(
    [
      item('a', { start: '2026-02-03', storyPoints: 1e307, sprint: 'S-3' }),
      item('b', { start: '2026-02-04', storyPoints: 1e307, sprint: 'S-3' }),
    ],
    SPRINTS,
  );
  const huge = status({ sprint: 'S-3' }, big);
  said(huge, 'Umfang 2e+307 von 20 Punkten (überbucht)');
  // …and „1e+306 weitere Sprints" is not an extrapolation, it is the same unusable
  // number one step further on.
  said(huge, 'ist gegen eine Kapazität von 20 keine Zahl von Sprints mehr, die eine Aussage wäre');
  didNotSay(huge, 'weitere Sprints');

  const beyond = timeline(
    [
      item('a', { start: '2026-02-03', storyPoints: 1e308, sprint: 'S-3' }),
      item('b', { start: '2026-02-04', storyPoints: 1e308, sprint: 'S-3' }),
    ],
    SPRINTS,
  );
  const result = status({ sprint: 'S-3' }, beyond);
  said(result, 'Die Summe der Schätzungen ist keine darstellbare Zahl mehr (Infinity)');
  didNotSay(result, 'von 20 Punkten');
});

test('a sprint without a usable capacity gets sums without a yardstick', () => {
  // Absent, zero, negative and unparseable are one case: the answer owed to the caller
  // is the same, and none of them is a number a rule may divide by. The sums still
  // stand, labelled as sums.
  for (const capacity of [undefined, 0, -3, 'viel', '0x10']) {
    const sprint = row('S-3', { ...(S3.data as Record<string, unknown>), capacity });
    const file = timeline([item('a', { start: '2026-02-03', storyPoints: '13', sprint: 'S-3' })], [sprint]);
    const result = status({ sprint: 'S-3' }, file);
    said(result, 'Umfang 13 Punkte, davon offen 13 Punkte');
    said(result, 'Ohne `capacity` auf dem Sprint steht diese Zahl ohne Maßstab.');
    // No verdict anywhere: „von 20 Punkten" is the shape a comparison would take.
    didNotSay(result, 'im Rahmen');
    didNotSay(result, 'überbucht');
    didNotSay(result, 'weitere Sprints');
  }
});

test('open work beyond the capacity is extrapolated as one, never as a velocity', () => {
  const file = timeline(
    [
      item('a', { start: '2026-02-03', storyPoints: '45', sprint: 'S-3' }),
      item('b', { start: '2026-02-04', storyPoints: '13', status: 'Done', sprint: 'S-3' }),
    ],
    SPRINTS,
  );
  const result = status({ sprint: 'S-3' }, file);
  said(result, 'Offen sind 45 Punkte bei einer Kapazität von 20: das reicht über diesen Sprint hinaus, um 2 weitere Sprints dieser Größe.');
  said(result, 'Hochrechnung aus einer Kapazität, keine Zusage.');
  didNotSay(result, 'velocity');
});

test('the unit follows the sprint, then the config, and never a guess', () => {
  const hours = row('S-3', { ...(S3.data as Record<string, unknown>), capacityUnit: 'hours' });
  const file = timeline([item('a', { start: '2026-02-03', storyPoints: '13', sprint: 'S-3' })], [hours]);
  said(status({ sprint: 'S-3' }, file), 'Umfang 13 von 20 Stunden');
  // The plugin config is the fallback, and an unknown unit is the documented default
  // rather than a word nothing counts in.
  const withConfig = (estimateUnit: unknown) =>
    timeline([item('a', { start: '2026-02-03', storyPoints: '13', sprint: 'S-3' })], [S3], { estimateUnit });
  // One item of 13 points, in a sprint counted in entries: the scope is 1.
  said(status({ sprint: 'S-3' }, withConfig('items')), 'Umfang 1 von 20 Einträgen');
  said(status({ sprint: 'S-3' }, withConfig('bananen')), 'Umfang 13 von 20 Punkten');
});

test('a sprint counted in items reports entries, never a sum of their points', () => {
  // „Umfang 21 von 3 Einträgen (überbucht)": a story-point sum compared against a count
  // of entries, and declared over budget by an arithmetic nobody performed.
  const inItems = row('S-3', { ...(S3.data as Record<string, unknown>), capacity: 3, capacityUnit: 'items' });
  const file = timeline(
    [
      item('a', { start: '2026-02-03', storyPoints: '8', sprint: 'S-3' }),
      item('b', { start: '2026-02-04', storyPoints: '13', sprint: 'S-3' }),
    ],
    [inItems],
  );
  const result = status({ sprint: 'S-3' }, file);
  said(result, 'Umfang 2 von 3 Einträgen (im Rahmen), davon offen 2 Einträge.');
  didNotSay(result, '21');
  didNotSay(result, 'überbucht');
  // Nothing is missing from a count of entries, so no note claims the sum is incomplete.
  // The absent estimate is still named, by the warning that is about the item.
  const unsized = timeline([...file.items!, item('c', { start: '2026-02-05', sprint: 'S-3' })], [inItems]);
  const withUnsized = status({ sprint: 'S-3' }, unsized);
  said(withUnsized, 'Umfang 3 von 3 Einträgen (im Rahmen)');
  said(withUnsized, 'ohne verwertbare Schätzung: „c"');
  didNotSay(withUnsized, 'ist keine Kapazitätsaussage');
  // …and the declension follows the number, or „1 Einträge" makes the answer read as
  // machine output nobody checked.
  const one = timeline([item('a', { start: '2026-02-03', sprint: 'S-3' })], [inItems]);
  said(status({ sprint: 'S-3' }, one), 'Umfang 1 von 3 Einträgen (im Rahmen), davon offen 1 Eintrag.');
});

test('an item whose dates the window excludes is a warning on the status as well', () => {
  // The same fact the writing verbs report about the items they touch, here for the
  // timeline as stored. The rule is `sprintWarnings`, so the two cannot drift; only the
  // wording lives in this file.
  const file = timeline(
    [
      item('spät', { start: '2026-03-10', storyPoints: '5', sprint: 'S-3' }),
      item('passend', { start: '2026-02-03', storyPoints: '5', sprint: 'S-3' }),
    ],
    SPRINTS,
  );
  const result = status({ sprint: 'S-3' }, file);
  said(result, 'Die eigenen Daten widersprechen der Zuordnung zu „Sprint 3" (S-3) (2026-02-02 bis 2026-02-15): „spät"');
  didNotSay(result, '„passend"');
  // Reported, never resolved: an analysis verb that returned a date change would be a
  // declaration that stopped being true.
  assert.equal(result.changes, undefined);
  assert.deepEqual(validateToolPlan(decl('sprint_status'), file, result), []);
});

test('an assignment pointing at no sprint row is reported as such', () => {
  // The interface shows the item without a sprint, which is indistinguishable from one
  // nobody assigned. It counts in no sum either, so the answer has to name it.
  const file = timeline([item('verwaist', { start: '2026-02-03', storyPoints: '5', sprint: 'S-77' })], SPRINTS);
  const result = status({}, file);
  said(result, 'Zugeordnet auf einen Sprint, den es nicht gibt: „verwaist" (verwaist)');
  didNotSay(result, 'Ohne Sprint-Zuordnung');
});

test('the status reports what an earlier sprint handed over, out of the history rows', () => {
  // `passes` was written at every close and read by nothing. What it answers is what no
  // current figure can: part of this scope was already committed once.
  const file: TimelineFile = {
    items: [
      item('Q-1', { start: '2026-01-28', storyPoints: '5', sprint: 'S-3' }),
      item('A-1', { start: '2026-02-03', storyPoints: '8', sprint: 'S-3' }),
    ],
    plugins: [{ id: sprintsManifest.id }],
    pluginData: {
      [sprintsManifest.id]: {
        sprints: SPRINTS,
        passes: [
          row('Q-1:S-2', { itemId: 'Q-1', sprintId: 'S-2', outcome: 'carried', recordedOn: '2026-02-01' }),
          row('A-9:S-9', { itemId: 'A-9', sprintId: 'S-9', outcome: 'done', recordedOn: '2026-02-01' }),
        ],
      },
    },
  };
  const result = status({ sprint: 'S-3' }, file);
  said(result, 'Aus einem früheren Sprint mitgenommen: "Q-1" aus „Sprint 2" (S-2), festgehalten am 2026-02-01');
  // The estimate at that close is the figure a later re-estimate cannot rewrite, and
  // „damals ohne Schätzung" is why a report can say „carried: 0" about a carried item.
  said(result, 'damals ohne Schätzung');
  // The other half of giving those rows a reader: one pointing at a sprint that does not
  // exist is a warning, and it belongs in every answer because it names no real sprint.
  said(result, 'Der Verlaufseintrag "A-9:S-9" nennt den Sprint "S-9", den es nicht gibt');
  assert.deepEqual(validateToolPlan(decl('sprint_status'), file, result), []);
});

test('two sprints whose windows overlap are reported, with both names', () => {
  // Nothing else can see it: the item below sits inside its own sprint's window, so
  // „outside the window" stays silent, while „Sprint nach Datum" names the earlier row.
  const wide = row('S-3', { ...(S3.data as Record<string, unknown>), end: '2026-02-20' });
  const file = timeline([item('a', { start: '2026-02-17', storyPoints: '5', sprint: 'S-4' })], [wide, S4]);
  const result = status({ sprint: 'S-4' }, file);
  said(result, 'Die Fenster von „Sprint 3" (S-3) und „Sprint 4" (S-4) überschneiden sich (2026-02-16 bis 2026-02-20)');
  didNotSay(result, 'widersprechen der Zuordnung');
});

test('a window the row does not carry is stated as computed wherever it is stated', () => {
  // A computed end reads exactly like a written one, and it is usually quoted in the note
  // telling a caller its items are in the wrong place. „Bis zum 2026-01-18" out of a
  // cadence nobody looked at is a date the plugin invented.
  const noDates = timeline(
    [item('A-1', { start: '2026-02-03', storyPoints: '5', sprint: 'S-x' })],
    [row('S-x', { name: 'Sprint X', state: 'active', goal: 'A' })],
    { start: '2026-01-05', lengthDays: 14 },
  );
  const cadence = status({ sprint: 'S-x' }, noDates);
  said(cadence, 'Die eigenen Daten widersprechen der Zuordnung zu „Sprint X" (S-x) (2026-01-05 bis 2026-01-18)');
  said(cadence, 'Dieses Fenster (2026-01-05 bis 2026-01-18) steht nicht auf „Sprint X" (S-x)');
  said(cadence, 'Raster der Konfiguration');

  // Only a start: the start stands and the END is the computed half.
  const halfDated = timeline(
    [item('A-1', { start: '2026-05-04', storyPoints: '5', sprint: 'S-y' })],
    [row('S-y', { name: 'Sprint Y', state: 'active', goal: 'A', start: '2026-05-01' })],
    { start: '2026-01-05', lengthDays: 14 },
  );
  const half = status({ sprint: 'S-y' }, halfDated, '2026-05-04');
  said(half, '11 Tage bis zum Ende am 2026-05-14');
  said(half, 'Das Ende dieses Fensters (2026-05-14) steht nicht auf „Sprint Y" (S-y)');
  // …and the item that agrees with the written start is not reported as contradicting it.
  didNotSay(half, 'widersprechen der Zuordnung');

  // A row that carries both dates says nothing of the sort.
  didNotSay(status({ sprint: 'S-3' }, statusFile()), 'steht nicht auf');
});

test('a status answer is notes only, whatever it found', () => {
  // An analysis tool that returns changes is a declaration that stopped being true, and
  // the host refuses the whole plan over it.
  const file = statusFile();
  for (const args of [{}, { sprint: 'S-3' }, { sprint: 'S-4' }]) {
    const result = status(args, file);
    assert.equal(result.changes, undefined);
    assert.deepEqual(validateToolPlan(decl('sprint_status'), file, result), []);
  }
});

// ---- the wiring -------------------------------------------------------------

test('every declared tool has an implementation, and every implementation a declaration', () => {
  // The two live in different files and drift silently: a declared verb with no handler
  // is one an agent can see and cannot call, and a handler nobody declared never becomes
  // callable. This is also the test that retires the fallback declarations above.
  const declared = (sprintsManifest.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(Object.keys(sprintsTools).sort(), declared);
  assert.deepEqual(
    declared,
    FALLBACK.map((t) => t.name).sort(),
  );
  for (const t of sprintsManifest.tools ?? []) {
    assert.equal(t.writes, FALLBACK.find((f) => f.name === t.name)?.writes, `writes of ${t.name}`);
  }
});

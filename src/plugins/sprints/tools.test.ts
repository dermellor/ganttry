import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSprintCapacity, forecastCompletion, rebalanceSprint, sprintsTools } from './tools';
import { sprintsManifest } from './manifest';
import { validateToolArgs, validateToolPlan, type ToolPlan } from '../../pluginHost/api';
import type { TimelineFile, TimelineFileItem } from '../../types';

// One test per rule, and one per boundary the domain cares about: the sprint with no
// velocity to measure against, the item with no estimate, the item that fits in no
// sprint at all, the scope with nothing open left. „It works on the happy path" is not
// what these are for: a plausible-looking wrong rule is worse than a missing one,
// because it gets trusted.
//
// Every plan is also checked against `validateToolPlan`, which is the frame the host
// puts around a rule: ids that exist, no rename, nothing host-managed. Cheaper to
// assert here than to discover through a refused call.

const RASTER = { start: '2026-01-05', lengthDays: 14, velocity: 20 };
const NOW = '2026-02-04'; // inside sprint 3

const decl = (name: string) => sprintsManifest.tools!.find((t) => t.name === name)!;

const item = (
  id: string,
  start: string | undefined,
  storyPoints?: unknown,
  over: Partial<TimelineFileItem> = {},
): TimelineFileItem => ({
  id,
  content: id,
  ...(start ? { start } : {}),
  ...over,
  metadata: { ...(storyPoints === undefined ? {} : { storyPoints }), ...(over.metadata ?? {}) },
});

const file = (items: TimelineFileItem[]): TimelineFile => ({ items });

/** Sprint 3 holds 34 points against a velocity of 20; sprint 4 already holds 8. */
const overcommitted = file([
  item('P-1', '2026-01-05', '8'),
  item('P-2', '2026-02-02', '13'),
  item('A-3', '2026-02-03', '8'),
  item('I-2', '2026-02-09', '5'),
  item('Q-2', '2026-02-11', '8'),
  item('A-4', '2026-02-16', '8'),
]);

const notes = (plan: ToolPlan) => plan.notes ?? [];
const says = (plan: ToolPlan, needle: string) => notes(plan).some((note) => note.includes(needle));
const said = (plan: ToolPlan, needle: string) =>
  assert.equal(says(plan, needle), true, `no note said "${needle}": ${notes(plan).join(' | ')}`);
const didNotSay = (plan: ToolPlan, needle: string) =>
  assert.equal(says(plan, needle), false, `a note said "${needle}": ${notes(plan).join(' | ')}`);

// ---- check_sprint_capacity ---------------------------------------------------

const capacity = (args: Record<string, unknown>, timeline = overcommitted, config: Record<string, unknown> = RASTER) =>
  checkSprintCapacity({ file: timeline, config, args, now: NOW });

test('the capacity check sums each sprint in play against the velocity', () => {
  const plan = capacity({});
  said(plan, 'Sprint 1: 8 von 20 Punkten aus 1 Eintrag (im Rahmen).');
  said(plan, 'Sprint 3: 34 von 20 Punkten aus 4 Einträgen (überbucht).');
  said(plan, 'Sprint 4: 8 von 20 Punkten aus 1 Eintrag (im Rahmen).');
  // An analysis tool must return no changes, or the host refuses the whole plan.
  assert.equal(plan.changes, undefined);
  assert.deepEqual(validateToolPlan(decl('check_sprint_capacity'), overcommitted, plan), []);
});

test('the capacity check narrows to one sprint when asked', () => {
  const plan = capacity({ sprint: 3 });
  said(plan, 'Sprint 3: 34 von 20 Punkten');
  didNotSay(plan, 'Sprint 1:');
});

test('a sprint that holds nothing is reported as empty, not as 0 of 20', () => {
  said(capacity({ sprint: 9 }), 'Sprint 9 ist leer.');
});

test('items with no usable estimate are named rather than counted as zero', () => {
  // A missing key, an empty string, a word and a stray array are one case: none of
  // them can be summed. A sum that quietly omits them reads as a capacity statement
  // and is not one.
  const timeline = file([
    item('mit', '2026-02-02', '8'),
    item('ohne', '2026-02-03'),
    item('leer', '2026-02-04', ''),
    item('wort', '2026-02-05', 'XL'),
    item('liste', '2026-02-06', ['8']),
    item('null', '2026-02-07', 0),
  ]);
  const plan = capacity({ sprint: 3 }, timeline);
  said(plan, 'Sprint 3: 8 von 20 Punkten aus 6 Einträgen');
  said(plan, 'ohne verwertbare Schätzung: „ohne", „leer", „wort", „liste", „null"');
  said(plan, 'Eine Summe, in der 5 Einträge fehlen, ist keine Kapazitätsaussage.');
});

test('without a usable velocity the capacity check says it cannot answer', () => {
  for (const config of [
    { start: '2026-01-05', lengthDays: 14 }, // absent
    { ...RASTER, velocity: 0 }, // zero: never a division, and never a yardstick either
    { ...RASTER, velocity: -3 },
    { ...RASTER, velocity: 'viel' },
  ]) {
    const plan = capacity({ sprint: 3 }, overcommitted, config);
    said(plan, 'lässt sich nicht sagen, ob ein Sprint');
    // The sums still stand, labelled as sums: summing needs no velocity, and
    // withholding the numbers would be less useful than saying they have no yardstick.
    said(plan, 'Sprint 3: 34 Punkte aus 4 Einträgen.');
    // No verdict anywhere: „von 20 Punkten" is the shape a comparison would take.
    didNotSay(plan, 'von 20 Punkten');
  }
});

test('nothing in the raster at all is said out loud', () => {
  const plan = capacity({}, file([item('a', undefined, '8'), item('b', '2025-12-15', '5')]));
  said(plan, 'Kein Eintrag fällt in einen Sprint des Rasters (Anker 2026-01-05, 14 Tage).');
  // …and the thirteen points are still named. „Nothing is in the raster" plus silence
  // about what is outside it reads as „there is nothing", which is a different claim.
  said(plan, '13 Punkte aus 2 Einträgen (a, b)');
});

test('items the raster does not place are reported, not dropped from the answer', () => {
  // The sweep iterates the sprints in play, so an item with no start, or a start before
  // the anchor, appeared in no line at all — while `forecast_completion` counted its
  // points. On the shipped example those are P-0 (3 points, starts 2025-12-15) and P-4
  // (5 points, no start), and neither showed up anywhere in the answer.
  const timeline = file([
    item('P-0', '2025-12-15', '3'),
    item('P-4', undefined, '5'),
    item('P-1', '2026-01-05', '8'),
  ]);
  const plan = capacity({}, timeline);
  said(plan, 'Sprint 1: 8 von 20 Punkten aus 1 Eintrag (im Rahmen).');
  said(plan, 'Außerhalb des Rasters und daher in keiner Sprint-Summe: 8 Punkte aus 2 Einträgen (P-0, P-4),');
  said(plan, 'ohne Startdatum oder mit einem Start vor dem Anker 2026-01-05');
  // A caller who named one sprint asked about that sprint, so the line would be noise
  // there rather than a scope the answer left out.
  didNotSay(capacity({ sprint: 1 }, timeline), 'Außerhalb des Rasters');
});

test('the verdict cannot contradict the numbers printed beside it', () => {
  // „0.1" + „0.2" is 0.30000000000000004 in binary floating point, so against a velocity
  // of 0.3 the check printed „0.3 von 0.3 Punkten (überbucht)": the verdict said the
  // opposite of the two numbers in front of it.
  const config = { ...RASTER, velocity: 0.3 };
  const timeline = file([item('a', '2026-02-02', '0.1'), item('b', '2026-02-03', '0.2')]);
  said(capacity({ sprint: 3 }, timeline, config), 'Sprint 3: 0.3 von 0.3 Punkten aus 2 Einträgen (im Rahmen).');
  // The writing verb has to agree, or it moves a date over a rounding artefact.
  const plan = rebalance({ sprint: 3 }, timeline, config);
  assert.equal(plan.changes, undefined);
  said(plan, 'Sprint 3: 0.3 von 0.3 Punkten, nicht überbucht.');
});

test('a sum that is no longer a representable number is refused, not printed as Infinity', () => {
  // `points()` multiplied by 100 before rounding, and that product overflows: a finite
  // total of 2e307 printed „Infinity", which is not a number anybody can check.
  const large = file([item('a', '2026-02-02', 1e307), item('b', '2026-02-03', 1e307)]);
  said(capacity({ sprint: 3 }, large), 'Sprint 3: 2e+307 von 20 Punkten aus 2 Einträgen (überbucht).');

  // A total that really is Infinity is not a capacity at all, and both verbs say so
  // rather than comparing against it.
  const beyond = file([item('a', '2026-02-02', 1e308), item('b', '2026-02-03', 1e308)]);
  said(capacity({ sprint: 3 }, beyond), 'Die Summe der Schätzungen ist keine darstellbare Zahl mehr (Infinity)');
  didNotSay(capacity({ sprint: 3 }, beyond), 'von 20 Punkten');
  const plan = rebalance({ sprint: 3 }, beyond);
  assert.equal(plan.changes, undefined);
  said(plan, 'keine darstellbare Zahl mehr');
});

test('only a plain decimal counts as an estimate', () => {
  // Bare `Number()` also reads „0x10" as 16 and „1e3" as 1000, so a typo in a
  // hand-written file entered the capacity sum as a number nobody wrote — and a sum
  // always looks right. `AGENTS.md` promises a plain string of digits.
  const timeline = file([
    item('hex', '2026-02-02', '0x10'),
    item('exponent', '2026-02-03', '1e3'),
    item('komma', '2026-02-04', '2,5'),
    item('vorzeichen', '2026-02-05', '+8'),
    item('bruch', '2026-02-06', '2.5'),
    item('fuehrende-null', '2026-02-07', '08'),
  ]);
  const plan = capacity({ sprint: 3 }, timeline);
  said(plan, 'Sprint 3: 18.5 von 20 Punkten aus 6 Einträgen (im Rahmen).');
  said(plan, 'ohne verwertbare Schätzung: „hex", „exponent", „komma"');
});

test('an unconfigured raster is refused, not answered with an empty plan', () => {
  // „Nothing to do" is what an empty plan says, and an unconfigured raster is not
  // that. The message reaches the agent, which is the only party that can fix it.
  assert.throws(() => capacity({}, overcommitted, {}), /Kein Sprintraster konfiguriert/);
  assert.throws(() => capacity({}, overcommitted, { start: '2026-01-05', lengthDays: 0 }), /lengthDays/);
  assert.throws(() => capacity({ sprint: 0 }), /keine Sprintnummer/);
});

// ---- rebalance_sprint -------------------------------------------------------

const rebalance = (args: Record<string, unknown>, timeline = overcommitted, config: Record<string, unknown> = RASTER) =>
  rebalanceSprint({ file: timeline, config, args, now: NOW });

test('rebalancing moves the latest starts out until the sprint fits', () => {
  const plan = rebalance({ sprint: 3 });
  // 34 → 26 → 21 → 13: Q-2 (11.2.), I-2 (9.2.), A-3 (3.2.). P-2 stays, and the sprint
  // is not emptied beyond what it takes to fit.
  assert.deepEqual(plan.changes, [
    { op: 'update', itemId: 'Q-2', patch: { start: '2026-02-25' } },
    { op: 'update', itemId: 'I-2', patch: { start: '2026-02-23' } },
    { op: 'update', itemId: 'A-3', patch: { start: '2026-02-17' } },
  ]);
  said(plan, 'Sprint 3: 3 von 4 Einträgen nach Sprint 4 verschoben');
  said(plan, '34 → 13 von 20 Punkten.');
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), overcommitted, plan), []);
});

test('the receiving sprint is reported, and nothing cascades into it', () => {
  // A cascade rewrites the rest of the roadmap out of a single call. An agent that
  // wants the next sprint relieved asks again, and the note says so.
  const plan = rebalance({ sprint: 3 });
  said(plan, 'Sprint 4 ist damit überbucht (29 von 20 Punkten).');
  said(plan, 'für den nächsten ist ein zweiter Aufruf nötig');
  assert.equal(
    plan.changes?.every((change) => change.op === 'update' && ['Q-2', 'I-2', 'A-3'].includes(change.itemId)),
    true,
  );
});

test('a move keeps the duration: an end shifts by the same amount', () => {
  const timeline = file([
    item('lang', '2026-02-11', '8', { end: '2026-02-20T18:00:00' }),
    item('bleibt', '2026-02-02', '13'),
  ]);
  const plan = rebalance({ sprint: 3 }, timeline);
  assert.deepEqual(plan.changes, [
    { op: 'update', itemId: 'lang', patch: { start: '2026-02-25', end: '2026-03-06T18:00:00' } },
  ]);
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), timeline, plan), []);
});

test('the same start orders by the larger estimate, then by the item id', () => {
  const config = { ...RASTER, velocity: 8 };
  const bigger = file([item('k-small', '2026-01-06', '2'), item('k-big', '2026-01-06', '8'), item('j', '2026-01-05', '3')]);
  assert.deepEqual(rebalance({ sprint: 1 }, bigger, config).changes, [
    { op: 'update', itemId: 'k-big', patch: { start: '2026-01-20' } },
  ]);

  // Same day, same estimate: the id is the third key, and without it two runs could
  // produce two different roadmaps out of the source order alone.
  const tied = file([item('b', '2026-01-06', '5'), item('a', '2026-01-06', '5')]);
  assert.deepEqual(rebalance({ sprint: 1 }, tied, config).changes, [
    { op: 'update', itemId: 'a', patch: { start: '2026-01-20' } },
  ]);
});

test('a sprint that is not overcommitted is left alone', () => {
  const plan = rebalance({ sprint: 1 });
  assert.deepEqual(plan.changes, undefined);
  said(plan, 'Sprint 1: 8 von 20 Punkten, nicht überbucht.');
});

test('an empty sprint has nothing to relieve', () => {
  said(rebalance({ sprint: 9 }), 'Sprint 9 ist leer, es gibt nichts zu entlasten.');
});

test('an item bigger than the whole velocity is reported, never moved forever', () => {
  // Moving it relieves nothing: it fits in no sprint of this raster, so every call
  // would push it one sprint further down the roadmap and the sprint it lands in would
  // be overcommitted by the same item.
  const timeline = file([item('Monolith', '2026-01-05', '34')]);
  const plan = rebalance({ sprint: 1 }, timeline);
  assert.deepEqual(plan.changes, []);
  said(plan, '„Monolith" trägt 34 Punkte und passt damit in keinen Sprint mit velocity 20.');
  said(plan, 'Sprint 1 bleibt überbucht (34 von 20 Punkten)');
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), timeline, plan), []);
});

test('an item with no usable estimate is named and stays put', () => {
  // Moving it would reduce the sum by nothing, so it would be a write with no reason.
  const timeline = file([item('gross', '2026-01-05', '21'), item('ungeschätzt', '2026-01-06')]);
  const plan = rebalance({ sprint: 1 }, timeline);
  assert.deepEqual(plan.changes, []);
  said(plan, 'ohne verwertbare Schätzung: „ungeschätzt"');
  said(plan, 'Sprint 1 bleibt überbucht (21 von 20 Punkten)');
});

test('rebalancing without a usable velocity refuses rather than guessing what fits', () => {
  // It writes, so a refusal is the only safe answer: „what fits" is undefined without
  // a velocity, and a default would move items on the strength of a number nobody entered.
  for (const velocity of [undefined, 0, -3, 'viel']) {
    assert.throws(
      () => rebalance({ sprint: 3 }, overcommitted, { start: '2026-01-05', lengthDays: 14, velocity }),
      /velocity/,
      `velocity ${String(velocity)}`,
    );
  }
});

test('rebalancing needs to be told which sprint', () => {
  assert.throws(() => rebalance({}), /`sprint` fehlt/);
  assert.throws(() => rebalance({ sprint: 'drei' }), /keine Sprintnummer/);
  // The host checks the arguments before the handler runs; this is that check.
  assert.deepEqual(validateToolArgs(decl('rebalance_sprint'), { sprint: 3 }), []);
  assert.equal(validateToolArgs(decl('rebalance_sprint'), {}).length, 1);
});

test('a rejected sprint argument is quoted so it cannot look like valid input', () => {
  // `String([3])` is „3", so `{sprint: [3]}` came back quoted as the number it is not:
  // an agent reading „„3" ist keine Sprintnummer" sees a valid sprint number being
  // refused and has nothing to correct.
  assert.throws(() => rebalance({ sprint: [3] }), /^Error: \[3\] ist keine Sprintnummer/);
  assert.throws(() => rebalance({ sprint: 'drei' }), /^Error: "drei" ist keine Sprintnummer/);
  assert.throws(() => rebalance({ sprint: {} }), /^Error: \{\} ist keine Sprintnummer/);
  assert.throws(() => rebalance({ sprint: 2.5 }), /^Error: 2\.5 ist keine Sprintnummer/);
});

test('finished work counts in the sum and is never re-dated', () => {
  // The reproduction is the shipped example at velocity 10: sprint 1 holds P-1 and A-1,
  // both „Done", 13 points in total. `movable` was built from estimate, id and end
  // alone — `status` was never read — so the rule rewrote the dates of work that was
  // over, while `forecast_completion` had been excluding „Done" all along. The points
  // stay in the sum, because that capacity really was consumed.
  const config = { ...RASTER, velocity: 10 };
  const timeline = file([
    item('P-1', '2026-01-05', '8', { status: 'Done' }),
    item('A-1', '2026-01-07', '5', { status: 'Done' }),
  ]);
  const plan = rebalance({ sprint: 1 }, timeline, config);
  assert.deepEqual(plan.changes, []);
  said(plan, 'Abgeschlossene Arbeit wird nicht verschoben („P-1", „A-1")');
  said(plan, 'Sprint 1 bleibt überbucht (13 von 10 Punkten)');
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), timeline, plan), []);
});

test('an open item moves while the finished one beside it stays', () => {
  const config = { ...RASTER, velocity: 8 };
  const timeline = file([
    item('fertig', '2026-01-05', '8', { status: 'Done' }),
    item('offen', '2026-01-07', '2'),
  ]);
  const plan = rebalance({ sprint: 1 }, timeline, config);
  assert.deepEqual(plan.changes, [{ op: 'update', itemId: 'offen', patch: { start: '2026-01-21' } }]);
  said(plan, '10 → 8 von 8 Punkten.');
  said(plan, 'Abgeschlossene Arbeit wird nicht verschoben („fertig")');
});

test('an item another item depends on is not moved past its successor', () => {
  // `metadata.dependsOn` is a core reserved key and the relation graph draws an edge for
  // it, so moving a predecessor by a sprint length puts its successor's start before the
  // predecessor's end and the graph draws the arrow backwards. The successors are
  // deliberately not moved along: that is the same „one call rewrites the roadmap" trade
  // the no-cascade rule already refuses.
  const timeline = file([
    item('BIG', '2026-02-10', '13', { end: '2026-02-15' }),
    item('klein', '2026-02-03', '8'),
    item('SUCC', '2026-02-16', '1', { metadata: { dependsOn: ['BIG'] } }),
  ]);
  const plan = rebalance({ sprint: 3 }, timeline);
  // „klein" starts earlier, so the old order picked BIG first and moved it.
  assert.deepEqual(plan.changes, [{ op: 'update', itemId: 'klein', patch: { start: '2026-02-17' } }]);
  said(plan, '„BIG" wird nicht verschoben: „SUCC" hängt davon ab');
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), timeline, plan), []);

  // A single id written as a bare string is the other shape `extractDependsOn`
  // (src/buildItems.ts) accepts, so this rule has to read it too.
  const bare = file([
    item('BIG', '2026-02-10', '13', { end: '2026-02-15' }),
    item('klein', '2026-02-03', '8'),
    item('SUCC', '2026-02-16', '1', { metadata: { dependsOn: 'BIG' } }),
  ]);
  said(rebalance({ sprint: 3 }, bare), '„BIG" wird nicht verschoben');
});

test('a sprint whose immovable part alone exceeds the velocity is left untouched', () => {
  // Reproduction: „MONOLITH" carries 30 points and fits in no sprint of this raster, so
  // it cannot move; „klein" carries 2. The old rule moved „klein" and then reported the
  // sprint still overcommitted at 30 of 20 — a date rewrite with no possible benefit,
  // which is worse than a refusal because it looks like the tool worked.
  const timeline = file([item('MONOLITH', '2026-02-02', '30'), item('klein', '2026-02-05', '2')]);
  const plan = rebalance({ sprint: 3 }, timeline);
  assert.deepEqual(plan.changes, []);
  said(plan, 'Sprint 3 bleibt überbucht (32 von 20 Punkten): allein was nicht verschoben werden kann, trägt 30 Punkte');
  said(plan, 'deshalb ändert dieser Aufruf nichts');
  didNotSay(plan, 'verschoben (');
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), timeline, plan), []);
});

test('an id that is only whitespace is named rather than written into a refused plan', () => {
  // `if (!item.id)` let `"  "` through, and `validateToolPlan` then rejected the WHOLE
  // plan over the blank `itemId` — so one whitespace id made a genuinely overcommitted
  // sprint impossible to relieve at all.
  const timeline = file([item('  ', '2026-02-11', '13'), item('echt', '2026-02-03', '13')]);
  const plan = rebalance({ sprint: 3 }, timeline);
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), timeline, plan), []);
  assert.deepEqual(plan.changes, [{ op: 'update', itemId: 'echt', patch: { start: '2026-02-17' } }]);
  said(plan, 'hat keine Id und kann daher nicht verschoben werden');
});

test('a start that cannot be shifted back is named instead of silently skipped', () => {
  // The move used to be attempted and abandoned inside the loop, so the item was neither
  // moved nor named and the sum it left behind had no explanation.
  const config = { start: '9999-12-29', lengthDays: 14, velocity: 20 };
  const timeline = file([item('rand', '9999-12-30', '13'), item('klein', '9999-12-29', '13')]);
  const plan = rebalance({ sprint: 1 }, timeline, config);
  said(plan, '„rand" hat einen Start, der sich nicht verschieben lässt (9999-12-30)');
  assert.deepEqual(validateToolPlan(decl('rebalance_sprint'), timeline, plan), []);
});

test('the id tie-break is a total order, including ids a collator calls equal', () => {
  // `localeCompare` returns 0 for „a" + U+00AD + „b" against „ab" (a soft hyphen is
  // ignorable), so the third sort key stopped separating two items and the order fell
  // back to however the source listed them: two runs, two different roadmaps.
  assert.equal('a\u00ADb'.localeCompare('ab'), 0, 'the premise: a collator calls these two equal');
  const config = { ...RASTER, velocity: 8 };
  const oneWay = file([item('a\u00ADb', '2026-01-06', '5'), item('ab', '2026-01-06', '5')]);
  const theOther = file([item('ab', '2026-01-06', '5'), item('a\u00ADb', '2026-01-06', '5')]);
  assert.deepEqual(rebalance({ sprint: 1 }, oneWay, config).changes, [
    { op: 'update', itemId: 'ab', patch: { start: '2026-01-20' } },
  ]);
  assert.deepEqual(rebalance({ sprint: 1 }, theOther, config).changes, rebalance({ sprint: 1 }, oneWay, config).changes);
});

// ---- forecast_completion ----------------------------------------------------

const forecastTimeline = file([
  item('erledigt', '2026-01-05', '13', { status: 'Done' }),
  item('offen-1', '2026-02-02', '13', { group: 'plattform' }),
  item('offen-2', '2026-02-09', '8', { status: 'Doing', group: 'app' }),
  item('ohne-schätzung', '2026-02-16', undefined, { group: 'app' }),
]);

const forecast = (
  args: Record<string, unknown>,
  timeline = forecastTimeline,
  config: Record<string, unknown> = RASTER,
  now = NOW,
) => forecastCompletion({ file: timeline, config, args, now });

test('the forecast counts open points from the sprint today falls into', () => {
  // 21 open points at velocity 20 is two sprints, and today is in sprint 3, so the
  // scope is expected to finish in sprint 4.
  const plan = forecast({});
  said(plan, '21 offene Punkte bei velocity 20: 2 Sprints ab Sprint 3');
  said(plan, 'Abschluss voraussichtlich in Sprint 4 (ab 2026-02-16).');
  said(plan, 'keine Zusage');
  said(plan, 'Ohne verwertbare Schätzung und daher nicht in der Rechnung: „ohne-schätzung"');
  assert.equal(plan.changes, undefined);
  assert.deepEqual(validateToolPlan(decl('forecast_completion'), forecastTimeline, plan), []);
});

test('the forecast narrows to one group when asked', () => {
  const plan = forecast({ group: 'app' });
  said(plan, '8 offene Punkte in Gruppe „app" bei velocity 20: 1 Sprint ab Sprint 3');
  said(plan, 'Abschluss voraussichtlich in Sprint 3');
  didNotSay(plan, '„offen-1"');
});

test('a now before the anchor counts from sprint 1, when that is where the work is', () => {
  // The raster has nothing earlier than sprint 1, so a `now` before the anchor counts
  // from it. What must not follow is counting from sprint 1 while the work is scheduled
  // later — that is the test below.
  const early = file([item('a', '2026-01-05', '13'), item('b', '2026-01-06', '8')]);
  said(forecast({}, early, RASTER, '2025-11-30'), '2 Sprints ab Sprint 1');
  said(forecast({}, early, RASTER, '2025-11-30'), 'Abschluss voraussichtlich in Sprint 2 (ab 2026-01-19).');
  didNotSay(forecast({}, early, RASTER, '2025-11-30'), 'Gezählt wird ab');
});

test('the count starts where the open work is scheduled, not where today is', () => {
  // Counting from „now" alone promised a completion before the plan even starts the
  // work: 25 points scheduled in sprint 5 were reported as finishing in sprint 2 when
  // asked in sprint 1.
  const timeline = file([item('spaeter', '2026-03-02', '25')]);
  const plan = forecast({}, timeline, RASTER, '2026-01-06');
  said(plan, '2 Sprints ab Sprint 5');
  said(plan, 'Abschluss voraussichtlich in Sprint 6 (ab 2026-03-16).');
  said(plan, 'Gezählt wird ab Sprint 5, nicht ab dem heutigen Sprint 1');
  didNotSay(plan, 'Abschluss voraussichtlich in Sprint 2');
});

test('a forecast the plan contradicts says so', () => {
  // The reproduction is the shipped example's group „4-qualitaet" asked on 2026-02-10:
  // „Abschluss voraussichtlich in Sprint 3 (ab 2026-02-02)", a first day eight days in
  // the past, while half those points belong to an item not scheduled before sprint 7.
  // This rule divides points by a throughput and reads no start dates, so where the plan
  // disagrees it has to say so instead of leaving the reader to notice.
  const timeline = file([item('Q-2', '2026-02-11', '8'), item('Q-3', '2026-03-30', '8')]);
  const plan = forecast({}, timeline, RASTER, '2026-02-10');
  said(plan, 'Abschluss voraussichtlich in Sprint 3');
  said(plan, 'Der Plan widerspricht dieser Hochrechnung: offene Arbeit ist erst nach Sprint 3 terminiert („Q-3")');
});

test('an unusable now is said out loud instead of silently becoming sprint 1', () => {
  // `sprintOfDay(raster, now) ?? 1` conflated „before the anchor" (a real day the raster
  // does not cover) with „not a date at all": „", „heute" and „2026-13-40" all became
  // sprint 1, and the answer read exactly as confident as any other.
  for (const now of ['', '   ', 'heute', '2026-13-40']) {
    said(forecast({}, forecastTimeline, RASTER, now), 'ist kein Datum, deshalb beginnt die Zählung bei Sprint 1');
  }
  // A real day before the anchor is the other case, and gets no such note.
  didNotSay(forecast({}, forecastTimeline, RASTER, '2025-11-30'), 'ist kein Datum');
});

test('nothing open left is an answer, not an empty plan', () => {
  const done = file([item('a', '2026-01-05', '8', { status: 'Done' }), item('b', '2026-02-02', '5', { status: 'Done' })]);
  const plan = forecast({}, done);
  said(plan, 'Kein offener Eintrag: es gibt nichts hochzurechnen.');
  assert.equal(plan.changes, undefined);
  said(forecast({ group: 'app' }, done), 'Kein offener Eintrag in Gruppe „app": es gibt nichts hochzurechnen.');
});

test('open items with no usable estimate give no forecast, and are named', () => {
  const unestimated = file([item('a', '2026-02-02'), item('b', '2026-02-03', 'XL')]);
  const plan = forecast({}, unestimated);
  said(plan, 'ohne Punkte gibt es keine Prognose');
  said(plan, 'Ohne verwertbare Schätzung und daher nicht in der Rechnung: „a", „b"');
  didNotSay(plan, 'Abschluss voraussichtlich');
});

test('without a usable velocity the forecast says it cannot answer', () => {
  for (const velocity of [undefined, 0, -3, 'viel']) {
    const plan = forecast({}, forecastTimeline, { start: '2026-01-05', lengthDays: 14, velocity });
    said(plan, 'lässt sich kein Abschluss-Sprint hochrechnen');
    didNotSay(plan, 'Abschluss voraussichtlich');
    assert.equal(plan.changes, undefined);
  }
});

// ---- the wiring -------------------------------------------------------------

test('every declared tool has an implementation, and every implementation a declaration', () => {
  // The two live in different files and drift silently: a declared verb with no handler
  // is one an agent can see and cannot call, and a handler nobody declared never
  // becomes callable.
  const declared = (sprintsManifest.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(Object.keys(sprintsTools).sort(), declared);
});

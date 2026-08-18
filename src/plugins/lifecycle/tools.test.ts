import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkEolRisk, lifecycleTools, planCutover, shiftOutOfFreeze } from './tools';
import { lifecycleManifest } from './manifest';
import { LIFECYCLE_PLUGIN } from './lifecycle';
import { validateToolArgs, validateToolPlan, type ToolPlan } from '../../pluginHost/api';
import type { TimelineFile, TimelineFileItem } from '../../types';

// The rules themselves are pinned in `lifecycle.test.ts`. These tests are about the
// three verbs as the host sees them: the arguments they accept, the plans they return,
// and the refusals a caller has to be able to act on.
//
// Every plan is checked against `validateToolPlan`, which is the frame the host puts
// around a rule — ids that exist, no rename, nothing host-managed, and no `changes` from
// a verb that declared no `writes`. Cheaper to assert here than to discover through a
// refused call.

type Decl = NonNullable<typeof lifecycleManifest.tools>[number];
const decl = (name: string): Decl => lifecycleManifest.tools!.find((t) => t.name === name)!;

const NOW = '2026-08-18';
const CONFIG = { minParallelRunDays: 30, defaultLeadTimeDays: 180 };

type PlanSpec = {
  system?: string;
  endOfSupport?: string;
  extendedUntil?: string;
  leadTimeDays?: unknown;
  cutover?: string;
  shutdown?: string;
  start?: string;
  content?: string;
};

const item = (id: string, spec: PlanSpec = {}): TimelineFileItem => {
  const metadata: Record<string, unknown> = {};
  for (const key of ['system', 'endOfSupport', 'extendedUntil', 'leadTimeDays', 'cutover', 'shutdown'] as const) {
    if (spec[key] !== undefined) metadata[key] = spec[key];
  }
  return {
    id,
    content: spec.content ?? id,
    ...(spec.start ? { start: spec.start } : {}),
    metadata,
  };
};

type FreezeSpec = [id: string, name: string, from: string, to: string];

const file = (items: TimelineFileItem[], freezes: FreezeSpec[] = []): TimelineFile =>
  ({
    id: 't',
    plugins: [{ id: LIFECYCLE_PLUGIN }],
    pluginData: {
      [LIFECYCLE_PLUGIN]: {
        freezes: freezes.map(([id, name, from, to]) => ({ id, data: { name, from, to } })),
      },
    },
    items,
  }) as unknown as TimelineFile;

/** Run a verb the way the host does, and hold its plan to the host's own frame. */
const run = (
  name: string,
  handler: (ctx: { file: TimelineFile; config: Record<string, unknown>; args: Record<string, unknown>; now: string }) => ToolPlan,
  f: TimelineFile,
  args: Record<string, unknown> = {},
  config: Record<string, unknown> = CONFIG,
): ToolPlan => {
  assert.deepEqual(validateToolArgs(decl(name), args), [], `arguments refused for ${name}`);
  const plan = handler({ file: f, config, args, now: NOW });
  assert.deepEqual(validateToolPlan(decl(name), f, plan), [], `plan refused for ${name}`);
  return plan;
};

// ---- plan_cutover ----------------------------------------------------------------

test('plan_cutover writes only the cutover and the shutdown, and keeps other metadata', () => {
  const f = file([item('a', { endOfSupport: '2026-10-14', start: '2026-03-01', system: 'Exchange 2016' })]);
  const plan = run('plan_cutover', planCutover, f, { item: 'a' });

  assert.equal(plan.changes?.length, 1);
  const change = plan.changes![0];
  assert.equal(change.op, 'update');
  assert.ok(change.op === 'update');
  assert.deepEqual(change.patch.metadata, {
    // Untouched, and that is the point: a patch replaces `metadata` wholesale, so a
    // verb that rebuilt only its own keys would delete the vendor date it just read.
    endOfSupport: '2026-10-14',
    system: 'Exchange 2016',
    cutover: '2026-09-14',
    shutdown: '2026-10-14',
  });
});

test('plan_cutover names the parallel run it produced', () => {
  const f = file([item('a', { endOfSupport: '2026-10-14', start: '2026-03-01' })]);
  const plan = run('plan_cutover', planCutover, f, { item: 'a' });
  assert.ok(plan.notes?.some((n) => n.includes('parallel run 30 days')));
});

test('plan_cutover says it moved a cutover earlier, and why that is the safe direction', () => {
  const f = file(
    [item('a', { endOfSupport: '2027-01-15', leadTimeDays: 300 })],
    [['ye', 'Year-end freeze', '2026-12-20', '2026-12-31']],
  );
  const plan = run('plan_cutover', planCutover, f, { item: 'a' }, { minParallelRunDays: 20 });
  const change = plan.changes![0];
  assert.ok(change.op === 'update');
  assert.equal((change.patch.metadata as Record<string, unknown>).cutover, '2026-12-19');
  assert.ok(plan.notes?.some((n) => n.includes('Year-end freeze') && n.includes('lengthens')));
});

test('plan_cutover reports a deadline that has already passed instead of hiding it', () => {
  const f = file([item('a', { endOfSupport: '2025-10-14' })]);
  const plan = run('plan_cutover', planCutover, f, { item: 'a' });
  assert.ok(plan.notes?.some((n) => n.includes('already behind 2026-08-18')));
});

test('plan_cutover reports a plan that starts after the latest possible start', () => {
  const f = file([item('a', { endOfSupport: '2026-10-14', start: '2026-08-01' })]);
  const plan = run('plan_cutover', planCutover, f, { item: 'a' });
  assert.ok(plan.notes?.some((n) => n.includes('latest possible start') && n.includes('2026-04-17')));
});

test('plan_cutover refuses an unknown item, a missing vendor date and a missing minimum', () => {
  assert.throws(
    () => planCutover({ file: file([item('a')]), config: CONFIG, args: { item: 'nope' }, now: NOW }),
    /no item "nope"/,
  );
  assert.throws(
    () => planCutover({ file: file([item('a', { system: 'X' })]), config: CONFIG, args: { item: 'a' }, now: NOW }),
    /no end-of-support date/,
  );
  assert.throws(
    () =>
      planCutover({
        file: file([item('a', { endOfSupport: '2026-10-14' })]),
        config: {},
        args: { item: 'a' },
        now: NOW,
      }),
    /no minParallelRunDays configured/,
  );
});

test('plan_cutover refuses when the freeze windows leave no room before the start', () => {
  const f = file(
    [item('a', { endOfSupport: '2026-10-14', start: '2026-09-01' })],
    [['long', 'Whole-year freeze', '2026-01-01', '2026-10-14']],
  );
  assert.throws(
    () => planCutover({ file: f, config: CONFIG, args: { item: 'a' }, now: NOW }),
    /before the item's own start \(2026-09-01\)/,
  );
});

// ---- check_eol_risk ---------------------------------------------------------------

test('check_eol_risk returns no changes at all, because it declares no writes', () => {
  const f = file([item('a', { endOfSupport: '2026-10-14', start: '2026-08-01' })]);
  const plan = run('check_eol_risk', checkEolRisk, f);
  // `validateToolPlan` inside `run` already refuses changes here; this pins the intent.
  assert.equal(plan.changes, undefined);
  assert.ok(plan.notes?.length);
});

test('check_eol_risk says a timeline carries no lifecycle dates rather than "no risks"', () => {
  const plan = run('check_eol_risk', checkEolRisk, file([item('a'), item('b')]));
  assert.ok(plan.notes?.[0].includes('nothing to judge'));
});

test('check_eol_risk names an unchecked parallel run when no minimum is configured', () => {
  const f = file([item('a', { endOfSupport: '2026-10-14', leadTimeDays: 180, start: '2026-03-01', cutover: '2026-10-13', shutdown: '2026-10-14' })]);
  const plan = run('check_eol_risk', checkEolRisk, f, {}, { defaultLeadTimeDays: 180 });
  // Two of the checks did not run, so „none at risk" must not be read as covering them.
  assert.ok(plan.notes?.some((n) => n.includes('no minParallelRunDays is configured')));
});

test('check_eol_risk filters by system and reports an unknown one', () => {
  const f = file([
    item('a', { system: 'Exchange', endOfSupport: '2026-10-14', start: '2026-08-01' }),
    item('b', { system: 'SQL Server', endOfSupport: '2027-07-13', start: '2026-08-01' }),
  ]);
  const only = run('check_eol_risk', checkEolRisk, f, { system: 'Exchange' });
  assert.ok(only.notes!.some((n) => n.includes('Exchange')));
  assert.ok(!only.notes!.some((n) => n.includes('SQL Server')));

  const none = run('check_eol_risk', checkEolRisk, f, { system: 'Notes' });
  assert.ok(none.notes![0].includes('no item on this timeline carries the system "Notes"'));
});

test('check_eol_risk reports a clean timeline as clean, with the count it checked', () => {
  const f = file([
    item('a', {
      endOfSupport: '2026-10-14',
      leadTimeDays: 180,
      start: '2026-03-01',
      cutover: '2026-09-14',
      shutdown: '2026-10-14',
    }),
  ]);
  const plan = run('check_eol_risk', checkEolRisk, f);
  assert.ok(plan.notes![0].includes('none of them at risk'));
});

// ---- shift_out_of_freeze ----------------------------------------------------------

test('shift_out_of_freeze moves the cutover forward and leaves the shutdown alone', () => {
  const f = file(
    [item('a', { endOfSupport: '2027-03-31', cutover: '2026-12-22', shutdown: '2027-01-21' })],
    [['ye', 'Year-end freeze', '2026-12-20', '2026-12-31']],
  );
  const plan = run('shift_out_of_freeze', shiftOutOfFreeze, f, {});
  const change = plan.changes![0];
  assert.ok(change.op === 'update');
  const meta = change.patch.metadata as Record<string, unknown>;
  assert.equal(meta.cutover, '2027-01-01');
  // The vendor's date is the one nobody can negotiate, so the freeze costs parallel-run
  // time rather than pushing the shutdown past end of support.
  assert.equal(meta.shutdown, '2027-01-21');
});

test('shift_out_of_freeze names the days lost and the minimum it dropped under', () => {
  const f = file(
    [item('a', { endOfSupport: '2027-03-31', cutover: '2026-12-22', shutdown: '2027-01-21' })],
    [['ye', 'Year-end freeze', '2026-12-20', '2026-12-31']],
  );
  const plan = run('shift_out_of_freeze', shiftOutOfFreeze, f, {});
  assert.ok(plan.notes!.some((n) => n.includes('10 days later')));
  assert.ok(plan.notes!.some((n) => n.includes('drops to 20 days') && n.includes('minimum of 30')));
});

test('shift_out_of_freeze walks through a chained window', () => {
  const f = file(
    [item('a', { endOfSupport: '2027-06-30', cutover: '2026-12-22', shutdown: '2027-03-01' })],
    [
      ['a', 'Year-end freeze', '2026-12-20', '2026-12-31'],
      ['b', 'January stabilisation', '2027-01-01', '2027-01-10'],
    ],
  );
  const plan = run('shift_out_of_freeze', shiftOutOfFreeze, f, {});
  const change = plan.changes![0];
  assert.ok(change.op === 'update');
  assert.equal((change.patch.metadata as Record<string, unknown>).cutover, '2027-01-11');
});

test('shift_out_of_freeze touches nothing whose cutover is already admissible', () => {
  const f = file(
    [
      item('a', { cutover: '2026-11-02', shutdown: '2026-12-02' }),
      item('b', { cutover: '2026-12-22', shutdown: '2027-01-21' }),
    ],
    [['ye', 'Year-end freeze', '2026-12-20', '2026-12-31']],
  );
  const plan = run('shift_out_of_freeze', shiftOutOfFreeze, f, {});
  assert.equal(plan.changes?.length, 1);
  const change = plan.changes![0];
  assert.ok(change.op === 'update');
  assert.equal(change.itemId, 'b');
});

test('shift_out_of_freeze reports a timeline with no windows and one with nothing frozen', () => {
  const noWindows = run('shift_out_of_freeze', shiftOutOfFreeze, file([item('a', { cutover: '2026-12-22' })]), {});
  assert.equal(noWindows.changes, undefined);
  assert.ok(noWindows.notes![0].includes('declares no freeze windows'));

  const nothingFrozen = run(
    'shift_out_of_freeze',
    shiftOutOfFreeze,
    file([item('a', { cutover: '2026-11-02' })], [['ye', 'Year-end freeze', '2026-12-20', '2026-12-31']]),
    {},
  );
  assert.equal(nothingFrozen.changes, undefined);
  assert.ok(nothingFrozen.notes![0].includes('no cutover on this timeline sits in a freeze window'));
});

test('shift_out_of_freeze reports a cutover that ends up after its own shutdown', () => {
  const f = file(
    [item('a', { cutover: '2026-12-22', shutdown: '2026-12-27' })],
    [['ye', 'Year-end freeze', '2026-12-20', '2026-12-31']],
  );
  const plan = run('shift_out_of_freeze', shiftOutOfFreeze, f, {});
  assert.ok(plan.notes!.some((n) => n.includes('no') && n.includes('parallel run left at all')));
});

test('shift_out_of_freeze refuses an unknown item', () => {
  assert.throws(
    () =>
      shiftOutOfFreeze({
        file: file([item('a')], [['ye', 'y', '2026-12-20', '2026-12-31']]),
        config: CONFIG,
        args: { item: 'nope' },
        now: NOW,
      }),
    /no item "nope"/,
  );
});

// ---- the declarations and the handlers agree --------------------------------------

test('every declared verb has a handler and every handler is declared', () => {
  const declared = (lifecycleManifest.tools ?? []).map((t) => t.name).sort();
  const implemented = Object.keys(lifecycleTools).sort();
  // A declaration with no handler is a verb an agent can see and cannot call; a handler
  // with no declaration stays uncallable. Both are silent without this.
  assert.deepEqual(implemented, declared);
});

test('only the two writing verbs declare writes', () => {
  const writes = (lifecycleManifest.tools ?? []).filter((t) => t.writes === 'items').map((t) => t.name);
  assert.deepEqual(writes.sort(), ['plan_cutover', 'shift_out_of_freeze']);
});

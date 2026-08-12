import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shiftExample } from './tools';
import { exampleManifest } from './manifest';
import { validateToolPlan } from '../../pluginHost/tools';
import type { TimelineFile } from '../../types';

// TEMPLATE. **Delete this file with `tools.ts` if the plugin has no rules.**
// Otherwise: one test per rule, and one per boundary the domain cares about.
//
// This is where a wrong deadline calculation gets caught. A plausible-looking
// wrong rule is worse than a missing one, because it gets trusted — and a rule
// that lives in a prompt cannot be tested at all, which is the whole reason for
// pulling it out into a function.
//
// The boundaries worth a case are the ones a practitioner would name: the deadline
// that falls on a weekend, the trade with zero lead time, the gate that is already
// closed. „It works on the happy path" is not what the tests are for.

const file: TimelineFile = {
  items: [
    { id: 'a', content: 'Mit Datum', start: '2026-03-02' },
    { id: 'b', content: 'Ohne Datum' },
  ],
};

const decl = exampleManifest.tools![0];
const run = (args: Record<string, unknown>, now = '2026-08-11') =>
  shiftExample({ file, config: {}, args, now });

test('touches only the items the rule selects', () => {
  const plan = run({ from: '2026-04-01' });
  assert.deepEqual(plan.changes, [{ op: 'update', itemId: 'a', patch: { start: '2026-04-01' } }]);
});

test('falls back to the date the host handed in, never to the clock', () => {
  // A rule that reads the clock itself cannot be tested against the boundary it
  // exists for, which is why `now` is a parameter.
  const change = run({}).changes?.[0];
  assert.equal(change?.op, 'update');
  assert.deepEqual(change, { op: 'update', itemId: 'a', patch: { start: '2026-08-11' } });
});

test('says what it did, because a diff does not', () => {
  assert.match(run({ from: '2026-04-01' }).notes?.[0] ?? '', /1 Einträge/);
});

test('the plan is one the host will accept', () => {
  // The frame around every rule: item ids that exist, no rename, nothing
  // host-managed. Cheaper to assert here than to discover through a refused call.
  assert.deepEqual(validateToolPlan(decl, file, run({ from: '2026-04-01' })), []);
});

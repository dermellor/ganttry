import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTool, validateToolArgs, validateToolPlan, type ToolHandler } from './tools';
import type { ToolDecl } from './manifest';
import type { TimelineFile } from '../types';

// The checks around a contributed verb. A plugin's own rule gets its own tests in
// its own folder; what is pinned here is the frame the host puts around any rule:
// arguments checked before it runs, the plan checked before anything is written,
// and a throwing handler turned into an answer rather than a stack trace.

const decl = (over: Partial<ToolDecl> = {}): ToolDecl => ({
  name: 'shift_dates',
  title: 'Shift dates',
  description: 'Move the dates of the items a rule selects.',
  writes: 'items',
  ...over,
});

const file: TimelineFile = {
  items: [
    { id: 'a', content: 'Klageerhebung', start: '2026-03-02' },
    { id: 'b', content: 'Frist', start: '2026-03-16' },
  ],
};

test('arguments are checked against the declared schema', () => {
  const withSchema = decl({
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1 } },
      required: ['days'],
      additionalProperties: false,
    },
  });
  assert.deepEqual(validateToolArgs(withSchema, { days: 14 }), []);
  assert.match(validateToolArgs(withSchema, {})[0], /missing required "days"/);
  assert.match(validateToolArgs(withSchema, { days: 0 })[0], /below 1/);
  // additionalProperties: false is the reason the args object reaches this check
  // unstripped; a dropped key would make the typo silently succeed.
  assert.match(validateToolArgs(withSchema, { days: 1, dayz: 2 })[0], /unknown property "dayz"/);
});

test('no declared schema still demands an object', () => {
  assert.deepEqual(validateToolArgs(decl(), { anything: true }), []);
  assert.deepEqual(validateToolArgs(decl(), undefined), []);
  assert.match(validateToolArgs(decl(), 'nope')[0], /must be an object/);
});

test('a plan may only touch items that exist', () => {
  const problems = validateToolPlan(decl(), file, {
    changes: [{ op: 'update', itemId: 'nope', patch: { start: '2026-04-01' } }],
  });
  assert.match(problems[0], /no item "nope"/);
});

test('an item added earlier in the same plan may be updated later in it', () => {
  const problems = validateToolPlan(decl(), file, {
    changes: [
      { op: 'add', item: { id: 'c', content: 'Zustellung', start: '2026-03-01' } },
      { op: 'update', itemId: 'c', patch: { start: '2026-03-03' } },
    ],
  });
  assert.deepEqual(problems, []);
});

test('a plan may not rename an item or forge the managed fields', () => {
  const renaming = validateToolPlan(decl(), file, {
    changes: [{ op: 'update', itemId: 'a', patch: { id: 'a2' } }],
  });
  assert.match(renaming[0], /must not change an item's id/);

  for (const managed of ['version', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']) {
    const problems = validateToolPlan(decl(), file, {
      changes: [{ op: 'update', itemId: 'a', patch: { [managed]: 1 } as never }],
    });
    assert.match(problems.join(' '), new RegExp(`"${managed}" is managed by the host`));
  }
});

test('an added item needs content and a free id', () => {
  assert.match(
    validateToolPlan(decl(), file, { changes: [{ op: 'add', item: { content: '' } }] })[0],
    /needs content/,
  );
  assert.match(
    validateToolPlan(decl(), file, { changes: [{ op: 'add', item: { id: 'a', content: 'Doppelt' } }] })[0],
    /already exists/,
  );
});

test('a tool that declares no writes may not return changes', () => {
  const analysis = decl({ name: 'check_gates', writes: undefined });
  const problems = validateToolPlan(analysis, file, {
    changes: [{ op: 'update', itemId: 'a', patch: { start: '2026-04-01' } }],
    notes: ['one gate is already closed'],
  });
  assert.match(problems[0], /declares no writes/);
  // Notes alone are the legitimate shape for it.
  assert.deepEqual(validateToolPlan(analysis, file, { notes: ['one gate is already closed'] }), []);
});

test('notes have to be strings', () => {
  assert.match(validateToolPlan(decl(), file, { notes: [42] })[0], /array of strings/);
});

test('runTool refuses before the handler runs when the arguments are wrong', () => {
  let ran = false;
  const handler: ToolHandler = () => {
    ran = true;
    return {};
  };
  const withSchema = decl({
    inputSchema: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] },
  });
  const result = runTool(withSchema, handler, { file, config: {}, args: {}, now: '2026-03-02' });
  assert.equal(result.ok, false);
  assert.equal(ran, false, 'a rule must not see arguments that failed their own schema');
});

test('a throwing handler becomes a reported refusal, not an exception', () => {
  const handler: ToolHandler = () => {
    throw new Error('no reference date on this timeline');
  };
  const result = runTool(decl(), handler, { file, config: {}, args: {}, now: '2026-03-02' });
  assert.equal(result.ok, false);
  assert(!result.ok && result.problems[0].includes('no reference date'));
});

test('a handler is handed the config, the args and the date it must not read itself', () => {
  let seen: { config: unknown; args: unknown; now: string } | null = null;
  const handler: ToolHandler = (ctx) => {
    seen = { config: ctx.config, args: ctx.args, now: ctx.now };
    return { changes: [{ op: 'update', itemId: 'b', patch: { start: ctx.now } }] };
  };
  const result = runTool(decl(), handler, {
    file,
    config: { leadTime: 5 },
    args: { days: 14 },
    now: '2026-03-02',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, { config: { leadTime: 5 }, args: { days: 14 }, now: '2026-03-02' });
});

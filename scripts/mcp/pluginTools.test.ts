import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { mcpPluginTools, splitChanges, today, toolArgShape, toolResult } from './pluginTools.ts';
import { register, type PluginDescriptor } from '../../src/pluginHost/registry.ts';
import type { PluginManifest, ToolDecl } from '../../src/pluginHost/manifest.ts';
import type { ToolPlan } from '../../src/pluginHost/tools.ts';
import type { TimelineFile } from '../../src/types.ts';

// Turning a declared verb into something an MCP server can register.
//
// The load-bearing property of the argument shape is that it is never STRICTER
// than the declared schema: this layer exists so an agent sees what to pass, and
// the enforcement happens in `validateToolArgs` against the manifest's own
// schema. A zod type that rejects more than the schema does turns a valid call
// into an error the plugin author cannot find anywhere in their manifest.

const decl = (over: Partial<ToolDecl> = {}): ToolDecl => ({
  name: 'shift_dates',
  title: 'Shift dates',
  description: 'Move dates.',
  writes: 'items',
  ...over,
});

const parse = (d: ToolDecl, value: unknown) => z.object(toolArgShape(d)).safeParse(value);

test('the timeline id is always part of the shape', () => {
  const shape = toolArgShape(decl());
  assert.ok('id' in shape);
  assert.equal(parse(decl(), {}).success, false, 'a tool call without a timeline is not a call');
  assert.equal(parse(decl(), { id: 'roadmap' }).success, true);
});

test('declared properties become typed arguments, optional unless required', () => {
  const d = decl({
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Working days to shift by.' },
        reason: { type: 'string' },
      },
      required: ['days'],
    },
  });
  assert.equal(parse(d, { id: 'x', days: 14 }).success, true);
  assert.equal(parse(d, { id: 'x' }).success, false, 'a required property stays required');
  assert.equal(parse(d, { id: 'x', days: 1.5 }).success, false, 'integer means integer');
  assert.equal(parse(d, { id: 'x', days: 3, reason: 'Zustellung verschoben' }).success, true);
});

test('an enum arrives as a choice', () => {
  const d = decl({
    inputSchema: { type: 'object', properties: { mode: { enum: ['forward', 'backward'] } } },
  });
  assert.equal(parse(d, { id: 'x', mode: 'forward' }).success, true);
  assert.equal(parse(d, { id: 'x', mode: 'sideways' }).success, false);
});

test('what the converter cannot express passes through instead of being guessed', () => {
  // A union of types is legal in the subset and not worth expressing here. The
  // wrong answer would be picking one of them: that rejects a valid call.
  const d = decl({ inputSchema: { type: 'object', properties: { when: { type: ['string', 'null'] } } } });
  assert.equal(parse(d, { id: 'x', when: null }).success, true);
  assert.equal(parse(d, { id: 'x', when: '2026-03-02' }).success, true);
});

test('a nested object keeps unknown keys so the schema check can still refuse them', () => {
  const d = decl({
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          type: 'object',
          properties: { from: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
  });
  const parsed = parse(d, { id: 'x', window: { from: '2026-01-01', to: '2026-02-01' } });
  assert.equal(parsed.success, true);
  // Stripping `to` here would make `additionalProperties: false` unenforceable,
  // because the args object this hands on is what gets validated.
  assert.deepEqual(parsed.data?.window, { from: '2026-01-01', to: '2026-02-01' });
});

test('today is the local date, not a UTC slice of it', () => {
  // A deadline rule reading a date that is one day off in the evening is the
  // failure this avoids; the handler never reads a clock, so this is the only
  // place the question is answered.
  assert.equal(today(new Date(2026, 0, 31, 23, 30)), '2026-01-31');
  assert.equal(today(new Date(2026, 11, 1, 0, 15)), '2026-12-01');
});

test('splitChanges separates what a write path does differently', () => {
  const plan: ToolPlan = {
    changes: [
      { op: 'update', itemId: 'a', patch: { start: '2026-04-01' } },
      { op: 'add', item: { content: 'Neue Frist', start: '2026-05-01' } },
      { op: 'update', itemId: 'b', patch: { end: '2026-04-15' } },
    ],
  };
  const { updates, adds } = splitChanges(plan);
  assert.deepEqual(updates.map((u) => u.itemId), ['a', 'b']);
  assert.equal(adds.length, 1);
  assert.deepEqual(splitChanges({}), { updates: [], adds: [] });
});

test('the answer leads with the notes', () => {
  const result = toolResult({ notes: ['die vierte Frist war bereits verstrichen'] }, { updated: 3, added: 0 });
  assert.deepEqual(result, {
    ok: true,
    notes: ['die vierte Frist war bereits verstrichen'],
    updated: 3,
    added: 0,
  });
  assert.deepEqual(toolResult({}, { updated: 0, added: 0 }).notes, []);
});

test('a registered plugin ends up as a runnable MCP tool, handed its own config', () => {
  const manifest: PluginManifest = {
    id: 'com.example.deadlines',
    name: 'Deadlines',
    version: '1.0.0',
    apiVersion: '^1.3',
    capabilities: ['tools', 'items:write'],
    configSchema: { type: 'object', properties: { leadDays: { type: 'integer' } } },
    tools: [
      {
        name: 'recalculate_deadlines',
        title: 'Recalculate deadlines',
        description: 'Recompute deadlines from the reference date.',
        inputSchema: { type: 'object', properties: { from: { type: 'string' } }, required: ['from'] },
        writes: 'items',
      },
    ],
  };
  const plugin: PluginDescriptor = {
    manifest,
    matches: () => true,
    fields: () => [],
    tools: {
      // A rule with the shape every domain rule has: reads the timeline and its
      // config, returns changes, touches nothing else.
      recalculate_deadlines: ({ file, config, args, now }) => ({
        changes: file.items
          .filter((i) => i.id)
          .map((i) => ({ op: 'update' as const, itemId: i.id!, patch: { start: String(args.from) } })),
        notes: [`lead ${config.leadDays}, today ${now}`],
      }),
    },
    load: async () => ({ renderView: () => {} }),
  };
  register(plugin);

  const tool = mcpPluginTools().tools.find((t) => t.decl.name === 'recalculate_deadlines');
  assert.ok(tool);

  const file: TimelineFile = {
    items: [{ id: 'a', content: 'Frist', start: '2026-03-02' }],
    plugins: [{ id: 'com.example.deadlines', config: { leadDays: 5 } }],
  };
  const plan = tool.plan(file, { from: '2026-04-01' }, '2026-08-11');
  assert.deepEqual(plan.changes, [{ op: 'update', itemId: 'a', patch: { start: '2026-04-01' } }]);
  assert.deepEqual(plan.notes, ['lead 5, today 2026-08-11']);

  // Arguments that fail the declared schema never reach the rule, and the caller
  // gets the reason rather than a stack trace.
  assert.throws(() => tool.plan(file, {}, '2026-08-11'), /missing required "from"/);
});

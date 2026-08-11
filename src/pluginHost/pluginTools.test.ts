import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pluginTools, register, type PluginDescriptor } from './registry';
import type { PluginManifest } from './manifest';
import type { ToolPlan } from './tools';

// Assembling one flat list of verbs out of several plugins. The interesting part
// is not the happy path but what happens to a verb that cannot be called: a name
// another plugin already took, a declaration with nothing behind it, an
// implementation nobody declared. Each is reported, because a tool that is
// silently absent is indistinguishable from a plugin that was never installed —
// and that sends whoever debugs it to the wrong place.
//
// This file registers fixtures into the module-level registry. `node --test` runs
// each test file in its own process, so the extra plugins do not reach the tests
// that count product-roadmap's contributions.

const manifest = (id: string, tools: string[]): PluginManifest => ({
  id,
  name: id,
  version: '1.0.0',
  apiVersion: '^1.3',
  capabilities: ['tools', 'items:write'],
  tools: tools.map((name) => ({
    name,
    title: name,
    description: `The ${name} rule.`,
    writes: 'items' as const,
  })),
});

const plan = (): ToolPlan => ({ notes: ['ran'] });

const descriptor = (m: PluginManifest, handlers: Record<string, () => ToolPlan>): PluginDescriptor => ({
  manifest: m,
  matches: () => true,
  fields: () => [],
  tools: handlers,
  load: async () => ({ renderView: () => {} }),
});

test('a declared tool with an implementation is callable', () => {
  register(descriptor(manifest('com.example.first', ['shift_trades']), { shift_trades: plan }));
  const { tools, problems } = pluginTools();
  const mine = tools.find((t) => t.decl.name === 'shift_trades');
  assert.ok(mine, 'the verb is in the list');
  assert.equal(mine.pluginId, 'com.example.first');
  assert.deepEqual(mine.run({ file: { items: [] }, config: {}, args: {}, now: '2026-08-11' }), { notes: ['ran'] });
  assert.deepEqual(problems, []);
});

test('the first plugin keeps a contested name and the second is reported', () => {
  register(descriptor(manifest('com.example.first', ['shift_trades']), { shift_trades: plan }));
  register(descriptor(manifest('com.example.second', ['shift_trades']), { shift_trades: plan }));

  const { tools, problems } = pluginTools();
  const claimants = tools.filter((t) => t.decl.name === 'shift_trades');
  assert.equal(claimants.length, 1, 'one verb, one implementation');
  assert.equal(claimants[0].pluginId, 'com.example.first');

  const conflict = problems.find((p) => p.reason === 'name-taken');
  assert.ok(conflict);
  assert.equal(conflict.pluginId, 'com.example.second');
  assert.match(conflict.problem, /already provided by "com\.example\.first"/);
});

test('a declaration without an implementation is not callable and says so', () => {
  register(descriptor(manifest('com.example.declared', ['check_gates']), {}));
  const { tools, problems } = pluginTools();
  assert.equal(tools.some((t) => t.decl.name === 'check_gates'), false);
  const problem = problems.find((p) => p.tool === 'check_gates');
  assert.equal(problem?.reason, 'no-handler');
});

test('an implementation nobody declared stays uncallable', () => {
  register(descriptor(manifest('com.example.undeclared', []), { secret_rule: plan }));
  const { tools, problems } = pluginTools();
  assert.equal(tools.some((t) => t.decl.name === 'secret_rule'), false);
  const problem = problems.find((p) => p.tool === 'secret_rule');
  assert.equal(problem?.reason, 'not-declared');
});

test('a plugin with no tools contributes none and no problems', () => {
  const bare: PluginManifest = {
    id: 'com.example.quiet',
    name: 'Quiet',
    version: '1.0.0',
    apiVersion: '^1',
    capabilities: ['fields'],
  };
  register(descriptor(bare, {}));
  const { problems } = pluginTools();
  assert.equal(problems.some((p) => p.pluginId === 'com.example.quiet'), false);
});

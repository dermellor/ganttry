// What the plugin list says. Pure, so the wording is testable without a DOM —
// and so „the instance has it" and „this timeline uses it" are joined in exactly
// one place rather than once per renderer.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { pluginLines } from './installed.ts';
import type { PluginStatus } from '../types.ts';

const status = (over: Partial<PluginStatus> & { id: string }): PluginStatus => ({
  version: '1.0.0',
  apiVersion: '^1',
  artifact: { kind: 'builtin' },
  capabilities: [],
  manifest: { name: over.id },
  enabled: true,
  loadable: true,
  ...over,
});

describe('pluginLines', () => {
  test('an installed plugin the timeline uses is marked as active here', () => {
    const [line] = pluginLines([status({ id: 'demo', manifest: { name: 'Demo' } })], ['demo']);
    assert.equal(line.name, 'Demo');
    assert.equal(line.enabledHere, true);
    assert.equal(line.loadable, true);
  });

  test('installed but not enabled on this timeline is still listed', () => {
    // The whole point of the panel: a plugin that is there but off has to be
    // distinguishable from one that is not installed at all.
    const [line] = pluginLines([status({ id: 'demo' })], []);
    assert.equal(line.enabledHere, false);
  });

  test('a plugin that cannot run carries its reason', () => {
    const [line] = pluginLines([status({ id: 'demo', loadable: false, problem: 'update the host' })], ['demo']);
    assert.equal(line.loadable, false);
    assert.equal(line.problem, 'update the host');
  });

  test('a manifest with no usable name falls back to the id rather than showing nothing', () => {
    assert.equal(pluginLines([status({ id: 'sprints', manifest: {} })], [])[0].name, 'sprints');
    assert.equal(pluginLines([status({ id: 'sprints', manifest: { name: '  ' } })], [])[0].name, 'sprints');
  });

  test('sorted by name, which is the column a reader scans', () => {
    const lines = pluginLines(
      [
        status({ id: 'z', manifest: { name: 'Alpha' } }),
        status({ id: 'a', manifest: { name: 'Zeta' } }),
      ],
      [],
    );
    assert.deepEqual(lines.map((l) => l.name), ['Alpha', 'Zeta']);
  });

  test('an empty registry yields no lines rather than a placeholder row', () => {
    assert.deepEqual(pluginLines([], ['demo']), []);
  });

  test('a timeline enabling a plugin the instance does not have adds no line', () => {
    // The registry is what exists; a stale `plugins` entry on a timeline is not
    // evidence of an install, and inventing a row for it would report a plugin
    // as present that nothing can load.
    assert.deepEqual(pluginLines([], ['ghost']), []);
  });
});

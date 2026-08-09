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
    assert.equal(line.running, true);
  });

  test('installed but not enabled on this timeline is still listed', () => {
    // The whole point of the panel: a plugin that is there but off has to be
    // distinguishable from one that is not installed at all.
    const [line] = pluginLines([status({ id: 'demo' })], []);
    assert.equal(line.enabledHere, false);
  });

  test('a plugin that cannot run carries its reason', () => {
    const [line] = pluginLines([status({ id: 'demo', loadable: false, problem: 'update the host' })], ['demo']);
    assert.equal(line.running, false);
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

describe('pluginLines: folding in what the loader actually did', () => {
  const ok = status({ id: 'demo', manifest: { name: 'Demo' } });

  test("the loader's verdict wins over the host's willingness", () => {
    // The host was willing (`loadable`), the artifact was not there. Reporting
    // „active" because the host had no objection would be the wrong half of the
    // story.
    const [line] = pluginLines([ok], ['demo'], [
      { pluginId: 'demo', loaded: false, reason: 'unreachable', problem: 'could not fetch /p.js: HTTP 404' },
    ]);
    assert.equal(line.running, false);
    assert.equal(line.reason, 'unreachable');
    assert.match(line.problem!, /HTTP 404/);
  });

  test('a skipped plugin keeps the host reason, since the loader never tried', () => {
    const refused = status({ id: 'demo', loadable: false, reason: 'disabled', problem: 'switched off for this instance' });
    const [line] = pluginLines([refused], [], [
      { pluginId: 'demo', loaded: false, reason: 'skipped', problem: 'switched off for this instance' },
    ]);
    assert.equal(line.reason, 'disabled', '„skipped" says nothing a reader can act on');
  });

  test('a successful load reports running, and the timeline question comes back', () => {
    const [line] = pluginLines([ok], ['demo'], [{ pluginId: 'demo', loaded: true }]);
    assert.equal(line.running, true);
    assert.equal(line.enabledHere, true);
    assert.equal(line.reason, undefined);
  });

  test('no outcome yet falls back to willingness rather than reporting a failure', () => {
    // The panel can be opened during boot. Claiming „not running" for something
    // that has not been tried is a failure report about nothing.
    assert.equal(pluginLines([ok], [], [])[0].running, true);
  });

  test('an outcome for a plugin that is not installed is ignored', () => {
    assert.deepEqual(pluginLines([], [], [{ pluginId: 'ghost', loaded: false, reason: 'threw' }]), []);
  });

  test('integrity failure is distinguishable from every other failure', () => {
    // This is the one an operator has to act on differently: the artifact changed
    // under a version somebody approved.
    const [line] = pluginLines([ok], ['demo'], [
      { pluginId: 'demo', loaded: false, reason: 'integrity', problem: 'does not match its pinned hash' },
    ]);
    assert.equal(line.reason, 'integrity');
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pluginRows } from './pluginRows.ts';
import type { PluginStatus, TimelineFile } from './types.ts';

// What this pins is the decision the section makes before it draws anything:
// which plugins are offered, which are explained instead, and whether the switch
// reflects this timeline rather than the instance.

const file = (over: Partial<TimelineFile> = {}): TimelineFile => ({ items: [], ...over });

const installed = (over: Partial<PluginStatus> = {}): PluginStatus =>
  ({
    id: 'com.example.demo',
    version: '1.2.0',
    apiVersion: '^1',
    artifact: { kind: 'builtin' },
    capabilities: ['items:read', 'views'],
    manifest: { name: 'Demo', views: [{ id: 'board', label: 'Board' }] },
    enabled: true,
    loadable: true,
    ...over,
  }) as PluginStatus;

test('a plugin is listed with what its manifest declares', () => {
  const [row] = pluginRows([installed()], file());
  assert.equal(row.name, 'Demo');
  assert.equal(row.version, '1.2.0');
  assert.deepEqual(row.capabilities, ['items:read', 'views']);
  assert.deepEqual(row.views, ['Board']);
  assert.equal(row.refusal, null);
});

test('the switch reflects this timeline, not the instance', () => {
  const off = pluginRows([installed()], file())[0];
  assert.equal(off.enabled, false);

  const on = pluginRows([installed()], file({ plugins: [{ id: 'com.example.demo' }] }))[0];
  assert.equal(on.enabled, true);
});

test('a plugin the host cannot run is listed with its reason', () => {
  // The case the client registry cannot show: `register()` refuses a manifest
  // whose contract range the host does not satisfy, so such a plugin never
  // reaches it. The instance still has it installed, and somebody opening this
  // section is asking exactly why it is not available.
  const [row] = pluginRows(
    [installed({ loadable: false, reason: 'api-version', problem: 'needs plugin API ^99' })],
    file(),
  );
  assert.equal(row.refusal, 'api-version');
  assert.equal(row.enabled, false);
});

test('an instance-wide off switch is a reason, not an absence', () => {
  // „You may not switch this on here" and „this does not exist" must not look the
  // same, which is the rule „Every stored setting is reachable" (AGENTS.md).
  const [row] = pluginRows([installed({ enabled: false, loadable: false, reason: 'disabled' })], file());
  assert.equal(row.refusal, 'disabled');
});

test('a plugin with no declared views lists none rather than failing', () => {
  const [row] = pluginRows([installed({ manifest: { name: 'Bare' } })], file());
  assert.deepEqual(row.views, []);
  assert.equal(row.name, 'Bare');
});

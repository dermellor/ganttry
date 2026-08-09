import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { manifestOf, pluginStatus } from './installed.ts';
import type { InstalledPlugin } from '../types.ts';

const MANIFEST = {
  id: 'demo',
  name: 'Demo',
  version: '1.2.0',
  apiVersion: '^1',
  capabilities: ['items:read'],
};

const row = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'demo',
  version: '1.2.0',
  apiVersion: '^1',
  artifact: { kind: 'builtin' },
  capabilities: ['items:read'],
  manifest: MANIFEST,
  enabled: true,
  ...over,
});

describe('pluginStatus', () => {
  test('a healthy plugin is loadable and carries no problem', () => {
    const status = pluginStatus(row());
    assert.equal(status.loadable, true);
    assert.equal(status.problem, undefined);
  });

  test('switched off instance-wide is not loadable, and says so without blaming the plugin', () => {
    const status = pluginStatus(row({ enabled: false }));
    assert.equal(status.loadable, false);
    assert.match(status.problem!, /switched off/);
  });

  test('a contract range this host cannot satisfy is refused with a readable reason', () => {
    const status = pluginStatus(row({ apiVersion: '^2' }), { major: 1, minor: 0 });
    assert.equal(status.loadable, false);
    // An unreadable version error is indistinguishable from a broken plugin.
    assert.match(status.problem!, /update the host/);
  });

  test('a plugin built for an older major is told to update itself', () => {
    const status = pluginStatus(row({ apiVersion: '^1' }), { major: 2, minor: 0 });
    assert.match(status.problem!, /update the plugin/);
  });

  test('an empty manifest is not a failure — it is the row that defers to the build', () => {
    // Migration 0017 seeds a row per plugin already in use without inventing a
    // manifest in SQL. Validating `{}` would report every one of them as broken.
    const status = pluginStatus(row({ manifest: {} }));
    assert.equal(status.loadable, true);
  });

  test('a stored manifest that no longer validates is refused, with the reason', () => {
    // Possible after a host upgrade tightened the rules, which is exactly why the
    // manifest is re-checked here rather than trusted because install-time did.
    const status = pluginStatus(row({ manifest: { ...MANIFEST, id: 'NOT VALID' } }));
    assert.equal(status.loadable, false);
    assert.match(status.problem!, /no longer valid/);
  });

  test('off wins over a version mismatch: the operator switched it off, that is the answer', () => {
    const status = pluginStatus(row({ enabled: false, apiVersion: '^9' }));
    assert.match(status.problem!, /switched off/);
  });
});

describe('manifestOf', () => {
  test('a valid stored manifest comes back', () => {
    assert.equal(manifestOf(row())?.id, 'demo');
  });

  test('an empty one is null — the caller asks the build instead', () => {
    assert.equal(manifestOf(row({ manifest: {} })), null);
  });

  test('an invalid one is null rather than half-trusted', () => {
    assert.equal(manifestOf(row({ manifest: { id: 'demo' } })), null);
  });
});

// What the loader does at boot, and what it does when a plugin misbehaves.
//
// Fetch and import are injected, so every branch here runs without a network and
// without a module registry. The failure paths are the point: a plugin that is
// unreachable, tampered with, wrongly shaped or simply broken must each produce a
// distinct, readable outcome, and none of them may take the app down.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { descriptorFor, loadInstalledPlugins, moduleProblems, type LoaderDeps } from './loader.ts';
import type { PluginManifest } from './manifest.ts';
import type { PluginStatus } from '../types.ts';

const MANIFEST: PluginManifest = {
  id: 'com.example.sprints',
  name: 'Sprints',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['items:read', 'views'],
  views: [{ id: 'board', label: 'Board', icon: '<svg/>' }],
};

const FIELDS_ONLY: PluginManifest = {
  id: 'tagger',
  name: 'Tagger',
  version: '1.0.0',
  apiVersion: '^1',
  capabilities: ['items:read', 'fields'],
};

const status = (over: Partial<PluginStatus> & { id: string }): PluginStatus => ({
  version: '1.0.0',
  apiVersion: '^1',
  artifact: { kind: 'vendored', source: '/plugins/com.example.sprints/index.js' },
  capabilities: [],
  manifest: MANIFEST as unknown as Record<string, unknown>,
  enabled: true,
  loadable: true,
  ...over,
});

const SOURCE = new TextEncoder().encode('export const renderView = () => {};').buffer as ArrayBuffer;

function deps(over: Partial<LoaderDeps> = {}): LoaderDeps & { registered: string[] } {
  const registered: string[] = [];
  return {
    registered,
    fetchArtifact: async () => SOURCE,
    importModule: async () => ({ renderView: () => {} }),
    registerPlugin: (d) => registered.push(d.manifest.id),
    ...over,
  };
}

describe('loadInstalledPlugins: the happy path', () => {
  test('a vendored plugin is fetched, imported and registered', async () => {
    const d = deps();
    const [outcome] = await loadInstalledPlugins([status({ id: 'com.example.sprints' })], d);
    assert.deepEqual(outcome, { pluginId: 'com.example.sprints', loaded: true });
    assert.deepEqual(d.registered, ['com.example.sprints']);
  });

  test('a built-in is reported as loaded without being fetched', async () => {
    // Its static import already registered it. Leaving it out of the list would
    // make the panel unable to account for every installed plugin.
    let fetched = false;
    const d = deps({ fetchArtifact: async () => { fetched = true; return SOURCE; } });
    const [outcome] = await loadInstalledPlugins(
      [status({ id: 'dev.zeitlines.product-roadmap', artifact: { kind: 'builtin' } })],
      d,
    );
    assert.deepEqual(outcome, { pluginId: 'dev.zeitlines.product-roadmap', loaded: true });
    assert.equal(fetched, false);
    assert.deepEqual(d.registered, [], 'the static import owns that registration');
  });

  test('a verified hash lets the load through', async () => {
    const digest = await crypto.subtle.digest('SHA-384', SOURCE);
    const integrity = `sha384-${Buffer.from(new Uint8Array(digest)).toString('base64')}`;
    const d = deps();
    const [outcome] = await loadInstalledPlugins(
      [status({ id: 'com.example.sprints', artifact: { kind: 'url', source: 'https://x/p.js', integrity } })],
      d,
    );
    assert.equal(outcome.loaded, true);
  });
});

describe('loadInstalledPlugins: every failure is named and contained', () => {
  test('a plugin the host already refused is skipped, keeping that reason', async () => {
    const [outcome] = await loadInstalledPlugins(
      [status({ id: 'com.example.sprints', loadable: false, problem: 'switched off for this instance' })],
      deps(),
    );
    assert.equal(outcome.reason, 'skipped');
    assert.equal(outcome.problem, 'switched off for this instance');
  });

  test('an unreachable artifact says which URL and why', async () => {
    const d = deps({ fetchArtifact: async () => { throw new Error('HTTP 404'); } });
    const [outcome] = await loadInstalledPlugins([status({ id: 'com.example.sprints' })], d);
    assert.equal(outcome.loaded, false);
    assert.equal(outcome.reason, 'unreachable');
    assert.match(outcome.problem!, /\/plugins\/com\.example\.sprints\/index\.js.*HTTP 404/);
    assert.deepEqual(d.registered, []);
  });

  test('bytes that do not match the pinned hash are refused, and never imported', async () => {
    // The realistic attack is not a hostile plugin at install time: it is a
    // benign one replaced afterwards under a version somebody approved.
    let imported = false;
    const d = deps({ importModule: async () => { imported = true; return {}; } });
    const [outcome] = await loadInstalledPlugins(
      [status({ id: 'com.example.sprints', artifact: { kind: 'url', source: 'https://x/p.js', integrity: 'sha384-d3Jvbmc=' } })],
      d,
    );
    assert.equal(outcome.reason, 'integrity');
    assert.equal(imported, false, 'verification has to happen before execution or it is decorative');
    assert.deepEqual(d.registered, []);
  });

  test('an artifact that throws while executing is contained', async () => {
    const d = deps({ importModule: async () => { throw new SyntaxError('Unexpected token'); } });
    const [outcome] = await loadInstalledPlugins([status({ id: 'com.example.sprints' })], d);
    assert.equal(outcome.reason, 'threw');
    assert.match(outcome.problem!, /failed to execute.*Unexpected token/);
  });

  test('a manifest declaring views whose module has none is refused', async () => {
    // The button would otherwise appear and do nothing, which reads as a broken
    // app rather than a broken plugin.
    const d = deps({ importModule: async () => ({}) });
    const [outcome] = await loadInstalledPlugins([status({ id: 'com.example.sprints' })], d);
    assert.equal(outcome.reason, 'invalid-module');
    assert.match(outcome.problem!, /exports no renderView/);
    assert.deepEqual(d.registered, []);
  });

  test('an npm-package artifact is refused before any request', async () => {
    let fetched = false;
    const d = deps({ fetchArtifact: async () => { fetched = true; return SOURCE; } });
    const [outcome] = await loadInstalledPlugins(
      [status({ id: 'com.example.sprints', artifact: { kind: 'package', source: 'sprints@1' } })],
      d,
    );
    assert.equal(outcome.reason, 'unsupported-artifact');
    assert.equal(fetched, false);
  });

  test('a stored manifest that no longer validates fails with a sentence, not a crash', async () => {
    const d = deps();
    const [outcome] = await loadInstalledPlugins(
      [status({ id: 'com.example.sprints', manifest: { id: 'com.example.sprints' } })],
      d,
    );
    assert.equal(outcome.reason, 'invalid-module');
    assert.match(outcome.problem!, /manifest is not valid/);
  });

  test('one plugin failing does not stop the next from loading', async () => {
    let call = 0;
    const d = deps({
      fetchArtifact: async () => {
        if (call++ === 0) throw new Error('HTTP 500');
        return SOURCE;
      },
    });
    const outcomes = await loadInstalledPlugins(
      [status({ id: 'broken' }), status({ id: 'com.example.sprints' })],
      d,
    );
    assert.deepEqual(outcomes.map((o) => o.loaded), [false, true]);
    assert.deepEqual(d.registered, ['com.example.sprints']);
  });

  test('a registration that throws is reported rather than propagated', async () => {
    const d = deps({ registerPlugin: () => { throw new Error('duplicate view id'); } });
    const [outcome] = await loadInstalledPlugins([status({ id: 'com.example.sprints' })], d);
    assert.equal(outcome.reason, 'threw');
    assert.match(outcome.problem!, /registration failed.*duplicate view id/);
  });
});

describe('moduleProblems', () => {
  test('a fields-only plugin needs no renderView', () => {
    assert.deepEqual(moduleProblems(FIELDS_ONLY, { fields: () => [] }), []);
  });

  test('a non-object export is refused', () => {
    assert.equal(moduleProblems(FIELDS_ONLY, 42).length, 1);
  });

  test('fields that is not callable is refused', () => {
    assert.match(moduleProblems(FIELDS_ONLY, { fields: 'nope' })[0], /fields must be a function/);
  });
});

describe('descriptorFor', () => {
  const enabledFile = { items: [], plugins: [{ id: 'com.example.sprints' }] } as any;
  const otherFile = { items: [] } as any;

  test('availability comes from enablement, not from the plugin', () => {
    // A plugin deciding its own availability could put a button in the header on
    // a timeline that never enabled it.
    const d = descriptorFor(MANIFEST, { renderView: () => {} }, () => {});
    assert.equal(d.matches(enabledFile), true);
    assert.equal(d.matches(otherFile), false);
    assert.equal(d.applies!(enabledFile), true);
  });

  test('a throwing fields() costs the plugin its fields, not the item form', () => {
    const errors: unknown[] = [];
    const d = descriptorFor(MANIFEST, { fields: () => { throw new Error('boom'); } }, (e) => errors.push(e));
    assert.deepEqual(d.fields(enabledFile), []);
    assert.equal(errors.length, 1);
  });

  test('a module with no fields contributes none rather than failing', () => {
    assert.deepEqual(descriptorFor(MANIFEST, {}, () => {}).fields(enabledFile), []);
  });

  test('a throwing renderView is reported, contained, and replaced by the reason', async () => {
    const errors: unknown[] = [];
    const d = descriptorFor(MANIFEST, { renderView: () => { throw new Error('render boom'); } }, (e) => errors.push(e));
    const mod = await d.load();

    // A container that knows its own document, which is what the host uses
    // instead of the global — the same discipline it asks of plugins.
    const appended: any[] = [];
    const el = (): any => ({ className: '', textContent: '', children: [] as any[], append(...n: any[]) { this.children.push(...n); } });
    const container = {
      ownerDocument: { createElement: () => el() },
      replaceChildren() { appended.length = 0; },
      append(...nodes: any[]) { appended.push(...nodes); },
    } as unknown as HTMLElement;

    // The host object is irrelevant to this test and deliberately a stub: what
    // is asserted is that a throwing plugin cannot escape the repaint path.
    mod.renderView(container, 'board', {} as never);
    assert.equal(errors.length, 1);
    // Whatever the plugin managed to paint is cleared: a half-painted view reads
    // as a broken page rather than a broken plugin.
    assert.equal(appended.length, 1);
    assert.match((appended[0] as any).textContent, /konnte nicht dargestellt werden/);
  });
});

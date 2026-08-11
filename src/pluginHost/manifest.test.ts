import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grants, validateManifest, viewAccessories, type PluginManifest } from './manifest';
import { apiVersionMismatch, parseApiRange, satisfiesApiVersion } from './apiVersion';
import { productRoadmapManifest } from '../plugins/product-roadmap/manifest';

// The manifest is the only thing the host reads before running a plugin, so these
// tests pin what gets refused. A declaration the host silently ignores is the bad
// outcome: the plugin then behaves as if it had access it was never granted.

const base = (over: Partial<PluginManifest> = {}): unknown => ({
  id: 'com.example.sprints',
  name: 'Sprints',
  version: '1.0.0',
  apiVersion: '^1',
  ...over,
});

const problems = (input: unknown): string[] => {
  const r = validateManifest(input);
  return r.ok ? [] : r.problems;
};

test('a minimal manifest validates', () => {
  const r = validateManifest(base());
  assert.equal(r.ok, true);
});

test('identity fields are checked', () => {
  assert.deepEqual(problems(base({ id: 'com.acme.sprints' })), []);
  assert.match(problems(base({ id: 'Com.Acme.Sprints' }))[0], /id must be/, 'lowercase only');
  assert.match(problems(base({ id: 'has space' }))[0], /id must be/);
  assert.match(problems(base({ version: '1.0' }))[0], /semver/);
  assert.match(problems(base({ name: '  ' }))[0], /name is required/);
  assert.equal(validateManifest('nope').ok, false);
});

test('an id has to be reverse-DNS, and the two near-misses are refused', () => {
  // A bare word is the name a hundred people would pick, and the id keys data on
  // every instance that installs it — so a collision is a data collision.
  assert.match(problems(base({ id: 'sprints' }))[0], /reverse-DNS/);
  // An npm scope expresses the same idea but breaks the id's other two jobs: it
  // is a path segment and a directory name, and `/` ruins both.
  assert.match(problems(base({ id: '@acme/sprints' }))[0], /reverse-DNS/);
  // Malformed dotted forms are not „close enough".
  for (const id of ['com..sprints', 'com.sprints.', '.com.sprints']) {
    assert.match(problems(base({ id }))[0], /id must be/, id);
  }
});

test('every problem is reported, not just the first', () => {
  assert.ok(problems(base({ id: 'A', version: 'x', name: '' })).length >= 3);
});

test('a declaration must be covered by a capability', () => {
  const view = { id: 'board', label: 'Board', icon: '<svg/>' };
  assert.match(problems(base({ views: [view] }))[0], /requires the "views" capability/);
  assert.deepEqual(problems(base({ views: [view], capabilities: ['views'] })), []);
  assert.match(
    problems(base({ collections: [{ id: 'rows' }] }))[0],
    /requires the "data:own" capability/,
  );
  assert.match(problems(base({ metadataKeys: ['sprint'] }))[0], /items:read/);
});

test('unknown capabilities are refused', () => {
  assert.match(problems(base({ capabilities: ['network' as never] }))[0], /unknown capability/);
});

test('views need a usable id, label and icon', () => {
  const caps: PluginManifest['capabilities'] = ['views'];
  assert.match(problems(base({ capabilities: caps, views: [{ id: '', label: 'x', icon: 'i' }] }))[0], /non-empty id/);
  assert.match(
    problems(base({ capabilities: caps, views: [{ id: 'a:b', label: 'x', icon: 'i' }] }))[0],
    /must not contain ":"/,
  );
  assert.match(
    problems(base({
      capabilities: caps,
      views: [{ id: 'a', label: 'x', icon: 'i' }, { id: 'a', label: 'y', icon: 'i' }],
    }))[0],
    /duplicate view id/,
  );
});

test('a view declares its accessories, and an unknown one is refused', () => {
  const caps: PluginManifest['capabilities'] = ['views'];
  const view = (accessories: unknown) => ({ id: 'a', label: 'x', icon: 'i', accessories });

  assert.equal(validateManifest(base({ capabilities: caps, views: [view({ grouping: true })] as never })).ok, true);
  assert.match(
    problems(base({ capabilities: caps, views: [view({ sorting: true })] as never }))[0],
    /unknown accessory "sorting"/,
  );
  assert.match(
    problems(base({ capabilities: caps, views: [view({ filter: 'yes' })] as never }))[0],
    /accessory "filter" must be a boolean/,
  );
  assert.match(
    problems(base({ capabilities: caps, views: [view('all')] as never }))[0],
    /accessories must be an object/,
  );
});

test('viewAccessories answers for built-in and declared views alike', () => {
  // No view = a built-in presentation: everything applies, because the timeline and
  // the list are two renderings of the item list.
  assert.deepEqual(viewAccessories(), {
    grouping: true,
    filter: true,
    create: true,
    export: true,
  });
  // A declared view gets nothing it did not ask for.
  assert.deepEqual(viewAccessories({ id: 'a', label: 'x', icon: 'i' }), {
    grouping: false,
    filter: false,
    create: false,
    export: false,
  });
  assert.deepEqual(
    viewAccessories({ id: 'a', label: 'x', icon: 'i', accessories: { filter: true } }),
    { grouping: false, filter: true, create: false, export: false },
  );
});

test('the retired toolbar boolean speaks about the bar and nothing else', () => {
  // A plugin built against 1.0 declared one boolean about the grouping/filter bar.
  // Refusing to honour it would break an artifact the version contract promises to
  // keep running; reading it as permission to create items or export would grant
  // something it never claimed.
  assert.deepEqual(viewAccessories({ id: 'a', label: 'x', icon: 'i', toolbar: true }), {
    grouping: true,
    filter: true,
    create: false,
    export: false,
  });
  assert.deepEqual(viewAccessories({ id: 'a', label: 'x', icon: 'i', toolbar: false }), {
    grouping: false,
    filter: false,
    create: false,
    export: false,
  });
  // An explicit declaration wins over the old spelling beside it.
  assert.deepEqual(
    viewAccessories({ id: 'a', label: 'x', icon: 'i', toolbar: true, accessories: { grouping: true } }),
    { grouping: true, filter: false, create: false, export: false },
  );
});

test('references and publicRead must point at declared collections', () => {
  const caps: PluginManifest['capabilities'] = ['data:own', 'public:read'];
  const p = problems(base({
    capabilities: caps,
    collections: [{ id: 'tiers' }],
    references: [{ from: 'cells', field: 'tierId', to: 'tiers' }],
    publicRead: { collections: ['nope'] },
  }));
  assert.ok(p.some((x) => /reference from unknown collection "cells"/.test(x)));
  assert.ok(p.some((x) => /publicRead names unknown collection "nope"/.test(x)));
});

test('legacyModeIds must point at a declared view', () => {
  assert.match(
    problems(base({ capabilities: ['views'], views: [{ id: 'board', label: 'B', icon: 'i' }], legacyModeIds: { old: 'gone' } }))[0],
    /unknown view "gone"/,
  );
});

test('apiVersion ranges: only the documented subset, and the host has to satisfy them', () => {
  assert.deepEqual(parseApiRange('^1'), { major: 1, minMinor: 0 });
  assert.deepEqual(parseApiRange('^1.2'), { major: 1, minMinor: 2 });
  assert.equal(parseApiRange('1.x'), null);
  assert.equal(parseApiRange('>=1'), null);

  const host = { major: 1, minor: 3 };
  assert.equal(satisfiesApiVersion('^1', host), true);
  assert.equal(satisfiesApiVersion('^1.3', host), true);
  assert.equal(satisfiesApiVersion('^1.4', host), false);
  assert.equal(satisfiesApiVersion('^2', host), false);
  assert.equal(satisfiesApiVersion('^0', host), false);
});

test('a mismatch says which side is behind', () => {
  const host = { major: 1, minor: 0 };
  assert.equal(apiVersionMismatch('^1', host), null);
  assert.match(apiVersionMismatch('^2', host)!, /update the host/);
  assert.match(apiVersionMismatch('^0', host)!, /update the plugin/);
  assert.match(apiVersionMismatch('nonsense', host)!, /not a supported range/);
});

test('grants reads the capability list', () => {
  const m = validateManifest(base({ capabilities: ['items:read'] }));
  assert.equal(m.ok, true);
  if (!m.ok) return;
  assert.equal(grants(m.manifest, 'items:read'), true);
  assert.equal(grants(m.manifest, 'items:write'), false);
});

// The contract's acceptance criterion: the most demanding plugin here has to be
// expressible by it. If this fails, the manifest is short of something real
// rather than the plugin being special.
test('product-roadmap declares itself completely and validly', () => {
  const r = validateManifest(productRoadmapManifest);
  assert.deepEqual(r.ok ? [] : r.problems, []);
  const ids = (productRoadmapManifest.collections ?? []).map((c) => c.id);
  assert.deepEqual(ids, ['features', 'tiers', 'tier-values', 'highlights']);
  // The matrix cell is identified by its pair, and both halves cascade.
  const cells = productRoadmapManifest.collections!.find((c) => c.id === 'tier-values')!;
  assert.deepEqual(cells.keyFields, ['tierId', 'featureId']);
  const cascading = productRoadmapManifest.references!.filter((r2) => r2.onDelete === 'cascade');
  assert.equal(cascading.length, 2, 'the two foreign keys on pricing_tier_values');
  // The third relation has no foreign key behind it: a highlight bundles a LIST
  // of feature ids, and deleting one feature must shorten the list rather than
  // delete the tile. Behaviour is covered in plugin-store-product-roadmap.test.ts.
  const bundle = productRoadmapManifest.references!.find((r2) => r2.field === 'featureIds')!;
  assert.equal(bundle.array, true);
  assert.equal(bundle.onDelete, 'unlink');
  // The item metadata keys it owns, so an uninstall can clean them off items.
  assert.deepEqual(productRoadmapManifest.metadataKeys, ['featureIds', 'featureVersion', 'tier']);
});

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
  // No view = the timeline, the presentation everything falls back to.
  assert.deepEqual(viewAccessories(), {
    grouping: true,
    filter: true,
    edges: true,
    create: true,
    export: true,
  });
  assert.deepEqual(viewAccessories('timeline'), viewAccessories());
  // Timeline and list are two renderings of the item list and agree on everything
  // the list can act on — the arrows are the one thing it does not draw.
  assert.deepEqual(viewAccessories('list'), { ...viewAccessories(), edges: false });
  // A declared view gets nothing it did not ask for.
  assert.deepEqual(viewAccessories({ id: 'a', label: 'x', icon: 'i' }), {
    grouping: false,
    filter: false,
    edges: false,
    create: false,
    export: false,
  });
  assert.deepEqual(
    viewAccessories({ id: 'a', label: 'x', icon: 'i', accessories: { filter: true } }),
    { grouping: false, filter: true, edges: false, create: false, export: false },
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
    edges: false,
    create: false,
    export: false,
  });
  assert.deepEqual(viewAccessories({ id: 'a', label: 'x', icon: 'i', toolbar: false }), {
    grouping: false,
    filter: false,
    edges: false,
    create: false,
    export: false,
  });
  // An explicit declaration wins over the old spelling beside it.
  assert.deepEqual(
    viewAccessories({ id: 'a', label: 'x', icon: 'i', toolbar: true, accessories: { grouping: true } }),
    { grouping: true, filter: false, edges: false, create: false, export: false },
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

// Tools are the half of a plugin an agent calls, so what gets refused here is
// what stops a verb from being callable-but-wrong: an unusable name, a
// description no model can choose on, a constraint the host would not apply, and
// an analysis tool quietly granted write access.
const tool = (over: Record<string, unknown> = {}) => ({
  name: 'recalculate_deadlines',
  title: 'Recalculate deadlines',
  description: 'Recompute every deadline from the reference date.',
  ...over,
});
const withTools = (tools: unknown[], caps: string[] = ['tools']) =>
  base({ capabilities: caps as PluginManifest['capabilities'], tools: tools as never });

test('a declared tool needs a usable name, a title and a description', () => {
  assert.deepEqual(problems(withTools([tool()])), []);
  assert.match(problems(withTools([tool({ name: 'Recalculate' })]))[0], /snake_case/, 'no capitals');
  assert.match(problems(withTools([tool({ name: 'com.acme.recalc' })]))[0], /snake_case/, 'no dots');
  assert.match(problems(withTools([tool({ name: 'go' })]))[0], /snake_case/, 'too short to share a namespace');
  assert.match(problems(withTools([tool({ title: ' ' })]))[0], /needs a title/);
  assert.match(problems(withTools([tool({ description: '' })]))[0], /what an agent chooses on/);
  assert.match(problems(withTools([tool(), tool()]))[0], /duplicate tool/);
});

test('declaring tools requires the tools capability, and writing items the write one', () => {
  assert.match(problems(withTools([tool()], []))[0], /requires the "tools" capability/);
  assert.match(
    problems(withTools([tool({ writes: 'items' })], ['tools']))[0],
    /requires the "items:write" capability/,
  );
  assert.deepEqual(problems(withTools([tool({ writes: 'items' })], ['tools', 'items:write'])), []);
  assert.match(problems(withTools([tool({ writes: 'groups' })]))[0], /writes must be "items"/);
});

test('an inputSchema is held to the subset the host can apply, and may not claim "id"', () => {
  // Same rule as a collection's schema: a keyword that would be skipped is
  // refused, so an author cannot read a constraint that is never enforced.
  assert.match(
    problems(withTools([tool({ inputSchema: { type: 'object', properties: { d: { multipleOf: 2 } } } })]))[0],
    /unsupported keyword "multipleOf"/,
  );
  // `id` addresses the timeline the tool runs against. A declared argument of
  // that name does not fail — it sends the rule at someone else's timeline.
  assert.match(
    problems(withTools([tool({ inputSchema: { type: 'object', properties: { id: { type: 'string' } } } })]))[0],
    /"id" is reserved/,
  );
});

test('the tools section is additive: a plugin declaring "^1" still validates', () => {
  // 1.3 added `tools`, and „additive" is a claim with a consequence: an artifact
  // built against 1.0 has to keep loading. So `^1` plus tools validates here.
  //
  // The reverse is what an author has to get right themselves — a plugin whose
  // verbs are the point should declare `^1.3`, or an older host loads it and lists
  // them nowhere. This host cannot catch that for them: on 1.3 the tools work, and
  // the host where they would not is the one that has never heard of the section.
  assert.equal(validateManifest(withTools([tool()]), { major: 1, minor: 3 }).ok, true);
  assert.equal(
    validateManifest(base({ capabilities: ['tools'], tools: [tool()] as never, apiVersion: '^1.3' }), {
      major: 1,
      minor: 3,
    }).ok,
    true,
  );
  // A host older than the range keeps refusing, which is the mechanism that does
  // work in this direction.
  assert.equal(
    validateManifest(base({ capabilities: ['tools'], tools: [tool()] as never, apiVersion: '^1.3' }), {
      major: 1,
      minor: 2,
    }).ok,
    false,
  );
});

// The catalogue entry is a publication requirement, not a boot requirement: a
// plugin without one still runs, and `plugins:catalogue:check` is what insists.
// What is checked here is the entry that IS there, because a blank card and a
// two-paragraph summary both make the catalogue useless in different ways.
test('a catalogue entry is optional, and checked when present', () => {
  assert.deepEqual(problems(base()), [], 'no entry is not an error');
  assert.deepEqual(
    problems(base({ catalogue: { summary: 'Plans court deadlines.', domain: 'legal', keywords: ['fristen'] } })),
    [],
  );
  assert.match(problems(base({ catalogue: {} as never }))[0], /summary is required/);
});

test('what a catalogue entry may not be', () => {
  const entry = (over: Record<string, unknown>) =>
    problems(base({ catalogue: { summary: 'S.', domain: 'legal', keywords: ['fristen'], ...over } as never }));

  assert.match(entry({ summary: 'a'.repeat(201) })[0], /card subtitle stops at 200/);
  assert.match(entry({ summary: 'Two\nlines' })[0], /single line/);
  assert.match(entry({ domain: 'Legal Tech' })[0], /lowercase slug/);
  assert.match(entry({ keywords: [] })[0], /at least one entry/);
  // Case-insensitive, because a catalogue that lists "Fristen, fristen" reads as
  // sloppy to exactly the reader it is trying to convince.
  assert.match(entry({ keywords: ['Fristen', 'fristen'] })[0], /repeats/);
  assert.match(entry({ example: '  ' })[0], /must be a view id/);
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

// The graph is the first built-in presentation that is not a rendering of the item
// list, so "built-in" stopped being one answer. Handing it the export action
// because it happens to be built in would put a control in its bar that exports
// the timeline instead of what is on screen.
test('the graph declares its own accessories rather than inheriting the list’s', () => {
  assert.deepEqual(viewAccessories('graph'), {
    // The grouping dimension is what the columns are.
    grouping: true,
    filter: true,
    // The edges are the picture, so this is where the control belongs.
    edges: true,
    // An item with no date is exactly what this presentation can show.
    create: true,
    // Nothing renders a graph to HTML yet.
    export: false,
  });
});

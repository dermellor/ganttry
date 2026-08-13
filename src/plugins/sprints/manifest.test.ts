import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sprintsManifest } from './manifest';
import { CONFIDENCE_KEY, SPRINT_KEY, STORY_POINTS_KEY, sprintsFields } from './fields';
import { validateManifest, validateToolArgs } from '../../pluginHost/api';
// The check `scripts/db/plugin-api.ts` runs over a config bag before it stores one.
// Reaching past the contract barrel is allowed here and nowhere else: tests are exempt
// from the plugin-isolation check (`scripts/ci/check-plugin-isolation.mjs`), and
// asserting the schema against the very function the host applies is the point — an
// assertion on the schema's own keywords would only restate what is written above it.
import { unsupportedKeywords, validateRow } from '../../pluginHost/dataSchema';

// Cheap, and it catches the one failure that is not local to this plugin: `register()`
// validates a manifest and THROWS at module load, so an invalid one here does not
// produce a plugin that fails to appear. It takes the whole app down, for everyone, on
// the first import.

test('the manifest validates, so the plugin can be registered', () => {
  const result = validateManifest(sprintsManifest);
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join('\n'));
});

test('the catalogue entry is complete enough to publish', () => {
  const entry = sprintsManifest.catalogue;
  assert.ok(entry, 'a plugin without a catalogue entry cannot be published');
  assert.ok(entry.summary.trim().length > 0);
  assert.ok(entry.keywords.length > 0);
  // A domain is a slug, so it has to be one here: a space would only fail at
  // `register()`, which is at module load and takes the app with it.
  assert.match(entry.domain, /^[a-z][a-z0-9-]*$/);
  assert.equal(entry.example, 'src:example-sprint-planung');
});

test('a velocity of 0 is refused by the schema, not stored as a configured plugin', () => {
  // `minimum: 0` let `configure_plugin` succeed for a value every verb then treats as
  // absent and `rebalance_sprint` refuses outright: a plugin that looks configured and
  // is not, with nothing in the interface to say so. An operator gets the rejected call
  // instead.
  const schema = sprintsManifest.configSchema;
  assert.deepEqual(validateRow(schema, { start: '2026-01-05', velocity: 20 }, 'config'), []);
  assert.deepEqual(validateRow(schema, { start: '2026-01-05', velocity: 0.5 }, 'config'), []);
  for (const velocity of [0, -3]) {
    assert.equal(
      validateRow(schema, { start: '2026-01-05', velocity }, 'config').length > 0,
      true,
      `velocity ${velocity}`,
    );
  }
  // And the bound has to be one the host actually enforces: `exclusiveMinimum` is not in
  // the supported subset, so declaring it would be a constraint nothing checks and an
  // author would read it as one that is.
  assert.deepEqual(unsupportedKeywords(schema), []);
});

test('the derived field is owned by the code, never by an item', () => {
  // `metadataKeys` is the list an uninstall purges off items. The sprint is computed on
  // every build and stored nowhere, so listing it would promise a cleanup that has
  // nothing to clean, and would suggest the value is stored, which is the exact
  // misunderstanding the derived seam exists to prevent.
  assert.deepEqual(sprintsManifest.metadataKeys, [STORY_POINTS_KEY, CONFIDENCE_KEY]);
  assert.equal(sprintsManifest.metadataKeys?.includes(SPRINT_KEY), false);

  // The other half of the same statement: the field IS declared, and declared derived.
  const defs = sprintsFields({
    items: [{ id: 'a', content: 'x', start: '2026-01-05' }],
    plugins: [{ id: sprintsManifest.id, config: { start: '2026-01-05' } }],
  });
  assert.equal(defs.find((d) => d.key === SPRINT_KEY)?.derived, true);
});

test('a derived field demands the 1.5 contract, or it renders as an empty control', () => {
  // On an older host a `derived` field appears as an editable control with nothing
  // filling it, and no newer host can warn about that on the older one's behalf.
  assert.equal(sprintsManifest.apiVersion, '^1.5');
});

test('only the writing verb declares writes', () => {
  // A tool that declares no writes and returns changes is refused by the host, which is
  // what keeps `writes` from being decoration. Here it pins which of the three is the
  // one that may move an item at all.
  const writing = (sprintsManifest.tools ?? []).filter((t) => t.writes === 'items').map((t) => t.name);
  assert.deepEqual(writing, ['rebalance_sprint']);
  assert.equal(sprintsManifest.capabilities?.includes('items:write'), true);
});

test('the timeline is never an argument: `id` is the host\'s', () => {
  for (const tool of sprintsManifest.tools ?? []) {
    assert.equal('id' in ((tool.inputSchema?.properties as Record<string, unknown>) ?? {}), false, tool.name);
    // And an unknown argument is refused rather than ignored, so a misspelled one is
    // reported instead of silently changing which sprint is touched.
    assert.equal(validateToolArgs(tool, { sprnt: 3 }).length > 0, true, tool.name);
  }
});

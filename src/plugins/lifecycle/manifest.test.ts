import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIFECYCLE_COLLECTIONS, lifecycleManifest } from './manifest';
import {
  CUTOVER_KEY,
  END_OF_SUPPORT_KEY,
  EXTENDED_UNTIL_KEY,
  LATEST_START_KEY,
  LEAD_TIME_KEY,
  SHUTDOWN_KEY,
  SUPPORT_WINDOW_KEY,
  SYSTEM_KEY,
  lifecycleFields,
} from './fields';
import { validateManifest, validateToolArgs } from '../../pluginHost/api';
// The checks `scripts/db/plugin-api.ts` runs before it stores anything. Reaching past
// the contract barrel is allowed here and nowhere else: tests are exempt from the
// plugin-isolation check, and asserting a declaration against the very functions the
// host applies is the point — an assertion on the schema's own keywords would only
// restate what is written above it.
import { unsupportedKeywords, validateRow } from '../../pluginHost/dataSchema';

// Cheap, and it catches the one failure that is not local to this plugin: `register()`
// validates a manifest and THROWS at module load, so an invalid one here does not
// produce a plugin that fails to appear. It takes the whole app down, for everyone, on
// the first import.

const collection = (id: string) => {
  const found = (lifecycleManifest.collections ?? []).find((c) => c.id === id);
  assert.ok(found, `no collection "${id}" declared`);
  return found;
};

test('the manifest validates, so the plugin can be registered', () => {
  const result = validateManifest(lifecycleManifest);
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join('\n'));
});

test('the catalogue entry is complete enough to publish', () => {
  const entry = lifecycleManifest.catalogue;
  assert.ok(entry, 'a plugin without a catalogue entry cannot be published');
  assert.ok(entry.summary.trim().length > 0);
  // A domain is a slug, so it has to be one here: a space would only fail at
  // `register()`, which is at module load and takes the app with it.
  assert.match(entry.domain, /^[a-z][a-z0-9-]*$/);
  assert.equal(entry.example, 'src:example-eol-migration');
});

test('the keywords carry the words a reader searches with, not the ones the code uses', () => {
  // The harvest (2026-08-18) found both spellings in use on the vendors' own pages, and
  // a reader who types „EOL" and a reader who types „end of support" are the same person.
  const keywords = lifecycleManifest.catalogue!.keywords;
  for (const word of ['end of life', 'EOL', 'end of support', 'cutover', 'freeze window', 'parallel run']) {
    assert.ok(keywords.includes(word), `missing keyword: ${word}`);
  }
});

test('the declared contract is the newest thing the plugin actually uses', () => {
  // 1.3 for `tools`, 1.5 for the two `derived` fields (on an older host they render as
  // editable controls with nothing filling them, which reads as the plugin being broken),
  // 1.6 for `isoDateOnly` + `shiftDays` off the contract barrel, and 1.7 for
  // `pluginMessages`, which the labels go through. Anything below `^1.7` is a range this
  // plugin cannot keep.
  assert.equal(lifecycleManifest.apiVersion, '^1.7');
});

test('the six input keys are owned by the items and the two computed ones are not', () => {
  // `metadataKeys` is the list an uninstall purges off items. The input dates ARE stored,
  // so leaving them behind would leave items carrying a lifecycle nothing reads. The two
  // computed ones are recomputed on every build, so listing them would promise a cleanup
  // with nothing to clean and would suggest the dates are stored, which is the exact
  // misunderstanding the derived seam exists to prevent.
  assert.deepEqual(lifecycleManifest.metadataKeys, [
    SYSTEM_KEY,
    END_OF_SUPPORT_KEY,
    EXTENDED_UNTIL_KEY,
    LEAD_TIME_KEY,
    CUTOVER_KEY,
    SHUTDOWN_KEY,
  ]);
  assert.equal(lifecycleManifest.metadataKeys?.includes(LATEST_START_KEY), false);
  assert.equal(lifecycleManifest.metadataKeys?.includes(SUPPORT_WINDOW_KEY), false);

  // The other half of the same statement: all eight fields ARE declared, and exactly the
  // two computed ones are declared derived.
  const defs = lifecycleFields({
    items: [],
    plugins: [{ id: lifecycleManifest.id }],
  } as never);
  assert.deepEqual(
    defs.filter((d) => d.derived).map((d) => d.key),
    [LATEST_START_KEY, SUPPORT_WINDOW_KEY],
  );
  assert.equal(defs.length, 8);
});

test('there is no view, and no capability claiming one', () => {
  // Everything this plugin computes is a derived field or a verb, so grouping by the
  // support window is the rendering. A declared view would cost a lazily loaded chunk
  // that renders nothing, and the capability would be one an operator approves for no
  // reason.
  assert.equal(lifecycleManifest.views, undefined);
  assert.equal(lifecycleManifest.capabilities?.includes('views'), false);
});

test('the minimum parallel run has no default, because the practice has no number', () => {
  // The sources disagree by an order of magnitude — two to four weeks, fifteen days to
  // three months, two to eight weeks, a full business year. A default here would be this
  // plugin inventing a domain rule and every plan inheriting it silently.
  const props = lifecycleManifest.configSchema?.properties as Record<string, Record<string, unknown>>;
  assert.equal('default' in props.minParallelRunDays, false);
  assert.equal('default' in props.defaultLeadTimeDays, false);
});

test('the config takes whole positive days and refuses everything else', () => {
  const schema = lifecycleManifest.configSchema;
  assert.deepEqual(validateRow(schema, { minParallelRunDays: 30, defaultLeadTimeDays: 180 }, 'config'), []);
  // Absent is a legitimate state: the verbs report that they cannot answer.
  assert.deepEqual(validateRow(schema, {}, 'config'), []);
  for (const bad of [
    { minParallelRunDays: 0 },
    { minParallelRunDays: -30 },
    { minParallelRunDays: 30.5 },
    { minParallelRunDays: '30' },
    { defaultLeadTimeDays: 0 },
    { minParallelRunDays: 30, hypercareDays: 14 },
  ]) {
    assert.equal(validateRow(schema, bad, 'config').length > 0, true, JSON.stringify(bad));
  }
  // And the bounds have to be ones the host actually enforces: a keyword outside the
  // supported subset would be a constraint nothing checks while an author reads it as one.
  assert.deepEqual(unsupportedKeywords(schema), []);
});

test('a freeze window needs a name and both of its ends', () => {
  const schema = collection(LIFECYCLE_COLLECTIONS.freezes).schema;
  assert.deepEqual(validateRow(schema, { name: 'Year-end freeze', from: '2026-12-20', to: '2026-12-31' }), []);
  for (const bad of [
    {},
    // A span with one end is not a span: defaulting the other would block days nobody
    // declared.
    { name: 'Year-end freeze', from: '2026-12-20' },
    { name: 'Year-end freeze', to: '2026-12-31' },
    { from: '2026-12-20', to: '2026-12-31' },
    { name: '', from: '2026-12-20', to: '2026-12-31' },
    // „über Weihnachten" is the failure the pattern exists for: a window that blocks
    // nothing and no error to see. `format: 'date'` is not in the enforced subset.
    { name: 'Freeze', from: 'über Weihnachten', to: '2026-12-31' },
    { name: 'Freeze', from: '20.12.2026', to: '31.12.2026' },
    { name: 'Freeze', from: '2026-12-20', to: '2026-12-31', reason: 'peak' },
  ]) {
    assert.equal(validateRow(schema, bad).length > 0, true, JSON.stringify(bad));
  }
});

test('the freeze collection declares no order and no key fields', () => {
  // Nothing about a freeze depends on its position and the reader sorts by `from`, so
  // declaring an order would be an invariant the next person maintains for nothing.
  assert.equal(collection(LIFECYCLE_COLLECTIONS.freezes).ordered, undefined);
  assert.equal(collection(LIFECYCLE_COLLECTIONS.freezes).keyFields, undefined);
});

test('every collection schema is one the host can actually apply', () => {
  for (const c of lifecycleManifest.collections ?? []) {
    assert.deepEqual(unsupportedKeywords(c.schema), [], c.id);
  }
});

test('the freeze windows are publishable, and that alone publishes nothing', () => {
  // On a static local deploy the declaration decides what SURVIVES materialization, so
  // without it the committed example would render with no freeze windows — and a cutover
  // that avoids nothing is not a demonstration of this plugin. The per-timeline consent
  // is the separate gate, off by default.
  assert.deepEqual(lifecycleManifest.publicRead?.collections, [LIFECYCLE_COLLECTIONS.freezes]);
  assert.equal(lifecycleManifest.capabilities?.includes('public:read'), true);
  assert.equal(lifecycleManifest.publicRead?.fields, undefined);
});

test('there is no verb that writes a vendor date or a freeze row', () => {
  // Both absences are deliberate rather than pending. A tool returns item changes and
  // never the plugin's own rows, so a freeze calendar stays somebody's decision; and a
  // verb that could move an end-of-support date could make a late plan look on time.
  const names = (lifecycleManifest.tools ?? []).map((t) => t.name);
  assert.deepEqual(names, ['plan_cutover', 'check_eol_risk', 'shift_out_of_freeze']);
  for (const tool of lifecycleManifest.tools ?? []) {
    const props = Object.keys((tool.inputSchema?.properties as Record<string, unknown>) ?? {});
    assert.equal(props.includes(END_OF_SUPPORT_KEY), false, tool.name);
    assert.equal(props.includes(EXTENDED_UNTIL_KEY), false, tool.name);
  }
});

test('a verb that writes items says so, and the capability covers it', () => {
  // A tool that declares no writes and returns changes is refused by the host, which is
  // what keeps `writes` from being decoration.
  const writing = (lifecycleManifest.tools ?? []).filter((t) => t.writes === 'items');
  if (writing.length) assert.equal(lifecycleManifest.capabilities?.includes('items:write'), true);
  for (const tool of lifecycleManifest.tools ?? []) {
    assert.ok(tool.writes === undefined || tool.writes === 'items', tool.name);
  }
});

test('the timeline is never an argument: `id` is the host\'s', () => {
  for (const tool of lifecycleManifest.tools ?? []) {
    assert.equal('id' in ((tool.inputSchema?.properties as Record<string, unknown>) ?? {}), false, tool.name);
    if (!tool.inputSchema) continue;
    // An unknown argument is refused rather than ignored, so a misspelled one is
    // reported instead of silently touching a different item.
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(validateToolArgs(tool, { itm: 'a' }).length > 0, true, tool.name);
  }
});

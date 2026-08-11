import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW_PREFS,
  LEGACY_PREF_KEYS,
  legacyViewPrefs,
  parseViewPrefsStore,
  viewPrefsFor,
  withViewPrefs,
  type ViewPrefsStore,
} from './viewPrefs';

// The display state of a timeline is stored per timeline. These tests pin the
// two halves that used to be wrong instance-wide: reading one timeline's state
// without seeing another's, and carrying the old instance-wide keys over exactly
// once.

function get(store: Record<string, string>): (key: string) => string | null {
  return (key) => (key in store ? store[key] : null);
}

test('a timeline nobody looked at reads as the default', () => {
  assert.deepEqual(viewPrefsFor({}, 'roadmap'), { ...DEFAULT_VIEW_PREFS, filters: {} });
});

test('one timeline’s filter is invisible to another', () => {
  let store: ViewPrefsStore = {};
  store = withViewPrefs(store, 'a', { ...DEFAULT_VIEW_PREFS, filters: { 'cf:tier': ['Free'] } });

  assert.deepEqual(viewPrefsFor(store, 'a').filters, { 'cf:tier': ['Free'] });
  assert.deepEqual(viewPrefsFor(store, 'b').filters, {});
});

test('a timeline back at its default keeps no entry', () => {
  let store: ViewPrefsStore = {};
  store = withViewPrefs(store, 'a', { ...DEFAULT_VIEW_PREFS, filters: { type: ['point'] } });
  assert.deepEqual(Object.keys(store), ['a']);

  store = withViewPrefs(store, 'a', { ...DEFAULT_VIEW_PREFS });
  assert.deepEqual(store, {});
});

test('only what differs from the default is written', () => {
  const store = withViewPrefs({}, 'a', { ...DEFAULT_VIEW_PREFS, mode: 'list' });
  assert.deepEqual(store.a, { mode: 'list' });
});

test('the returned selection never aliases the stored one', () => {
  const store = withViewPrefs({}, 'a', { ...DEFAULT_VIEW_PREFS, filters: { status: ['Open'] } });
  viewPrefsFor(store, 'a').filters.status.push('Done');
  assert.deepEqual(viewPrefsFor(store, 'a').filters, { status: ['Open'] });
});

test('a null view id reads as the default rather than throwing', () => {
  assert.equal(viewPrefsFor({ a: { mode: 'list' } }, null).mode, 'timeline');
});

test('malformed storage reads as nothing stored', () => {
  assert.deepEqual(parseViewPrefsStore('{'), {});
  assert.deepEqual(parseViewPrefsStore('[1,2]'), {});
  assert.deepEqual(parseViewPrefsStore(null), {});
});

test('a stored field of the wrong type reads as absent', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({
      a: { mode: 42, groupBy: 'tag', filters: { status: ['Open', 7], tag: 'x' }, milestonesOnly: 'yes' },
    }),
  );
  const prefs = viewPrefsFor(store, 'a');
  assert.equal(prefs.mode, 'timeline');
  assert.equal(prefs.groupBy, 'tag');
  // The malformed dimension drops out, the well-typed one keeps its string values.
  assert.deepEqual(prefs.filters, { status: ['Open'] });
});

test('a round trip through the serialized store survives', () => {
  const store = withViewPrefs({}, 'a', {
    mode: 'plugin:product-roadmap:pricing',
    groupBy: 'cf:tier',
    filters: { status: ['Open', 'Doing'], 'cf:tier': ['Free'] },
  });
  assert.deepEqual(parseViewPrefsStore(JSON.stringify(store)), store);
});

test('a stored single-dimension pair is read as a selection', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({ a: { filterDim: 'status', filterValues: ['Open'] } }),
  );
  assert.deepEqual(viewPrefsFor(store, 'a').filters, { status: ['Open'] });
});

test('the current shape wins over a pair left beside it', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({ a: { filters: { tag: ['x'] }, filterDim: 'status', filterValues: ['Open'] } }),
  );
  assert.deepEqual(viewPrefsFor(store, 'a').filters, { tag: ['x'] });
});

test('saving drops the legacy pair rather than carrying it along', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({ a: { filterDim: 'status', filterValues: ['Open'] } }),
  );
  const saved = withViewPrefs(store, 'a', viewPrefsFor(store, 'a'));
  assert.deepEqual(saved.a, { filters: { status: ['Open'] } });
});

test('the instance-wide keys carry over', () => {
  const prefs = legacyViewPrefs(
    get({
      [LEGACY_PREF_KEYS.mode]: 'list',
      [LEGACY_PREF_KEYS.groupBy]: 'tag',
      [LEGACY_PREF_KEYS.filterDim]: 'status',
      [LEGACY_PREF_KEYS.filterValues]: '["Open"]',
      [LEGACY_PREF_KEYS.milestonesOnly]: 'true',
    }),
  );
  // The instance-wide „nur Meilensteine" folds into the type dimension and joins
  // the filter it used to compose with, rather than replacing it.
  assert.deepEqual(prefs, {
    mode: 'list',
    groupBy: 'tag',
    filters: { status: ['Open'], type: ['point'] },
  });
});

test('a stored milestonesOnly folds into the type dimension', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({ a: { milestonesOnly: true, filters: { status: ['Open'] } } }),
  );
  assert.deepEqual(viewPrefsFor(store, 'a').filters, { status: ['Open'], type: ['point'] });
});

test('an explicit type selection wins over a stored milestonesOnly', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({ a: { milestonesOnly: true, filters: { type: ['range'] } } }),
  );
  assert.deepEqual(viewPrefsFor(store, 'a').filters, { type: ['range'] });
});

test('saving drops milestonesOnly rather than carrying it along', () => {
  const store = parseViewPrefsStore(JSON.stringify({ a: { milestonesOnly: true } }));
  const saved = withViewPrefs(store, 'a', viewPrefsFor(store, 'a'));
  assert.deepEqual(saved.a, { filters: { type: ['point'] } });
});

test('nothing stored instance-wide carries nothing over', () => {
  assert.equal(legacyViewPrefs(get({})), null);
});

test('instance-wide keys at their default carry nothing over', () => {
  const prefs = legacyViewPrefs(
    get({
      [LEGACY_PREF_KEYS.mode]: '',
      [LEGACY_PREF_KEYS.filterDim]: '',
      [LEGACY_PREF_KEYS.filterValues]: '[]',
      [LEGACY_PREF_KEYS.milestonesOnly]: 'false',
    }),
  );
  assert.equal(prefs, null);
});

test('a legacy mode is carried over unparsed, so the registry can resolve it', () => {
  // `pricing` predates addressable plugin views; resolving it needs the plugin
  // registry, which this module deliberately does not know.
  assert.deepEqual(legacyViewPrefs(get({ [LEGACY_PREF_KEYS.mode]: 'pricing' })), {
    mode: 'pricing',
  });
});

test('a malformed legacy value list carries over as no selection', () => {
  assert.deepEqual(legacyViewPrefs(get({ [LEGACY_PREF_KEYS.filterValues]: '{oops' })), null);
});

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
  const prefs = viewPrefsFor({}, 'roadmap');
  assert.deepEqual(prefs, { ...DEFAULT_VIEW_PREFS, filterValues: [] });
});

test('one timeline’s filter is invisible to another', () => {
  let store: ViewPrefsStore = {};
  store = withViewPrefs(store, 'a', {
    ...DEFAULT_VIEW_PREFS,
    filterDim: 'cf:tier',
    filterValues: ['Free'],
  });

  assert.deepEqual(viewPrefsFor(store, 'a').filterValues, ['Free']);
  assert.equal(viewPrefsFor(store, 'b').filterDim, '');
  assert.deepEqual(viewPrefsFor(store, 'b').filterValues, []);
});

test('a timeline back at its default keeps no entry', () => {
  let store: ViewPrefsStore = {};
  store = withViewPrefs(store, 'a', { ...DEFAULT_VIEW_PREFS, milestonesOnly: true });
  assert.deepEqual(Object.keys(store), ['a']);

  store = withViewPrefs(store, 'a', { ...DEFAULT_VIEW_PREFS });
  assert.deepEqual(store, {});
});

test('only what differs from the default is written', () => {
  const store = withViewPrefs({}, 'a', { ...DEFAULT_VIEW_PREFS, mode: 'list' });
  assert.deepEqual(store.a, { mode: 'list' });
});

test('the returned filterValues never aliases the stored array', () => {
  const store = withViewPrefs({}, 'a', {
    ...DEFAULT_VIEW_PREFS,
    filterDim: 'status',
    filterValues: ['Open'],
  });
  viewPrefsFor(store, 'a').filterValues.push('Done');
  assert.deepEqual(viewPrefsFor(store, 'a').filterValues, ['Open']);
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
    JSON.stringify({ a: { mode: 42, groupBy: 'tag', filterValues: ['x', 7], milestonesOnly: 'yes' } }),
  );
  const prefs = viewPrefsFor(store, 'a');
  assert.equal(prefs.mode, 'timeline');
  assert.equal(prefs.groupBy, 'tag');
  assert.deepEqual(prefs.filterValues, ['x']);
  assert.equal(prefs.milestonesOnly, false);
});

test('a round trip through the serialized store survives', () => {
  const store = withViewPrefs({}, 'a', {
    ...DEFAULT_VIEW_PREFS,
    mode: 'plugin:product-roadmap:pricing',
    groupBy: 'cf:tier',
    filterDim: 'status',
    filterValues: ['Open', 'Doing'],
    milestonesOnly: true,
  });
  assert.deepEqual(parseViewPrefsStore(JSON.stringify(store)), store);
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
  assert.deepEqual(prefs, {
    mode: 'list',
    groupBy: 'tag',
    filterDim: 'status',
    filterValues: ['Open'],
    milestonesOnly: true,
  });
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW_PREFS,
  presentationPrefsFor,
  storedMode,
  withLegacyFallback,
  LEGACY_PREF_KEYS,
  legacyViewPrefs,
  parseViewPrefsStore,
  storedEdges,
  storedOrderFrom,
  viewPrefsFor,
  withEdgeSelection,
  withOrderFrom,
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

test('saving one presentation keeps the legacy layer the others still read', () => {
  // The pair used to be dropped on save, when there was one scope for the whole
  // timeline. Now every presentation without an entry of its own falls back to it,
  // so dropping it would reset the ones nobody has visited yet.
  const store = parseViewPrefsStore(
    JSON.stringify({ a: { filterDim: 'status', filterValues: ['Open'] } }),
  );
  const saved = withViewPrefs(store, 'a', { ...viewPrefsFor(store, 'a'), mode: 'list' });
  assert.deepEqual(saved.a, {
    mode: 'list',
    presentations: { list: { filters: { status: ['Open'] } } },
    filterDim: 'status',
    filterValues: ['Open'],
  });
  // …and the timeline, untouched, still reads the fallback.
  assert.deepEqual(presentationPrefsFor(saved, 'a', 'timeline').filters, { status: ['Open'] });
});

test('each presentation keeps its own grouping and filter', () => {
  // The point of the whole change: lanes and list sections are different
  // mechanisms, so one value for both could not express „group by Gruppe on the
  // timeline, by Status in the list".
  let store: ViewPrefsStore = {};
  store = withViewPrefs(store, 'a', {
    mode: 'timeline',
    groupBy: 'group',
    filters: { status: ['Open'] },
  });
  store = withViewPrefs(store, 'a', { mode: 'list', groupBy: 'status', filters: { tag: ['x'] } });

  assert.deepEqual(presentationPrefsFor(store, 'a', 'timeline'), {
    groupBy: 'group',
    filters: { status: ['Open'] },
  });
  assert.deepEqual(presentationPrefsFor(store, 'a', 'list'), {
    groupBy: 'status',
    filters: { tag: ['x'] },
  });
  assert.equal(storedMode(store, 'a'), 'list');
});

test('saving one presentation leaves the others alone', () => {
  // Rewriting the map instead would erase the grouping somebody set in a
  // presentation they are not currently in.
  let store: ViewPrefsStore = {};
  store = withViewPrefs(store, 'a', { mode: 'list', groupBy: 'status', filters: {} });
  store = withViewPrefs(store, 'a', { mode: 'timeline', groupBy: 'tag', filters: {} });
  assert.equal(presentationPrefsFor(store, 'a', 'list').groupBy, 'status');
  assert.equal(presentationPrefsFor(store, 'a', 'timeline').groupBy, 'tag');
});

test('a plugin view gets a slot of its own, keyed by its mode', () => {
  const mode = 'plugin:dev.zeitlines.sprints:board';
  const store = withViewPrefs({}, 'a', { mode, groupBy: 'cf:sprint', filters: {} });
  assert.equal(presentationPrefsFor(store, 'a', mode).groupBy, 'cf:sprint');
  // …and does not borrow the item list's dimension, which is the hole this closes.
  assert.equal(presentationPrefsFor(store, 'a', 'timeline').groupBy, DEFAULT_VIEW_PREFS.groupBy);
});

test('a presentation nobody visited inherits the timeline’s legacy values', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({ a: { groupBy: 'tag', filters: { status: ['Done'] } } }),
  );
  for (const mode of ['timeline', 'list', 'plugin:x:y']) {
    assert.deepEqual(presentationPrefsFor(store, 'a', mode), {
      groupBy: 'tag',
      filters: { status: ['Done'] },
    });
  }
});

test('an entry of its own wins over the legacy values', () => {
  const store = parseViewPrefsStore(
    JSON.stringify({
      a: {
        groupBy: 'tag',
        filters: { status: ['Done'] },
        presentations: { list: { groupBy: 'status' } },
      },
    }),
  );
  const list = presentationPrefsFor(store, 'a', 'list');
  assert.equal(list.groupBy, 'status');
  // An entry that names no filter means „no filter here", not „fall back": the
  // presentation has been configured, so its silence is a statement. Otherwise
  // clearing a filter in one presentation could never stick.
  assert.deepEqual(list.filters, {});
});

test('a presentation back at its default loses its entry, not the timeline', () => {
  let store = withViewPrefs({}, 'a', { mode: 'list', groupBy: 'status', filters: {} });
  store = withViewPrefs(store, 'a', {
    mode: 'list',
    groupBy: DEFAULT_VIEW_PREFS.groupBy,
    filters: {},
  });
  assert.equal(store.a?.presentations?.list, undefined);
  assert.equal(store.a?.mode, 'list', 'which presentation is open is still worth storing');
});

test('a timeline loses its entry only when no presentation has settings left', () => {
  let store = withViewPrefs({}, 'a', { mode: 'list', groupBy: 'status', filters: {} });
  // Going back to the timeline does NOT drop the list's grouping — that is the
  // whole point of the per-presentation scope.
  store = withViewPrefs(store, 'a', {
    mode: DEFAULT_VIEW_PREFS.mode,
    groupBy: DEFAULT_VIEW_PREFS.groupBy,
    filters: {},
  });
  assert.equal(presentationPrefsFor(store, 'a', 'list').groupBy, 'status');

  assert.deepEqual(Object.keys(store), ['a'], 'the entry stays while the list has settings');

  // Only clearing it in the list itself leaves nothing worth storing.
  let again = withViewPrefs({}, 'a', { mode: 'list', groupBy: 'status', filters: {} });
  again = withViewPrefs(again, 'a', {
    mode: 'list',
    groupBy: DEFAULT_VIEW_PREFS.groupBy,
    filters: {},
  });
  again = withViewPrefs(again, 'a', {
    mode: DEFAULT_VIEW_PREFS.mode,
    groupBy: DEFAULT_VIEW_PREFS.groupBy,
    filters: {},
  });
  assert.deepEqual(again, {});
});

test('the instance-wide keys land in the fallback, not in one presentation', () => {
  // They never were about a presentation: they applied to everything, so every
  // presentation of that timeline has to inherit them.
  const store = withLegacyFallback({}, 'a', {
    mode: 'list',
    groupBy: 'tag',
    filters: { status: ['Open'] },
  });
  assert.deepEqual(store.a, { mode: 'list', groupBy: 'tag', filters: { status: ['Open'] } });
  assert.equal(presentationPrefsFor(store, 'a', 'timeline').groupBy, 'tag');
  assert.equal(presentationPrefsFor(store, 'a', 'list').groupBy, 'tag');
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

test('milestonesOnly survives a save for the same reason', () => {
  const store = parseViewPrefsStore(JSON.stringify({ a: { milestonesOnly: true } }));
  const saved = withViewPrefs(store, 'a', { ...viewPrefsFor(store, 'a'), mode: 'list' });
  assert.deepEqual(saved.a?.presentations?.list, { filters: { type: ['point'] } });
  assert.equal(saved.a?.milestonesOnly, true);
  assert.deepEqual(presentationPrefsFor(saved, 'a', 'timeline').filters, { type: ['point'] });
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

// The edge selection is the timeline's rather than one presentation's, so it has
// a store and a save of its own. These pin the two ways that could go wrong: a
// grouping change clearing it, and a default selection outliving its usefulness
// as an entry nobody needs.
test('the edge selection survives a save of the presentation beside it', () => {
  const store = withEdgeSelection({}, 'src:buch', { Hints: 'off', Body: 'out' });
  const after = withViewPrefs(store, 'src:buch', { mode: 'graph', groupBy: 'tag', filters: {} });
  assert.deepEqual(storedEdges(after, 'src:buch'), { Hints: 'off', Body: 'out' });
});

test('a selection back at the default leaves no entry behind', () => {
  const store = withEdgeSelection({}, 'src:buch', { Hints: 'off' });
  assert.deepEqual(storedEdges(store, 'src:buch'), { Hints: 'off' });
  const cleared = withEdgeSelection(store, 'src:buch', { Hints: 'in' });
  assert.equal('src:buch' in cleared, false);
});

test('one timeline’s edges are not another’s', () => {
  const store = withEdgeSelection({}, 'src:a', { Hints: 'out' });
  assert.deepEqual(storedEdges(store, 'src:b'), {});
  assert.deepEqual(storedEdges(store, null), {});
});

test('a malformed stored direction reads as absent', () => {
  const store = parseViewPrefsStore(JSON.stringify({ 'src:a': { edges: { Hints: 'sideways', P: 'out' } } }));
  assert.deepEqual(storedEdges(store, 'src:a'), { P: 'out' });
});

// The chosen order is the timeline's too, and stored beside the edges for the same
// reason. These pin the same two failures: a neighbouring save clearing it, and an
// entry left behind for a timeline that states nothing.
test('the chosen order survives a save of the presentation beside it', () => {
  const store = withOrderFrom({}, 'src:buch', '_Index');
  const after = withViewPrefs(store, 'src:buch', { mode: 'graph', groupBy: 'tag', filters: {} });
  assert.equal(storedOrderFrom(after, 'src:buch'), '_Index');
});

test('clearing the order leaves no entry behind', () => {
  const store = withOrderFrom({}, 'src:buch', '_Index');
  const cleared = withOrderFrom(store, 'src:buch', '');
  assert.equal('src:buch' in cleared, false);
});

test('one timeline’s order is not another’s', () => {
  const store = withOrderFrom({}, 'src:a', '_Index');
  assert.equal(storedOrderFrom(store, 'src:b'), '');
  assert.equal(storedOrderFrom(store, null), '');
});

test('the order and the edges do not overwrite each other', () => {
  let store = withEdgeSelection({}, 'src:buch', { Hints: 'off' });
  store = withOrderFrom(store, 'src:buch', '_Index');
  assert.deepEqual(storedEdges(store, 'src:buch'), { Hints: 'off' });
  assert.equal(storedOrderFrom(store, 'src:buch'), '_Index');
});

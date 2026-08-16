import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEditSavedView,
  canPublishSavedView,
  canSeeSavedView,
  canonicalFilters,
  sanitizeSavedViews,
  savedViewMatches,
  savedViewSlug,
  sortSavedViews,
  stripSavedViewsForPublication,
  uniqueSavedViewId,
  visibleSavedViews,
  type SavedViewCaller,
} from './savedViews';
import type { SavedView } from './types';

// The rules the client, the API and the build all read. What is pinned here is
// what leaves the building (visibility, publication) and what the interface claims
// about the current display (drift) — the two halves that are wrong silently.

const ALICE: SavedViewCaller = { email: 'alice@example.com', canWrite: true, canManage: false };
const BOB: SavedViewCaller = { email: 'bob@example.com', canWrite: false, canManage: false };
const ADMIN: SavedViewCaller = { email: 'root@example.com', canWrite: true, canManage: true };
const NOBODY: SavedViewCaller = { email: null, canWrite: true, canManage: true };

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'q3',
  name: 'Q3',
  owner: 'alice@example.com',
  visibility: 'private',
  ...over,
});

test('a private view is its owner’s alone, a shared one is everybody’s', () => {
  const priv = view();
  assert.equal(canSeeSavedView(priv, ALICE), true);
  assert.equal(canSeeSavedView(priv, BOB), false);
  // Not even an admin sees it in a listing: administering the instance is not a
  // reason to read what somebody kept to themselves.
  assert.equal(canSeeSavedView(priv, ADMIN), false);

  const shared = view({ visibility: 'instance' });
  assert.equal(canSeeSavedView(shared, BOB), true);
});

test('an address is matched case-insensitively', () => {
  assert.equal(canSeeSavedView(view({ owner: 'ALICE@Example.com' }), ALICE), true);
});

test('two absent identities are the same actor, so a gateless instance works', () => {
  assert.equal(canSeeSavedView(view({ owner: undefined }), NOBODY), true);
  assert.equal(canSeeSavedView(view({ owner: undefined }), ALICE), false);
});

test('editing is the owner’s or an admin’s, never any editor’s', () => {
  const shared = view({ visibility: 'instance' });
  assert.equal(canEditSavedView(shared, ALICE), true);
  assert.equal(canEditSavedView(shared, ADMIN), true);
  // Bob may read it and may not rewrite it: sharing a view is not handing it over.
  assert.equal(canEditSavedView(shared, BOB), false);
});

test('publishing needs write, so a viewer keeps private views only', () => {
  assert.equal(canPublishSavedView(ALICE), true);
  assert.equal(canPublishSavedView(BOB), false);
});

test('a listing carries the shared ones plus my own, sorted by name', () => {
  const all = [
    view({ id: 'zeta', name: 'Zeta', visibility: 'instance' }),
    view({ id: 'mine', name: 'Alpha' }),
    view({ id: 'theirs', name: 'Beta', owner: 'bob@example.com' }),
  ];
  assert.deepEqual(
    visibleSavedViews(all, ALICE).map((v) => v.id),
    ['mine', 'zeta'],
  );
});

test('sorting ignores case and accents', () => {
  const names = sortSavedViews([
    view({ id: 'a', name: 'Übergabe' }),
    view({ id: 'b', name: 'alpha' }),
    view({ id: 'c', name: 'Beta' }),
  ]).map((v) => v.name);
  assert.deepEqual(names, ['alpha', 'Beta', 'Übergabe']);
});

test('drift is judged only on the fields the view states', () => {
  const narrow = view({ filters: { status: ['Open'] } });
  assert.equal(
    savedViewMatches(narrow, { mode: 'list', groupBy: 'tag', filters: { status: ['Open'] } }),
    true,
    'a view with no opinion about mode or grouping is not drifted by either',
  );
  assert.equal(
    savedViewMatches(narrow, { mode: 'timeline', groupBy: 'group', filters: {} }),
    false,
  );
});

test('a view that states no filter means the empty selection, not „leave it"', () => {
  // The column is NOT NULL DEFAULT '{}', so the two cannot be told apart coming
  // back out — and somebody saving an unfiltered view means the unfiltered one.
  const plain = view({ groupBy: 'group' });
  assert.equal(savedViewMatches(plain, { mode: 'timeline', groupBy: 'group', filters: {} }), true);
  assert.equal(
    savedViewMatches(plain, { mode: 'timeline', groupBy: 'group', filters: { status: ['Open'] } }),
    false,
  );
});

test('the order values were ticked in is not a drift', () => {
  const v = view({ filters: { status: ['Doing', 'Open'] } });
  assert.equal(
    savedViewMatches(v, { mode: 'timeline', groupBy: 'group', filters: { status: ['Open', 'Doing'] } }),
    true,
  );
});

test('an emptied dimension is the same as an absent one', () => {
  assert.deepEqual(canonicalFilters({ status: [], tag: ['x'] }), { tag: ['x'] });
});

test('a slug is derivable from a German name and never empty', () => {
  assert.equal(savedViewSlug('Q3 — Überfällig & offen'), 'q3-ueberfaellig-offen');
  assert.equal(savedViewSlug('\u{1F680}'), 'view');
});

test('a taken id counts up rather than refusing', () => {
  assert.equal(uniqueSavedViewId('Q3', ['q3', 'q3-2']), 'q3-3');
});

test('a malformed entry reads as absent instead of throwing', () => {
  const parsed = sanitizeSavedViews([
    { id: 'ok', name: 'Fine', filters: { status: ['Open'], broken: 'nope' } },
    { id: 'no-name' },
    'garbage',
    null,
  ]);
  assert.deepEqual(
    parsed.map((v) => v.id),
    ['ok'],
  );
  assert.deepEqual(parsed[0].filters, { status: ['Open'] });
});

test('materializing a file drops private views and the owners of the rest', () => {
  const file = {
    savedViews: [
      view({ id: 'mine' }),
      view({ id: 'ours', visibility: 'instance', updatedBy: 'alice@example.com', version: 4 }),
    ],
  };
  const published = stripSavedViewsForPublication(file);
  assert.deepEqual(
    published.savedViews?.map((v) => v.id),
    ['ours'],
  );
  // An address in a file a static deploy serves is the same leak `publicRead`
  // strips from a plugin row.
  assert.equal('owner' in published.savedViews![0], false);
  assert.equal('updatedBy' in published.savedViews![0], false);
  assert.equal('version' in published.savedViews![0], false);
});

test('a file whose views are all private loses the key entirely', () => {
  const published = stripSavedViewsForPublication({ savedViews: [view()] });
  assert.equal('savedViews' in published, false);
});

// The order a view puts its items in, which is the fourth thing a view stores
// about how the material is read (after the presentation, the grouping and the
// narrowing) and the second that names something in the timeline itself.
test('the order round-trips through a stored view', () => {
  const [only] = sanitizeSavedViews([{ id: 'kette', name: 'Hauptkette', orderFrom: '_Index' }]);
  assert.equal(only.orderFrom, '_Index');
});

test('an empty order is dropped rather than stored as one', () => {
  const [only] = sanitizeSavedViews([{ id: 'a', name: 'A', orderFrom: '' }]);
  assert.equal('orderFrom' in only, false);
  const [nonString] = sanitizeSavedViews([{ id: 'b', name: 'B', orderFrom: 7 }]);
  assert.equal('orderFrom' in nonString, false);
});

test('a view drifts when the order changes under it', () => {
  const ordered = { id: 'k', name: 'K', orderFrom: '_Index' };
  const shown = { mode: 'graph', groupBy: 'group', filters: {} };
  assert.equal(savedViewMatches(ordered, { ...shown, orderFrom: '_Index' }), true);
  assert.equal(savedViewMatches(ordered, { ...shown, orderFrom: '_Chrono' }), false);
  assert.equal(savedViewMatches(ordered, shown), false, 'and when it is cleared');
});

test('a view saved before this existed matches a timeline showing no order', () => {
  // Absence is „no order", not „no opinion" — the same reading the filter and the
  // edges take, so nothing that predates this feature reads as drifted.
  const plain = { id: 'p', name: 'P' };
  const shown = { mode: 'timeline', groupBy: 'group', filters: {} };
  assert.equal(savedViewMatches(plain, shown), true);
  assert.equal(savedViewMatches(plain, { ...shown, orderFrom: '' }), true);
  assert.equal(savedViewMatches(plain, { ...shown, orderFrom: '_Index' }), false);
});

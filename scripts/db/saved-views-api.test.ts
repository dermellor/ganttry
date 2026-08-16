import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSavedViewApi, withVisibleSavedViews } from './saved-views-api.ts';
import type { TimelineRepo } from './repo.ts';
import type { SavedView } from '../../src/types.ts';
import type { SavedViewCaller } from '../../src/savedViews.ts';

// The dispatcher's own rules, above any store: who is answered what, and which
// two fields cost more than `read`. The store is a faithful little map rather than
// a stub — a permissive fake would let a dispatcher bug pass, which is the failure
// mode a test double is most likely to have (same reasoning as
// plugin-store-memory.ts next door).

function memoryRepo(seed: SavedView[] = []): TimelineRepo {
  const rows = new Map<string, SavedView>(seed.map((v) => [v.id, { ...v }]));
  return {
    listSavedViews: async () => [...rows.values()],
    getSavedView: async (_id, viewId) => rows.get(viewId) ?? null,
    putSavedView: async (_id, view, _expected, updatedBy) => {
      const previous = rows.get(view.id);
      const stored: SavedView = {
        ...view,
        // The author survives a rewrite, the way both real drivers keep the column
        // out of their update.
        ...(previous?.owner != null ? { owner: previous.owner } : {}),
        version: (previous?.version ?? 0) + 1,
        ...(updatedBy ? { updatedBy } : {}),
      };
      rows.set(view.id, stored);
      return stored;
    },
    deleteSavedView: async (_id, viewId) => {
      rows.delete(viewId);
    },
  } as Partial<TimelineRepo> as TimelineRepo;
}

const ALICE: SavedViewCaller = { email: 'alice@example.com', canWrite: true, canManage: false };
const VIEWER: SavedViewCaller = { email: 'view@example.com', canWrite: false, canManage: false };
const ADMIN: SavedViewCaller = { email: 'root@example.com', canWrite: true, canManage: true };

const call = (repo: TimelineRepo, method: string, caller: SavedViewCaller, extra: Record<string, unknown> = {}) =>
  handleSavedViewApi(repo, { method, timelineId: 't', caller, ...extra });

const mine: SavedView = { id: 'mine', name: 'Meine', owner: 'alice@example.com', visibility: 'private' };
const theirs: SavedView = { id: 'theirs', name: 'Fremd', owner: 'bob@example.com', visibility: 'private' };
const ours: SavedView = { id: 'ours', name: 'Geteilt', owner: 'bob@example.com', visibility: 'instance' };

test('a listing hides somebody else’s private view', async () => {
  const res = await call(memoryRepo([mine, theirs, ours]), 'GET', ALICE);
  assert.equal(res.status, 200);
  assert.deepEqual((res.json as { savedViews: SavedView[] }).savedViews.map((v) => v.id), ['ours', 'mine']);
});

test('reading somebody else’s private view answers 404, not 403', async () => {
  const res = await call(memoryRepo([theirs]), 'GET', ALICE, { viewId: 'theirs' });
  assert.equal(res.status, 404);
});

test('a viewer may create a private view of their own', async () => {
  const repo = memoryRepo();
  const res = await call(repo, 'POST', VIEWER, { body: { name: 'Nur meins' } });
  assert.equal(res.status, 201);
  const stored = res.json as SavedView;
  assert.equal(stored.id, 'nur-meins');
  assert.equal(stored.owner, 'view@example.com');
  assert.equal(stored.visibility, 'private');
});

test('…and may not publish one', async () => {
  const res = await call(memoryRepo(), 'POST', VIEWER, {
    body: { name: 'Für alle', visibility: 'instance' },
  });
  assert.equal(res.status, 403);
});

test('…nor create one for somebody else', async () => {
  const res = await call(memoryRepo(), 'POST', VIEWER, {
    body: { name: 'Für Alice', owner: 'alice@example.com' },
  });
  assert.equal(res.status, 403);
});

test('an editor creates a view FOR somebody, which is what an agent does', async () => {
  const res = await call(memoryRepo(), 'POST', ALICE, {
    body: { name: 'Onboarding', owner: 'new@example.com', groupBy: 'status' },
  });
  assert.equal(res.status, 201);
  assert.equal((res.json as SavedView).owner, 'new@example.com');
});

test('a stated id that is taken is refused rather than renamed', async () => {
  const res = await call(memoryRepo([mine]), 'POST', ALICE, { body: { id: 'mine', name: 'Zweite' } });
  assert.equal(res.status, 409);
});

test('a derived id counts up instead', async () => {
  const taken = { ...mine, id: 'meine' };
  const res = await call(memoryRepo([taken]), 'POST', ALICE, { body: { name: 'Meine' } });
  assert.equal((res.json as SavedView).id, 'meine-2');
});

test('a name is required', async () => {
  const res = await call(memoryRepo(), 'POST', ALICE, { body: { groupBy: 'status' } });
  assert.equal(res.status, 400);
});

test('a patch touches only what it names, and null clears', async () => {
  const repo = memoryRepo([{ ...mine, mode: 'list', groupBy: 'status', filters: { status: ['Open'] } }]);
  const res = await call(repo, 'PATCH', ALICE, { viewId: 'mine', body: { mode: null } });
  assert.equal(res.status, 200);
  const stored = res.json as SavedView;
  assert.equal('mode' in stored, false);
  assert.equal(stored.groupBy, 'status', 'an unnamed field survives');
  assert.deepEqual(stored.filters, { status: ['Open'] });
});

test('a shared view is not editable by everybody who may write', async () => {
  const res = await call(memoryRepo([ours]), 'PATCH', ALICE, { viewId: 'ours', body: { name: 'Meins jetzt' } });
  assert.equal(res.status, 403);
});

test('…but an admin may fix one, without becoming its author', async () => {
  const repo = memoryRepo([ours]);
  const res = await call(repo, 'PATCH', ADMIN, { viewId: 'ours', body: { name: 'Korrigiert' } });
  assert.equal(res.status, 200);
  assert.equal((res.json as SavedView).owner, 'bob@example.com');
});

test('the id is not patchable, because links carry it', async () => {
  const res = await call(memoryRepo([mine]), 'PATCH', ALICE, { viewId: 'mine', body: { id: 'anders' } });
  assert.equal(res.status, 400);
});

test('deleting somebody else’s view is refused, deleting one’s own is not', async () => {
  const repo = memoryRepo([mine, ours]);
  assert.equal((await call(repo, 'DELETE', ALICE, { viewId: 'ours' })).status, 403);
  assert.equal((await call(repo, 'DELETE', ALICE, { viewId: 'mine' })).status, 200);
  assert.equal((await repo.getSavedView('t', 'mine')), null);
});

test('an unknown method is 405 rather than a silent no-op', async () => {
  assert.equal((await call(memoryRepo(), 'PUT', ALICE)).status, 405);
});

test('the timeline payload is filtered by who asked', async () => {
  const file = { savedViews: [mine, theirs, ours] };
  assert.deepEqual(
    withVisibleSavedViews(file, ALICE).savedViews?.map((v) => v.id),
    ['ours', 'mine'],
  );
  // Nothing visible drops the key rather than shipping an empty array, so a client
  // cannot tell „none for you" from „this timeline has none".
  assert.equal('savedViews' in withVisibleSavedViews({ savedViews: [theirs] }, ALICE), false);
});

// The edge selection an agent may set, so a named reading of a folder's relations
// is reachable without a browser. Canonicalised on the way in like `filters`:
// a field back at the default direction is dropped rather than stored, or the view
// would read as drifted against a display that matches it exactly.
test('an edge selection is stored, and the default direction is dropped', async () => {
  const repo = memoryRepo();
  const res = await call(repo, 'POST', ALICE, {
    body: { name: 'Kette', edges: { Blocks: 'out', Hints: 'in', Junk: 'sideways' } },
  });
  assert.equal(res.status, 201);
  assert.deepEqual((res.json as SavedView).edges, { Blocks: 'out' });
});

test('an edge selection is cleared by an explicit null and untouched when unnamed', async () => {
  const repo = memoryRepo([{ ...mine, edges: { Blocks: 'out' }, groupBy: 'status' }]);
  const kept = await call(repo, 'PATCH', ALICE, { viewId: 'mine', body: { groupBy: 'tag' } });
  assert.deepEqual((kept.json as SavedView).edges, { Blocks: 'out' }, 'an unnamed field survives');
  const cleared = await call(repo, 'PATCH', ALICE, { viewId: 'mine', body: { edges: null } });
  assert.equal('edges' in (cleared.json as SavedView), false);
});

// The order a view reads its items in, through the same endpoint and with the same
// two-way rule. It is here because `merged` builds the stored view from a
// whitelist: a field the client sends and that function does not name is accepted,
// answered 2xx and silently not stored — which is exactly what this one did on its
// first run, and what a browser cannot tell from a successful save.
test('the order a view declares is stored, and whitespace is not a value', async () => {
  const repo = memoryRepo();
  const res = await call(repo, 'POST', ALICE, { body: { name: 'Kette', orderFrom: '  _Index  ' } });
  assert.equal(res.status, 201);
  assert.equal((res.json as SavedView).orderFrom, '_Index');
  const blank = await call(repo, 'POST', ALICE, { body: { name: 'Ohne', orderFrom: '   ' } });
  assert.equal('orderFrom' in (blank.json as SavedView), false);
});

test('the order is cleared by an explicit null and untouched when unnamed', async () => {
  const repo = memoryRepo([{ ...mine, orderFrom: '_Index', groupBy: 'status' }]);
  const kept = await call(repo, 'PATCH', ALICE, { viewId: 'mine', body: { groupBy: 'tag' } });
  assert.equal((kept.json as SavedView).orderFrom, '_Index', 'an unnamed field survives');
  const cleared = await call(repo, 'PATCH', ALICE, { viewId: 'mine', body: { orderFrom: null } });
  assert.equal('orderFrom' in (cleared.json as SavedView), false);
});

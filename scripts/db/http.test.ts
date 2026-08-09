import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest, type ApiContext } from './http.ts';
import type { DbConnections } from './api.ts';
import type { TimelineRepo } from './repo.ts';

// The point of shaping the HTTP layer around Request/Response: it runs
// in-process, with no server, no port and no database.
const call = (path: string, init?: RequestInit, ctx?: Partial<ApiContext>) =>
  handleApiRequest(new Request(`http://localhost${path}`, init), {
    conns: {} as DbConnections,
    ...ctx,
  });

test('a path we do not own answers null so the caller can fall through', async () => {
  assert.equal(await call('/api/me'), null);
  assert.equal(await call('/api/jira/search?q=x'), null);
  assert.equal(await call('/index.html'), null);
  // Near misses must not be swallowed either.
  assert.equal(await call('/api/sourcesx'), null);
});

test('read-only routes reject a write with 405', async () => {
  for (const path of ['/api/sources', '/api/pricing/x']) {
    const res = await call(path, { method: 'POST' });
    assert.equal(res?.status, 405, path);
  }
  // /api/users takes POST and PATCH now (invite, role, status). Everything else
  // is still refused, and without a database a write has nowhere to go.
  assert.equal((await call('/api/users', { method: 'DELETE' }))?.status, 405);
  assert.equal((await call('/api/users', { method: 'POST', body: '{}' }))?.status, 503);
});

test('without a DB the collection is still answerable, and empty', async () => {
  const res = (await call('/api/sources'))!;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sources: [] });
});

test('without a DB the user directory is empty rather than an error', async () => {
  const res = (await call('/api/users'))!;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { users: [] });
});

test('without a DB a read 404s and a write 503s — never a static fallback', async () => {
  const read = (await call('/api/source/plan'))!;
  assert.equal(read.status, 404);
  assert.equal(((await read.json()) as any).error, 'db_not_configured');

  const write = (await call('/api/source/plan/item/a1', { method: 'PATCH', body: '{}' }))!;
  assert.equal(write.status, 503);
  // The refusal names the two ways to configure one; a bare error would leave a
  // self-hoster guessing.
  assert.match(((await write.json()) as any).detail, /TIMELINES_DATABASE_URL/);
});

test('the public plugin route stays cross-origin readable, errors included', async () => {
  // The consumer is a page on another origin fetching at build time. Without
  // CORS on the error paths a 404 reaches it as an opaque network failure.
  const res = (await call('/api/public/plugin/demo/x'))!;
  assert.equal(res.status, 503); // no backend in this context
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'no-store'); // never cache a miss
});

test('the retired pricing route answers 410 and names its successor', async () => {
  // Answered rather than dropped: an unrouted /api/pricing/… falls through to
  // the SPA and returns 200 with HTML, so a build-time fetch().json() would fail
  // on a parse error that says nothing about what happened. It also has to reach
  // a consumer on another origin, which is why the CORS header is here too.
  const res = (await call('/api/pricing/x'))!;
  assert.equal(res.status, 410);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = (await res.json()) as { successor?: string };
  assert.match(String(body.successor), /^\/api\/public\/plugin\//);
  assert.ok(String(body.successor).endsWith('/x'), 'the id carries over, so the message is actionable');
});

test('the data API is never cached', async () => {
  const res = (await call('/api/sources'))!;
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('a malformed id is rejected before it reaches the dispatcher', async () => {
  for (const path of ['/api/source/a%20b', '/api/source/a$b', '/api/source/plan/item/a b']) {
    const res = (await call(path))!;
    assert.equal(res.status, 400, path);
    assert.match(((await res.json()) as any).error, /invalid/);
  }
});

test('the plugin namespace is exempt from the id charset rule', async () => {
  // A scoped plugin id carries `@` and `/`, and a composite row id carries `:`
  // and percent escapes, so the charset rule that keeps malformed timeline ids
  // out would reject every legitimate one of them. The exemption is not a hole:
  // the plugin id and the collection are checked against the installed
  // manifest — an allowlist — and the row id by the store that holds it, and
  // none of those segments ever becomes a path.
  //
  // Pinned because it broke silently once: the exemption lived in the dev
  // server's own middleware, and moving the route into this layer dropped it.
  // Every plugin write answered „invalid id" while every core route was fine.
  const res = (await call('/api/source/plan/plugin/@acme%2Fsprints/entries/a%3Ab', undefined, withLocal()))!;
  assert.notEqual(res.status, 400, 'the charset rule must not see the plugin segments');
});

test('dot segments never reach the router — the URL parser resolves them first', async () => {
  // Worth pinning: `..` in a request line is normalised away before any handler
  // sees it, so the id check is not what stops traversal here and must not be
  // mistaken for the containment guard (that one lives in local/file-repo.ts and
  // works on the resolved path).
  assert.equal(new URL('http://localhost/api/source/../secrets').pathname, '/api/secrets');
  assert.equal(await call('/api/source/../secrets'), null);
});

// ---------------------------------------------------------------------------
// With a source behind it: a local file repo is enough to exercise the frame
// (routing, If-Match, the live header) without a database.
// ---------------------------------------------------------------------------

function stubRepo(seen: { req?: unknown }): TimelineRepo {
  return {
    getTimeline: async (id: string) => ({ items: [{ id: 'a1', content: 'A', start: '2026-01-01' }], name: id }),
    updateItem: async (_id: string, itemId: string, patch: unknown, expectedVersion?: number) => {
      seen.req = { itemId, patch, expectedVersion };
      return { id: itemId, content: 'A', version: (expectedVersion ?? 0) + 1 };
    },
  } as unknown as TimelineRepo;
}

const withLocal = (seen: { req?: unknown } = {}): Partial<ApiContext> => ({
  conns: { local: { has: (id: string) => id === 'plan', repo: stubRepo(seen) } } as DbConnections,
});

test('a local source is served and declares its live mode to the client', async () => {
  const res = (await call('/api/source/plan', undefined, withLocal()))!;
  assert.equal(res.status, 200);
  // A filesystem has no push channel, so the client is told to poll.
  assert.equal(res.headers.get('X-Source-Live'), 'poll');
});

test('If-Match becomes the optimistic-lock version', async () => {
  const seen: { req?: any } = {};
  const res = (await call('/api/source/plan/item/a1', {
    method: 'PATCH',
    headers: { 'If-Match': '7' },
    body: JSON.stringify({ content: 'B' }),
  }, withLocal(seen)))!;
  assert.equal(res.status, 200);
  assert.equal(seen.req.expectedVersion, 7);
  assert.deepEqual(seen.req.patch, { content: 'B' });
});

test('a non-numeric If-Match is ignored rather than sent as NaN', async () => {
  const seen: { req?: any } = {};
  await call('/api/source/plan/item/a1', {
    method: 'PATCH',
    headers: { 'If-Match': 'W/"weak"' },
    body: JSON.stringify({ content: 'B' }),
  }, withLocal(seen));
  assert.equal(seen.req.expectedVersion, undefined);
});

test('a malformed body is a 400, not a 500', async () => {
  const res = (await call('/api/source/plan/item/a1', {
    method: 'PATCH',
    body: '{not json',
  }, withLocal()))!;
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).error, 'invalid JSON');
});

test('an empty body is undefined rather than a parse error', async () => {
  const res = (await call('/api/source/plan', { method: 'PATCH', body: '' }, withLocal()))!;
  assert.notEqual(res.status, 400);
});

// ---- access control (TIMELINES_ACCESS_CONTROL) ------------------------------
// The switch is what makes this shippable ahead of the member list: with it off
// every case below has to behave exactly as it did before the role model
// existed, and that is asserted rather than assumed.

/**
 * Just enough PostgREST to answer `getMember`.
 *
 * Deliberately a fake of the CLIENT rather than of the repo: `resolveRepo` builds
 * the real `makeSupabaseRepo` from whatever handle it is given, so a repo-shaped
 * stub would never be reached and the test would prove nothing about the path
 * the deploy actually takes.
 */
function fakeDb(members: Record<string, { email: string; role: string; status: string }>) {
  return {
    from: () => ({
      select: () => ({
        ilike: (_col: string, value: string) => ({
          maybeSingle: async () => ({ data: members[value] ?? null, error: null }),
        }),
      }),
    }),
  };
}

const asMember = (
  members: Record<string, { email: string; role: string; status: string }>,
  email: string,
): Partial<ApiContext> => ({
  conns: { supabase: fakeDb(members) } as unknown as DbConnections,
  accessControl: true,
  caller: { email },
});

const MEMBERS = {
  'admin@example.test': { email: 'admin@example.test', role: 'admin', status: 'active' },
  'editor@example.test': { email: 'editor@example.test', role: 'editor', status: 'active' },
  'viewer@example.test': { email: 'viewer@example.test', role: 'viewer', status: 'active' },
  'gone@example.test': { email: 'gone@example.test', role: 'admin', status: 'suspended' },
};

const write = (ctx: Partial<ApiContext>) =>
  call('/api/source/plan/item/a1', { method: 'PATCH', body: JSON.stringify({ content: 'B' }) }, ctx);

test('with the switch off nothing is refused, whoever asks', async () => {
  // No caller, no member list, a write: exactly the pre-role-model behaviour.
  const res = (await write(withLocal()))!;
  assert.equal(res.status, 200);
});

test('a viewer may read and may not write', async () => {
  const denied = (await write(asMember(MEMBERS, 'viewer@example.test')))!;
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as any).capability, 'write');

  const read = (await call('/api/sources', undefined, asMember(MEMBERS, 'viewer@example.test')))!;
  assert.notEqual(read.status, 403);
});

test('an editor may write', async () => {
  const res = (await write(asMember(MEMBERS, 'editor@example.test')))!;
  assert.notEqual(res.status, 403);
});

test('a suspended member is refused even at the highest role', async () => {
  // The status decides before the role does; an admin who was suspended is out.
  const res = (await call('/api/sources', undefined, asMember(MEMBERS, 'gone@example.test')))!;
  assert.equal(res.status, 403);
});

test('somebody with no membership row is refused, reading included', async () => {
  const res = (await call('/api/sources', undefined, asMember(MEMBERS, 'stranger@example.test')))!;
  assert.equal(res.status, 403);
});

test('the refusal does not say whether the address is known', async () => {
  // „No such member" and „wrong role" answer the same way: the difference is
  // only useful to somebody probing which addresses exist.
  const stranger = (await write(asMember(MEMBERS, 'stranger@example.test')))!;
  const viewer = (await write(asMember(MEMBERS, 'viewer@example.test')))!;
  assert.equal(stranger.status, viewer.status);
  assert.equal(((await stranger.json()) as any).error, ((await viewer.json()) as any).error);
});

test('with the switch on and no identity at all, a request is refused', async () => {
  const res = (await call('/api/sources', undefined, { ...withLocal(), accessControl: true }))!;
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as any).error, 'forbidden');
});

test('the switch without a database says so instead of denying everybody', async () => {
  const res = (await call('/api/sources', undefined, {
    ...withLocal(),
    accessControl: true,
    caller: { email: 'someone@example.test' },
  }))!;
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as any).error, 'access_control_without_database');
});

test('a service token acts with its configured role', async () => {
  const viewer = (await write({ ...withLocal(), accessControl: true, serviceRole: 'viewer' }))!;
  assert.equal(viewer.status, 403, 'a viewer token may not write');

  const editor = (await write({ ...withLocal(), accessControl: true, serviceRole: 'editor' }))!;
  assert.equal(editor.status, 200, 'an editor token may, without any member row');
});

test('the public pricing route stays reachable with the switch on', async () => {
  // Public by contract (`security: []` in openapi.yaml). A gate that swallows it
  // breaks the one integration the API explicitly promises.
  const res = (await call('/api/pricing/x', undefined, { accessControl: true }))!;
  assert.notEqual(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('paths we do not own are never refused, only passed through', async () => {
  // The check must sit behind „is this ours", or a 403 lands on /api/me and the
  // presence badge dies the moment the switch goes on.
  for (const path of ['/api/me', '/api/jira/search?q=x', '/index.html']) {
    assert.equal(await call(path, undefined, { accessControl: true }), null, path);
  }
});

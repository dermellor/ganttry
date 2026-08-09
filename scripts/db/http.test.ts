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
  for (const path of ['/api/sources', '/api/users', '/api/pricing/x']) {
    const res = await call(path, { method: 'POST' });
    assert.equal(res?.status, 405, path);
  }
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

test('the public pricing route stays cross-origin readable, errors included', async () => {
  // The consumer is a page on another origin fetching at build time. Without
  // CORS on the error paths a 404 reaches it as an opaque network failure.
  const res = (await call('/api/pricing/x'))!;
  assert.equal(res.status, 503); // no DB in this context
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'no-store'); // never cache a miss
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

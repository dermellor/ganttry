// Binds the hand-written route table to the code it documents.
//
// openapi.yaml declares its routes by hand, because the dispatcher carries no
// per-route types. That would rot silently: someone adds a sub-resource to
// SUB_KINDS, wires it into handleTimelineApi, and the spec quietly describes an
// API that no longer exists in full. These tests make that a failing build
// instead of a discovery months later.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUB_KINDS } from '../db/api.ts';
import { ROUTES } from './openapi-routes.ts';

const paths = ROUTES.map((r) => r.path);

test('openapi routes: every SUB_KIND from the dispatcher is documented', () => {
  const undocumented = SUB_KINDS.filter(
    (kind) => !paths.some((p) => p.includes(`/${kind}`)),
  );
  assert.deepEqual(
    undocumented,
    [],
    `These sub-resources exist in scripts/db/api.ts but appear in no path in ` +
      `scripts/schema/openapi-routes.ts. Document them, then run \`npm run openapi\`.`,
  );
});

test('openapi routes: no path documents a sub-resource the dispatcher does not know', () => {
  // Catches the reverse drift: a route left behind after a sub-resource was
  // removed or renamed in the dispatcher. Only paths *below* a timeline id carry
  // sub-resources — the collection endpoints (/api/sources, /api/users, /api/me,
  // /api/pricing/{id}) are their own thing and must not be checked against
  // SUB_KINDS.
  const PREFIX = '/api/source/{id}/';
  const known = new Set<string>(SUB_KINDS);
  const stale: string[] = [];
  for (const path of paths.filter((p) => p.startsWith(PREFIX))) {
    for (const seg of path.slice(PREFIX.length).split('/').filter(Boolean)) {
      if (seg.startsWith('{')) continue;
      // `plugin` opens a namespace whose remaining segments are named by the
      // plugin, not by the dispatcher — the same rule parseSourcePath applies.
      // `move` there is a verb on a collection, and checking it against
      // SUB_KINDS would demand a sub-resource that must never exist.
      if (seg === 'move' && path.includes('/plugin/')) continue;
      if (!known.has(seg)) stale.push(`${path} → ${seg}`);
    }
  }
  assert.deepEqual(stale, [], 'Paths naming a sub-resource the dispatcher does not know');
});

test('openapi routes: each path is declared once', () => {
  const seen = new Set<string>();
  const dupes = paths.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
  assert.deepEqual(dupes, [], 'Duplicate path entries would silently overwrite each other');
});

test('openapi routes: each operation declares a success and the auth failure', () => {
  for (const route of ROUTES) {
    for (const op of route.operations) {
      const codes = Object.keys(op.responses);
      const success = codes.filter((c) => c.startsWith('2'));
      assert.ok(
        success.length > 0,
        `${op.method} ${route.path} declares no 2xx response`,
      );
      // The public pricing endpoint is the deliberate exception: no auth gate.
      if (route.path !== '/api/pricing/{id}') {
        assert.ok(
          codes.includes('401'),
          `${op.method} ${route.path} is behind the auth gate but documents no 401`,
        );
      }
    }
  }
});

test('openapi routes: a write with optimistic locking documents the 409', () => {
  for (const route of ROUTES) {
    for (const op of route.operations) {
      if (!op.optimisticLock) continue;
      assert.ok(
        Object.keys(op.responses).includes('409'),
        `${op.method} ${route.path} sends If-Match but documents no 409 — a client ` +
          `cannot tell a stale write from a rejected one`,
      );
    }
  }
});

test('openapi routes: path parameters are declared for every placeholder', () => {
  for (const route of ROUTES) {
    const placeholders = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const declared = (route.pathParams ?? []).map((p) => p.name);
    assert.deepEqual(
      placeholders,
      declared,
      `${route.path}: placeholders and declared pathParams disagree`,
    );
  }
});

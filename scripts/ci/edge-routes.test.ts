// Every path the shared HTTP layer answers for is declared in all three places.
//
// A route lives in `scripts/db/http.ts`, but reaching it in production also
// needs an entry in the edge function's `config.path` AND in `netlify.toml`.
// The Vite dev middleware matches all of `/api/`, so a missing declaration is
// invisible locally and 404s only on the deploy — which is exactly how
// `/api/members` shipped unreachable.
//
// A `curl` does not catch it either: the auth gate runs on `/*` and answers 401
// before routing, so an unauthenticated probe looks healthy.

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { OWNED_API_PATHS } from '../db/http.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every owned API path is declared in the edge function and in netlify.toml', async () => {
  const fn = await readFile(join(ROOT, 'netlify', 'edge-functions', 'timelines-api.ts'), 'utf8');
  const toml = await readFile(join(ROOT, 'netlify.toml'), 'utf8');

  const declaredInFn = [...fn.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  // Only the entries that route to this function; another function's paths must
  // not count as covering ours.
  const tomlBlocks = toml.split('[[edge_functions]]').filter((b) => b.includes('timelines-api'));
  const declaredInToml = tomlBlocks.flatMap((b) => [...b.matchAll(/path\s*=\s*"([^"]+)"/g)].map((m) => m[1]));

  for (const path of OWNED_API_PATHS) {
    assert.ok(
      declaredInFn.includes(path),
      `${path} is missing from timelines-api.ts config.path — it would 404 on the deploy`,
    );
    assert.ok(
      declaredInToml.includes(path),
      `${path} is missing from netlify.toml — it would 404 on the deploy`,
    );
  }
});

test('the check would fail if a declaration went missing', async () => {
  // Guards the guard: the matching above must not be so loose that anything
  // passes. A path nobody declares has to be reported as absent.
  const fn = await readFile(join(ROOT, 'netlify', 'edge-functions', 'timelines-api.ts'), 'utf8');
  const declaredInFn = [...fn.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  assert.equal(declaredInFn.includes('/api/invented'), false);
});

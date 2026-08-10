import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLive, liveOverride, resolveAdapter, type DbConnections } from './api.ts';
import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';

// The driver handles are never called here: resolveAdapter only selects, it does
// not query. Stand-ins keep the test free of a database.
const sql = {} as Sql;
const supabase = {} as SupabaseClient;

test('defaultLive: a bare Postgres polls, because Realtime needs a Supabase project', () => {
  assert.equal(defaultLive({ sql }), 'poll');
  assert.equal(defaultLive({}), 'poll');
});

test('defaultLive: a configured Supabase project gets realtime', () => {
  assert.equal(defaultLive({ supabase }), 'realtime');
});

test('defaultLive: postgres.js against a Supabase project keeps realtime', () => {
  // The documented opt-in: TIMELINES_DATABASE_URL wins over the Supabase vars
  // for the driver, but the project (and its Realtime channel) still exists.
  // Keying the mode off the winning driver would silently downgrade this setup.
  assert.equal(defaultLive({ sql, supabase }), 'realtime');
});

test('liveOverride: only the two known modes override, anything else defers', () => {
  assert.equal(liveOverride('poll'), 'poll');
  assert.equal(liveOverride('realtime'), 'realtime');
  assert.equal(liveOverride(undefined), undefined);
  assert.equal(liveOverride(''), undefined);
  // A typo must not be coerced into a mode — that is how `TIMELINES_DB_LIVE=polling`
  // used to turn into "realtime" and disable live updates on a Postgres deploy.
  assert.equal(liveOverride('polling'), undefined);
  assert.equal(liveOverride('true'), undefined);
});

test('resolveAdapter: advertises the default for the configured backend', () => {
  assert.equal(resolveAdapter({ sql }, 'plan').capabilities.live, 'poll');
  assert.equal(resolveAdapter({ supabase }, 'plan').capabilities.live, 'realtime');
});

test('resolveAdapter: an explicit override wins in both directions', () => {
  assert.equal(resolveAdapter({ sql }, 'plan', 'realtime').capabilities.live, 'realtime');
  assert.equal(resolveAdapter({ supabase }, 'plan', 'poll').capabilities.live, 'poll');
});

test('resolveAdapter: per-source routing picks the mode with the pool', () => {
  // sqlFor is the postgres.js path, so a routed source polls even when a
  // default `sql` handle is absent.
  const conns: DbConnections = { sqlFor: (id) => (id.startsWith('acme/') ? sql : null) };
  assert.equal(resolveAdapter(conns, 'acme/roadmap').capabilities.live, 'poll');
});

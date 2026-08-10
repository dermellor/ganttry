// Path parsing and adapter selection for the API dispatcher.
//
// The plugin routes are the reason this has its own suite: they add a segment
// that opens a NAMESPACE, and everything after it is named by the plugin rather
// than by us. Getting that wrong is not a parse error — it silently addresses a
// different resource, which is the class of bug a test finds and a reader does
// not.
//
// The second half covers the other decision this module makes without touching a
// database: which live mode a source advertises, and which driver serves it.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { defaultLive, liveOverride, parseSourcePath, resolveAdapter, type DbConnections } from './api.ts';
import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('parseSourcePath: the pre-existing sub-resources', () => {
  test('a bare id, with and without a namespace', () => {
    assert.deepEqual(parseSourcePath('/plan'), { id: 'plan' });
    assert.deepEqual(parseSourcePath('/acme/plan'), { id: 'acme/plan' });
  });

  test('a sub-resource with and without a child id', () => {
    assert.deepEqual(parseSourcePath('/plan/item'), { id: 'plan', sub: { kind: 'item', childId: undefined } });
    assert.deepEqual(parseSourcePath('/plan/item/i-7'), { id: 'plan', sub: { kind: 'item', childId: 'i-7' } });
  });

  test('an empty path has no id to serve', () => {
    assert.equal(parseSourcePath('/'), null);
  });
});

describe('parseSourcePath: the plugin namespace', () => {
  test('plugin id and collection are split out, not left as one child id', () => {
    assert.deepEqual(parseSourcePath('/plan/plugin/com.example.demo/tiers'), {
      id: 'plan',
      sub: { kind: 'plugin', childId: 'com.example.demo/tiers', plugin: { pluginId: 'com.example.demo', collection: 'tiers' } },
    });
  });

  test('a row id is the third part', () => {
    const parsed = parseSourcePath('/plan/plugin/com.example.demo/tiers/pro');
    assert.deepEqual(parsed?.sub?.plugin, { pluginId: 'com.example.demo', collection: 'tiers', rowId: 'pro' });
  });

  test('a collection named like a sub-resource is NOT read as one', () => {
    // Without the namespace rule the right-to-left scan finds `tier` first and
    // the timeline id swallows `plan/plugin/demo` — a write would then land on
    // the pricing tier of a timeline that does not exist.
    const parsed = parseSourcePath('/plan/plugin/com.example.demo/tier/pro');
    assert.equal(parsed?.sub?.kind, 'plugin');
    assert.deepEqual(parsed?.sub?.plugin, { pluginId: 'com.example.demo', collection: 'tier', rowId: 'pro' });
  });

  test('a namespaced timeline id keeps its slashes', () => {
    const parsed = parseSourcePath('/acme/plan/plugin/com.example.demo/tiers');
    assert.equal(parsed?.id, 'acme/plan');
  });

  test('a scoped plugin id survives as one percent-encoded segment', () => {
    const parsed = parseSourcePath('/plan/plugin/%40acme%2Fsprints/entries');
    assert.deepEqual(parsed?.sub?.plugin, { pluginId: '@acme/sprints', collection: 'entries' });
  });

  test('a row id decodes exactly once, so a composite key comes back intact', () => {
    // rowIdFor encodes each key part and joins with ":"; the client then encodes
    // the whole id for the path. A value that itself carried a ":" is therefore
    // double-encoded and must not decode into an extra separator.
    const parsed = parseSourcePath('/plan/plugin/com.example.demo/cells/pro%253Ax%3Acalls');
    assert.equal(parsed?.sub?.plugin?.rowId, 'pro%3Ax:calls');
  });

  test('a fourth segment is refused rather than joined into the row id', () => {
    // Accepting it would make `a/b` and `a%2Fb` two spellings of one row id.
    assert.equal(parseSourcePath('/plan/plugin/com.example.demo/tiers/pro/extra'), null);
  });

  test('the move verb arrives as the row id, for the dispatcher to recognise', () => {
    assert.equal(parseSourcePath('/plan/plugin/com.example.demo/tiers/move')?.sub?.plugin?.rowId, 'move');
  });

  test('a trailing `plugin` with nothing after it is not a plugin path', () => {
    // It carries no plugin id, so there is nothing to dispatch to; it falls back
    // to the ordinary scan, which finds the marker and leaves an empty child.
    const parsed = parseSourcePath('/plan/plugin');
    assert.equal(parsed?.sub?.plugin, undefined);
  });
});

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

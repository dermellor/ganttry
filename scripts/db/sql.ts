// Node-side postgres.js connection factory. Reads TIMELINES_DATABASE_URL (a
// Postgres connection string — e.g. the Supabase Supavisor transaction pooler)
// from the same cascade as the Supabase client. The edge function builds its own
// `sql` handle from Deno.env (see netlify/edge-functions).
//
// `prepare: false` is required for transaction-mode pooling (Supavisor :6543):
// prepared statements aren't supported when connections are multiplexed per
// transaction. It's harmless against a direct connection too.

import postgres, { type Sql } from 'postgres';
import { envValue } from './env.ts';

let cached: Sql | null | undefined;

/** Returns the DEFAULT postgres.js handle, or null if TIMELINES_DATABASE_URL is absent. */
export function getSql(): Sql | null {
  if (cached !== undefined) return cached;
  const url = envValue('TIMELINES_DATABASE_URL');
  cached = url ? postgres(url, { prepare: false }) : null;
  return cached;
}

/** The env var carrying a connection used only for schema work. */
export const MIGRATE_URL_VAR = 'TIMELINES_MIGRATE_DATABASE_URL';

let migrateCached: Sql | null | undefined;

/**
 * Connection for **schema work only** — the migration runner and the pending
 * check. It exists because migrating and serving are different concerns that were
 * forced to share one variable: setting `TIMELINES_DATABASE_URL` to get a runner
 * connection also switches the app's driver from supabase-js to postgres.js, which
 * is a behaviour change nobody asked for when all they wanted was to apply a
 * migration.
 *
 * A migration also cannot run over PostgREST at all: it is DDL, and the tracking
 * table is deliberately not exposed through the API. So a Supabase-backed instance
 * needs a direct connection string here (the Supavisor pooler works) even though
 * the app itself never uses one.
 *
 * Falls back to `TIMELINES_DATABASE_URL`, so a setup that already runs
 * postgres.js needs no second variable.
 */
export function getMigrationSql(): Sql | null {
  if (migrateCached !== undefined) return migrateCached;
  const url = envValue(MIGRATE_URL_VAR) || envValue('TIMELINES_DATABASE_URL');
  migrateCached = url ? postgres(url, { prepare: false }) : null;
  return migrateCached;
}

// ---------------------------------------------------------------------------
// Per-source connections (Phase 4): a timeline id may be served by its own
// Postgres, chosen by the id's namespace (first path segment). `warehouse/plan`
// → env `TIMELINES_DATABASE_URL_WAREHOUSE`; if that var is unset the default
// `TIMELINES_DATABASE_URL` is used. Opt-in and backward compatible: with no
// `TIMELINES_DATABASE_URL_<NAME>` set, every source uses the default exactly as
// before. Connection strings stay in env (never in committed config).
// ---------------------------------------------------------------------------

/** The namespace of a source id (first path segment), or null for a bare id. */
export function sourceNamespace(id: string): string | null {
  const i = id.indexOf('/');
  return i > 0 ? id.slice(0, i) : null;
}

/**
 * Whether a DB timeline id is in scope for a build scoped by
 * `TIMELINES_SOURCES_SUBDIR`. An empty subdir scopes to everything; otherwise the
 * id must sit under that subdir namespace (`<subdir>/…`), mirroring the old
 * `data/<subdir>/` folder scoping. `subdir` is normalised (surrounding slashes
 * stripped) by the caller.
 */
export function timelineInScope(id: string, subdir: string): boolean {
  if (!subdir) return true;
  return id === subdir || id.startsWith(`${subdir}/`);
}

/** The env var a namespace maps to, e.g. `my-warehouse` → `TIMELINES_DATABASE_URL_MY_WAREHOUSE`. */
export function connectionEnvKey(namespace: string): string {
  const suffix = namespace.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `TIMELINES_DATABASE_URL_${suffix}`;
}

// Named pools reused across calls (module-scoped), keyed by env var name.
const namedPools = new Map<string, Sql>();

/**
 * The postgres.js handle for a given source id: its namespace's dedicated
 * connection if `TIMELINES_DATABASE_URL_<NS>` is set, otherwise the default
 * (`getSql()`). Returns null only when no DB is configured at all.
 */
export function getSqlForSource(id: string): Sql | null {
  const ns = sourceNamespace(id);
  if (ns) {
    const key = connectionEnvKey(ns);
    const url = envValue(key);
    if (url) {
      let pool = namedPools.get(key);
      if (!pool) {
        pool = postgres(url, { prepare: false });
        namedPools.set(key, pool);
      }
      return pool;
    }
  }
  return getSql();
}

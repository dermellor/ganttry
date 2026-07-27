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

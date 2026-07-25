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

/** Returns a postgres.js handle, or null if TIMELINES_DATABASE_URL is absent. */
export function getSql(): Sql | null {
  if (cached !== undefined) return cached;
  const url = envValue('TIMELINES_DATABASE_URL');
  cached = url ? postgres(url, { prepare: false }) : null;
  return cached;
}

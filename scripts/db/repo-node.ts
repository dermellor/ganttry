// Node-only repo resolution for CLI tools (import, build-data stub sync,
// backfill helpers). Picks the driver by env — the SAME rule the runtime glue
// uses: a `TIMELINES_DATABASE_URL` selects native postgres.js, otherwise the
// Supabase service client (supabase-js). Returns null when neither is
// configured so callers can print a clear message.
//
// Deliberately NOT importable from the Deno edge functions: it pulls the Node
// connection factories (sql.ts → postgres, client.ts → @supabase/supabase-js +
// ws + node:fs). The edge functions build their own handles from Deno.env.

import { getSql } from './sql.ts';
import { getServiceClient } from './client.ts';
import { makePostgresRepo } from './timeline-repo.ts';
import { makeSupabaseRepo } from './timeline-repo-supabase.ts';
import { envValue } from './env.ts';
import type { TimelineRepo } from './repo.ts';

/** Resolve the storage repo from env, or null if no DB is configured. */
export function resolveRepoFromEnv(): TimelineRepo | null {
  if (envValue('TIMELINES_DATABASE_URL')) {
    const sql = getSql();
    return sql ? makePostgresRepo(sql) : null;
  }
  const db = getServiceClient();
  return db ? makeSupabaseRepo(db) : null;
}

/**
 * Close any pooled postgres.js connection so a one-shot CLI process exits. A
 * no-op on the Supabase path (no persistent handle). Safe to call unconditionally
 * at the end of a script; NEVER call it in a request handler (see sql.ts).
 */
export async function closeRepoFromEnv(): Promise<void> {
  const sql = getSql();
  if (sql) await sql.end();
}

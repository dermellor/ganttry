// Netlify Edge Function — the two PUBLIC, unauthenticated routes.
//
// The file is still called `pricing-api` although it no longer serves a pricing
// endpoint. An edge function's filename is its identity in the host's dashboard
// and its logs, so renaming it is a deployment change rather than a code change
// (AGENTS.md → „Deployment identity"). It can be renamed the day the retired
// route below is deleted, in one commit that touches both.
//
// - GET /api/public/plugin/<pluginId>/<id> → the rows a plugin publishes for one
//   timeline, as public JSON. External pages fetch it at build time.
// - GET /api/pricing/<id> → retired, answers 410 and names its successor. It
//   stays routed so a stale consumer gets that instead of the SPA's HTML.
//
// The auth gate excludes both (see auth.ts excludedPath and scripts/admission.ts),
// so no login and no MCP token is required. What is actually served is decided by
// three gates inside the dispatcher, and every failure is a 404 — the route must
// not become a way to probe which timelines exist.
//
// Driver selection mirrors timelines-api.ts: TIMELINES_DATABASE_URL selects
// postgres.js (opt-in), else TIMELINES_SUPABASE_URL + SERVICE_KEY select
// supabase-js (the Netlify default). Both drivers are imported so the bundle
// carries each.

import type { Context, Config } from '@netlify/edge-functions';
import postgres from 'https://esm.sh/postgres@3.4.9';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0';
import type { DbConnections } from '../../scripts/db/api.ts';
import { handleApiRequest } from '../../scripts/db/http.ts';

// Module-scoped, reused handles (see timelines-api.ts) — opened once per
// isolate, never torn down in a handler.
let sqlHandle: ReturnType<typeof postgres> | null | undefined;
function getSql() {
  if (sqlHandle !== undefined) return sqlHandle;
  const dbUrl = Deno.env.get('TIMELINES_DATABASE_URL');
  sqlHandle = dbUrl ? postgres(dbUrl, { prepare: false }) : null;
  return sqlHandle;
}

let sbHandle: ReturnType<typeof createClient> | null | undefined;
function getSupabase() {
  if (sbHandle !== undefined) return sbHandle;
  const url = Deno.env.get('TIMELINES_SUPABASE_URL');
  const key = Deno.env.get('TIMELINES_SUPABASE_SERVICE_KEY');
  sbHandle = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return sbHandle;
}

const dbConns = (): DbConnections => ({ sql: getSql(), supabase: getSupabase() });

// The routes themselves — status codes, the public cache policy and the CORS
// header — live in the shared HTTP layer, so this function is only the driver
// setup plus a dispatch. No auth: the gate excludes both paths on purpose.
export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  const out = await handleApiRequest(req, { conns: dbConns() });
  return out ?? undefined;
}

export const config: Config = {
  path: ['/api/public/plugin/*', '/api/pricing/*'],
};

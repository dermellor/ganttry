// Netlify Edge Function — timeline API, dual-adapter (Supabase-JS or Postgres).
//
// Handles GET/PUT/PATCH/POST/DELETE on /api/source/<id>[/item|group|phases[/<childId>]]
// and GET /api/sources. Uses the SAME dispatcher as the local Vite middleware
// (scripts/db/api.ts) — one implementation of the storage + optimistic-locking
// semantics across both runtimes.
//
// Driver selection (additive, env-driven): a `TIMELINES_DATABASE_URL` selects a
// direct Postgres connection (postgres.js, opt-in for self-hosters); otherwise
// `TIMELINES_SUPABASE_URL` + `TIMELINES_SUPABASE_SERVICE_KEY` select supabase-js
// over HTTP/PostgREST — the DEFAULT the Netlify deploy runs on (no raw TCP
// needed in the Deno edge). BOTH drivers are imported so the bundle carries
// each; only the resolved one is used. Requests are gated by the signed session
// cookie (per-user, allowed-domain) or the MCP service token; edits are
// attributed to the logged-in user's email via `updated_by`.

import type { Context, Config } from '@netlify/edge-functions';
import postgres from 'https://esm.sh/postgres@3.4.9';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0';
import { readSession, hasValidMcpToken } from './_shared/session.ts';
import { resolveRepo, type DbConnections } from '../../scripts/db/api.ts';
import { handleApiRequest, liveOverride } from '../../scripts/db/http.ts';

// Module-scoped, reused postgres.js connection. Opened once per isolate and
// reused across invocations — NEVER call sql.end() in a handler (it throws a
// benign teardown TypeError in the Deno edge runtime, and tearing the pool down
// per request would defeat pooling). `prepare: false` for Supavisor
// transaction-pooler compatibility (harmless on a direct connection).
let sqlHandle: ReturnType<typeof postgres> | null | undefined;
function getSql() {
  if (sqlHandle !== undefined) return sqlHandle;
  const dbUrl = Deno.env.get('TIMELINES_DATABASE_URL');
  sqlHandle = dbUrl ? postgres(dbUrl, { prepare: false }) : null;
  return sqlHandle;
}

// Module-scoped supabase-js client (the default). Realtime isn't used
// server-side; the Deno global WebSocket satisfies its ctor without `ws`.
let sbHandle: ReturnType<typeof createClient> | null | undefined;
function getSupabase() {
  if (sbHandle !== undefined) return sbHandle;
  const url = Deno.env.get('TIMELINES_SUPABASE_URL');
  const key = Deno.env.get('TIMELINES_SUPABASE_SERVICE_KEY');
  sbHandle = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return sbHandle;
}

// postgres.js wins when present, else supabase-js (see resolveAdapter/resolveRepo).
const dbConns = (): DbConnections => ({ sql: getSql(), supabase: getSupabase() });

function json(data: unknown, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Cache-Control', 'no-store'); // never cache the data API (CDN/browser)
  return new Response(JSON.stringify(data), { status, headers: h });
}

export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  const conns = dbConns();
  // No DB configured → nothing to serve; pass through (the request then 404s,
  // and the client surfaces a loud error — no static content fallback).
  if (!resolveRepo(conns)) return;

  // Auth gate: valid session or MCP service token. This is what stays here —
  // everything after it is the shared HTTP layer, so the routing, locking and
  // error semantics cannot drift from the other two runtimes.
  const mcp = hasValidMcpToken(req);
  const session = mcp ? null : await readSession(req);
  if (!mcp && !session) {
    // When the site isn't gated at all, allow reads; otherwise 401.
    if (Deno.env.get('AUTH_REQUIRED') === 'true') return json({ error: 'unauthorized' }, 401);
  }

  // The user directory (`/api/users`) rides along in this function rather than in
  // its own: it needs exactly this driver setup and this auth gate, and a second
  // edge bundle importing both drivers to serve one read would be a copy of the
  // 40 lines above.
  const out = await handleApiRequest(req, {
    conns,
    updatedBy: mcp ? 'mcp' : session?.email,
    caller: session ? { email: session.email, name: session.name ?? null } : undefined,
    live: liveOverride(Deno.env.get('TIMELINES_DB_LIVE')),
  });
  // null → not one of our routes; fall through to the rest of the stack.
  return out ?? undefined;
}

export const config: Config = {
  path: ['/api/source/*', '/api/sources', '/api/users'],
};

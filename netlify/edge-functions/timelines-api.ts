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
import { resolveAdapter, resolveRepo, parseSourcePath, type DbConnections, type ApiRequest } from '../../scripts/db/api.ts';

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

  const reqUrl = new URL(req.url);
  const isCollection = reqUrl.pathname === '/api/sources';
  const parsed = isCollection ? { id: '' } : parseSourcePath(reqUrl.pathname.replace(/^\/api\/source/, ''));
  if (!parsed) return; // not our route → fall through

  // Auth gate: valid session or MCP service token.
  const mcp = hasValidMcpToken(req);
  const session = mcp ? null : await readSession(req);
  if (!mcp && !session) {
    // When the site isn't gated at all, allow reads; otherwise 401.
    if (Deno.env.get('AUTH_REQUIRED') === 'true') return json({ error: 'unauthorized' }, 401);
  }

  const method = req.method ?? 'GET';
  let body: unknown;
  if (method !== 'GET' && method !== 'DELETE') {
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
  }

  const ifMatchHeader = req.headers.get('if-match');
  const ifMatch = ifMatchHeader ? parseInt(ifMatchHeader, 10) : undefined;

  const apiReq: ApiRequest = {
    method,
    id: parsed.id,
    sub: (parsed as { sub?: ApiRequest['sub'] }).sub,
    body,
    ifMatch: Number.isFinite(ifMatch as number) ? (ifMatch as number) : undefined,
    updatedBy: mcp ? 'mcp' : session?.email,
  };

  try {
    // TIMELINES_DB_LIVE=poll makes DB sources advertise polling instead of
    // Supabase Realtime (for a Postgres without Realtime enabled).
    const live = Deno.env.get('TIMELINES_DB_LIVE') === 'poll' ? 'poll' : 'realtime';
    const adapter = resolveAdapter(conns, apiReq.id, live);
    const result = await adapter.handle(apiReq);
    // Tell the client which live-update impl to use (read by loadSource).
    const headers = new Headers();
    headers.set('X-Source-Live', adapter.capabilities.live);
    // A GET 404 (source not in the DB) surfaces as a loud client error —
    // no static content fallback (see AGENTS.md „keine Notfall-Daten").
    return json(result.json, result.status, headers);
  } catch (err) {
    return json({ error: 'server_error', message: String(err) }, 500);
  }
}

export const config: Config = {
  path: ['/api/source/*', '/api/sources'],
};

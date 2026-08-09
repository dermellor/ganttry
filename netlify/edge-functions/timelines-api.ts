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
import { handlePluginsApi, handlePublicPluginApi } from '../../scripts/db/plugin-api.ts';
import { makeManifestSource } from '../../scripts/db/plugin-manifests.ts';
import { parseOperators } from '../../scripts/db/operator.ts';
import { handleUsersApi, resolveAdapter, resolveRepo, parseSourcePath, parsePublicPluginPath, type DbConnections, type ApiRequest } from '../../scripts/db/api.ts';

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
  const isUsers = reqUrl.pathname === '/api/users';
  // The instance's install registry. A sibling of /api/sources rather than
  // something under a timeline: which plugins this deployment has is not a
  // property of any one of them.
  const isPlugins = reqUrl.pathname === '/api/plugins' || reqUrl.pathname.startsWith('/api/plugins/');
  // Public and unauthenticated. Handled BEFORE the gate below, because it is
  // excluded from the gate anyway (auth.ts) and must answer for a caller with no
  // session at all.
  const publicPlugin = reqUrl.pathname.startsWith('/api/public/plugin/')
    ? parsePublicPluginPath(reqUrl.pathname)
    : null;
  const parsed =
    isCollection || isUsers || isPlugins || publicPlugin
      ? { id: '' }
      : parseSourcePath(reqUrl.pathname.replace(/^\/api\/source/, ''));
  if (!parsed) return; // not our route → fall through

  if (publicPlugin) {
    const repo = resolveRepo(conns);
    if (!repo) return json({ error: 'db_not_configured' }, 503);
    const result = await handlePublicPluginApi(repo, makeManifestSource(repo), {
      method: req.method ?? 'GET',
      pluginId: publicPlugin.pluginId,
      timelineId: publicPlugin.timelineId,
      collection: reqUrl.searchParams.get('collection') ?? undefined,
    });
    const headers = new Headers({
      // The same contract the pricing endpoint has always offered: cacheable and
      // cross-origin, because consumers fetch it at build time from another site.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*',
    });
    return json(result.json, result.status, headers);
  }

  // Auth gate: valid session or MCP service token.
  const mcp = hasValidMcpToken(req);
  const session = mcp ? null : await readSession(req);
  if (!mcp && !session) {
    // When the site isn't gated at all, allow reads; otherwise 401.
    if (Deno.env.get('AUTH_REQUIRED') === 'true') return json({ error: 'unauthorized' }, 401);
  }

  // The user directory (`/api/users`) rides along in this function rather than in
  // its own: it needs exactly this driver setup and this auth gate, and a second
  // edge bundle importing both drivers to serve one read would be a copy of the
  // 40 lines above. Serving it registers the caller — see handleUsersApi.
  if (isUsers) {
    const repo = resolveRepo(conns);
    if (!repo) return json({ users: [] });
    const result = await handleUsersApi(repo, {
      method: req.method ?? 'GET',
      caller: session ? { email: session.email, name: session.name ?? null } : undefined,
    });
    return json(result.json, result.status);
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

  // Reads are open past the gate above; every write is operator-only, which is a
  // different permission from „may edit a timeline" — see scripts/db/operator.ts.
  if (isPlugins) {
    const repo = resolveRepo(conns);
    if (!repo) return json({ plugins: [] });
    const pluginId = reqUrl.pathname.slice('/api/plugins'.length).replace(/^\/+|\/+$/g, '');
    const result = await handlePluginsApi(repo, {
      method,
      pluginId: pluginId ? decodeURIComponent(pluginId) : undefined,
      body,
      params: Object.fromEntries(reqUrl.searchParams),
      caller: { email: session?.email ?? null, mcp },
      operators: parseOperators(Deno.env.get('PLUGIN_OPERATOR_EMAILS')),
    });
    return json(result.json, result.status);
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
  path: ['/api/source/*', '/api/sources', '/api/users', '/api/plugins', '/api/plugins/*', '/api/public/plugin/*'],
};

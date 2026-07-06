// Netlify Edge Function — timeline API backed by Supabase.
//
// Handles GET/PUT/PATCH/POST/DELETE on /api/source/<id>[/item|group|phases[/<childId>]]
// and GET /api/sources. Uses the SAME dispatcher as the local Vite middleware
// (scripts/db/api.ts) — one implementation of the storage + optimistic-locking
// semantics across both runtimes.
//
// Access uses the Supabase service key (server-side). The request is gated by
// the signed session cookie (per-user, Acme-domain) or the MCP service token.
// Edits are attributed to the logged-in user's email via `updated_by`.
//
// Required env vars: TIMELINES_SUPABASE_URL, TIMELINES_SUPABASE_SERVICE_KEY.
// Gating honours AUTH_REQUIRED / MCP_API_TOKEN like the rest of the site.
//
// NOTE: this replaces sheets-api.ts — remove that file before deploying so the
// two functions don't both claim /api/source/*.

import type { Context, Config } from '@netlify/edge-functions';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0';
import { readSession, hasValidMcpToken } from './_shared/session.ts';
import { handleTimelineApi, parseSourcePath, type ApiRequest } from '../../scripts/db/api.ts';

function json(data: unknown, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { status, headers: h });
}

export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  const url = Deno.env.get('TIMELINES_SUPABASE_URL');
  const key = Deno.env.get('TIMELINES_SUPABASE_SERVICE_KEY');
  // No DB configured → fall through to the static /data/sources files (read-only).
  if (!url || !key) return;

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

  const db = createClient(url, key, { auth: { persistSession: false } });
  try {
    const result = await handleTimelineApi(db, apiReq);
    // On GET 404 the client falls back to the static /data/sources file.
    return json(result.json, result.status);
  } catch (err) {
    return json({ error: 'server_error', message: String(err) }, 500);
  }
}

export const config: Config = {
  path: ['/api/source/*', '/api/sources'],
};

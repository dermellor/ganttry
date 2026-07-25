// Netlify Edge Function — PUBLIC pricing endpoint.
//
// GET /api/pricing/<id> → the pricing model (name, tiers, features, highlights,
// versions) of a product timeline as public JSON. This is the single source of
// truth consumed by external marketing pages (e.g. the Astro pricing page),
// which fetch it at build time. Deliberately public and cacheable: it exposes
// only the pricing model, never roadmap items or status.
//
// The auth gate excludes /api/pricing/* (see auth.ts excludedPath), so no login
// or MCP token is required.
//
// Driver selection mirrors timelines-api.ts: TIMELINES_DATABASE_URL selects
// postgres.js (opt-in), else TIMELINES_SUPABASE_URL + SERVICE_KEY select
// supabase-js (the Netlify default). Both drivers are imported so the bundle
// carries each; the resolved repo serves getPublicPricing.

import type { Context, Config } from '@netlify/edge-functions';
import postgres from 'https://esm.sh/postgres@3.4.9';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0';
import { resolveRepo, type DbConnections } from '../../scripts/db/api.ts';

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Public + cacheable: fine to serve stale briefly; consumers fetch at build.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const repo = resolveRepo(dbConns());
  if (!repo) return json({ error: 'db_not_configured' }, 503);

  // Path: /api/pricing/<id> — id may contain slashes (e.g. "acme/foo").
  const id = new URL(req.url).pathname.replace(/^\/api\/pricing\//, '').replace(/\/+$/, '');
  if (!id) return json({ error: 'id required' }, 400);

  try {
    const pricing = await repo.getPublicPricing(decodeURIComponent(id));
    return pricing ? json(pricing) : json({ error: 'not found' }, 404);
  } catch (err) {
    return json({ error: 'server_error', message: String(err) }, 500);
  }
}

export const config: Config = {
  path: '/api/pricing/*',
};

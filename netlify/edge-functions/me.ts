// Netlify Edge Function — current-user probe for the header presence badge and
// for what the interface may offer.
//
// Returns the signed-in user's identity so the client can label its own avatar
// and track itself in the Supabase presence channel (see src/presence.ts /
// src/realtime.ts). The session cookie is HttpOnly, so this is the only way the
// browser learns who it is.
//
// It also reports `role` and `status` while access control is on, so the
// interface can hide what the caller cannot do. That is a hint and never the
// enforcement: every route checks for itself (scripts/db/http.ts), because a
// client-side check protects nothing.
//
// The role is NOT carried in the session cookie. That cookie lives 30 days with
// sliding renewal, so a suspension would sit stale in it for weeks; reading the
// row costs one lookup on a request the client makes once per load.
//
// Runs after the auth gate (netlify.toml order): when AUTH_REQUIRED=true the
// request only reaches here with a valid session. When the gate is off there is
// no session — we return { email: null } and the client shows no badge.

import type { Context, Config } from '@netlify/edge-functions';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0';
import { accessControlEnabled } from '../../src/access.ts';
import { getMember } from '../../scripts/db/timeline-repo-supabase.ts';
import { readSession } from './_shared/session.ts';

export default async function handler(req: Request, _ctx: Context): Promise<Response> {
  const session = await readSession(req);
  const body: Record<string, unknown> = session
    ? { email: session.email, name: session.name ?? null }
    : { email: null };

  if (session && accessControlEnabled(Deno.env.get('TIMELINES_ACCESS_CONTROL'))) {
    const url = Deno.env.get('TIMELINES_SUPABASE_URL');
    const key = Deno.env.get('TIMELINES_SUPABASE_SERVICE_KEY');
    if (url && key) {
      const db = createClient(url, key, { auth: { persistSession: false } });
      // A failure here must not cost the caller their identity: the badge and
      // the presence channel matter more than the affordance hints, and the
      // routes refuse on their own regardless of what this answers.
      try {
        const member = await getMember(db, session.email);
        if (member) {
          body.role = member.role;
          body.status = member.status;
        }
      } catch {
        // leave role/status absent — the interface then offers its safe subset
      }
    }
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const config: Config = {
  path: '/api/me',
};

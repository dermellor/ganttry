// Netlify Edge Function — current-user probe for the header presence badge.
//
// Returns the signed-in user's identity ({ email, name }) so the client can
// label its own avatar and track itself in the Supabase presence channel
// (see src/presence.ts / src/realtime.ts). The session cookie is HttpOnly, so
// this is the only way the browser learns who it is.
//
// Runs after the auth gate (netlify.toml order): when AUTH_REQUIRED=true the
// request only reaches here with a valid session. When the gate is off there
// is no session — we return { email: null } and the client shows no badge.

import type { Context, Config } from '@netlify/edge-functions';
import { readSession } from './_shared/session.ts';

export default async function handler(req: Request, _ctx: Context): Promise<Response> {
  const session = await readSession(req);
  return new Response(
    JSON.stringify(
      session ? { email: session.email, name: session.name ?? null } : { email: null },
    ),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}

export const config: Config = {
  path: '/api/me',
};

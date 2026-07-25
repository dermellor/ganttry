// Node-side Supabase client factory. Reads credentials from the shared cascade
// (process.env → ~/_AGENTS/.env → <repo>/.env.local) via ./env.ts, the same
// source ./sql.ts uses for the postgres.js connection string. The edge function
// builds its own client from Deno.env instead.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { envValue } from './env.ts';

let cached: SupabaseClient | null | undefined;

/** Returns a service-role client, or null if credentials are absent. */
export function getServiceClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = envValue('TIMELINES_SUPABASE_URL');
  const key = envValue('TIMELINES_SUPABASE_SERVICE_KEY');
  // supabase-js constructs a realtime client that needs a WebSocket ctor; provide
  // `ws` so it works in Node runtimes without a global WebSocket (e.g. Netlify
  // Functions). Realtime isn't used server-side, but the ctor is required.
  cached =
    url && key
      ? createClient(url, key, {
          auth: { persistSession: false },
          realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
        })
      : null;
  return cached;
}

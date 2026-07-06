// Node-side Supabase client factory. Reads credentials from the same cascade
// the rest of the project uses: process.env → ~/_AGENTS/.env → <repo>/.env.local.
// The edge function builds its own client from Deno.env instead.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import WebSocket from 'ws';

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
  } catch {
    /* file may not exist — fine */
  }
  return out;
}

let cached: SupabaseClient | null | undefined;

/** Returns a service-role client, or null if credentials are absent. */
export function getServiceClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const fromFiles = {
    ...parseEnvFile(resolve(homedir(), '_AGENTS/.env')),
    ...parseEnvFile(resolve(process.cwd(), '.env.local')),
  };
  const pick = (k: string) => process.env[k] ?? fromFiles[k] ?? '';
  const url = pick('TIMELINES_SUPABASE_URL');
  const key = pick('TIMELINES_SUPABASE_SERVICE_KEY');
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

// Shared Node-side credential cascade: process.env → ~/_AGENTS/.env →
// <repo>/.env.local. Extracted so both the Supabase client (client.ts) and the
// postgres.js factory (sql.ts) read credentials the same way. The edge function
// uses Deno.env instead.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

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

let fileCache: Record<string, string> | undefined;
function fromFiles(): Record<string, string> {
  if (!fileCache) {
    fileCache = {
      ...parseEnvFile(resolve(homedir(), '_AGENTS/.env')),
      ...parseEnvFile(resolve(process.cwd(), '.env.local')),
    };
  }
  return fileCache;
}

/** Resolve a credential from the cascade, or '' if absent. */
export function envValue(key: string): string {
  return process.env[key] ?? fromFiles()[key] ?? '';
}

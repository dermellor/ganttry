// Shared Node-side credential cascade: process.env → <repo>/.env.local →
// files named by TIMELINES_ENV_FILE. The single implementation for every Node
// entry point (Supabase client, postgres.js factory, Vite dev middleware, MCP
// server, pricing export) — each used to carry its own copy of this parser.
// The edge functions use Deno.env instead.
//
// TIMELINES_ENV_FILE is the opt-in seam for credentials kept outside the repo
// (e.g. a shared file holding cross-project keys). It takes one or more paths
// separated by ':', each optionally starting with '~/'. Missing files are
// ignored, so setting it is always safe. Nothing outside the repo is read
// unless it is set: a checkout starts from process.env and .env.local alone.
//
// Precedence: process.env wins over .env.local, which wins over the
// TIMELINES_ENV_FILE files (later paths in the list override earlier ones).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Env var naming the extra credential files to read. */
export const ENV_FILE_VAR = 'TIMELINES_ENV_FILE';

// Resolved from this module's own location rather than process.cwd(): the MCP
// server is registered user-global and runs from arbitrary directories.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal .env parser. Absent or unreadable files yield {}. */
export function parseEnvFile(path: string): Record<string, string> {
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

/**
 * Split a TIMELINES_ENV_FILE spec into absolute paths. Pure, so the parsing
 * rules (':' separator, '~/' expansion, blank entries) are unit-testable
 * without touching the filesystem.
 */
export function envFilePaths(spec: string, home: string = homedir()): string[] {
  return spec
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p === '~' ? home : p.startsWith('~/') ? resolve(home, p.slice(2)) : resolve(p)));
}

let fileCache: Record<string, string> | undefined;
function fromFiles(): Record<string, string> {
  if (!fileCache) {
    const local = parseEnvFile(resolve(REPO_ROOT, '.env.local'));
    // The spec itself may come from .env.local, so a checkout needs no shell
    // export to point at an external credential file.
    const spec = process.env[ENV_FILE_VAR] ?? local[ENV_FILE_VAR] ?? '';
    const extra: Record<string, string> = {};
    for (const path of envFilePaths(spec)) Object.assign(extra, parseEnvFile(path));
    fileCache = { ...extra, ...local };
  }
  return fileCache;
}

/** Resolve a credential from the cascade, or '' if absent. */
export function envValue(key: string): string {
  return process.env[key] ?? fromFiles()[key] ?? '';
}

/** Human-readable list of the places a credential can be set, for error messages. */
export function envSourcesHint(): string {
  const spec = process.env[ENV_FILE_VAR] ?? parseEnvFile(resolve(REPO_ROOT, '.env.local'))[ENV_FILE_VAR] ?? '';
  return spec ? `.env.local, ${spec}, or the environment` : `.env.local or the environment`;
}

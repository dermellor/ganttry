// Shared Node-side credential cascade: process.env → <repo>/.env.local → the
// named instance profile → files named by TIMELINES_ENV_FILE. The single
// implementation for every Node entry point (Supabase client, postgres.js
// factory, Vite dev middleware, build-data, MCP server, pricing export) — each
// used to carry its own copy of this parser. The edge functions use Deno.env.
//
// TIMELINES_INSTANCE names a deployment this checkout can be pointed at (a
// production site, a staging site, a throwaway test DB). It resolves to
// ~/.config/zeitlines/instances/<name>.env — outside the repo, so instance
// identity never becomes a tracked file and switching instances is one line in
// .env.local rather than a rewrite of it. TIMELINES_INSTANCE_DIR moves that
// directory. Unset = no profile, which is what a fresh checkout does.
//
// TIMELINES_ENV_FILE is the older seam for credentials kept outside the repo
// (e.g. a shared file holding keys used by several projects). It takes one or
// more paths separated by ':', each optionally starting with '~/'. Missing
// files are ignored, so setting either var is always safe. Nothing outside the
// repo is read unless one of them is set.
//
// Precedence: process.env > .env.local > instance profile > TIMELINES_ENV_FILE
// files (later paths in that list override earlier ones). The instance profile
// outranks the shared files because it is the more specific statement.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Env var naming the extra credential files to read. */
export const ENV_FILE_VAR = 'TIMELINES_ENV_FILE';

/** Env var naming the instance profile to load. */
export const INSTANCE_VAR = 'TIMELINES_INSTANCE';

/** Env var overriding the directory instance profiles are looked up in. */
export const INSTANCE_DIR_VAR = 'TIMELINES_INSTANCE_DIR';

/** Where instance profiles live unless INSTANCE_DIR_VAR says otherwise. */
export const DEFAULT_INSTANCE_DIR = '~/.config/zeitlines/instances';

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

/**
 * Instance names address a file, so they are restricted to a single path
 * segment of safe characters. A stray value can then only miss, never escape
 * the profile directory.
 */
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Absolute path of an instance profile, or null when no valid name is given.
 * Pure, so the naming rules are unit-testable without touching the filesystem.
 */
export function instanceFilePath(
  name: string,
  dir: string = DEFAULT_INSTANCE_DIR,
  home: string = homedir(),
): string | null {
  const clean = name.trim();
  if (!INSTANCE_NAME.test(clean)) return null;
  const [base] = envFilePaths(dir.trim() || DEFAULT_INSTANCE_DIR, home);
  return base ? resolve(base, `${clean}.env`) : null;
}

/** The instance profile this checkout resolves to, or null if none is named. */
function instancePath(local: Record<string, string>): string | null {
  const name = process.env[INSTANCE_VAR] ?? local[INSTANCE_VAR] ?? '';
  if (!name.trim()) return null;
  const dir = process.env[INSTANCE_DIR_VAR] ?? local[INSTANCE_DIR_VAR] ?? DEFAULT_INSTANCE_DIR;
  return instanceFilePath(name, dir);
}

let fileCache: Record<string, string> | undefined;
function fromFiles(): Record<string, string> {
  if (!fileCache) {
    const local = parseEnvFile(resolve(REPO_ROOT, '.env.local'));
    // Both specs may come from .env.local, so a checkout needs no shell export
    // to point at an external credential file or an instance profile.
    const spec = process.env[ENV_FILE_VAR] ?? local[ENV_FILE_VAR] ?? '';
    const extra: Record<string, string> = {};
    for (const path of envFilePaths(spec)) Object.assign(extra, parseEnvFile(path));
    const profile = instancePath(local);
    const instance = profile ? parseEnvFile(profile) : {};
    fileCache = { ...extra, ...instance, ...local };
  }
  return fileCache;
}

/** Resolve a credential from the cascade, or '' if absent. */
export function envValue(key: string): string {
  return process.env[key] ?? fromFiles()[key] ?? '';
}

/**
 * Copy every resolved value into process.env without overwriting what is
 * already there, so consumers that cannot call envValue() still see the
 * instance profile: Vite's own `loadEnv` (which fills `import.meta.env` from
 * prefixed process.env keys and from repo-local .env files only) and any child
 * process this one spawns. Idempotent.
 */
export function hydrateProcessEnv(): void {
  for (const [key, value] of Object.entries(fromFiles())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Human-readable list of the places a credential can be set, for error messages. */
export function envSourcesHint(): string {
  const local = parseEnvFile(resolve(REPO_ROOT, '.env.local'));
  const spec = process.env[ENV_FILE_VAR] ?? local[ENV_FILE_VAR] ?? '';
  const places = ['.env.local', instancePath(local), spec, 'the environment'].filter(
    (p): p is string => Boolean(p),
  );
  return `${places.slice(0, -1).join(', ')} or ${places[places.length - 1]}`;
}

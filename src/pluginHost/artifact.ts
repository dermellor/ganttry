// Where a plugin's code comes from, and the check that it is the code we agreed
// to run.
//
// Pure and network-free on purpose: deciding whether an artifact is fetchable, and
// deciding whether the bytes match their hash, are the two parts of loading that
// have to be right and are the two that a fetch in the middle would make untestable.
// The loader does the fetching and asks these.

import type { PluginStatus } from '../types';

/** What the loader should do with an artifact, decided before any request. */
export type ArtifactPlan =
  | { action: 'builtin' }
  | { action: 'fetch'; url: string; integrity?: string }
  | { action: 'refuse'; problem: string };

/**
 * Decide how (and whether) to obtain a plugin's code.
 *
 * `builtin` is not a fetch: the module is already in the bundle, registered by its
 * static import. Nothing to download, nothing to verify, and pretending otherwise
 * would mean inventing a URL for code that has none.
 *
 * `package` is refused with a reason rather than attempted. A browser cannot
 * resolve an npm specifier — there is no registry lookup, no version solving and
 * no `node_modules` — so the operator either vendors the package into the deploy
 * or serves it at a URL. Failing here with that sentence is more useful than a
 * network error about a path that was never going to resolve.
 */
export function planFor(status: Pick<PluginStatus, 'id' | 'artifact'>): ArtifactPlan {
  const { kind, source, integrity } = status.artifact;
  if (kind === 'builtin') return { action: 'builtin' };
  if (kind === 'package') {
    return {
      action: 'refuse',
      problem:
        'installed as an npm package, which a browser cannot resolve; vendor it into the deploy or serve it at a URL',
    };
  }
  if (!source) return { action: 'refuse', problem: `artifact kind "${kind}" carries no source` };
  // A remote artifact without a hash is refused at INSTALL (#13). Re-checked here
  // because the registry is a table an operator can also write to by hand, and a
  // row that skipped the API must not skip the guarantee with it.
  if (kind === 'url' && !integrity) {
    return { action: 'refuse', problem: 'a remote artifact without an integrity hash is not pinned to any version' };
  }
  return integrity ? { action: 'fetch', url: source, integrity } : { action: 'fetch', url: source };
}

export type Integrity = { algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512'; expected: string };

/**
 * Parse a subresource-integrity string (`sha384-<base64>`).
 *
 * The same spelling `<script integrity>` uses, so an operator can copy the value
 * from wherever their build produced it instead of learning a second format.
 */
export function parseIntegrity(value: string): Integrity | null {
  const m = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
  if (!m) return null;
  return { algorithm: `SHA-${m[1]}` as Integrity['algorithm'], expected: m[2] };
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  // btoa exists in browsers and in Node 16+, so this needs no per-runtime branch.
  return btoa(binary);
}

/**
 * Does `bytes` hash to what the registry pinned?
 *
 * A mismatch means the artifact changed under a version that was supposed to be
 * fixed, which is the realistic attack on a plugin somebody already trusted: not
 * a hostile plugin at install time, but a benign one replaced afterwards. So it
 * is a refusal, never a warning.
 *
 * An unparseable integrity string is also a refusal. Treating it as „no hash
 * given" would turn a typo into a silently unverified load, which is the exact
 * outcome the field exists to prevent.
 */
export async function verifyIntegrity(bytes: ArrayBuffer, value: string): Promise<{ ok: boolean; problem?: string }> {
  const parsed = parseIntegrity(value);
  if (!parsed) {
    return { ok: false, problem: `integrity "${value}" is not a recognised hash (expected e.g. "sha384-…")` };
  }
  const digest = await crypto.subtle.digest(parsed.algorithm, bytes);
  const actual = toBase64(digest);
  if (actual !== parsed.expected) {
    return {
      ok: false,
      problem: `the artifact does not match its pinned hash (expected ${parsed.algorithm.toLowerCase().replace('-', '')}-${parsed.expected}, got ${parsed.algorithm.toLowerCase().replace('-', '')}-${actual})`,
    };
  }
  return { ok: true };
}

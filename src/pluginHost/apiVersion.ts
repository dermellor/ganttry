// The host contract's version, and how a plugin says which one it was built for.
//
// A plugin is installed as an artifact and is not rebuilt when the host changes,
// so "does this still fit?" has to be answerable before the plugin runs. Refusing
// to load with a readable reason beats failing halfway through a render, which is
// what an unversioned contract produces the first time a field is removed.

/**
 * The contract version this host implements.
 *
 * `major` changes on a breaking change (something removed or its meaning
 * changed), `minor` on a purely additive one. A plugin built against 1.0 keeps
 * working on 1.7; one built against 1.7 does not run on 1.0, because it may use
 * something that did not exist yet.
 */
// 1.1 added `ManifestView.accessories`, which is why it is a minor: the boolean
// it replaces (`toolbar`) is still read, so a plugin built against 1.0 keeps
// running. Removing that reading is what would make it a major.
//
// 1.2 added the `create` and `export` accessories, when those two actions moved
// into the presentation's own bar and a view therefore had to be able to say
// whether they apply to it. Additive as well: an existing declaration simply does
// not claim them.
//
// 1.3 added `manifest.tools` plus the `tools` capability. Purely additive: a plugin
// declaring neither is unaffected. A plugin whose verbs are the point of it should
// say `^1.3`, or an older host loads it and lists them nowhere.
export const HOST_API_VERSION = { major: 1, minor: 3 } as const;

export type ApiVersion = { major: number; minor: number };

/**
 * Parse a plugin's declared range. Two forms, deliberately not the whole semver
 * grammar: `^1` ("any 1.x") and `^1.2` ("1.x from 1.2 on"). A dependency-free
 * subset keeps this module importable by a plugin author without pulling a semver
 * package into the contract.
 */
export function parseApiRange(range: string): { major: number; minMinor: number } | null {
  const m = /^\^(\d+)(?:\.(\d+))?$/.exec(range.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minMinor = m[2] == null ? 0 : Number(m[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minMinor)) return null;
  return { major, minMinor };
}

/** Does the host satisfy a plugin's declared range? */
export function satisfiesApiVersion(range: string, host: ApiVersion = HOST_API_VERSION): boolean {
  const parsed = parseApiRange(range);
  if (!parsed) return false;
  return parsed.major === host.major && parsed.minMinor <= host.minor;
}

/**
 * Why a plugin was refused, phrased for the person who installed it rather than
 * for whoever wrote the loader. An unreadable version error is indistinguishable
 * from a broken plugin, and gets reported as one.
 */
export function apiVersionMismatch(
  range: string,
  host: ApiVersion = HOST_API_VERSION,
): string | null {
  if (satisfiesApiVersion(range, host)) return null;
  const hostStr = `${host.major}.${host.minor}`;
  const parsed = parseApiRange(range);
  if (!parsed) return `apiVersion "${range}" is not a supported range (use "^1" or "^1.2")`;
  if (parsed.major > host.major) {
    return `needs plugin API ${range}, this host provides ${hostStr} — update the host`;
  }
  if (parsed.major < host.major) {
    return `built for plugin API ${range}, this host provides ${hostStr} — update the plugin`;
  }
  return `needs plugin API ${range}, this host provides ${hostStr} — update the host`;
}

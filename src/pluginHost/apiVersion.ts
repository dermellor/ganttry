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
// not claim them. `export` has since gone inert — the HTML export belongs to the
// timeline and lives in its settings — and that is not a major: the key is still
// accepted, so no plugin fails to load over it. It stops steering a control that
// no presentation offers any more, for anybody.
//
// 1.3 added `manifest.tools` plus the `tools` capability. Purely additive: a plugin
// declaring neither is unaffected. A plugin whose verbs are the point of it should
// say `^1.3`, or an older host loads it and lists them nowhere.
// 1.4 added `DataApi.patch`, `panel`, `status` and `canWrite`. Additive, and every
// one of them exists because the in-tree plugin could not be moved onto the public
// contract without it (#117) — which is the evidence a contract addition should
// have, rather than someone deciding a method sounded useful.
// 1.5 added derived field values: `CustomFieldDef.derived` plus
// `PluginDescriptor.derive` (src/pluginHost/derived.ts). Additive — a plugin that
// declares neither keeps working, and a host on 1.4 simply never asks. A plugin
// whose field only makes sense computed should say `^1.5`, because on an older host
// the field appears as an editable one with nothing filling it, which reads as the
// plugin being broken rather than as a version mismatch.
// 1.6 exported the core's calendar-day and duration arithmetic through the contract
// barrel (`durationToMs`, `endFromDuration`, `parseLocalDay`, `shiftDays`,
// `isoDateOnly`). Additive, and the evidence is a bug rather than a preference: the
// first date-shaped plugin had to restate the rules, and its reconstruction of a
// burndown burned every `duration`-only item on the day it started, because resolving
// an item's real end was the one piece the contract did not carry.
// 1.7 added `pluginMessages`, plus the host's locale-aware `formatDay`,
// `formatNumber` and `compare`, when the interface language became a per-person
// setting (#153). Additive: a plugin that declares neither keeps running and
// keeps showing the one language it was written in, which is the behaviour every
// plugin had before this existed. A plugin whose text should follow the reader
// says `^1.7`, because on an older host `pluginMessages` is not there to import.
// 1.8 added the `edges` accessory, when the relations control stopped being handed
// to every built-in presentation: it steers `build.dependencies`, which the list
// never reads, so there the panel was a control whose every move left the screen
// as it was. Additive — an existing declaration does not claim it — but a plugin
// view that draws those edges has to say `^1.8`, because on an older host `edges`
// is an unknown accessory and the whole manifest is refused rather than the key
// ignored.
export const HOST_API_VERSION = { major: 1, minor: 8 } as const;

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

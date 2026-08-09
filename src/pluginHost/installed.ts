// What the host currently thinks of an installed plugin.
//
// One pure function, because three places need the same verdict and must not
// disagree: the loader deciding whether to run the code, the interface explaining
// why a plugin is not there, and the write path deciding whether to accept a
// change. Three copies of „is this plugin usable" is how a plugin ends up
// invisible in the interface while its writes still succeed.
//
// The split that matters: an incompatible CONTRACT stops the code, not the data.
// A host that outgrew a plugin cannot run its views safely, but the rows it
// already stored have not changed shape, and the collections its manifest
// declares are still the right thing to validate them against. Refusing the data
// rules too would mean a host upgrade silently turned a plugin's storage into
// something nothing checks.

import { apiVersionMismatch, type ApiVersion } from './apiVersion.ts';
import { validateManifest, type PluginManifest } from './manifest.ts';
import type { InstalledPlugin, PluginStatus } from '../types';

/**
 * Decide whether a plugin's code may run, and say why not in one sentence.
 *
 * Three reasons a plugin is not loadable, in the order an operator would ask
 * about them:
 *
 *   1. It was switched off instance-wide. Nothing is wrong with it.
 *   2. The host does not satisfy the contract range it was built against.
 *   3. Its stored manifest does not validate — possible after a host upgrade
 *      tightened the rules, and the reason it is checked here rather than trusted
 *      because it was checked at install time.
 */
export function pluginStatus(plugin: InstalledPlugin, host?: ApiVersion): PluginStatus {
  const base = { ...plugin, loadable: false };

  if (plugin.enabled === false) {
    return { ...base, reason: 'disabled', problem: 'switched off for this instance' };
  }
  const mismatch = apiVersionMismatch(plugin.apiVersion, host);
  if (mismatch) return { ...base, reason: 'api-version', problem: mismatch };

  // An empty manifest is not a failure: it is what the registry holds for a
  // plugin whose manifest comes from the build (see `manifestOf`). Validating
  // `{}` would report every built-in plugin as broken.
  if (Object.keys(plugin.manifest ?? {}).length) {
    const result = validateManifest(plugin.manifest, host);
    if (!result.ok) {
      return {
        ...base,
        reason: 'invalid-manifest',
        problem: `its manifest is no longer valid: ${result.problems.join('; ')}`,
      };
    }
  }
  return { ...plugin, loadable: true };
}

/** One line of the plugin list: what it is, and where it stands right now. */
export type PluginLine = {
  id: string;
  /** The display name from the manifest, falling back to the id. */
  name: string;
  version: string;
  /** Is it switched on for the timeline currently open? */
  enabledHere: boolean;
  loadable: boolean;
  reason?: PluginStatus['reason'];
  problem?: string;
};

/**
 * The installed plugins as the interface lists them, for one open timeline.
 *
 * Pure, so what the panel says is testable without a DOM — and so the two facts
 * it joins („the instance has it" and „this timeline uses it") are combined in
 * exactly one place. Sorted by name rather than by id, because that is the column
 * a reader scans.
 */
export function pluginLines(
  installed: PluginStatus[],
  enabledIds: readonly string[],
): PluginLine[] {
  return installed
    .map((plugin) => {
      const name = typeof plugin.manifest?.name === 'string' && plugin.manifest.name.trim()
        ? (plugin.manifest.name as string)
        : plugin.id;
      const line: PluginLine = {
        id: plugin.id,
        name,
        version: plugin.version,
        enabledHere: enabledIds.includes(plugin.id),
        loadable: plugin.loadable,
      };
      if (plugin.reason) line.reason = plugin.reason;
      if (plugin.problem) line.problem = plugin.problem;
      return line;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The manifest to hold a plugin to, or null when the registry carries none.
 *
 * Null is the „ask the build" case, not an error: the migration that introduced
 * the registry seeded a row per plugin already in use without inventing a
 * manifest in SQL, and a plugin that ships inside the build has its manifest
 * there rather than in a column. The caller resolves that fallback, because only
 * it knows what the build shipped.
 */
export function manifestOf(plugin: InstalledPlugin): PluginManifest | null {
  if (!Object.keys(plugin.manifest ?? {}).length) return null;
  const result = validateManifest(plugin.manifest);
  return result.ok ? result.manifest : null;
}

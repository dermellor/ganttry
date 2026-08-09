// Which plugins this instance has installed, and what each one declared.
//
// The write path enforces a plugin's declarations against its manifest, so it has
// to be able to find one — without running any plugin code, which is why the
// manifest is static data.
//
// Two sources, in this order:
//
//   1. **The install registry** (`installed_plugins`, migration 0017). Authoritative
//      once it holds anything at all.
//   2. **What the build shipped.** The fallback, and the only source on an instance
//      with no registry: a filesystem-only deploy has nowhere to record an install
//      and no loader to act on one, so „the plugins in this build" is the truthful
//      installed set there.
//
// The switch between them is deliberately „is the registry empty", not „does the
// registry know this id". Per-id fallback would make uninstalling a built-in
// plugin impossible — it would reappear the moment its row was gone. Migration
// 0017 seeds a row for every plugin already in use, so an existing deployment
// never sits in the ambiguous state where the rule matters.

import type { InstalledPlugin, PluginStatus } from '../../src/types';
import type { PluginManifest } from '../../src/pluginHost/manifest';
import { manifestOf, pluginStatus } from '../../src/pluginHost/installed.ts';
import { productRoadmapManifest } from '../../src/plugins/product-roadmap/manifest.ts';
import type { TimelineRepo } from './repo.ts';

/** The manifests compiled into this build. */
const BUILT_IN: PluginManifest[] = [productRoadmapManifest];

/** Every manifest the build ships, whatever the registry says. */
export function builtInManifests(): PluginManifest[] {
  return BUILT_IN;
}

/** The build's manifest for one plugin id, or null when it ships no such plugin. */
export function builtInManifest(pluginId: string): PluginManifest | null {
  return BUILT_IN.find((m) => m.id === pluginId) ?? null;
}

/**
 * What a plugin is, and whether it is switched on — the two facts the write path
 * needs. `enabled` is the INSTANCE-level switch, not „enabled on this timeline".
 */
export type InstalledRecord = { manifest: PluginManifest; enabled: boolean };

/** How the dispatcher asks about a plugin. Null = this instance has no such plugin. */
export type ManifestSource = (pluginId: string) => Promise<InstalledRecord | null>;

/**
 * A lookup over one repo, reading the registry once per instance of it.
 *
 * The cache is per call of this factory — the dispatcher builds one per request —
 * so a request sees a consistent registry without a second read per collection,
 * and the next request sees any change.
 */
export function makeManifestSource(repo: TimelineRepo): ManifestSource {
  let registry: InstalledPlugin[] | null = null;
  return async (pluginId) => {
    if (registry == null) {
      try {
        registry = await repo.listInstalledPlugins();
      } catch {
        // A repo that cannot answer (no such table yet, mid-migration) must not
        // take the data routes down with it. Falling back to the build is the same
        // answer an instance without a registry gets.
        registry = [];
      }
    }
    if (registry.length === 0) {
      const built = builtInManifest(pluginId);
      return built ? { manifest: built, enabled: true } : null;
    }
    const row = registry.find((p) => p.id === pluginId);
    if (!row) return null;
    // A manifest the registry does not carry comes from the build — that is the
    // seeded row, and the built-in case. Falling through to null instead would
    // make every seeded plugin's data unwritable after the migration.
    const manifest = manifestOf(row) ?? builtInManifest(pluginId);
    if (!manifest) return null;
    return { manifest, enabled: row.enabled !== false };
  };
}

/**
 * The registry as the interface and the loader read it: every installed plugin
 * with the host's verdict on it, plus the built-ins on an instance with no
 * registry so „nothing installed" is never shown to a deploy that is running one.
 */
export async function installedPluginStatuses(repo: TimelineRepo): Promise<PluginStatus[]> {
  let registry: InstalledPlugin[] = [];
  try {
    registry = await repo.listInstalledPlugins();
  } catch {
    registry = [];
  }
  if (registry.length === 0) {
    return BUILT_IN.map((manifest) =>
      pluginStatus({
        id: manifest.id,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        artifact: { kind: 'builtin' },
        capabilities: [...(manifest.capabilities ?? [])],
        manifest: manifest as unknown as Record<string, unknown>,
        enabled: true,
      }),
    );
  }
  return registry.map((row) => {
    // Show the build's manifest for a row that carries none, so the interface
    // lists a real name and version instead of a bare id.
    const manifest = manifestOf(row) ?? builtInManifest(row.id);
    const merged: InstalledPlugin = manifest
      ? {
          ...row,
          version: row.version === '0.0.0' ? manifest.version : row.version,
          manifest: manifest as unknown as Record<string, unknown>,
        }
      : row;
    return pluginStatus(merged);
  });
}

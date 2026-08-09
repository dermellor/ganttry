// How a plugin's enablement and config are read off a TimelineFile.
//
// A plugin is enabled on a timeline purely by data (a `timeline_plugins` row);
// this module keeps that check in a single spot so client (registry, custom
// fields) and server (both drivers, export) agree.
//
// Deliberately free of plugin ids: a helper here that named one plugin would be
// the thing every *other* plugin has to work around. A plugin's own facts live
// in its folder (see `src/plugins/product-roadmap/plugin.ts`).

import type { PluginRef, TimelineFile } from '../types';

/** Is the given plugin enabled on this timeline? */
export function hasPlugin(file: TimelineFile | null | undefined, pluginId: string): boolean {
  return !!file?.plugins?.some((p) => p.id === pluginId);
}

/** The plugin's opaque config bag, or undefined when the plugin isn't enabled. */
export function pluginConfig(
  file: TimelineFile | null | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  return file?.plugins?.find((p) => p.id === pluginId)?.config;
}

/**
 * The plugin registrations a whole-timeline write should persist.
 *
 * Carries one rule: **a plugin with rows is a plugin that is enabled.** A bulk
 * write that brought a plugin's data but not its registration would store rows
 * nothing reads, and the timeline would look empty while the data sat there.
 *
 * Generic on purpose. This used to be `resolveWritePlugins` inside
 * product-roadmap, keyed on `file.pricing`, and imported by BOTH database
 * drivers — which is a core file importing from a plugin folder, the coupling
 * issue #17 removes. The rule was never plugin-specific; only its old trigger was.
 */
export function pluginsForWrite(file: TimelineFile): PluginRef[] {
  const plugins: PluginRef[] = (file.plugins ?? []).map((p) => ({
    id: p.id,
    config: p.config ? { ...p.config } : {},
    ...(p.public ? { public: true } : {}),
  }));
  for (const pluginId of Object.keys(file.pluginData ?? {})) {
    if (!plugins.some((p) => p.id === pluginId)) plugins.push({ id: pluginId, config: {} });
  }
  return plugins;
}

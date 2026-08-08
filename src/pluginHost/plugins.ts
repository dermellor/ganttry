// How a plugin's enablement and config are read off a TimelineFile.
//
// A plugin is enabled on a timeline purely by data (a `timeline_plugins` row);
// this module keeps that check in a single spot so client (registry, custom
// fields) and server (both drivers, export) agree.
//
// Deliberately free of plugin ids: a helper here that named one plugin would be
// the thing every *other* plugin has to work around. A plugin's own facts live
// in its folder (see `src/plugins/product-roadmap/plugin.ts`).

import type { TimelineFile } from '../types';

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

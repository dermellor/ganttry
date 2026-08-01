// Timeline plugin helpers — the one place that knows plugin ids and how their
// enablement/config is read off a TimelineFile. A plugin is enabled on a
// timeline purely by data (a `timeline_plugins` row); this module keeps that
// check in a single spot so client (kind registry, custom fields) and server
// (both drivers, export) agree and no `type === 'product'` literal is duplicated.

import type { PluginRef, TimelineFile } from './types';

/** Stable id of the product-roadmap (pricing matrix/cards) plugin. */
export const PRODUCT_ROADMAP_PLUGIN = 'product-roadmap';

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

/** The ordered version-label list a product-roadmap plugin config carries. */
export function versionsFromConfig(config: Record<string, unknown> | null | undefined): string[] {
  const v = config?.versions;
  return Array.isArray(v) ? (v as string[]) : [];
}

/** Build a product-roadmap PluginRef from an ordered version list. */
export function productRoadmapRef(versions: string[] | undefined): PluginRef {
  return { id: PRODUCT_ROADMAP_PLUGIN, config: { versions: versions ?? [] } };
}

/**
 * The plugin rows a whole-timeline write should persist. Starts from
 * `file.plugins`, and — because a populated `file.pricing` implies the
 * product-roadmap plugin — ensures that plugin is present with its version list
 * folded into config. `file.pricing.versions` is the authoritative version
 * source on write (that's what every caller sets); a missing list falls back to
 * whatever the incoming plugin config already carried. Used by both drivers'
 * replaceTimeline so the "pricing ⇒ enabled" rule lives in one place.
 */
export function resolveWritePlugins(file: TimelineFile): PluginRef[] {
  const plugins: PluginRef[] = (file.plugins ?? []).map((p) => ({ id: p.id, config: p.config ? { ...p.config } : {} }));
  if (file.pricing) {
    const idx = plugins.findIndex((p) => p.id === PRODUCT_ROADMAP_PLUGIN);
    const existing = idx >= 0 ? plugins[idx].config : undefined;
    const versions = file.pricing.versions ?? versionsFromConfig(existing);
    const config = { ...(existing ?? {}), versions };
    if (idx >= 0) plugins[idx] = { id: PRODUCT_ROADMAP_PLUGIN, config };
    else plugins.push({ id: PRODUCT_ROADMAP_PLUGIN, config });
  }
  return plugins;
}

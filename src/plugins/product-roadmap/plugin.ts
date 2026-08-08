// The product-roadmap plugin's own facts: its id, the item metadata keys it owns,
// and the rules that turn its model into `timeline_plugins` rows.
//
// This module is DOM-free and imports nothing but types plus the generic plugin
// helper, which is what lets the server import it too (both drivers and the
// export script). It is the plugin's counterpart to `src/pluginHost/plugins.ts`:
// the host knows how enablement works, the plugin knows what its own id means.
//
// It used to live in the core (`src/plugins.ts`, plus three constants in
// `src/types.ts`), which is exactly the leak #18 describes: core modules carrying
// facts that stop being true the moment the plugin is uninstalled.

import { pluginConfig } from '../../pluginHost/plugins';
import type { PluginRef, TimelineFile } from '../../types';

/** Stable id of the product-roadmap (pricing matrix/cards) plugin. */
export const PRODUCT_ROADMAP_PLUGIN = 'product-roadmap';

/** Item metadata key holding the feature ids an item is assigned to (string[]). */
export const PRICING_FEATURE_META_KEY = 'featureIds';

// Item metadata key holding the pricing version an item's work targets (string,
// one of Pricing.versions). Drives the version-dependent work indicator in the
// matrix (an item is "work for version X on feature Y").
export const PRICING_ITEM_VERSION_META_KEY = 'featureVersion';

// Item metadata key holding the pricing tier ids an item concerns (string[]).
// Keeps the historical key of the hand-seeded `tier` custom field it replaces:
// the field is derived from Pricing.tiers now (see ./fields.ts), and changing the
// key would orphan every value already stored on an item.
export const PRICING_TIER_META_KEY = 'tier';

/** The ordered version-label list a product-roadmap plugin config carries. */
export function versionsFromConfig(config: Record<string, unknown> | null | undefined): string[] {
  const v = config?.versions;
  return Array.isArray(v) ? (v as string[]) : [];
}

/** Build a product-roadmap PluginRef from an ordered version list. */
export function productRoadmapRef(versions: string[] | undefined): PluginRef {
  return { id: PRODUCT_ROADMAP_PLUGIN, config: { versions: versions ?? [] } };
}

/** This plugin's version list as carried by a file's plugin row. */
export function versionsOf(file: TimelineFile | null | undefined): string[] {
  return versionsFromConfig(pluginConfig(file, PRODUCT_ROADMAP_PLUGIN));
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

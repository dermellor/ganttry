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

// Explicit `.ts` on both: this module is reachable from the Deno edge functions
// (edge → scripts/db/api.ts → timeline-repo*.ts → here), and Deno resolves an
// extensionless relative import to nothing. A missing extension anywhere in that
// graph fails the *deploy*, not the build or the tests — see the guard in
// `netlify/edge-functions/imports.test.ts`.
import { pluginConfig } from '../../pluginHost/plugins.ts';
import type { PluginRef, TimelineFile } from '../../types.ts';

/** Stable id of the product-roadmap (pricing matrix/cards) plugin. */
export const PRODUCT_ROADMAP_PLUGIN = 'dev.zeitlines.product-roadmap';

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


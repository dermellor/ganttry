// The plugin registration seam.
//
// A plugin contributes extra item fields and, optionally, extra views on top of
// the generic timeline+list core. The core stays free of any plugin-specific
// import:
//
//   - `matches` / `views` / `fields` are lightweight, synchronous data checks —
//     they pull in NO view code, so the generic bundle never statically reaches a
//     plugin's renderers.
//   - `load()` is a dynamic import(); Rollup emits everything reachable from it
//     as a separate chunk (including the plugin's CSS, which it imports itself).
//     It runs only when a timeline enters one of the plugin's views, so a generic
//     build downloads none of it.
//
// The list is mutable rather than a `const` array because the endgame is
// installing plugins at runtime (#9): `register()` is the seam a loader will call.
// Until then the entries below are registered at module load.

import type { CustomFieldDef, TimelineFile } from '../types';
import { pluginViewMode, type PluginViewMode } from './viewMode';
import { PRODUCT_ROADMAP_PLUGIN } from '../plugins/product-roadmap/plugin';
import { productRoadmapFields } from '../plugins/product-roadmap/fields';
import { hasPlugin } from './plugins';

/** One view a plugin adds to the header's mode toggle. */
export interface PluginView {
  /** Unique within the plugin. Part of the addressable mode id and the DOM id. */
  id: string;
  /** Button title/aria-label, and the section's accessible name. */
  label: string;
  /** Inline SVG markup for the toggle button. Rendered as-is into the button. */
  icon: string;
  /**
   * Whether the shared grouping/filter toolbar applies to this view. Off by
   * default: a plugin view that is not a rendering of the item list has nothing
   * to group, and leaving the toolbar up implies otherwise.
   */
  toolbar?: boolean;
}

/** The lazily-loaded surface a plugin exposes to the host. */
export interface PluginModule {
  /**
   * Render `viewId` into the container the host created for it. Called on entry
   * and on every repaint, so it has to be idempotent.
   */
  renderView(container: HTMLElement, viewId: string): void;
}

export interface PluginDescriptor {
  id: string;
  /** Display name — the item form's section heading for this plugin's fields. */
  label: string;
  /**
   * Cheap predicate — decides view *availability*. May demand enough data to make
   * the view worth showing. No plugin view imports.
   */
  matches(file: TimelineFile | null | undefined): boolean;
  /**
   * Is this plugin enabled on the timeline at all? Defaults to `matches`.
   *
   * The two differ on purpose: `matches` can require a populated model, and a
   * DB-backed source assembles that model a tick after the first paint. Leaving a
   * plugin's view on `matches` alone therefore kicked the user back to the
   * timeline during that tick. Enablement is a stable data check, so it is what
   * decides whether the user *stays* in a view.
   */
  applies?(file: TimelineFile | null | undefined): boolean;
  /** Views this plugin contributes beyond the built-in timeline / list. */
  views: PluginView[];
  /**
   * Bare mode ids this plugin's views used to answer to, before view modes were
   * addressable. Read once when a stored or linked mode is resolved, so old
   * localStorage values and shared deep links keep working; see readViewMode.
   */
  legacyModeIds?: Record<string, string>;
  /**
   * Postgres tables the plugin owns, for the realtime subscription. Data-only, so
   * naming them here costs the core no import. Goes away with the generic store
   * (#12), which gives every plugin one table the host already subscribes to.
   */
  realtimeTables?: readonly string[];
  /**
   * Extra item fields this plugin contributes, derived from the timeline's own
   * data. Synchronous and data-only (no view imports), gated internally on the
   * plugin being enabled — so it stays independent of `matches`, which also
   * demands enough data to make the *view* worth offering.
   */
  fields(file: TimelineFile | null | undefined): CustomFieldDef[];
  /** Dynamic import of the plugin's module — the only edge into its chunk. */
  load(): Promise<PluginModule>;
}

const PLUGINS: PluginDescriptor[] = [];

/** Register a plugin. The seam a runtime loader will call (#9). */
export function register(descriptor: PluginDescriptor): void {
  const idx = PLUGINS.findIndex((p) => p.id === descriptor.id);
  if (idx >= 0) PLUGINS[idx] = descriptor;
  else PLUGINS.push(descriptor);
}

register({
  id: PRODUCT_ROADMAP_PLUGIN,
  label: 'Produkt',
  // Enabled by the product-roadmap plugin registration (a data row), plus a
  // populated pricing model. Still a cheap sync check that pulls in no pricing
  // code, so the generic bundle never reaches the plugin's chunk.
  matches: (f) =>
    hasPlugin(f, PRODUCT_ROADMAP_PLUGIN) &&
    !!f?.pricing &&
    (f.pricing.tiers.length > 0 || f.pricing.features.length > 0),
  views: [
    {
      id: 'pricing',
      label: 'Preise',
      icon:
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="3" y="4" width="18" height="16" rx="2" />' +
        '<line x1="3" y1="9" x2="21" y2="9" />' +
        '<line x1="11" y1="9" x2="11" y2="20" />' +
        '</svg>',
    },
  ],
  applies: (f) => hasPlugin(f, PRODUCT_ROADMAP_PLUGIN),
  legacyModeIds: { pricing: 'pricing' },
  realtimeTables: ['pricing_features', 'pricing_tiers', 'pricing_tier_values', 'pricing_highlights'],
  fields: productRoadmapFields,
  load: () => import('../plugins/product-roadmap/index'),
});

/** Every registered plugin, in registration order. */
export function allPlugins(): readonly PluginDescriptor[] {
  return PLUGINS;
}

/**
 * The plugins whose views apply to this timeline. Several can apply at once,
 * which is why this returns a list: a timeline can carry sprints *and* a matrix,
 * and the header shows a button per view.
 */
export function activePlugins(file: TimelineFile | null | undefined): PluginDescriptor[] {
  return PLUGINS.filter((p) => p.matches(file));
}

/** Is the plugin behind this mode enabled on the timeline at all? */
export function pluginAppliesTo(file: TimelineFile | null | undefined, pluginId: string): boolean {
  const plugin = PLUGINS.find((p) => p.id === pluginId);
  if (!plugin) return false;
  return plugin.applies ? plugin.applies(file) : plugin.matches(file);
}

/** Resolve an addressable mode to its plugin and view, if it applies here. */
export function resolveViewMode(
  file: TimelineFile | null | undefined,
  pluginId: string,
  viewId: string,
): { plugin: PluginDescriptor; view: PluginView } | null {
  const plugin = activePlugins(file).find((p) => p.id === pluginId);
  const view = plugin?.views.find((v) => v.id === viewId);
  return plugin && view ? { plugin, view } : null;
}

/**
 * Map a pre-plugin mode id (e.g. `pricing`) onto the plugin view that claims it.
 * Independent of the active timeline: a stored mode has to resolve before any
 * file is loaded, and availability is checked separately when it is applied.
 */
export function legacyViewMode(legacyId: string): PluginViewMode | null {
  for (const plugin of PLUGINS) {
    const viewId = plugin.legacyModeIds?.[legacyId];
    if (viewId) return pluginViewMode(plugin.id, viewId);
  }
  return null;
}

/** Every table a registered plugin owns, for the realtime subscription. */
export function pluginRealtimeTables(): string[] {
  return PLUGINS.flatMap((p) => [...(p.realtimeTables ?? [])]);
}

/**
 * Every enabled plugin's contributed fields, each stamped with its plugin's label
 * so the form can section them under a heading. The single seam the generic
 * custom-field machinery (customFields.ts) reads plugin fields through: it knows
 * nothing about which plugins exist or what they contribute.
 *
 * A def that already declares its own `group` keeps it, so a plugin can file
 * fields under a sub-heading of its own choosing.
 */
export function pluginFieldDefs(file: TimelineFile | null | undefined): CustomFieldDef[] {
  const out: CustomFieldDef[] = [];
  for (const plugin of PLUGINS) {
    for (const def of plugin.fields(file)) {
      out.push(def.group ? def : { ...def, group: plugin.label });
    }
  }
  return out;
}

/**
 * The timeline's stored field definitions merged with the contributed ones, one
 * definition per metadata key. A contributed field **wins** over a stored one
 * with the same key: it is derived from the live model, so it cannot drift, which
 * is the whole reason it exists. Two defs on one key would otherwise render two
 * controls writing the same `metadata[key]` — and share one multi-select state
 * bucket, since that is keyed by the field key.
 *
 * This makes cleaning up a superseded stored definition a tidy-up rather than a
 * fix: `tier` was such a hand-seeded copy of the pricing tiers.
 */
export function mergeFieldDefs(
  stored: CustomFieldDef[],
  contributed: CustomFieldDef[],
): CustomFieldDef[] {
  const shadowed = new Set(contributed.map((d) => d.key));
  return [...stored.filter((d) => !shadowed.has(d.key)), ...contributed];
}

// Loaded-module cache, keyed by plugin id so the synchronous repaint paths
// (render.ts) can call a view once it has been entered, without re-importing.
const loaded = new Map<string, PluginModule>();

/** Import (and cache) a plugin's module. Call before rendering its view. */
export async function ensurePluginLoaded(desc: PluginDescriptor): Promise<PluginModule> {
  const cached = loaded.get(desc.id);
  if (cached) return cached;
  const mod = await desc.load();
  loaded.set(desc.id, mod);
  return mod;
}

/** A loaded plugin module, or null if that plugin has not been entered yet. */
export function loadedPluginView(pluginId: string): PluginModule | null {
  return loaded.get(pluginId) ?? null;
}

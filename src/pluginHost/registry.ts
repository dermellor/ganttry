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
import { validateManifest, type ManifestView, type PluginManifest } from './manifest';
import { PRODUCT_ROADMAP_PLUGIN } from '../plugins/product-roadmap/plugin';
import { productRoadmapManifest } from '../plugins/product-roadmap/manifest';
import { productRoadmapFields } from '../plugins/product-roadmap/fields';
import { hasPlugin } from './plugins';

/**
 * One view a plugin adds to the header's mode toggle. Declared in the manifest,
 * so the host has it before any plugin code runs.
 */
export type PluginView = ManifestView;

/** The lazily-loaded surface a plugin exposes to the host. */
export interface PluginModule {
  /**
   * Render `viewId` into the container the host created for it. Called on entry
   * and on every repaint, so it has to be idempotent.
   */
  renderView(container: HTMLElement, viewId: string): void;
}

export interface PluginDescriptor {
  /**
   * What the plugin declares about itself: id, display name, views, capabilities
   * and (for #12/#20) its data. The single source for all of it — the descriptor
   * adds only the parts that are code rather than data.
   */
  manifest: PluginManifest;
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

/**
 * Register a plugin. The seam a runtime loader will call (#9).
 *
 * A manifest that does not validate is **refused**, loudly. A plugin running with
 * a declaration the host silently ignored is the failure mode this check exists
 * for: it then behaves as if it had access it was never granted, and the symptom
 * shows up far from the cause.
 */
export function register(descriptor: PluginDescriptor): void {
  const result = validateManifest(descriptor.manifest);
  if (!result.ok) {
    throw new Error(
      `plugin "${(descriptor.manifest as { id?: string })?.id ?? '?'}" has an invalid manifest:\n` +
        result.problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
  const idx = PLUGINS.findIndex((p) => p.manifest.id === descriptor.manifest.id);
  if (idx >= 0) PLUGINS[idx] = descriptor;
  else PLUGINS.push(descriptor);
}

/** Views a plugin declares, or none. */
export function pluginViews(plugin: PluginDescriptor): PluginView[] {
  return plugin.manifest.views ?? [];
}

register({
  manifest: productRoadmapManifest,
  // Enabled by the product-roadmap plugin registration (a data row), plus a
  // populated pricing model. Still a cheap sync check that pulls in no pricing
  // code, so the generic bundle never reaches the plugin's chunk.
  matches: (f) =>
    hasPlugin(f, PRODUCT_ROADMAP_PLUGIN) &&
    !!f?.pricing &&
    (f.pricing.tiers.length > 0 || f.pricing.features.length > 0),
  applies: (f) => hasPlugin(f, PRODUCT_ROADMAP_PLUGIN),
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
  const plugin = PLUGINS.find((p) => p.manifest.id === pluginId);
  if (!plugin) return false;
  return plugin.applies ? plugin.applies(file) : plugin.matches(file);
}

/** Resolve an addressable mode to its plugin and view, if it applies here. */
export function resolveViewMode(
  file: TimelineFile | null | undefined,
  pluginId: string,
  viewId: string,
): { plugin: PluginDescriptor; view: PluginView } | null {
  const plugin = activePlugins(file).find((p) => p.manifest.id === pluginId);
  const view = pluginViews(plugin ?? ({ manifest: {} } as PluginDescriptor)).find((v) => v.id === viewId);
  return plugin && view ? { plugin, view } : null;
}

/**
 * Map a pre-plugin mode id (e.g. `pricing`) onto the plugin view that claims it.
 * Independent of the active timeline: a stored mode has to resolve before any
 * file is loaded, and availability is checked separately when it is applied.
 */
export function legacyViewMode(legacyId: string): PluginViewMode | null {
  for (const plugin of PLUGINS) {
    const viewId = plugin.manifest.legacyModeIds?.[legacyId];
    if (viewId) return pluginViewMode(plugin.manifest.id, viewId);
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
      out.push(def.group ? def : { ...def, group: plugin.manifest.name });
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
  const cached = loaded.get(desc.manifest.id);
  if (cached) return cached;
  const mod = await desc.load();
  loaded.set(desc.manifest.id, mod);
  return mod;
}

/** A loaded plugin module, or null if that plugin has not been entered yet. */
export function loadedPluginView(pluginId: string): PluginModule | null {
  return loaded.get(pluginId) ?? null;
}

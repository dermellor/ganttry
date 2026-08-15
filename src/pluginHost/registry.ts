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

import type { CustomFieldDef, TimelineFile, TimelineFileItem } from '../types';
import { pluginViewMode, type PluginViewMode } from './viewMode';
import { validateManifest, type ManifestView, type PluginManifest, type ToolDecl } from './manifest';
import type { ToolHandler } from './tools';
import { manifestText } from './messages';
import { viewLoader } from './viewLoaders';
import { productRoadmapDescriptor } from '../plugins/product-roadmap/descriptor';
import { sprintsDescriptor } from '../plugins/sprints/descriptor';
import type { HostApi } from './hostApi';

/**
 * One view a plugin adds to the header's mode toggle. Declared in the manifest,
 * so the host has it before any plugin code runs.
 */
export type PluginView = ManifestView;

/** The values one plugin computed for one item, keyed by the field key. */
export type DerivedValues = Record<string, unknown>;

/**
 * What `PluginDescriptor.derive(file)` returns: the per-item half of a derived
 * field. Pure over one item, so a plugin's rule is testable in its own folder.
 *
 * The types live here rather than in `./derived` because that module reads the
 * registry, and the contract a plugin author writes against should not depend on
 * which direction the host's own imports run.
 */
export type DeriveFn = (item: TimelineFileItem) => DerivedValues;

/** The lazily-loaded surface a plugin exposes to the host. */
export interface PluginModule {
  /**
   * Render `viewId` into the container the host created for it. Called on entry
   * and on every repaint, so it has to be idempotent.
   *
   * `host` is the plugin's gated API (`createHostApi`): the timeline, its own
   * config, its own rows, and a change signal. It arrives as an ARGUMENT rather
   * than through an import, which is the whole reason a plugin can be a file
   * fetched from a URL — there is nothing for it to resolve at load time. It is
   * a third parameter rather than a new export so an artifact written against
   * the two-parameter shape keeps working: JavaScript ignores what it does not
   * take.
   */
  renderView(container: HTMLElement, viewId: string, host: HostApi): void | Promise<void>;
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
  /**
   * The values behind the fields this plugin declared `derived`, as a factory over
   * the timeline: `derive(file)` is called once per build, the function it returns
   * once per item.
   *
   * Two shapes in one signature, and both matter. The factory is where whatever
   * the *whole* timeline decides gets computed — a sprint raster, a set of cohorts
   * — so it happens once rather than per item. The returned function is pure over
   * one item, which is what makes the plugin's rule unit-testable in its own
   * folder, exactly like a tool handler.
   *
   * `null` means „nothing to derive here" and is the right answer whenever the
   * plugin is off or its config is empty. Data-only, like `fields`: this runs in
   * the generic bundle and must reach no view code.
   */
  derive?(file: TimelineFile | null | undefined): DeriveFn | null;
  /**
   * The implementation of each tool the manifest declares, keyed by tool name.
   *
   * Pure functions over the timeline (see ./tools.ts), so this stays as cheap and
   * synchronous as `fields`: the module holding a plugin's domain rules imports
   * types and nothing else. A rule behind the dynamic `load()` would be
   * unreachable for the process that actually calls tools, which has no DOM to
   * render a view into.
   */
  tools?: Record<string, ToolHandler>;
  /**
   * Dynamic import of the plugin's module — the only edge into its chunk.
   *
   * Optional, because a plugin that declares no view has no module to import and
   * carrying an empty one would cost a chunk that renders nothing. It used to be
   * required, which forced the first view-less plugin to satisfy the type with a
   * cast: a declaration the compiler could not check, in the one file that is
   * supposed to be the plugin's contract with the host.
   */
  load?(): Promise<PluginModule>;
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

// The one built-in plugin, registered from its own folder. The host imports a
// descriptor it does not understand — the same thing it will do for a plugin
// loaded at runtime (src/pluginHost/loader.ts). Nothing about product-roadmap is
// decided here any more.
register(productRoadmapDescriptor);
// The second in-tree plugin, and the first with no view: its raster is a derived
// field, so grouping by it is the rendering (src/plugins/sprints/README.md).
register(sprintsDescriptor);

/** Every registered plugin, in registration order. */
/**
 * One registered plugin by id, or null.
 *
 * The render path needs it to build that plugin's gated host API, which is
 * derived from its manifest — so the lookup has to be by id rather than by
 * descriptor, since a view mode carries the id and nothing else.
 */
export function pluginById(pluginId: string): PluginDescriptor | null {
  return allPlugins().find((p) => p.manifest.id === pluginId) ?? null;
}

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

/** One callable verb: what was declared, and what implements it. */
export type RegisteredTool = {
  pluginId: string;
  decl: ToolDecl;
  run: ToolHandler;
};

/** Why a declared tool is not callable. Reported, never swallowed. */
export type ToolProblem = {
  pluginId: string;
  tool: string;
  reason: 'name-taken' | 'no-handler' | 'not-declared';
  problem: string;
};

/**
 * Every callable tool across the registered plugins, plus the ones that are not.
 *
 * **A tool namespace is flat**, so two plugins can claim one verb. The first
 * registration keeps the name and the second is reported: the alternative is
 * silent shadowing, where an agent calls `recalculate_deadlines` and gets a
 * different plugin's rule with no indication that it happened. Refusing to
 * assemble any list at all would be worse still — one squatted name would cost
 * an instance every other plugin's tools.
 *
 * The two mismatch cases are reported for the same reason. A declaration without
 * a handler is a tool an agent can see and cannot call; a handler without a
 * declaration is a rule nobody approved on install, and it stays uncallable.
 */
export function pluginTools(): { tools: RegisteredTool[]; problems: ToolProblem[] } {
  const tools: RegisteredTool[] = [];
  const problems: ToolProblem[] = [];
  const claimed = new Map<string, string>();

  for (const plugin of PLUGINS) {
    const pluginId = plugin.manifest.id;
    const handlers = plugin.tools ?? {};
    const declared = new Set<string>();

    for (const decl of plugin.manifest.tools ?? []) {
      declared.add(decl.name);
      const owner = claimed.get(decl.name);
      if (owner) {
        problems.push({
          pluginId,
          tool: decl.name,
          reason: 'name-taken',
          problem: `"${decl.name}" is already provided by "${owner}"`,
        });
        continue;
      }
      const run = handlers[decl.name];
      if (typeof run !== 'function') {
        problems.push({
          pluginId,
          tool: decl.name,
          reason: 'no-handler',
          problem: `"${decl.name}" is declared but the plugin provides no implementation for it`,
        });
        continue;
      }
      claimed.set(decl.name, pluginId);
      tools.push({ pluginId, decl, run });
    }

    for (const name of Object.keys(handlers)) {
      if (declared.has(name)) continue;
      problems.push({
        pluginId,
        tool: name,
        reason: 'not-declared',
        problem: `"${name}" is implemented but not declared in the manifest, so it is not callable`,
      });
    }
  }

  return { tools, problems };
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
    // The group heading is the plugin's name as the **reader** sees it, not the
    // literal in the manifest: a manifest cannot call `t()`, so the name is looked
    // up in the plugin's own catalogue with the literal as fallback. Same seam the
    // control in the bar uses — see `manifestText`.
    const name = manifestText(plugin.manifest.id, 'manifest.name', plugin.manifest.name);
    for (const def of plugin.fields(file)) {
      out.push(def.group ? def : { ...def, group: name });
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
  return [
    ...stored.filter((d) => !shadowed.has(d.key)).map(withoutStoredDerived),
    ...contributed,
  ];
}

/**
 * A stored definition may not claim `derived`.
 *
 * Only a contributing plugin can compute a value, so `derived` on a stored def is a
 * read-only control that can never hold anything, with nothing in the interface
 * saying why. The key is reachable: it is part of the committed JSON Schema (that is
 * what gives a data file completion), so a file, a `PATCH` or a bulk write can carry
 * it. Dropping it here rather than refusing the whole definition keeps one bad flag
 * from costing a timeline its field.
 */
function withoutStoredDerived(def: CustomFieldDef): CustomFieldDef {
  if (!def.derived) return def;
  const { derived: _derived, ...rest } = def;
  return rest;
}

// Loaded-module cache, keyed by plugin id so the synchronous repaint paths
// (render.ts) can call a view once it has been entered, without re-importing.
const loaded = new Map<string, PluginModule>();

/** Import (and cache) a plugin's module. Call before rendering its view. */
export async function ensurePluginLoaded(desc: PluginDescriptor): Promise<PluginModule> {
  const cached = loaded.get(desc.manifest.id);
  if (cached) return cached;
  // A plugin with no views has no module. Reaching here for one means a view mode
  // resolved to a plugin that declares none, which is a bug in the caller rather
  // than something to paper over with an empty module.
  const load = desc.load ?? viewLoader(desc.manifest.id);
  if (!load) {
    throw new Error(`plugin "${desc.manifest.id}" declares no view module to load`);
  }
  const mod = await load();
  loaded.set(desc.manifest.id, mod);
  return mod;
}

/** A loaded plugin module, or null if that plugin has not been entered yet. */
export function loadedPluginView(pluginId: string): PluginModule | null {
  return loaded.get(pluginId) ?? null;
}

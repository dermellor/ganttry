// The view-mode identity, shared by the app state, the URL and localStorage.
//
// The two built-in renderings of a timeline keep their bare names; a plugin view
// is addressed by the plugin that owns it plus its own view id. Encoding both into
// one string is what lets `state.viewMode`, `?mode=` and the persisted key stay a
// single scalar instead of growing a second field everywhere they are read.
//
// This module is pure: no DOM, no registry import, so both the state module and the
// URL parser can use it without pulling the plugin layer along.

export type BuiltinViewMode = 'timeline' | 'list';
export type PluginViewMode = `plugin:${string}:${string}`;
export type ViewMode = BuiltinViewMode | PluginViewMode;

const PREFIX = 'plugin:';

/** The addressable id of a plugin's view. */
export function pluginViewMode(pluginId: string, viewId: string): PluginViewMode {
  return `${PREFIX}${pluginId}:${viewId}`;
}

export function isPluginViewMode(mode: string): mode is PluginViewMode {
  return parsePluginViewMode(mode) !== null;
}

/**
 * Split a plugin view mode back into its parts, or null for a built-in one.
 * Both parts must be non-empty, so a truncated hash (`mode=plugin:`) falls back
 * to the timeline rather than addressing a plugin called "".
 */
export function parsePluginViewMode(mode: string): { pluginId: string; viewId: string } | null {
  if (!mode.startsWith(PREFIX)) return null;
  const rest = mode.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const pluginId = rest.slice(0, sep);
  const viewId = rest.slice(sep + 1);
  return pluginId && viewId ? { pluginId, viewId } : null;
}

/**
 * Read a mode that may come from an older client: before plugin views were
 * addressable, the product-roadmap matrix was simply `pricing`, and that value
 * sits in every user's localStorage and in every deep link ever shared.
 * `resolveLegacy` maps such a bare id onto the plugin that claims it (the registry
 * knows, this module deliberately does not). An unknown value degrades to the
 * timeline instead of leaving the app on a mode nothing renders.
 */
export function readViewMode(
  raw: string | null | undefined,
  resolveLegacy: (legacyId: string) => PluginViewMode | null,
): ViewMode {
  if (!raw) return 'timeline';
  if (raw === 'timeline' || raw === 'list') return raw;
  if (isPluginViewMode(raw)) return raw as PluginViewMode;
  return resolveLegacy(raw) ?? 'timeline';
}

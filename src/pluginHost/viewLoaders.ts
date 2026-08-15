// Where a built-in plugin's view lives, kept apart from its descriptor.
//
// **Why this is not a field on the descriptor.** A descriptor is read on both
// sides: the browser renders from it, and the server asks it for a plugin's
// fields, its derived values and its tool handlers. A
// `load: () => import('./index')` sitting on it is followed by any bundler that
// reaches the descriptor at all — so the MCP function's bundle grew to carry both
// plugin views, their stylesheets and all 50 design-system modules, and then
// stopped bundling, because esbuild has no loader for a `.css` import. Netlify
// failed every deploy from that day on while still serving the last good one, so
// nothing shipped and no check said a word.
//
// Registering the loader separately is what keeps „the server reads plugins" and
// „the client renders them" two graphs instead of one. A **runtime-installed**
// plugin is unaffected and still carries its own `load`: it never passes through a
// bundler, so there is nothing to follow (see ./loader.ts).
//
// Its own module rather than a few lines in `registry.ts`, so that `api.ts` can
// re-export `attachView` without importing the registry — which would make
// api → registry → descriptor → api a cycle.

// A **type-only** import: erased at build time, so it creates no edge in any
// bundle and no cycle with the registry that imports this file back.
import type { PluginModule } from './registry';

const loaders = new Map<string, () => Promise<PluginModule>>();

/**
 * Declare where a built-in plugin's view lives.
 *
 * Called from the plugin's own `view.ts`, which only the browser entry reaches
 * (see ./builtInViews.ts). Calling it twice for one id is the plugin replacing its
 * own loader, which is what a hot reload does.
 */
export function attachView(pluginId: string, load: () => Promise<PluginModule>): void {
  loaders.set(pluginId, load);
}

/** The loader a plugin registered, or `undefined`. For the registry. */
export function viewLoader(pluginId: string): (() => Promise<PluginModule>) | undefined {
  return loaders.get(pluginId);
}

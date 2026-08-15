// What this plugin registers with the host: the one object the registry takes.
//
// It lives here rather than in `src/pluginHost/registry.ts` because a core file that
// knows a plugin's availability rule is a plugin with a privilege no third party can
// have (#17). The registry imports a descriptor it does not understand, exactly as it
// will for a plugin loaded at runtime.
//
// Everything reachable from this module lands in the generic bundle, so it imports
// types, the contract barrel and this plugin's own data-only modules, and nothing that
// reaches view code, DOM helpers or CSS.

import type { PluginDescriptor } from '../../pluginHost/api';
import { hasPlugin } from '../../pluginHost/api';
import { sprintsManifest } from './manifest';
import { SPRINTS_PLUGIN, sprintsDerive, sprintsFields } from './fields';
import { sprintsTools } from './tools';

// **`load()` is the only thing in this file that reaches view code**, and it is a
// dynamic `import()` for that reason: Rollup emits everything behind it — the sprint
// page, the chart and `sprints.css` — as its own chunk, so a deploy without this
// plugin downloads none of it (scripts/ci/check-bundle-split.sh asserts exactly
// that). Making it a static import would pull the stylesheet into the generic
// bundle.
//
// `matches` and `applies` still answer the same question, and now for a stated
// reason rather than for lack of a view: the view's own **empty state** is what tells
// a reader with no sprint rows yet what to do, so demanding rows here would hide the
// one screen that explains the plugin. `applies` has to stay a plain data check
// either way.
export const sprintsDescriptor: PluginDescriptor = {
  manifest: sprintsManifest,

  matches: (file) => hasPlugin(file, SPRINTS_PLUGIN),
  applies: (file) => hasPlugin(file, SPRINTS_PLUGIN),

  fields: sprintsFields,
  derive: sprintsDerive,
  tools: sprintsTools,
};

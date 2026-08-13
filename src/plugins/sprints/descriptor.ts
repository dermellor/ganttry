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

// **No `load()`.** This plugin has no view: grouping by „Sprints · Sprint" is the
// raster rendering, and a burndown chart would be a second product rather than a
// second view (see the README). A `load()` here would be a dynamic import, which is a
// build chunk that renders nothing.
//
// `matches` and `applies` answer the same question here, and only because there is no
// view: `matches` may additionally demand enough data to make a VIEW worth a button,
// while `applies` has to stay a stable data check.
export const sprintsDescriptor: PluginDescriptor = {
  manifest: sprintsManifest,

  matches: (file) => hasPlugin(file, SPRINTS_PLUGIN),
  applies: (file) => hasPlugin(file, SPRINTS_PLUGIN),

  fields: sprintsFields,
  derive: sprintsDerive,
  tools: sprintsTools,
};

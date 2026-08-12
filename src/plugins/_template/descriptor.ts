// What this plugin registers with the host: the one object the registry takes.
//
// TEMPLATE. Copy it, rename the exports, delete what the plugin does not have.
//
// It lives here rather than in `src/pluginHost/registry.ts` because a core file
// that knows a plugin's availability rule is a plugin with a privilege no third
// party can have (#17). The registry imports a descriptor it does not understand,
// which is exactly what it does for a plugin loaded at runtime.
//
// **Everything reachable from this module lands in the generic bundle.** It is
// imported statically by the registry, so it may import types, the plugin helpers
// and its own `fields`/`tools` modules — and nothing that reaches view code, DOM
// helpers or CSS. Those hang off `load()`, which is a dynamic import and the only
// edge into the plugin's own chunk (`scripts/ci/check-bundle-split.sh` asserts
// both halves).

import type { PluginDescriptor } from '../../pluginHost/registry';
import { hasPlugin } from '../../pluginHost/plugins';
import { exampleManifest } from './manifest';
import { EXAMPLE_PLUGIN, exampleFields } from './fields';
import { exampleTools } from './tools';

export const exampleDescriptor: PluginDescriptor = {
  manifest: exampleManifest,

  // Two different questions, and conflating them makes a restored view flicker
  // away on load. `applies` is „is this plugin on here at all", which is stable
  // data; `matches` may additionally demand enough data to make the VIEW worth a
  // button. A DB source assembles its rows a tick after the first paint, so only
  // the stable one may decide whether the user stays in a view.
  //
  // With no view, both are the same question and one line answers it.
  matches: (file) => hasPlugin(file, EXAMPLE_PLUGIN),
  applies: (file) => hasPlugin(file, EXAMPLE_PLUGIN),

  fields: exampleFields,

  // The domain rules, keyed by the tool name the manifest declares. Delete this
  // line if the plugin has no verbs; a handler with no declaration stays
  // uncallable and is reported, which is not the same as being ignored.
  tools: exampleTools,

  // Delete this if the plugin has no view. Keeping it costs a chunk that renders
  // nothing.
  load: () => import('./index'),
};

// What this plugin registers with the host: the one object the registry takes.
//
// It lives here rather than in `src/pluginHost/registry.ts` because a core file that
// knows a plugin's availability rule is a plugin with a privilege no third party can
// have (#17). The registry imports a descriptor it does not understand, which is
// exactly what it does for a plugin loaded at runtime.
//
// **No `load()`**, because this plugin has no view. Declaring one would cost a lazily
// loaded chunk that renders nothing.

import type { PluginDescriptor } from '../../pluginHost/api';
import { hasPlugin } from '../../pluginHost/api';
import { lifecycleManifest } from './manifest';
import { LIFECYCLE_PLUGIN, lifecycleDerive, lifecycleFields } from './fields';
import { lifecycleTools } from './tools';

export const lifecycleDescriptor: PluginDescriptor = {
  manifest: lifecycleManifest,

  // With no view, `matches` and `applies` are the same question and one line answers
  // it: the two only differ when a plugin's view needs enough data to be worth a
  // button, and there is no button here.
  matches: (file) => hasPlugin(file, LIFECYCLE_PLUGIN),
  applies: (file) => hasPlugin(file, LIFECYCLE_PLUGIN),

  fields: lifecycleFields,

  // The values behind `latestStart` and `supportWindow`, the two fields declared
  // `derived: true`.
  derive: lifecycleDerive,

  // The domain rules, keyed by the tool name the manifest declares.
  tools: lifecycleTools,
};

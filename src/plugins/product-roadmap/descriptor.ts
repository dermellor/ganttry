// What this plugin registers with the host.
//
// It lives HERE rather than in `src/pluginHost/registry.ts`, and that move is the
// point of issue #17: a core file that knows a plugin's availability rule is a
// plugin with a privilege no third party can have. The registry now imports a
// descriptor it does not understand, which is exactly what it will do for a
// runtime-loaded plugin.
//
// It also removed a real bug. „Does this timeline have a pricing model" existed
// twice — once here, once in `pricingMatrix.ts` — and the read-path migration
// updated one of them. The view button disappeared, because the copy in the core
// registry was still asking for `file.pricing`, a field that no longer exists.
// One rule, one place (AGENTS.md → Conventions).
//
// Everything in this module has to stay data-only and free of view imports: the
// registry imports it STATICALLY, so anything it reaches pulls into the generic
// bundle and the lazy split is gone (`scripts/ci/check-bundle-split.sh`).

import type { PluginDescriptor } from '../../pluginHost/api';
import { hasPlugin } from '../../pluginHost/api';
import { hasPricingModel } from './compose';
import { productRoadmapManifest } from './manifest';
import { productRoadmapFields } from './fields';
import { PRODUCT_ROADMAP_PLUGIN } from './plugin';

export const productRoadmapDescriptor: PluginDescriptor = {
  manifest: productRoadmapManifest,

  // Two different questions, and conflating them made a restored view flicker
  // away on load: `applies` is „is this plugin on here at all" (stable data),
  // `matches` additionally demands a populated model, because a view with nothing
  // in it is not worth a button. A DB source assembles its rows a tick after the
  // first paint, so only the stable one may decide whether the user STAYS in a
  // view.
  matches: (file) => hasPlugin(file, PRODUCT_ROADMAP_PLUGIN) && hasPricingModel(file),
  applies: (file) => hasPlugin(file, PRODUCT_ROADMAP_PLUGIN),

  fields: productRoadmapFields,
};

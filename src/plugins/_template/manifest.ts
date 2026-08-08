// What this plugin declares about itself. The host reads it *before* running any
// plugin code, so everything the plugin needs has to be declared, not requested.
//
// TEMPLATE. Rename the id, delete the sections you do not need. The validator is
// strict on purpose (`register()` refuses an invalid manifest): a declaration the
// host silently ignored means the plugin runs believing it has access it was never
// granted, and the symptom then shows up far from the cause.

import type { PluginManifest } from '../../pluginHost/manifest';

export const exampleManifest: PluginManifest = {
  id: 'example',
  name: 'Example',
  version: '0.1.0',
  // The host contract range this was built against. "^1" = any 1.x.
  apiVersion: '^1',

  // Keep this list short and true. It is shown to whoever installs the plugin, and
  // every declaration below has to be covered by it.
  capabilities: ['items:read', 'fields'],

  // What the field writes to. Declared so uninstalling can clean the key off items
  // instead of leaving it behind in the raw metadata box.
  metadataKeys: ['example'],

  // The shape of the `timeline_plugins.config` bag, validated by the host on write.
  configSchema: {
    type: 'object',
    properties: {
      choices: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },

  // A view costs roughly ten times what a field does, and grouping by a
  // contributed field usually renders the useful thing already. Uncomment only
  // when you know what the view shows that grouping cannot, and add the "views"
  // capability with it.
  //
  // views: [{ id: 'board', label: 'Board', icon: '<svg …>' }],

  // Rows of your own (a plugin whose data is not per item). Requires "data:own",
  // and the host stores them generically — a plugin never ships a migration.
  //
  // collections: [{ id: 'entries', ordered: true }],
};

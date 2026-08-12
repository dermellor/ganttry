// What this plugin declares about itself. The host reads it *before* running any
// plugin code, so everything the plugin needs has to be declared, not requested.
//
// TEMPLATE. Rename the id, delete the sections you do not need. The validator is
// strict on purpose (`register()` refuses an invalid manifest): a declaration the
// host silently ignored means the plugin runs believing it has access it was never
// granted, and the symptom then shows up far from the cause.

import type { PluginManifest } from '../../pluginHost/manifest';

export const exampleManifest: PluginManifest = {
  // **Reverse-DNS, derived from a domain you own.** At least two labels, no
  // capitals. This id keys the plugin's row, its data and the metadata on items,
  // so a collision is a data collision — which is why a bare `example` is refused
  // rather than merely discouraged.
  id: 'com.example.template',
  name: 'Example',
  version: '0.1.0',
  // The host contract range this was built against. "^1" = any 1.x. Declare
  // "^1.3" or later if you use `tools` below, or an older host will load the plugin
  // and list your verbs nowhere.
  apiVersion: '^1.3',

  // Keep this list short and true. It is shown to whoever installs the plugin, and
  // every declaration below has to be covered by it.
  capabilities: ['items:read', 'items:write', 'fields', 'tools'],

  // What the generated catalogue renders (PLUGINS.md). Required to publish, not to
  // load, and `npm run plugins:catalogue:check` is what insists on it. Write the
  // keywords in the words a reader searches with rather than the ones your code
  // uses — nobody looks for the term you invented.
  catalogue: {
    summary: 'One sentence saying what this plugin does, in the words a reader would use.',
    domain: 'example',
    keywords: ['example'],
    // The view id of the example timeline that demonstrates it. Linked by the
    // catalogue and rendered by `npm run plugins:preview -- <folder>`.
    example: 'src:example-<slug>',
  },

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

  // The verbs an agent can call — the half of a plugin that fields cannot express.
  // One per domain rule that turns a single instruction into many item changes;
  // the implementation is a pure function in `tools.ts`, keyed by the same name.
  // **Delete this section and `tools.ts` together** if the plugin has no rules of
  // its own: a declaration with no handler is a verb an agent can see and cannot
  // call, and a handler with no declaration stays uncallable. Both are reported.
  //
  // The description is the only thing a model reads before deciding to call the
  // tool, so it is the field worth writing carefully. `id` is reserved in
  // `inputSchema` — the host passes the timeline under that name.
  tools: [
    {
      name: 'shift_example',
      title: 'Shift example dates',
      description: 'Move every dated item to one date. Replace this with your domain rule.',
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'string', description: 'ISO date. Defaults to today.' } },
        additionalProperties: false,
      },
      writes: 'items',
    },
  ],

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

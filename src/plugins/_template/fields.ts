// The item fields this plugin contributes to the generic item form.
//
// TEMPLATE. Copy the folder, rename the ids, delete what you do not need. The
// comments explain the constraints; keep the ones that still describe a rule you
// depend on and delete the rest, so the copy does not carry advice about code it
// no longer has.
//
// Contributed fields are *derived*: their options come from the plugin's config or
// from the timeline's own data, so they are never stored as definitions and can
// never drift out of sync with what they describe. Routing them through the
// custom-field machinery buys the form control, grouping, filtering and the context
// menu without a parallel code path.
//
// This module is imported by the registry *statically*, so it must stay data-only:
// types and the plugin helper, nothing that reaches view code. Everything heavier
// belongs behind the descriptor's dynamic `load()`, or the plugin's code ends up in
// the generic bundle and the lazy split is gone.

import { hasPlugin, pluginConfig } from '../../pluginHost/plugins';
import type { CustomFieldDef, TimelineFile } from '../../types';

/** Stable id of this plugin: the value in its `timeline_plugins` row. */
export const EXAMPLE_PLUGIN = 'example';

/**
 * The `metadata` key the field writes to. It lives here rather than in the core
 * `src/types.ts`, because it is a fact about this plugin and nothing in the core
 * needs to know it (see #18).
 */
export const EXAMPLE_META_KEY = 'example';

/** The config bag shape, read off the plugin's `timeline_plugins` row. */
type ExampleConfig = {
  /** The labels the field offers. Ordered; the order is the order in the form. */
  choices?: string[];
};

function readConfig(file: TimelineFile | null | undefined): ExampleConfig {
  const raw = pluginConfig(file, EXAMPLE_PLUGIN);
  const choices = raw?.choices;
  // Tolerate a malformed bag rather than throwing: the config is user-editable
  // data, and a bad value must not take the whole item form down with it.
  return { choices: Array.isArray(choices) ? (choices as string[]).filter((c) => typeof c === 'string') : [] };
}

/**
 * The plugin's fields, in the order they render. `width: 'full'` spans both form
 * columns; the default `half` pairs a field up with its neighbour. `contextMenu`
 * opts a field into the item's right-click menu, which is worth it for a short,
 * fixed list that gets retargeted often and wrong for a long one.
 *
 * Returning `[]` is the correct answer whenever the plugin is off or its config is
 * empty: a field with no options is a control the user cannot use.
 */
export function exampleFields(file: TimelineFile | null | undefined): CustomFieldDef[] {
  if (!file || !hasPlugin(file, EXAMPLE_PLUGIN)) return [];

  const { choices } = readConfig(file);
  if (!choices?.length) return [];

  return [
    {
      key: EXAMPLE_META_KEY,
      label: 'Example',
      type: 'select',
      contextMenu: true,
      options: choices.map((value) => ({ value })),
    },
  ];
}

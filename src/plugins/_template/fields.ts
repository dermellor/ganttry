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

import { hasPlugin, pluginConfig, type DeriveFn } from '../../pluginHost/api';
import { exampleManifest } from './manifest';
import type { CustomFieldDef, TimelineFile } from '../../types';

/**
 * Stable id of this plugin: the value in its `timeline_plugins` row. Read from the
 * manifest so the id exists exactly once — the manifest is what the host reads,
 * so a second copy here is the one that goes stale.
 */
export const EXAMPLE_PLUGIN = exampleManifest.id;

/**
 * The `metadata` key the field writes to. A fact about this plugin, so it lives
 * here rather than in the core `src/types.ts` (see #18) — and it is declared in
 * the manifest's `metadataKeys`, which is what lets an uninstall clean it up.
 */
export const EXAMPLE_META_KEY = 'example';

/**
 * The key of the *derived* field. Nothing is stored under it — the value is
 * computed on every build (`exampleDerive`) — so it is deliberately NOT in the
 * manifest's `metadataKeys`: that list is what an uninstall purges, and there is
 * nothing on an item to purge.
 */
export const EXAMPLE_DERIVED_KEY = 'exampleDerived';

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
    {
      // A *derived* field: the plugin computes the value, so the form shows it
      // read-only and nothing is ever stored on this key. Delete it, and
      // `exampleDerive` with it, if every field here is something a user picks.
      key: EXAMPLE_DERIVED_KEY,
      label: 'Example (derived)',
      type: 'select',
      derived: true,
      options: choices.map((value) => ({ value })),
    },
  ];
}

/**
 * The values behind a `derived: true` field. Delete both this and the descriptor's
 * `derive` line if the plugin has none.
 *
 * Use it when the value *follows* from the item rather than being chosen: which
 * sprint its dates fall into, which cohort its start belongs to. Storing such a
 * value means the item can move out from under it, and a stale bucket looks exactly
 * like a chosen one — which is the bug this replaces, not a style preference.
 *
 * Two things the shape is asking for. Whatever the whole timeline decides (the
 * raster, the cohort boundaries) is computed **here**, once per build; the function
 * returned is pure over one item, so the rule is unit-testable in this folder and
 * can be reused by a tool handler. The host drops any key this plugin did not
 * declare `derived`, so returning more than the declaration is not a way in.
 */
export function exampleDerive(file: TimelineFile | null | undefined): DeriveFn | null {
  if (!file || !hasPlugin(file, EXAMPLE_PLUGIN)) return null;
  const { choices } = readConfig(file);
  if (!choices?.length) return null;
  // A stand-in rule: the real one belongs in a module of its own next to its test.
  return (item) => ({ [EXAMPLE_DERIVED_KEY]: item.start ? choices[0] : undefined });
}

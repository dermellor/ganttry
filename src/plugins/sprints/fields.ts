// The three item fields this plugin contributes, and the values behind the derived
// one.
//
// Two of them are chosen (`storyPoints`, `estimateConfidence`) and stored in the
// item's `metadata`; one is computed (`sprint`) and stored nowhere. Routing all three
// through the generic custom-field machinery buys the form control, the grouping, the
// filter and the context menu without a parallel code path.
//
// This module is imported by the registry **statically**, so it stays data-only:
// types, the contract barrel and this plugin's own `raster` module. Anything that
// reaches view code would land the plugin in the generic bundle and undo the lazy
// split (scripts/ci/check-bundle-split.sh).

import { hasPlugin, pluginConfig, type DeriveFn } from '../../pluginHost/api';
import type { CustomFieldDef, CustomFieldOption, TimelineFile } from '../../types';
import { sprintsManifest } from './manifest';
import {
  rasterFrom,
  readSprintConfig,
  sprintLabel,
  sprintOfItem,
  sprintValue,
  sprintsInPlay,
  type SprintRaster,
} from './raster';

/**
 * Stable id of this plugin, read from the manifest so the id exists exactly once.
 * The manifest is what the host reads, so a second copy here is the one that would
 * go stale.
 */
export const SPRINTS_PLUGIN = sprintsManifest.id;

/**
 * The key of the **derived** field. Nothing is ever stored under it: the value is
 * computed on every build by `sprintsDerive`, which is why it is deliberately absent
 * from the manifest's `metadataKeys` (an uninstall has nothing to purge). Storing it
 * would mean an item that moves keeps a sprint it is no longer in, and a stale bucket
 * is indistinguishable from a chosen one.
 */
export const SPRINT_KEY = 'sprint';

/** The estimate, chosen from `scale`. Stored on the item, so owned in the manifest. */
export const STORY_POINTS_KEY = 'storyPoints';

/** How much the estimate is trusted. Stored on the item. */
export const CONFIDENCE_KEY = 'estimateConfidence';

/**
 * The confidence options, values and labels alike in German.
 *
 * Normally a field stores an id and shows a label, so a reworded label costs nothing.
 * Here the value *is* the German word, because these three are already stored on
 * items (the example timeline carries them) and swapping in English ids would orphan
 * every existing value. They are three fixed words that will not be reworded; see
 * `AGENTS.md` in this folder.
 */
export const CONFIDENCE_OPTIONS: CustomFieldOption[] = [
  { value: 'hoch', label: 'hoch' },
  { value: 'mittel', label: 'mittel' },
  { value: 'niedrig', label: 'niedrig' },
];

/** This plugin's raster on a timeline, or null when it is off or unconfigured. */
export function rasterOf(file: TimelineFile | null | undefined): SprintRaster | null {
  if (!file || !hasPlugin(file, SPRINTS_PLUGIN)) return null;
  return rasterFrom(readSprintConfig(pluginConfig(file, SPRINTS_PLUGIN)));
}

/**
 * The plugin's fields, in the order they render.
 *
 * Nothing at all without a raster: `start` is required, and a sprint field with no
 * anchor behind it would be a control that cannot ever hold a value.
 *
 * The `sprint` field appears only when some item actually falls into a sprint. A
 * select with no options is a control the user cannot use, and an empty dimension in
 * the „Gruppieren" menu is a choice that does nothing. The other two do not depend on
 * any item being placed, so they survive that case: estimating an item that starts
 * before the anchor is still legitimate. All three need a usable raster, though,
 * because the estimate options come out of its `scale`.
 */
export function sprintsFields(file: TimelineFile | null | undefined): CustomFieldDef[] {
  const raster = rasterOf(file);
  if (!raster) return [];

  const defs: CustomFieldDef[] = [];

  const inPlay = sprintsInPlay(raster, file?.items ?? []);
  if (inPlay.length) {
    defs.push({
      key: SPRINT_KEY,
      // The label is half of what the interface shows: the core qualifies a
      // plugin's field with the plugin name, so the dimension reads „Sprints ·
      // Sprint" and the empty bucket „Ohne Sprints · Sprint" (dimensionLabel in
      // src/listGrouping.ts). Renaming either half renames both.
      label: 'Sprint',
      type: 'select',
      // Read-only everywhere, and skipped by the context menu: there is nothing to
      // set, because the item's own start decides the value.
      derived: true,
      // The options are the sprints the items occupy, chronologically, which is also
      // the order the lanes get: the grouping follows a field's declared options
      // before it falls back to first appearance.
      options: inPlay.map((n) => ({ value: sprintValue(n), label: sprintLabel(n) })),
    });
  }

  defs.push({
    key: STORY_POINTS_KEY,
    label: 'Story Points',
    type: 'select',
    // A short, fixed ladder that gets retargeted often: exactly the case the
    // right-click menu is worth it for.
    contextMenu: true,
    options: raster.scale.map((value) => ({ value })),
  });

  defs.push({
    key: CONFIDENCE_KEY,
    // „Confidence" is the word the practice uses; „Schätzsicherheit" would be a term
    // this plugin invented (see „How does it compare?" in the README).
    label: 'Confidence',
    type: 'select',
    contextMenu: true,
    options: CONFIDENCE_OPTIONS,
  });

  return defs;
}

/**
 * The value behind the `derived: true` sprint field.
 *
 * The factory shape is the contract: the raster is decided once per build here, and
 * the function handed back is pure over one item, which is what makes the rule
 * testable in this folder and lets `tools.ts` reuse the same bucketing. Returning
 * `null` is the right answer whenever the plugin is off or has no anchor.
 *
 * `undefined` for an item with no sprint (no start, or a start before the anchor) is
 * deliberate: the host drops absent values, so the item lands in the „Ohne …" bucket
 * instead of one with no name.
 */
export function sprintsDerive(file: TimelineFile | null | undefined): DeriveFn | null {
  const raster = rasterOf(file);
  if (!raster) return null;
  return (item) => {
    const sprint = sprintOfItem(raster, item);
    return { [SPRINT_KEY]: sprint == null ? undefined : sprintValue(sprint) };
  };
}

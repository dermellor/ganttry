// The item fields this plugin contributes, and the value behind the derived one.
//
// Four fields, and the interesting part is that two of them are about sprints:
//
//   - `sprint` is the **assignment**, stored in the item's `metadata`. Membership is an
//     act, not a date test (canon makes the Sprint Backlog a selection), and none of
//     the six products checked derives it from dates. Its options are the `sprints`
//     rows, by row id, so renaming „Sprint 7" orphans nothing.
//   - `sprintByDate` is the **suggestion**, computed and stored nowhere: the sprint
//     whose window contains the item's start. It is what makes the timeline's own axis
//     useful for planning, and it is a second dimension rather than a correction:
//     resolving a disagreement silently would edit either the plan or the commitment,
//     and both are somebody's decision.
//
// The two are labelled apart on purpose, because the core qualifies a plugin's field
// with the plugin name: the „Gruppieren" menu reads „Sprints · Sprint" and „Sprints ·
// Sprint nach Datum", and one of them being called just „Sprint" for both would make
// the two dimensions indistinguishable in the one place a user picks between them.
//
// `storyPoints` and `estimateConfidence` are unchanged and must stay so: both are
// stored on items in the committed example, so a renamed key or a reworded *value*
// silently drops every existing one (see `AGENTS.md` in this folder).
//
// This module is imported by the registry **statically**, so it stays data-only:
// types, the contract barrel and this plugin's own modules. Anything that reaches view
// code would land the plugin in the generic bundle and undo the lazy split
// (scripts/ci/check-bundle-split.sh).

import { hasPlugin, pluginConfig, type DeriveFn } from '../../pluginHost/api';
import type { CustomFieldDef, CustomFieldOption, TimelineFile } from '../../types';
import { readSprintConfig } from './raster';
import {
  CONFIDENCE_KEY,
  SPRINTS_PLUGIN,
  SPRINT_BY_DATE_KEY,
  SPRINT_KEY,
  STORY_POINTS_KEY,
  rasterOf,
  readSprints,
  suggestedSprintId,
  type Sprint,
} from './sprints';

// Re-exported rather than declared twice: the keys and the plugin id belong to the data
// model (`sprints.ts`), and the rest of the plugin already imports them from here.
// Two `const SPRINT_KEY = 'sprint'` is how a rename fixes one reader and not the other.
export { CONFIDENCE_KEY, SPRINTS_PLUGIN, SPRINT_BY_DATE_KEY, SPRINT_KEY, STORY_POINTS_KEY } from './sprints';
export { rasterOf } from './sprints';

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

/** One option per sprint row: the id is the value, the name is what a person reads. */
function optionsOf(sprints: readonly Sprint[]): CustomFieldOption[] {
  return sprints.map((sprint) => ({ value: sprint.id, label: sprint.name }));
}

/**
 * The plugin's fields, in the order they render.
 *
 * Nothing at all when the plugin has neither a sprint row nor a usable raster: there is
 * then no sprint to assign to and no window to fall into, so every control would be one
 * the user cannot use, and an empty dimension in „Gruppieren" is a choice that does
 * nothing.
 *
 * The two sprint fields appear on different evidence, and that difference is the point:
 *
 *   - the **assignment** appears as soon as one sprint row exists, including sprints
 *     holding nothing, because assigning the first item to an empty sprint is the whole
 *     planning act, so its options are every row.
 *   - the **suggestion** appears only when some item actually falls into a sprint's
 *     window, and its options are only those sprints. An option there is a bucket that
 *     exists rather than a choice somebody can make, and a run of empty lanes out to
 *     the end of the raster says nothing.
 */
export function sprintsFields(file: TimelineFile | null | undefined): CustomFieldDef[] {
  if (!file || !hasPlugin(file, SPRINTS_PLUGIN)) return [];
  const config = readSprintConfig(pluginConfig(file, SPRINTS_PLUGIN));
  const raster = rasterOf(file);
  const sprints = readSprints(file);
  if (!raster && !sprints.length) return [];

  const defs: CustomFieldDef[] = [];

  if (sprints.length) {
    defs.push({
      key: SPRINT_KEY,
      // Half of what the interface shows: the core prefixes the plugin name, so this
      // reads „Sprints · Sprint" and the empty bucket „Ohne Sprints · Sprint"
      // (dimensionLabel in src/listGrouping.ts). Renaming either half renames both.
      label: 'Sprint',
      type: 'select',
      // Retargeting an item into another sprint is the action people take most in
      // planning, and it is exactly one value on one item: the right-click menu is
      // what it is for.
      contextMenu: true,
      options: optionsOf(sprints),
    });

    const occupied = new Set<string>();
    for (const item of file.items ?? []) {
      const suggested = suggestedSprintId(sprints, raster, item);
      if (suggested) occupied.add(suggested);
    }
    const inPlay = sprints.filter((sprint) => occupied.has(sprint.id));
    if (inPlay.length) {
      defs.push({
        key: SPRINT_BY_DATE_KEY,
        label: 'Sprint nach Datum',
        type: 'select',
        // Read-only everywhere and skipped by the context menu: there is nothing to
        // set, because the item's own start decides the value.
        derived: true,
        options: optionsOf(inPlay),
      });
    }
  }

  defs.push({
    key: STORY_POINTS_KEY,
    label: 'Story Points',
    type: 'select',
    // A short, fixed ladder that gets retargeted often: exactly the case the
    // right-click menu is worth it for.
    contextMenu: true,
    options: config.scale.map((value) => ({ value })),
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
 * The value behind the `derived: true` field.
 *
 * The factory shape is the contract: the sprints and the raster are read once per
 * build here, and the function handed back is pure over one item, which is what makes
 * the rule testable in this folder and lets the tools reuse the same bucketing.
 *
 * Returning `null` is the right answer while the plugin is off or has no sprint rows:
 * there are then no windows, so there is no suggestion to make. `undefined` for an item
 * that falls into none of them is deliberate too: the host drops absent values, so the
 * item lands in the „Ohne …" bucket instead of one with no name.
 */
export function sprintsDerive(file: TimelineFile | null | undefined): DeriveFn | null {
  if (!file || !hasPlugin(file, SPRINTS_PLUGIN)) return null;
  const sprints = readSprints(file);
  if (!sprints.length) return null;
  const raster = rasterOf(file);
  return (item) => {
    const suggested = suggestedSprintId(sprints, raster, item);
    return { [SPRINT_BY_DATE_KEY]: suggested ?? undefined };
  };
}

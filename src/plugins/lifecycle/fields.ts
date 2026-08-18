// The item fields this plugin contributes, and the values behind the two derived
// ones.
//
// Eight fields, and the split between them is the model:
//
//   - Six are **input**, and four of those are dates somebody reads off a vendor's
//     lifecycle page. They are stored in the item's `metadata` and declared in the
//     manifest's `metadataKeys`, so an uninstall cleans them off.
//   - Two are **computed** and stored nowhere: the latest possible start, and which
//     support window the plan ends in. Both follow from the item's own dates plus the
//     lead time, so keeping a copy would let the item move out from under it, and a
//     stale „inside standard support" is indistinguishable from a true one.
//
// **Every date field is `type: 'text'`, and that is a limit rather than a choice.**
// `CustomFieldType` is `text | select | multi-select` — there is no date type and no
// number type — so the form offers no picker and this plugin parses and refuses in
// `lifecycle.ts` instead. That is why `day()` is strict about the shape: „01.05.2026"
// accepted here would read as an American date and put every computed date months
// from where the author meant it, with nothing on screen saying so.
//
// This module is imported by the registry **statically**, so it stays data-only:
// types, the contract barrel and this plugin's own modules. Anything that reaches view
// code would land the plugin in the generic bundle and undo the lazy split.

import { hasPlugin, pluginConfig, type DeriveFn } from '../../pluginHost/api';
import type { CustomFieldDef, TimelineFile } from '../../types';
import { t } from './messages';
import {
  CUTOVER_KEY,
  END_OF_SUPPORT_KEY,
  EXTENDED_UNTIL_KEY,
  LATEST_START_KEY,
  LEAD_TIME_KEY,
  LIFECYCLE_PLUGIN,
  SHUTDOWN_KEY,
  SUPPORT_WINDOWS,
  SUPPORT_WINDOW_KEY,
  SYSTEM_KEY,
  deadlineOf,
  latestStart,
  readConfig,
  readPlan,
  supportWindowOf,
} from './lifecycle';

// Re-exported rather than declared twice: the keys and the plugin id belong to the
// data model (`lifecycle.ts`), and two `const CUTOVER_KEY = 'cutover'` is how a rename
// fixes one reader and not the other.
export {
  CUTOVER_KEY,
  END_OF_SUPPORT_KEY,
  EXTENDED_UNTIL_KEY,
  LATEST_START_KEY,
  LEAD_TIME_KEY,
  LIFECYCLE_PLUGIN,
  SHUTDOWN_KEY,
  SUPPORT_WINDOW_KEY,
  SYSTEM_KEY,
} from './lifecycle';

/** The label for one support window, looked up per call so it follows the reader. */
function windowLabel(window: (typeof SUPPORT_WINDOWS)[number]): string {
  return t(`window.${window}`);
}

/**
 * The plugin's fields, in the order they render.
 *
 * All eight as soon as the plugin is enabled, with **no config requirement** — and
 * that is the difference from a plugin whose fields are options: there is nothing to
 * derive the controls from, because a date field offers no choices. A timeline that
 * has just switched the plugin on needs somewhere to type the first end-of-support
 * date, so gating the fields on config would leave the user with no way to produce
 * the data the config is about.
 *
 * The two computed fields are declared unconditionally for the same reason and yield
 * `undefined` per item until the data is there, which lands that item in the „Ohne …"
 * bucket rather than in one with no name.
 */
export function lifecycleFields(file: TimelineFile | null | undefined): CustomFieldDef[] {
  if (!file || !hasPlugin(file, LIFECYCLE_PLUGIN)) return [];

  return [
    {
      key: SYSTEM_KEY,
      // Half of what the interface shows: the core prefixes the plugin name, so this
      // reads „Lifecycle · System" in the grouping menu. Renaming either half renames
      // both.
      label: t('field.system'),
      type: 'text',
    },
    { key: END_OF_SUPPORT_KEY, label: t('field.endOfSupport'), type: 'text' },
    { key: EXTENDED_UNTIL_KEY, label: t('field.extendedUntil'), type: 'text' },
    { key: LEAD_TIME_KEY, label: t('field.leadTimeDays'), type: 'text' },
    { key: CUTOVER_KEY, label: t('field.cutover'), type: 'text' },
    { key: SHUTDOWN_KEY, label: t('field.shutdown'), type: 'text' },
    {
      key: LATEST_START_KEY,
      label: t('field.latestStart'),
      // A date rather than a choice, so `text`: the options of a select would be every
      // day in the calendar.
      type: 'text',
      derived: true,
    },
    {
      key: SUPPORT_WINDOW_KEY,
      label: t('field.supportWindow'),
      // A select, because this is the field the domain groups by: „which of my systems
      // are planned past their own end of life" is one grouping away once the buckets
      // exist. Every window is offered rather than only the occupied ones — three
      // fixed states, so an empty bucket is a real answer („nothing is unsupported")
      // rather than a lane out to the end of a raster.
      type: 'select',
      derived: true,
      options: SUPPORT_WINDOWS.map((value) => ({ value, label: windowLabel(value) })),
    },
  ];
}

/**
 * The values behind the two `derived: true` fields.
 *
 * The factory shape is the contract: the config is read once per build here, and the
 * function handed back is pure over one item, which is what makes the rules testable
 * in this folder and lets the tool handlers reuse exactly the same arithmetic.
 *
 * The support window is measured at the **shutdown** date, falling back to the
 * cutover and then to the item's own end of the plan. That is the day the question is
 * about: „will the old system still be supported when we finally switch it off" is
 * what a migration plan is trying to answer, and measuring at the start would report
 * every plan as safe on the day it was written.
 */
export function lifecycleDerive(file: TimelineFile | null | undefined): DeriveFn | null {
  if (!file || !hasPlugin(file, LIFECYCLE_PLUGIN)) return null;
  const config = readConfig(pluginConfig(file, LIFECYCLE_PLUGIN));

  return (item) => {
    const plan = readPlan(item, config);
    if (!deadlineOf(plan)) return {};
    const measuredAt = plan.shutdown ?? plan.cutover;
    return {
      [LATEST_START_KEY]: latestStart(plan) ?? undefined,
      [SUPPORT_WINDOW_KEY]: supportWindowOf(measuredAt, plan) ?? undefined,
    };
  };
}

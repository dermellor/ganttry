// Which plugins a timeline could carry, and which of them it does.
//
// **The source is what the instance installed, not what the client registry
// holds**, and the difference is the whole reason this module exists. `register()`
// refuses a manifest whose contract range the host cannot satisfy, so a plugin
// that is installed but unrunnable never reaches the registry at all. Listing from
// there would answer „which plugins work" with silence about the ones that do not,
// which is precisely the case somebody opens this section to understand.
//
// **DOM-free on purpose.** The section that draws this imports `render.ts`, and
// that imports vis-timeline, which does not load outside a browser. The half with
// a rule in it belongs where it can be tested without one, like `itemExtent.ts`
// and `phaseOverlap.ts` (AGENTS.md → „A rule lives in exactly one place").

import { manifestText } from './pluginHost/messages';
import { hasPlugin } from './pluginHost/plugins';
import type { PluginStatus, TimelineFile } from './types';

/** One plugin as the section reads it. */
export type PluginRow = {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  views: string[];
  /** Switched on for THIS timeline. */
  enabled: boolean;
  /**
   * Why it cannot be switched on here, as a code the interface words itself.
   *
   * A code rather than a sentence because the sentence belongs to the reader's
   * language and this module has no business choosing one. The server's own
   * `problem` string carries the specifics for a log and for whoever wrote the
   * plugin, and is deliberately not what a user is shown.
   */
  refusal: PluginStatus['reason'] | null;
};

/** The manifest's declared views, named as the reader's language names them. */
function viewLabels(status: PluginStatus): string[] {
  const declared = (status.manifest as { views?: { id: string; label: string }[] })?.views;
  if (!Array.isArray(declared)) return [];
  return declared.map((v) => manifestText(status.id, `manifest.view.${v.id}`, v.label));
}

/**
 * What the section lists, in the order the instance reports.
 *
 * A plugin the instance has switched off is listed with that as its reason: it
 * exists here, and „you may not switch this on" and „this does not exist" must not
 * look the same (AGENTS.md → „Every stored setting is reachable").
 */
export function pluginRows(
  statuses: readonly PluginStatus[],
  file: TimelineFile | null | undefined,
): PluginRow[] {
  return statuses.map((status) => {
    const declaredName = (status.manifest as { name?: string })?.name ?? status.id;
    return {
      id: status.id,
      name: manifestText(status.id, 'manifest.name', declaredName),
      version: status.version,
      capabilities: [...status.capabilities],
      views: viewLabels(status),
      enabled: hasPlugin(file, status.id),
      refusal: status.loadable ? null : (status.reason ?? 'invalid-manifest'),
    };
  });
}

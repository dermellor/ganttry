// What the „Plugins" section of a timeline's settings shows, as data.
//
// Enabling a plugin on a timeline has been pure data since the beginning — a row in
// `timeline_plugins`, surfaced as `TimelineFile.plugins` — and the API for one plugin
// on one timeline exists too (`PUT`/`DELETE /api/source/<id>/plugin/<id>`). What was
// missing is the interface: switching a plugin on meant writing that row by hand.
//
// DOM-free and unit-tested, for the reason `pluginLines` beside it is: what the
// interface *says* about a plugin is a verdict joined from three sources (the
// registry, the loader, this timeline), and a verdict assembled inside a render
// function is one nobody can test. This module adds the manifest half — what an
// installer would see — to the state half `pluginLines` already answers.

import { pluginLines, type PluginLine } from './pluginHost/installed';
import type { PluginManifest } from './pluginHost/manifest';
import type { LoadOutcome } from './pluginHost/loader';
import type { PluginRef, PluginStatus } from './types';

/** One row of the section: what the plugin is, and what may be done with it here. */
export type PluginSettingsRow = PluginLine & {
  /**
   * May it be switched on for this timeline?
   *
   * The host's *willingness* rather than „is its code running right now". A contract
   * range this host does not satisfy is a statement about the plugin and takes the
   * switch away; an artifact that failed to load this session is infrastructure, and
   * the row it would write is still the right row — the data rules of an installed
   * plugin keep being enforced either way (see pluginHost/installed.ts).
   */
  offerable: boolean;
  /** Granted-and-declared capabilities, from the manifest — what an installer saw. */
  capabilities: string[];
  /** The views it would contribute here, by label. */
  views: string[];
  /**
   * The schema its config is edited and validated against, or null when the manifest
   * declares none. The form is derived from it (`configForm` in pluginConfigForm.ts),
   * and it is the same object the API validates the saved bag against.
   */
  configSchema: Record<string, unknown> | null;
  /** Does it declare `publicRead` collections, so publishing this timeline's rows is a choice? */
  publishable: boolean;
  /** What this timeline currently stores for it. */
  config: Record<string, unknown>;
  public: boolean;
};

/**
 * The manifest to describe a plugin by: the one the host handed over, or null.
 *
 * Deliberately without a fallback of its own. Resolving „the registry row carries no
 * manifest, so use the build's" is the host's job and it already does it
 * (`installedPluginStatuses`), which is why a seeded built-in arrives here with a real
 * name and version. A second copy of that rule in the browser would be the copy that
 * keeps saying yesterday's answer after the first one changes.
 */
function describingManifest(plugin: PluginStatus): PluginManifest | null {
  const stored = plugin.manifest as PluginManifest | undefined;
  return stored && Object.keys(stored).length ? stored : null;
}

/** The rows the section renders, in the order it renders them. */
export function pluginSettingsRows(
  installed: PluginStatus[],
  enabled: readonly PluginRef[],
  outcomes: readonly LoadOutcome[] = [],
): PluginSettingsRow[] {
  const refs = new Map(enabled.map((ref) => [ref.id, ref]));
  return pluginLines(installed, [...refs.keys()], outcomes).map((line) => {
    const plugin = installed.find((p) => p.id === line.id);
    const manifest = plugin ? describingManifest(plugin) : null;
    const ref = refs.get(line.id);
    const schema = manifest?.configSchema ?? null;
    return {
      ...line,
      offerable: plugin?.loadable === true,
      capabilities: manifest?.capabilities ? [...manifest.capabilities] : [],
      views: (manifest?.views ?? []).map((v) => v.label || v.id),
      configSchema: schema,
      publishable: (manifest?.publicRead?.collections?.length ?? 0) > 0,
      config: ref?.config ?? {},
      public: ref?.public === true,
    };
  });
}

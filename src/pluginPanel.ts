// The plugin list: which plugins this instance has, and where each one stands.
//
// It exists for one question that otherwise has no answer in the interface:
// „why is that view not there?". A plugin the host cannot load simply does not
// appear, and without somewhere to look, a version mismatch and a broken plugin
// are indistinguishable from a bug in the app.
//
// The host builds this, not a plugin — the whole list would be missing exactly
// when the plugin that renders it fails to load.

import { pluginLines, type PluginLine } from './pluginHost/installed.ts';
import type { LoadOutcome } from './pluginHost/loader.ts';
import type { PluginStatus, TimelineFile } from './types';

/**
 * Where the registry comes from, in the order that makes both deploy shapes work.
 *
 * A served instance answers `GET /api/plugins` and is authoritative — a plugin
 * installed after the last build has to appear without one. A static deploy has
 * no API at all, so the copy the build baked into the config is what it has. The
 * fetch failing therefore falls back rather than erroring: „the API is not there"
 * is the normal state of a static deploy, not a fault.
 *
 * This is not the „try the API, fall back to a stale file" pattern the project
 * bans, and the difference is what is being fetched: a list of which plugins
 * exist, never a timeline's content. A stale entry here shows one wrong row in a
 * diagnostic list; a stale timeline would be mistaken for live data.
 */
export async function loadPluginStatuses(fromConfig: PluginStatus[] | undefined): Promise<PluginStatus[]> {
  try {
    const res = await fetch('/api/plugins');
    if (res.ok) {
      const body = (await res.json()) as { plugins?: PluginStatus[] };
      if (Array.isArray(body.plugins)) return body.plugins;
    }
  } catch {
    // no API on this deploy — the built copy below is the answer
  }
  return fromConfig ?? [];
}

function lineElement(line: PluginLine): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'plugin-line';
  li.classList.toggle('plugin-line-problem', !line.running);

  const name = document.createElement('span');
  name.className = 'plugin-line-name';
  name.textContent = line.name;
  li.append(name);

  const version = document.createElement('span');
  version.className = 'plugin-line-version';
  version.textContent = line.version;
  li.append(version);

  // Either the plugin is fine and the only open question is whether this timeline
  // uses it, or it cannot run and the reason is the thing worth reading. Showing
  // both at once would bury the reason behind a state that no longer matters.
  const state = document.createElement('span');
  state.className = 'plugin-line-state';
  state.textContent = line.running
    ? line.enabledHere
      ? 'in dieser Timeline aktiv'
      : 'nicht aktiv'
    : reasonText(line);
  // The full sentence carries the specifics a fixed phrase cannot — which version,
  // which manifest field — so it stays reachable on hover rather than being lost.
  if (line.problem) state.title = line.problem;
  li.append(state);

  return li;
}

/**
 * The reason in the interface's own language.
 *
 * Worded here rather than shown as it arrives, because `problem` is written for
 * logs and for whoever wrote the plugin, and printing a server's English sentence
 * at a user of a German interface is how a diagnostic starts looking like a leak.
 * An unknown code falls back to the sentence: a new reason showing up in English
 * is worse than the phrase, but far better than an empty line.
 */
function reasonText(line: PluginLine): string {
  switch (line.reason) {
    // The host refused before trying.
    case 'disabled':
      return 'für diese Instanz abgeschaltet';
    case 'api-version':
      return 'passt nicht zu dieser Host-Version';
    case 'invalid-manifest':
      return 'das Manifest ist nicht mehr gültig';
    // The loader tried and could not.
    case 'unsupported-artifact':
      return 'die Herkunft des Codes wird nicht unterstützt';
    case 'unreachable':
      return 'der Code ist nicht erreichbar';
    case 'integrity':
      return 'der Code weicht von seiner Prüfsumme ab';
    case 'invalid-module':
      return 'der Code passt nicht zum Manifest';
    case 'threw':
      return 'das Laden ist gescheitert';
    default:
      return line.problem ?? 'kann nicht geladen werden';
  }
}

/** Render the list into `container`, replacing whatever was there. */
export function renderPluginList(
  container: HTMLElement,
  installed: PluginStatus[],
  file: TimelineFile | null | undefined,
  outcomes: readonly LoadOutcome[] = [],
): void {
  const lines = pluginLines(installed, (file?.plugins ?? []).map((p) => p.id), outcomes);
  container.replaceChildren();
  if (!lines.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-empty';
    empty.textContent = 'Keine Plugins installiert.';
    container.append(empty);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'plugin-list';
  for (const line of lines) list.append(lineElement(line));
  container.append(list);
}

// Loading the plugins the instance installed.
//
// Until now the browser ran exactly what the build contained: `register()` was
// called by a static import, and the install registry from #13 only governed the
// server. This is the step that closes that gap.
//
// **Plugins run in the app's own realm.** That is a decision with a rationale and
// a set of things that protect an instance instead of a sandbox; both are written
// down in docs/plugin-isolation.md, including the condition under which the
// decision gets revisited. What matters here: installing a plugin is trusting its
// author, the way installing a browser extension is, and nothing in this file
// pretends otherwise.
//
// What this file DOES guarantee:
//
//   - the code is the code that was pinned (integrity), so a plugin cannot be
//     swapped under a version somebody already approved;
//   - a plugin that fails at any step is skipped with a reason a human can read,
//     never silently;
//   - a plugin that throws does not take the timeline down with it.
//
// Fetch and import are injected rather than called directly, so the whole
// sequence is testable without a network or a module registry.

import { planFor, verifyIntegrity } from './artifact.ts';
import { register, type DeriveFn, type PluginDescriptor, type PluginModule } from './registry.ts';
import { hasPlugin } from './plugins.ts';
import { validateManifest, type PluginManifest } from './manifest.ts';
import type { CustomFieldDef, PluginStatus, TimelineFile } from '../types';

/** What happened to one plugin at boot. Shown to the user, never swallowed. */
export type LoadOutcome = {
  pluginId: string;
  /** Is the plugin's code running now? */
  loaded: boolean;
  /**
   * Why not. Absent only when `loaded`.
   *
   * These are separate from `PluginStatus.reason` on purpose: that one says why the
   * host would not even try (switched off, wrong contract version), this one says
   * what went wrong while trying. An operator debugging „my plugin is not there"
   * needs to know which of the two happened.
   */
  reason?: 'skipped' | 'unsupported-artifact' | 'unreachable' | 'integrity' | 'invalid-module' | 'threw';
  problem?: string;
};

export type LoaderDeps = {
  /** Fetch an artifact's bytes. Rejects like `fetch` does. */
  fetchArtifact(url: string): Promise<ArrayBuffer>;
  /** Turn verified bytes into a module. */
  importModule(bytes: ArrayBuffer, url: string): Promise<unknown>;
  /** Register a descriptor with the host. Defaults to the real registry. */
  registerPlugin?(descriptor: PluginDescriptor): void;
};

/**
 * The default way to execute verified bytes: a blob URL plus a dynamic import.
 *
 * Importing the original URL again would be one line shorter and wrong: between
 * the fetch we hashed and the import, the server is free to answer differently,
 * and the check would be decorative. Executing the exact bytes that were verified
 * removes that window.
 *
 * The cost is that `script-src` has to allow `blob:`, which is noted in the CSP
 * this repo ships. It is the narrower price of the two.
 */
export async function importFromBlob(bytes: ArrayBuffer): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    // The module is resolved and cached by then; the URL only kept the bytes
    // reachable long enough to import them.
    URL.revokeObjectURL(url);
  }
}

export function browserDeps(): LoaderDeps {
  return {
    async fetchArtifact(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    },
    importModule: (bytes) => importFromBlob(bytes),
  };
}

/** What a plugin artifact may export. Everything is optional but the view. */
type LoadedModule = {
  renderView?: PluginModule['renderView'];
  fields?: (file: TimelineFile | null | undefined) => CustomFieldDef[];
  derive?: (file: TimelineFile | null | undefined) => DeriveFn | null;
};

/**
 * Check that an imported module is shaped like a plugin, given what its manifest
 * promised.
 *
 * A manifest declaring views whose module has no `renderView` is refused rather
 * than registered: the view button would appear and do nothing, which reads as a
 * broken app rather than a broken plugin.
 */
export function moduleProblems(manifest: PluginManifest, mod: unknown): string[] {
  if (typeof mod !== 'object' || mod === null) return ['the artifact did not export an object'];
  const m = mod as LoadedModule;
  const problems: string[] = [];
  if ((manifest.views ?? []).length && typeof m.renderView !== 'function') {
    problems.push('the manifest declares views but the artifact exports no renderView()');
  }
  if (m.fields != null && typeof m.fields !== 'function') problems.push('fields must be a function when present');
  if (m.derive != null && typeof m.derive !== 'function') problems.push('derive must be a function when present');
  // A field declared `derived` with no `derive` behind it is the one combination
  // that produces a control which can never hold a value, and it cannot be checked
  // from the manifest: the declaration lives in `fields(file)`, which is code.
  // Reported rather than refused, because it depends on the timeline: `fields` may
  // legitimately return nothing at all for the file this check has no access to.
  if (m.derive == null && typeof m.fields === 'function') {
    problems.push(...deriveWithoutValues(m));
  }
  return problems;
}

/**
 * „Declares a derived field but exports no derive" as a problem string, or nothing.
 *
 * Probed with no file, which is the only argument this layer has. A plugin that
 * derives its fields from the timeline returns `[]` here and is not accused.
 */
function deriveWithoutValues(m: LoadedModule): string[] {
  let defs: CustomFieldDef[] = [];
  try {
    defs = m.fields?.(null) ?? [];
  } catch {
    return [];
  }
  const derived = defs.filter((d) => d?.derived).map((d) => d.key);
  return derived.length
    ? [`fields declares derived field(s) ${derived.join(', ')} but the artifact exports no derive()`]
    : [];
}

/**
 * Build the descriptor for a runtime-loaded plugin.
 *
 * `matches` and `applies` are derived by the HOST from enablement rather than
 * taken from the plugin. An in-tree plugin can refine `matches` (product-roadmap
 * also demands a populated model before offering its view), but that refinement
 * is a judgement about its own data that a third party cannot express in the
 * contract today, and letting a plugin decide its own availability would let it
 * put a button in the header on a timeline that never enabled it.
 *
 * `fields`, `derive` and `renderView` are all wrapped: a plugin that throws must
 * cost the user its own view, not the timeline. `fields` in particular runs on the
 * item form's path, where an exception would take the form down for every item.
 *
 * **`derive` is wired here, unlike `tools` below**, and the difference is where the
 * code runs. A derived value is computed in the browser on the same path as
 * `fields`, so an artifact's `derive` is no new trust question — while a tool runs
 * in a server process. Leaving it out was worse than a gap: an artifact declaring
 * `derived: true` would show a read-only control that stays empty forever, which is
 * exactly the symptom the `^1.5` version gate promises to prevent.
 *
 * **`tools` is deliberately not wired here, and an artifact's tools do not run.**
 * A tool is called by a server process, and executing an installed artifact's
 * code there is a decision docs/plugin-isolation.md has not taken — this file
 * loads plugins into the app's own realm in the browser, which is a different
 * trust question from running them next to the database. The gap does not need a
 * check of its own to be visible: `pluginTools()` reports such a plugin's verbs
 * as declared with no implementation, which is what they are.
 */
export function descriptorFor(manifest: PluginManifest, mod: unknown, onError: (e: unknown) => void): PluginDescriptor {
  const m = (mod ?? {}) as LoadedModule;
  const enabled = (file: TimelineFile | null | undefined) => hasPlugin(file, manifest.id);
  return {
    manifest,
    matches: enabled,
    applies: enabled,
    fields: (file) => {
      if (!m.fields) return [];
      try {
        return m.fields(file) ?? [];
      } catch (e) {
        onError(e);
        return [];
      }
    },
    derive: (file) => {
      if (!m.derive) return null;
      try {
        const fn = m.derive(file);
        if (typeof fn !== 'function') return null;
        // The per-item half is wrapped too: it runs once per item on every build, so
        // one throw there would otherwise cost every item its fields.
        return (item) => {
          try {
            return fn(item) ?? {};
          } catch (e) {
            onError(e);
            return {};
          }
        };
      } catch (e) {
        onError(e);
        return null;
      }
    },
    load: async () => ({
      renderView: (container, viewId, host) => {
        try {
          m.renderView?.(container, viewId, host);
        } catch (e) {
          onError(e);
          renderViewFailure(container, manifest, e);
        }
      },
    }),
  };
}

/**
 * Put the failure where the view would have been.
 *
 * A plugin that throws mid-render otherwise leaves whatever it managed to paint,
 * which looks like a half-loaded page rather than a fault, and the user reports
 * „the pricing view is broken" without the sentence that would explain it.
 */
function renderViewFailure(container: HTMLElement, manifest: PluginManifest, error: unknown): void {
  // `container.ownerDocument`, never the global `document`. The habit matters
  // beyond this function: reaching for the global is what ties code to the one
  // realm it happens to start in, and it is the assumption that would have to be
  // unpicked from every plugin if this host ever grows a sandbox
  // (docs/plugin-isolation.md). The host has no business modelling the habit it
  // asks plugins to avoid.
  const doc = container.ownerDocument;
  container.replaceChildren();
  const box = doc.createElement('p');
  box.className = 'plugin-view-error';
  box.textContent = `„${manifest.name}" konnte nicht dargestellt werden.`;
  const detail = doc.createElement('span');
  detail.className = 'plugin-view-error-detail';
  detail.textContent = error instanceof Error ? error.message : String(error);
  box.append(' ', detail);
  container.append(box);
}

/**
 * Load every installed plugin, and report what happened to each.
 *
 * Sequential rather than parallel, deliberately: the whole point is a readable
 * account of what the instance did at boot, and interleaved failures from six
 * plugins are harder to attribute than six lines in order. The set is small.
 */
export async function loadInstalledPlugins(
  statuses: readonly PluginStatus[],
  deps: LoaderDeps,
  onError: (pluginId: string, error: unknown) => void = () => {},
): Promise<LoadOutcome[]> {
  const outcomes: LoadOutcome[] = [];
  const registerWith = deps.registerPlugin ?? register;

  for (const status of statuses) {
    // Already decided against by the host: switched off, or a contract version
    // this host does not satisfy. The reason is already phrased; repeating the
    // decision here would be a second place to keep it in step.
    if (!status.loadable) {
      outcomes.push({ pluginId: status.id, loaded: false, reason: 'skipped', problem: status.problem });
      continue;
    }

    const plan = planFor(status);
    if (plan.action === 'refuse') {
      outcomes.push({ pluginId: status.id, loaded: false, reason: 'unsupported-artifact', problem: plan.problem });
      continue;
    }
    // Compiled into the bundle, registered by its own static import. Reported as
    // loaded so the list accounts for every installed plugin rather than leaving
    // the built-in ones unexplained.
    if (plan.action === 'builtin') {
      outcomes.push({ pluginId: status.id, loaded: true });
      continue;
    }

    // The manifest is re-validated here even though the registry checked it at
    // install: `register()` refuses an invalid one by throwing, and arriving at a
    // throw with no message of our own would report a contract problem as a crash.
    const validated = validateManifest(status.manifest);
    if (!validated.ok) {
      outcomes.push({
        pluginId: status.id,
        loaded: false,
        reason: 'invalid-module',
        problem: `its manifest is not valid: ${validated.problems.join('; ')}`,
      });
      continue;
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await deps.fetchArtifact(plan.url);
    } catch (e) {
      onError(status.id, e);
      outcomes.push({
        pluginId: status.id,
        loaded: false,
        reason: 'unreachable',
        problem: `could not fetch ${plan.url}: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (plan.integrity) {
      const verdict = await verifyIntegrity(bytes, plan.integrity);
      if (!verdict.ok) {
        outcomes.push({ pluginId: status.id, loaded: false, reason: 'integrity', problem: verdict.problem });
        continue;
      }
    }

    let mod: unknown;
    try {
      mod = await deps.importModule(bytes, plan.url);
    } catch (e) {
      onError(status.id, e);
      outcomes.push({
        pluginId: status.id,
        loaded: false,
        reason: 'threw',
        problem: `the artifact failed to execute: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const problems = moduleProblems(validated.manifest, mod);
    if (problems.length) {
      outcomes.push({ pluginId: status.id, loaded: false, reason: 'invalid-module', problem: problems.join('; ') });
      continue;
    }

    try {
      registerWith(descriptorFor(validated.manifest, mod, (e) => onError(status.id, e)));
      outcomes.push({ pluginId: status.id, loaded: true });
    } catch (e) {
      onError(status.id, e);
      outcomes.push({
        pluginId: status.id,
        loaded: false,
        reason: 'threw',
        problem: `registration failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return outcomes;
}

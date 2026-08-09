// The host side of the plugin API: what `createHostApi` gates, implemented.
//
// `hostApi.ts` has described this object since #14 and nothing supplied it, so a
// runtime-loaded plugin could render and nothing else — it could not read the
// timeline it was rendering into, could not see its own config, and could not
// write a single row of its own collections. A field-only plugin worked, because
// `fields(file)` is handed the file; a view plugin was blind. That was found by
// trying to build a plugin outside this repository
// (<https://github.com/dermellor/zeitlines/issues/16>), which is what that issue
// is for.
//
// Two shape rules from `hostApi.ts` are honoured here rather than restated:
//
//   - **Serializable in, serializable out.** Nothing hands a plugin a live app
//     object — not `state`, not the file it holds. `timeline()` returns a deep
//     copy, because a plugin that mutates the snapshot would be editing the app's
//     state through a hole nobody declared, and the same call behind an iframe
//     would silently stop working (docs/plugin-isolation.md).
//   - **Writes go through the host.** These methods call the same endpoints the
//     interface calls, so a plugin cannot bypass optimistic locking, validation
//     or the auth gate by having its own fetch.
//
// The backend is built PER PLUGIN, because `data` is scoped to the caller's own
// collections: the plugin id is bound here rather than passed as an argument, so
// there is no call shape in which one plugin can name another's data.

import { apiAddItem, apiDeleteItem, apiJson, apiUpdateItem } from '../editor';
import { state } from '../state';
import { onTimelineChanged } from './changes';
import { createDataApi } from './dataApi';
import { createHostApi, type HostApi, type HostApiBackend, type ItemsApi } from './hostApi';
import { HOST_API_VERSION } from './apiVersion';
import type { PluginManifest } from './manifest';
import type { TimelineFileItem } from '../types';

/**
 * The active source, or a refusal that names the reason.
 *
 * „No timeline loaded" and „this source is not writable" are different answers,
 * and collapsing them into a silent no-op is how a plugin author spends an
 * afternoon on a write that was never going to happen.
 */
function sourceId(): string {
  const id = state.activeSourceId;
  if (!id) throw new Error('no timeline is loaded');
  return id;
}

/** A structural copy, so a plugin cannot reach the app's state through its snapshot. */
function snapshot<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The item writes, over the same endpoints the interface uses. */
function itemsApi(): ItemsApi {
  return {
    add: (item: TimelineFileItem) => apiAddItem(sourceId(), item),
    update: (id, patch, version) => apiUpdateItem(sourceId(), id, patch as Record<string, unknown>, version),
    remove: (id) => apiDeleteItem(sourceId(), id),
  };
}

/**
 * Everything before the capability gate. `createHostApi` removes what the
 * manifest did not ask for, so an over-reaching plugin fails at a missing method
 * rather than quietly doing what it was not permitted to do.
 */
export function hostBackend(pluginId: string): HostApiBackend {
  return {
    async timeline() {
      return snapshot(state.activeSourceFile);
    },
    subscribe: onTimelineChanged,
    async config() {
      const entry = (state.activeSourceFile?.plugins ?? []).find((p) => p.id === pluginId);
      return snapshot(entry?.config ?? {});
    },
    async currentUser() {
      // Read from the app's own identity rather than a second /api/me call: a
      // plugin asking who is looking must not be able to make the page issue a
      // request, which is the shape a sandbox would have to police anyway.
      const email = state.currentUser?.email;
      if (!email) return null;
      return { email, ...(state.currentUser?.name ? { name: state.currentUser.name } : {}) };
    },
    items: itemsApi(),
    // Its own module, because it decides which rows a plugin can reach and the
    // rest of this file cannot be imported without the app's state and its DOM.
    data: createDataApi(pluginId, { sourceId, json: apiJson }),
  };
}

/**
 * The gated object one plugin receives.
 *
 * The version is stringified here because that is the form a plugin compares
 * against: `apiVersion` on the manifest is a range string (`^1`), so handing out
 * `{ major, minor }` would make the two sides of one comparison different types.
 */
export function hostApiFor(manifest: PluginManifest): HostApi {
  const version = `${HOST_API_VERSION.major}.${HOST_API_VERSION.minor}`;
  return createHostApi(manifest, hostBackend(manifest.id), version);
}

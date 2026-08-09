// Everything a plugin can do, and the capability gate in front of it.
//
// Two shape rules, both load-bearing:
//
//   - **Async and serializable throughout.** Every argument and every result is
//     JSON, and nothing hands a plugin a live object. Today plugins run in the
//     app's own realm and a direct call would be cheaper, but the isolation
//     decision (#14) is still open, and an API shaped around shared objects cannot
//     be moved behind an iframe or a worker afterwards without rewriting every
//     plugin. This is the cheap insurance to take before anybody writes one.
//   - **Writes go through the host.** A plugin never talks to the API itself, so
//     it cannot bypass optimistic locking, validation or the auth gate.
//
// The capability gate is not decoration: a plugin without `items:write` gets an
// object with **no** item-write methods, so an over-reaching plugin fails at the
// missing method rather than silently doing what it was not permitted to do.

import type { PluginDataRow, TimelineFile, TimelineFileItem } from '../types';
import { grants, type PluginManifest } from './manifest';

/**
 * The timeline as a plugin sees it. Pinned to the file shape the viewer already
 * loads, which carries `pluginData` — so a plugin's own rows arrive with the
 * snapshot rather than through a second request.
 *
 * It is an alias of `TimelineFile` and no longer a lossy one: the file format
 * carries no plugin-specific field any more. `pricing` was the last of them and
 * went with #17, so what a plugin sees here is exactly the core format plus the
 * rows it owns.
 */
export type TimelineSnapshot = TimelineFile;

/**
 * A row in one of the plugin's own collections.
 *
 * One definition, aliased rather than restated: this is the shape the store
 * writes, the wire carries and a local file holds, and two declarations of it
 * drift the moment one changes. The first draft here also carried a `sort`, which
 * the store does not have — order is the array's order, because that is the only
 * representation a JSON file has (see docs/plugin-storage.md).
 */
export type PluginRow = PluginDataRow;

export type ItemsApi = {
  add(item: TimelineFileItem): Promise<TimelineFileItem>;
  update(id: string, patch: Partial<TimelineFileItem>, version?: number): Promise<TimelineFileItem>;
  remove(id: string): Promise<void>;
};

export type DataApi = {
  list(collection: string): Promise<PluginRow[]>;
  put(collection: string, row: { id: string; data: Record<string, unknown>; version?: number }): Promise<PluginRow>;
  remove(collection: string, id: string): Promise<void>;
  move(collection: string, id: string, anchor: { after?: string; before?: string }): Promise<string[]>;
};

export type HostApi = {
  /** The contract version actually in force, for a plugin that adapts to it. */
  readonly apiVersion: string;
  /** The active timeline, or null before one is loaded. */
  timeline(): Promise<TimelineSnapshot | null>;
  /** Fires after any change to the timeline. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** This plugin's `timeline_plugins.config` bag on the active timeline. */
  config(): Promise<Record<string, unknown>>;
  /** Who is looking, or null when unknown. */
  currentUser(): Promise<{ email?: string; name?: string } | null>;
  /** Present only with `items:write`. */
  items?: ItemsApi;
  /** Present only with `data:own`. */
  data?: DataApi;
};

/** The raw operations a host implementation supplies, before any gating. */
export type HostApiBackend = Omit<HostApi, 'apiVersion' | 'items' | 'data'> & {
  items: ItemsApi;
  data: DataApi;
};

/**
 * Build the API object for one plugin: the full backend, minus everything its
 * manifest did not ask for.
 *
 * `items:read` is what the read side needs; without it a plugin still gets the
 * object (it may be a pure view over its own data), but `timeline()` resolves to
 * null rather than handing out items it never declared an interest in.
 */
export function createHostApi(
  manifest: PluginManifest,
  backend: HostApiBackend,
  apiVersion: string,
): HostApi {
  const canRead = grants(manifest, 'items:read') || grants(manifest, 'items:write');
  const api: HostApi = {
    apiVersion,
    timeline: canRead ? backend.timeline : async () => null,
    subscribe: backend.subscribe,
    config: backend.config,
    currentUser: backend.currentUser,
  };
  if (grants(manifest, 'items:write')) api.items = backend.items;
  if (grants(manifest, 'data:own')) api.data = backend.data;
  return api;
}

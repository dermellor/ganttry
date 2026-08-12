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
import type { PanelApi } from './panel';

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
  /**
   * Change some fields of a row and leave the rest standing. A `null` value
   * **removes** its key.
   *
   * Distinct from `put`, which replaces the whole `data` object, because the two
   * answer different questions and collapsing them loses one of them: a form that
   * edits two fields of a six-field row would have to read the row first and hope
   * nothing else changed in between, and an emptied input could not be told apart
   * from a field the form does not manage. The `null`-removes rule is the same one
   * the item patch path uses (`mergeMetadata` in scripts/mcp/patch.ts), so an
   * emptied field disappears everywhere rather than being stored as a null in one
   * place and absent in another.
   *
   * This method exists because the only plugin that writes rows could not be moved
   * onto `DataApi` without it (#117) — it had been reaching past the host API to a
   * route the contract did not expose.
   */
  patch(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    version?: number,
  ): Promise<PluginRow>;
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
  /**
   * Does this source accept writes at all?
   *
   * A plugin needs it before it draws an edit affordance: on a read-only source a
   * „+ Feature" button is a button that fails on click, and the plugin has no
   * other way to know — the capability says what the plugin may do, this says what
   * the timeline allows.
   */
  canWrite(): Promise<boolean>;
  /**
   * Put a line in the app's status area — what the plugin just did, in the place
   * the user already looks for it.
   *
   * Deliberately not a toast or a log: there is one status line in this product and
   * a plugin reporting elsewhere would be reporting somewhere nobody reads.
   */
  status(text: string): void;
  /** Present only with `items:write`. */
  items?: ItemsApi;
  /** Present only with `data:own`. */
  data?: DataApi;
  /**
   * The detail drawer, for a plugin's own forms. Present with `views`.
   *
   * Gated on `views` rather than on a write capability, and the first attempt got
   * that wrong: `items:write` looks like the right gate until you notice that the
   * plugin which needs the drawer most edits its OWN rows (`data:own`) and never
   * touches an item. The drawer grants no data access at all — it renders DOM the
   * plugin supplies into a container the host owns, exactly as `renderView` does.
   *
   * What `views` does buy: a plugin with no view has no surface a form could have
   * been opened from, so handing it the drawer would let it take over the panel
   * with nothing on screen that led there.
   */
  panel?: PanelApi;
};

/** The raw operations a host implementation supplies, before any gating. */
export type HostApiBackend = Omit<HostApi, 'apiVersion' | 'items' | 'data' | 'panel'> & {
  items: ItemsApi;
  data: DataApi;
  panel: PanelApi;
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
    // Ungated on purpose. Both answer questions about the host rather than doing
    // anything to it, and gating them would mean a plugin that draws its own
    // affordances has to guess at what a read-only source allows.
    canWrite: backend.canWrite,
    status: backend.status,
  };
  if (grants(manifest, 'items:write')) api.items = backend.items;
  if (grants(manifest, 'data:own')) api.data = backend.data;
  // A view is what gives a plugin somewhere to open a form FROM. It is not a data
  // grant: the drawer renders what the plugin hands it, which its view already does.
  if (grants(manifest, 'views')) api.panel = backend.panel;
  return api;
}

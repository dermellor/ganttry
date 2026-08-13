// Storage seam shared by both data-access drivers.
//
// `TimelineRepo` is the driver-agnostic interface every storage method is
// exposed through, with the DB client ALREADY BOUND (no leading client param).
// Two implementations satisfy it behind one seam:
//   - makePostgresRepo(sql)   — native postgres.js (opt-in, self-hosters)
//     ([`./timeline-repo.ts`](./timeline-repo.ts))
//   - makeSupabaseRepo(db)    — supabase-js / PostgREST (the Netlify default)
//     ([`./timeline-repo-supabase.ts`](./timeline-repo-supabase.ts))
// The runtime glue picks one by env and hands it to `handleTimelineApi`.
//
// This module is deliberately driver-free (only `import type` from src/types +
// plain classes), so importing it never pulls postgres.js OR supabase-js into a
// bundle — the Deno edge bundle stays clean, the drivers arrive only through the
// callers that construct a concrete handle.

import type { MemberRole, MemberStatus } from '../../src/access';
import type {
  CustomFieldDef,
  DirectoryUser,
  InstalledPlugin,
  Member,
  PluginData,
  PluginDataRow,
  SavedView,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
  Watermark,
} from '../../src/types';

export type TimelineGroupDecl = {
  id: string;
  content: string;
  nestedGroups?: string[];
  showNested?: boolean;
  /** The group's own colour; see `TimelineFile.groups[].color` in src/types.ts. */
  color?: string;
};

/**
 * What a timeline-level PATCH may carry.
 *
 * A named type rather than the same object literal at each implementation, because
 * it was written out four times — the interface, both drivers and the file repo —
 * and #137 is what that cost: three settings were added to `TimelineFile`, one copy
 * of this shape was never widened, and the fields became readable-but-unsettable
 * without anything failing.
 *
 * `null` means „clear it". The database columns take a null; a file source deletes
 * the key instead, because `TimelineFile` types these as optional and a written
 * null makes the file invalid against its own schema.
 */
export type TimelineMetaPatch = {
  name?: string | null;
  description?: string | null;
  groupBy?: string | null;
  customFields?: CustomFieldDef[] | null;
  /** `alpha` | `declared`; see src/groupOrder.ts. */
  groupOrder?: TimelineFile['groupOrder'] | null;
  /** Which group supplies band roots, which is shown as references. */
  graph?: TimelineFile['graph'] | null;
};

export type TimelineMeta = { id: string; name?: string; description?: string; groupBy?: string };

/**
 * What creating or re-sending an invitation needs.
 *
 * The token arrives already hashed, and that split is deliberate: hashing in the
 * repo would mean two implementations of it, one per driver, and the plain token
 * only exists in the request that generates it. `null` for both token fields is
 * how an admin adds somebody without a link to hand over.
 */
export type MemberInvite = {
  email: string;
  role: MemberRole;
  /** Address of the inviting admin, stored for the audit trail. */
  invitedBy?: string | null;
  /** SHA-256 of the invitation token; never the token itself. */
  tokenHash?: string | null;
  /** ISO timestamp after which the invitation is refused at sign-in. */
  expiresAt?: string | null;
};


// Error classes are shared (not re-defined per driver) so `instanceof` in the
// dispatcher's catch block works regardless of which driver threw — two
// definitions would make a Supabase-thrown ConflictError miss the Postgres
// `instanceof` and surface as a 500 instead of a 409.
export class ConflictError extends Error {
  constructor(message = 'version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}
export class NotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}
/**
 * A request this repo understands but does not implement. → HTTP 501.
 *
 * Distinct from ValidationError (the caller is wrong) and from a 500 (we are
 * broken): the caller and the request are both fine, this backing store just
 * cannot do it. The local file repo answers this for the pricing sub-resources.
 * Returning a silent success instead would let the interface report
 * „Gespeichert" for a write that never happened, which is the failure mode the
 * extent-error handling in „Standalone JSON timelines" (docs/data-model.md)
 * exists to prevent.
 */
export class NotSupportedError extends Error {
  constructor(message = 'not supported by this source') {
    super(message);
    this.name = 'NotSupportedError';
  }
}
/** A write that violates a data invariant (e.g. overlapping phases). → HTTP 400. */
export class ValidationError extends Error {
  constructor(message = 'invalid request') {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Every storage operation with the DB client already bound. The two driver
 * factories return an object satisfying this; `handleTimelineApi` dispatches
 * through it and never sees the underlying client. Pure helpers (row mappers,
 * `reorderIds`, `enforceExtentExclusivity`) stay as standalone functions in the
 * impl modules — they are DB-shape utilities, not part of the request-serving
 * surface.
 *
 * **No method here names a plugin, and a CI check asserts it.** For four years
 * this interface carried fifteen `addFeature` / `setTierValue` / `replacePricing`
 * methods for one plugin, which meant a third-party plugin could not store
 * anything without a change to every driver — the privilege issue #17 removed.
 * The generic plugin-store methods above are what replaced them: a plugin
 * declares its collections, and the store does not care what they mean.
 */
export interface TimelineRepo {
  // reads
  listTimelines(): Promise<TimelineMeta[]>;
  getTimeline(id: string): Promise<TimelineFile | null>;
  getWatermark(id: string): Promise<Watermark>;

  // user directory (`app_users`) — not timeline-scoped, like listTimelines()
  /** The whole directory, ordered for a picker (named users first, then by name). */
  listUsers(): Promise<DirectoryUser[]>;
  /**
   * Register a caller in the directory: insert them, refresh `last_seen_at`, and
   * fill in a `name` once one is known. Never clears a stored name with an empty
   * one — an identity source that only knows the address must not erase what a
   * previous visit already learned.
   */
  touchUser(email: string, name?: string | null): Promise<void>;

  // membership (`app_users`, migration 0016) — the same rows the directory
  // serves, read through the columns that say what a person may do. Nothing
  // enforces these yet; the dispatcher starts consulting them behind
  // TIMELINES_ACCESS_CONTROL in a later step.
  /**
   * One membership by address, or null when the address is not a member.
   *
   * Null is the ordinary answer for a stranger rather than an error, which is
   * what lets the enforcement path treat "no row" and "wrong role" the same way.
   */
  getMember(email: string): Promise<Member | null>;
  /** Every membership, `removed` ones included, ordered like the directory. */
  listMembers(): Promise<Member[]>;
  /**
   * Create or re-invite a membership.
   *
   * Re-inviting an address that already has a row updates it in place instead of
   * failing: an admin who invites somebody twice means "send it again", and an
   * error there would leave them unable to fix a bounced invitation. An `active`
   * membership is never downgraded to `invited` by this — accepting is one-way.
   */
  inviteMember(input: MemberInvite): Promise<Member>;
  /** Change what an existing member may do. Throws NotFoundError for a stranger. */
  updateMemberRole(email: string, role: MemberRole): Promise<Member>;
  /** Move a membership through its lifecycle. Throws NotFoundError for a stranger. */
  setMemberStatus(email: string, status: MemberStatus): Promise<Member>;

  // whole-timeline
  replaceTimeline(id: string, file: TimelineFile): Promise<void>;

  // items
  addItem(timelineId: string, item: TimelineFileItem, updatedBy?: string): Promise<TimelineFileItem>;
  updateItem(
    timelineId: string,
    itemId: string,
    patch: Partial<TimelineFileItem>,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<TimelineFileItem>;
  getItem(timelineId: string, itemId: string): Promise<TimelineFileItem | null>;
  deleteItem(timelineId: string, itemId: string): Promise<void>;

  // groups
  upsertGroup(timelineId: string, group: TimelineGroupDecl): Promise<TimelineGroupDecl>;
  deleteGroup(timelineId: string, groupId: string): Promise<void>;

  // timeline-level meta / phases
  updatePhases(id: string, phases: TimelinePhase[]): Promise<void>;
  /**
   * Patch the timeline's own metadata. An absent key is left alone; an explicit
   * `null` clears the value — which a database stores as NULL and a file source
   * expresses by dropping the key, since `TimelineFile` types these as optional.
   */
  updateMeta(id: string, meta: TimelineMetaPatch): Promise<void>;

  // ---- the instance's install registry ------------------------------------
  // Instance-level, not timeline-level, which is why none of these takes a
  // timeline id. „Installed" is „this instance has the code"; „enabled" is a
  // `timeline_plugins` row and stays where it is.

  /** Every installed plugin, enabled or not, ordered by id. */
  listInstalledPlugins(): Promise<InstalledPlugin[]>;
  /**
   * Install or re-install one plugin (upsert by id). Re-installing is how a
   * version is changed, so it keeps the row's identity rather than making the
   * caller delete first — a delete-then-insert would take the plugin's data with
   * it through the purge, which is not what „update" means.
   */
  installPlugin(plugin: InstalledPlugin, updatedBy?: string): Promise<InstalledPlugin>;
  /** The instance-level off switch. Keeps the row and everything the plugin stored. */
  setPluginInstalledEnabled(pluginId: string, enabled: boolean, updatedBy?: string): Promise<void>;
  /**
   * Remove the registry row. The plugin's DATA is not touched here — purging it
   * is a separate, explicit step (`purgePlugin`), so that the destructive half of
   * an uninstall is never a side effect of the bookkeeping half.
   */
  removeInstalledPlugin(pluginId: string): Promise<void>;

  // ---- a plugin's enablement on ONE timeline ------------------------------

  /**
   * Enable a plugin on a timeline, or replace its config. Upsert, because
   * „enable" and „reconfigure" are the same write from the caller's side and
   * splitting them would only add a 404 nobody can act on.
   */
  setTimelinePlugin(
    timelineId: string,
    pluginId: string,
    config: Record<string, unknown>,
    options?: { public?: boolean },
  ): Promise<void>;
  /**
   * What one timeline says about one plugin: its config, and whether the timeline
   * consents to publishing that plugin's declared collections.
   *
   * Deliberately NOT `getTimeline`, which the public path could otherwise reuse:
   * that one loads every item, and the endpoint this serves is unauthenticated.
   * Reading a timeline's whole content to answer „may I publish four rows" is both
   * wasteful and the kind of shortcut that turns into a leak the day somebody
   * returns more of it than they meant to.
   */
  getTimelinePlugin(
    timelineId: string,
    pluginId: string,
  ): Promise<{ timelineName?: string; config: Record<string, unknown>; public: boolean } | null>;
  /**
   * Disable a plugin on a timeline. Deliberately keeps every row the plugin owns,
   * so re-enabling is lossless — the destructive operation is the instance-level
   * uninstall, and that one asks.
   */
  removeTimelinePlugin(timelineId: string, pluginId: string): Promise<void>;

  // ---- plugin-owned rows (the generic store) ------------------------------
  // Eight methods that together replace the per-plugin ones below: a plugin
  // installed at runtime cannot add to this interface, so the interface has to
  // stop naming plugins. What they store differs per backing store — a
  // `plugin_data` table for `db`, a section in the user's own file for `local` —
  // and only that difference lives in the implementations. The rules (shape,
  // references, ordering, composite identity) sit ABOVE this seam, in
  // [`src/pluginHost/dataStore.ts`](../../src/pluginHost/dataStore.ts), so all
  // three implementations are held to them by one piece of code.

  /** One collection's rows, in order. Empty when the plugin stored nothing. */
  listPluginRows(timelineId: string, pluginId: string, collection: string): Promise<PluginDataRow[]>;
  /**
   * Every collection of the named plugins, for folding into `getTimeline`.
   * Omitting `pluginIds` means „whichever plugins this timeline has enabled" —
   * the store knows that without being told, and a caller that had to look it up
   * first would make two round trips out of one.
   */
  listPluginData(timelineId: string, pluginIds?: string[]): Promise<PluginData>;
  /**
   * Create or replace one row's `data` wholesale. Upsert rather than insert,
   * because a collection with `keyFields` has no separate create: writing the
   * cell (tier, feature) twice addresses the same row both times.
   */
  putPluginRow(
    timelineId: string,
    pluginId: string,
    collection: string,
    row: PluginDataRow,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<PluginDataRow>;
  /** Merge `patch` into an existing row's `data` (shallow, top-level keys). */
  patchPluginRow(
    timelineId: string,
    pluginId: string,
    collection: string,
    rowId: string,
    patch: Record<string, unknown>,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<PluginDataRow>;
  deletePluginRow(timelineId: string, pluginId: string, collection: string, rowId: string): Promise<void>;
  /** Persist an explicit row order for an `ordered` collection. */
  orderPluginRows(
    timelineId: string,
    pluginId: string,
    collection: string,
    orderedIds: string[],
    updatedBy?: string,
  ): Promise<void>;
  /**
   * Drop every row of a plugin. `timelineId: null` is the instance-wide
   * uninstall; a timeline id scopes it to that one timeline.
   */
  purgePluginData(pluginId: string, timelineId?: string | null): Promise<void>;
  /**
   * Strip the given `metadata` keys off items. The other half of an uninstall:
   * without it a plugin's keys stay behind in the raw metadata box of every item
   * that ever carried one, visible and unexplained.
   */
  purgeItemMetadata(keys: string[], timelineId?: string | null): Promise<number>;

  // ---- saved views --------------------------------------------------------
  // Four methods, and no `patch` among them: a saved view is five small fields a
  // caller always holds in full, so a partial write is resolved above the repo
  // (read → merge → put, guarded by the same `expectedVersion`) rather than
  // implemented three times. The same reasoning kept `updateMeta` down to one.
  //
  // **None of them filters by visibility.** That rule decides what leaves the
  // building and therefore lives in exactly one place, above the seam
  // (`src/savedViews.ts`, applied in the dispatcher) — a per-driver filter is how
  // one of the three ends up serving somebody else's private view.

  /** Every saved view on a timeline, unfiltered. Ordered by name. */
  listSavedViews(timelineId: string): Promise<SavedView[]>;
  /** One saved view, or null. Needed to resolve a patch and to authorize a write. */
  getSavedView(timelineId: string, viewId: string): Promise<SavedView | null>;
  /**
   * Create or replace one saved view wholesale. Upsert rather than insert plus
   * update, because the client's „save" is the same act either way and a 404 on
   * „it was deleted while you had it open" is not something the caller can act on.
   */
  putSavedView(
    timelineId: string,
    view: SavedView,
    expectedVersion?: number,
    updatedBy?: string,
  ): Promise<SavedView>;
  deleteSavedView(timelineId: string, viewId: string): Promise<void>;
}

// Data-access layer for Supabase-backed timelines (supabase-js / PostgREST).
//
// This is the proven origin/main implementation, the DEFAULT the Netlify deploy
// runs on: it talks HTTP/PostgREST, so it works in the Deno edge without raw TCP
// and must not change behaviourally. `makePostgresRepo` in ./timeline-repo.ts is
// the opt-in native alternative; both satisfy the shared `TimelineRepo` seam.
//
// Runtime-agnostic: every function takes a supabase-js client, so the same code
// serves the Node Vite middleware, the import script, and the Deno edge function.
// Client creation (env cascade vs. Deno.env) lives in the callers.
//
// Item-level writes with an optimistic `version` check replace the old
// whole-sheet rewrite — concurrent edits on different items no longer clobber.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MemberRole, MemberStatus } from '../../src/access';
import type {
  CustomFieldDef,
  DirectoryUser,
  InstalledPlugin,
  Member,
  PluginData,
  PluginDataRow,
  PluginRef,
  SavedView,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
  Watermark,
} from '../../src/types';
import { statusOrDefault } from '../../src/status.ts';
import { describePhaseOverlap, findPhaseOverlap } from '../../src/phaseOverlap.ts';
import { describeReversedExtent, findReversedExtent, hasReversedExtent } from '../../src/itemExtent.ts';
import { pluginsForWrite } from '../../src/pluginHost/plugins.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type MemberInvite,
  type TimelineGroupDecl,
  type TimelineMeta,
  type TimelineRepo,
} from './repo.ts';

// Shared seam types/classes (single definition — see ./repo.ts). Re-exported for
// symmetry with ./timeline-repo.ts.
export { ConflictError, NotFoundError, ValidationError };
export type { TimelineGroupDecl, TimelineMeta };

const ITEM_SELECT =
  'id, start, "end", duration, content, "group", type, body, icon, status, class_name, metadata, version, sort, created_at, created_by, updated_at, updated_by';

// ---- row <-> object mapping ------------------------------------------------

function rowToItem(row: Record<string, any>): TimelineFileItem {
  const item: TimelineFileItem = {
    id: row.id,
    content: row.content,
  };
  // `start` is optional now — a date-less item shows only in the list view.
  if (row.start != null) item.start = row.start;
  if (row.end != null) item.end = row.end;
  if (row.duration != null) item.duration = row.duration;
  if (row.group != null) item.group = row.group;
  if (row.type != null) item.type = row.type;
  if (row.body != null) item.body = row.body;
  if (row.icon != null) item.icon = row.icon;
  if (row.status != null) item.status = statusOrDefault(row.status);
  if (row.class_name != null) item.className = row.class_name;
  if (row.metadata && Object.keys(row.metadata).length > 0) item.metadata = row.metadata;
  if (row.version != null) item.version = row.version;
  // Server-managed audit fields (read-only; surfaced in the viewer's detail panel).
  if (row.created_at != null) item.createdAt = row.created_at;
  if (row.created_by != null) item.createdBy = row.created_by;
  if (row.updated_at != null) item.updatedAt = row.updated_at;
  if (row.updated_by != null) item.updatedBy = row.updated_by;
  return item;
}

/**
 * DB invariant: an item's extent is expressed by EITHER `end` OR `duration`,
 * never both. When both are present `end` wins — mirroring the render precedence
 * in `buildItems`. A row carrying both is the bug that silently shrank
 * `end`-based bars to a stale `duration` on the next edit. Callers assembling a
 * full item/row funnel through here; partial patches clear the counterpart
 * inline (see `updateItem`).
 */
export function enforceExtentExclusivity<T extends { end?: unknown; duration?: unknown }>(o: T): T {
  if (o.end != null) (o as { duration?: unknown }).duration = null;
  return o;
}

/**
 * DB invariant: an item's `end` lies AFTER its `start`. Rejected before any write
 * persists it, from any path (item API, MCP, direct API) — the rule itself is
 * shared with the client in `src/itemExtent.ts`. Unlike `enforceExtentExclusivity`
 * this cannot be normalised away: which of the two dates the caller meant is not
 * knowable, so the write fails loudly (400) instead of guessing.
 */
function assertExtentOrdered(item: { start?: unknown; end?: unknown }): void {
  if (hasReversedExtent(item)) throw new ValidationError(describeReversedExtent(item.start, item.end));
}

/** Bulk counterpart: one reversed item rejects the whole write. */
function assertItemExtentsOrdered(items: TimelineFileItem[] | undefined): void {
  const bad = findReversedExtent(items ?? []);
  if (bad) throw new ValidationError(describeReversedExtent(bad.start, bad.end));
}

// Columns for insert/update. `sort` and `version` are managed here / by trigger.
function itemToRow(timelineId: string, item: TimelineFileItem, sort?: number): Record<string, any> {
  enforceExtentExclusivity(item);
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: item.id,
    start: item.start ?? null,
    end: item.end ?? null,
    duration: item.duration != null ? String(item.duration) : null,
    content: item.content,
    group: item.group ?? null,
    type: item.type ?? null,
    body: item.body ?? null,
    icon: item.icon ?? null,
    // status is NOT NULL in the DB: always write a canonical value, never null
    // (a missing/invalid status becomes the default so inserts never violate the
    // constraint and every row carries exactly one of the three states).
    status: statusOrDefault(item.status),
    class_name: item.className ?? null,
    metadata: item.metadata ?? {},
  };
  if (sort != null) row.sort = sort;
  return row;
}

function rowToGroup(row: Record<string, any>): TimelineGroupDecl {
  const g: TimelineGroupDecl = { id: row.id, content: row.content ?? row.id };
  if (Array.isArray(row.nested_groups) && row.nested_groups.length) g.nestedGroups = row.nested_groups;
  if (row.show_nested != null) g.showNested = row.show_nested;
  return g;
}

function groupToRow(timelineId: string, g: TimelineGroupDecl, sort?: number): Record<string, any> {
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: g.id,
    content: g.content ?? null,
    nested_groups: g.nestedGroups ?? null,
    show_nested: g.showNested ?? null,
  };
  if (sort != null) row.sort = sort;
  return row;
}

// ---- reads -----------------------------------------------------------------

export async function listTimelines(db: SupabaseClient): Promise<TimelineMeta[]> {
  const { data, error } = await db.from('timelines').select('id, name, description, group_by').order('id');
  if (error) throw new Error(`listTimelines: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name ?? undefined,
    description: r.description ?? undefined,
    groupBy: r.group_by ?? undefined,
  }));
}

// ---- user directory (app_users) --------------------------------------------
// Named users first so a picker shows resolvable people before the address-only
// rows the backfill created; alphabetical within each group.

export async function listUsers(db: SupabaseClient): Promise<DirectoryUser[]> {
  const { data, error } = await db
    .from('app_users')
    .select('email, name')
    .order('name', { ascending: true, nullsFirst: false })
    .order('email', { ascending: true });
  if (error) throw new Error(`listUsers: ${error.message}`);
  return (data ?? []).map((r) => (r.name != null ? { email: r.email, name: r.name } : { email: r.email }));
}

export async function touchUser(db: SupabaseClient, email: string, name?: string | null): Promise<void> {
  const clean = email.trim();
  if (!clean) return;
  const label = name?.trim();
  // PostgREST's upsert sets exactly the columns present in the payload, so
  // leaving `name` out when we don't know one is what keeps a stored name intact
  // (the postgres.js driver spells the same rule as coalesce(excluded.name, …)).
  const row: Record<string, unknown> = { email: clean, last_seen_at: new Date().toISOString() };
  if (label) row.name = label;
  const { error } = await db.from('app_users').upsert(row, { onConflict: 'email' });
  if (error) throw new Error(`touchUser: ${error.message}`);
}

// ---- membership (app_users, migration 0016) --------------------------------
// The same rows the directory above serves, read through the columns that decide
// what a person may do. One table on purpose: see the migration's header.

const MEMBER_SELECT = 'email, name, role, status, invited_by, invited_at, accepted_at, invite_expires_at, last_seen_at';

/** Row → `Member`, dropping nulls so an absent field is absent rather than null. */
function toMember(r: Record<string, any>): Member {
  const out: Member = { email: r.email, role: r.role, status: r.status };
  if (r.name != null) out.name = r.name;
  if (r.invited_by != null) out.invitedBy = r.invited_by;
  if (r.invited_at != null) out.invitedAt = r.invited_at;
  if (r.accepted_at != null) out.acceptedAt = r.accepted_at;
  if (r.invite_expires_at != null) out.inviteExpiresAt = r.invite_expires_at;
  if (r.last_seen_at != null) out.lastSeenAt = r.last_seen_at;
  return out;
}

export async function getMember(db: SupabaseClient, email: string): Promise<Member | null> {
  const clean = email.trim().toLowerCase();
  if (!clean) return null;
  // maybeSingle(): "not a member" is an ordinary answer, and single() would turn
  // it into a PostgREST error the caller then has to decode.
  const { data, error } = await db
    .from('app_users')
    .select(MEMBER_SELECT)
    .ilike('email', clean)
    .maybeSingle();
  if (error) throw new Error(`getMember: ${error.message}`);
  return data ? toMember(data) : null;
}

export async function listMembers(db: SupabaseClient): Promise<Member[]> {
  const { data, error } = await db
    .from('app_users')
    .select(MEMBER_SELECT)
    .order('name', { ascending: true, nullsFirst: false })
    .order('email', { ascending: true });
  if (error) throw new Error(`listMembers: ${error.message}`);
  return (data ?? []).map(toMember);
}

export async function inviteMember(db: SupabaseClient, input: MemberInvite): Promise<Member> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new ValidationError('inviteMember: email required');
  // PostgREST's upsert cannot express "keep the old value when it was 'active'"
  // the way the postgres.js driver's CASE does, so the read decides instead. The
  // rule is the same in both: re-inviting never downgrades an accepted
  // membership, because accepting is one-way and an active user must not be sent
  // back through the door.
  const existing = await getMember(db, email);
  const row: Record<string, unknown> = {
    email,
    role: input.role,
    status: existing?.status === 'active' ? 'active' : 'invited',
    invited_by: input.invitedBy ?? null,
    invited_at: new Date().toISOString(),
    invite_token_hash: input.tokenHash ?? null,
    invite_expires_at: input.expiresAt ?? null,
  };
  const { data, error } = await db
    .from('app_users')
    .upsert(row, { onConflict: 'email' })
    .select(MEMBER_SELECT)
    .single();
  if (error) throw new Error(`inviteMember: ${error.message}`);
  return toMember(data);
}

export async function updateMemberRole(
  db: SupabaseClient,
  email: string,
  role: MemberRole,
): Promise<Member> {
  const { data, error } = await db
    .from('app_users')
    .update({ role })
    .ilike('email', email.trim().toLowerCase())
    .select(MEMBER_SELECT)
    .maybeSingle();
  if (error) throw new Error(`updateMemberRole: ${error.message}`);
  if (!data) throw new NotFoundError(`no member ${email}`);
  return toMember(data);
}

export async function setMemberStatus(
  db: SupabaseClient,
  email: string,
  status: MemberStatus,
): Promise<Member> {
  const clean = email.trim().toLowerCase();
  const patch: Record<string, unknown> = { status };
  if (status === 'active') {
    // Accepting stamps `accepted_at` once and clears the invitation: a spent
    // token must not resolve to a row any more, and a leftover expiry would let
    // a later check refuse a member who is long since active. `accepted_at` is
    // only written when it is still empty, so restoring a suspended member does
    // not rewrite the day they joined.
    const existing = await getMember(db, clean);
    if (!existing) throw new NotFoundError(`no member ${email}`);
    if (!existing.acceptedAt) patch.accepted_at = new Date().toISOString();
    patch.invite_token_hash = null;
    patch.invite_expires_at = null;
  }
  const { data, error } = await db
    .from('app_users')
    .update(patch)
    .ilike('email', clean)
    .select(MEMBER_SELECT)
    .maybeSingle();
  if (error) throw new Error(`setMemberStatus: ${error.message}`);
  if (!data) throw new NotFoundError(`no member ${email}`);
  return toMember(data);
}

export async function getTimeline(db: SupabaseClient, id: string): Promise<TimelineFile | null> {
  const { data: tl, error: tlErr } = await db
    .from('timelines')
    .select('id, name, description, group_by, phases, custom_fields')
    .eq('id', id)
    .maybeSingle();
  if (tlErr) throw new Error(`getTimeline: ${tlErr.message}`);
  if (!tl) return null;

  const { data: pluginRows, error: plgErr } = await db
    .from('timeline_plugins')
    .select('plugin_id, config, public')
    .eq('timeline_id', id)
    .order('plugin_id', { ascending: true });
  if (plgErr) throw new Error(`getTimeline plugins: ${plgErr.message}`);

  const { data: itemRows, error: itemErr } = await db
    .from('timeline_items')
    .select(ITEM_SELECT)
    .eq('timeline_id', id)
    .order('sort', { ascending: true, nullsFirst: true });
  if (itemErr) throw new Error(`getTimeline items: ${itemErr.message}`);

  const { data: groupRows, error: grpErr } = await db
    .from('timeline_groups')
    .select('id, content, nested_groups, show_nested, sort')
    .eq('timeline_id', id)
    .order('sort', { ascending: true, nullsFirst: true });
  if (grpErr) throw new Error(`getTimeline groups: ${grpErr.message}`);

  const file: TimelineFile = { items: (itemRows ?? []).map(rowToItem) };
  if (tl.name != null) file.name = tl.name;
  if (tl.description != null) file.description = tl.description;
  if (tl.group_by != null) file.groupBy = tl.group_by;
  const plugins: PluginRef[] = (pluginRows ?? []).map((r) => ({
    id: r.plugin_id,
    config: (r.config ?? {}) as Record<string, unknown>,
    ...((r as any).public === true ? { public: true } : {}),
  }));
  if (plugins.length) file.plugins = plugins;
  if (Array.isArray(tl.phases) && tl.phases.length) file.phases = tl.phases as TimelinePhase[];
  if (Array.isArray(tl.custom_fields) && tl.custom_fields.length)
    file.customFields = tl.custom_fields as CustomFieldDef[];
  // No pricing assembly here any more. The model is composed by the PLUGIN from
  // its generic rows (src/plugins/product-roadmap/compose.ts), which is what makes
  // it a plugin rather than a privilege: the host serves undistinguished
  // collections and knows nothing about tiers, features or cells. The `pricing_*`
  // tables are still there and still written by the legacy sub-resources, but
  // nothing reads them on this path (issue #17).
  // Plugin-owned rows travel with the timeline; see `PluginData` in src/types.ts.
  // The enabled set is already in hand here, so it is passed rather than re-read.
  if (plugins.length) {
    const pluginData = await listPluginData(db, id, plugins.map((p) => p.id));
    if (Object.keys(pluginData).length) file.pluginData = pluginData;
  }
  // Unfiltered on purpose: which of these the caller may see is decided once,
  // above the seam, in the dispatcher (see src/savedViews.ts).
  // Tolerated rather than fatal, and this is the ONE read here that is: a
  // migration is a deliberate manual step while a deploy happens on merge, so the
  // two cannot be made atomic and the window between them is real. A timeline that
  // will not load because a DISPLAY-STATE table is missing spends the whole
  // window's cost on content that is perfectly fine — the same trade `touchUser`
  // makes for the user directory. What is pending is reported by `npm run db:check`,
  // which is where an operator looks for it; nothing here quietly invents data
  // („no fallback data" is about content, and this returns none).
  let savedViews: SavedView[] = [];
  try {
    savedViews = await listSavedViews(db, id);
  } catch {
    // The saved views are simply absent until the migration lands.
  }
  if (savedViews.length) file.savedViews = savedViews;
  if (groupRows && groupRows.length) file.groups = groupRows.map(rowToGroup);
  return file;
}

// ---- watermark (cheap change-detection for polling clients) ----------------

/**
 * Cheap change signature for a timeline, used by polling clients to decide
 * whether to reload (see `Watermark` in src/types.ts). Two small queries — one
 * over the (small) item set, one for the timeline row — no full assemble:
 *   v — max item `version`   (own-echo hint)
 *   n — item count           (catches inserts/deletes)
 *   t — max `updated_at` across the items and the timeline row (an item edit,
 *       a phase/meta write and a rename all bump this)
 *
 *   pv/pn — the same pair over `plugin_data`. Kept apart from v/n so the item
 *       row version stays usable as the own-echo hint; see the note on the
 *       native driver's copy for the full reasoning.
 *
 * NOTE: this still does NOT cover the `pricing_*` tables — they go away in #17,
 * at which point product-roadmap is covered by pv/pn like any other plugin.
 */
export async function getWatermark(db: SupabaseClient, id: string): Promise<Watermark> {
  const [itemsRes, tlRes, pluginRes] = await Promise.all([
    db.from('timeline_items').select('version, updated_at').eq('timeline_id', id),
    db.from('timelines').select('updated_at').eq('id', id).maybeSingle(),
    db.from('plugin_data').select('version, updated_at').eq('timeline_id', id),
  ]);
  if (itemsRes.error) throw new Error(`getWatermark items: ${itemsRes.error.message}`);
  if (tlRes.error) throw new Error(`getWatermark timeline: ${tlRes.error.message}`);
  if (pluginRes.error) throw new Error(`getWatermark plugin data: ${pluginRes.error.message}`);

  const rows = (itemsRes.data ?? []) as { version: number | null; updated_at: string | null }[];
  let v = 0;
  let t: string | null = (tlRes.data as { updated_at?: string | null } | null)?.updated_at ?? null;
  for (const r of rows) {
    if (r.version != null && r.version > v) v = r.version;
    if (r.updated_at != null && (t == null || r.updated_at > t)) t = r.updated_at;
  }
  const pluginRows = (pluginRes.data ?? []) as { version: number | null; updated_at: string | null }[];
  let pv = 0;
  for (const r of pluginRows) {
    if (r.version != null && r.version > pv) pv = r.version;
    if (r.updated_at != null && (t == null || r.updated_at > t)) t = r.updated_at;
  }
  const wm: Watermark = { v, n: rows.length, t };
  if (pluginRows.length) {
    wm.pv = pv;
    wm.pn = pluginRows.length;
  }
  return wm;
}

// ---- public pricing (marketing sites consume this) -------------------------

// ---- pricing assembly (normalized tables → the Pricing shape) --------------


// ---- whole-timeline replace (import, MCP bulk, PUT fallback) ---------------

export async function replaceTimeline(db: SupabaseClient, id: string, file: TimelineFile): Promise<void> {
  assertPhasesNonOverlapping(file.phases);
  // Before the wipe below, not while mapping the rows: this replace deletes the
  // existing items first, so a reversed item discovered mid-map would leave the
  // timeline emptied.
  assertItemExtentsOrdered(file.items);
  const { error: upErr } = await db.from('timelines').upsert({
    id,
    name: file.name ?? null,
    description: file.description ?? null,
    group_by: file.groupBy ?? null,
    phases: file.phases ?? [],
    custom_fields: file.customFields ?? [],
    updated_at: new Date().toISOString(),
  });
  if (upErr) throw new Error(`replaceTimeline meta: ${upErr.message}`);

  // Clear children, then re-insert (cascade-free explicit wipe keeps it simple).
  const del1 = await db.from('timeline_items').delete().eq('timeline_id', id);
  if (del1.error) throw new Error(`replaceTimeline clear items: ${del1.error.message}`);
  const del2 = await db.from('timeline_groups').delete().eq('timeline_id', id);
  if (del2.error) throw new Error(`replaceTimeline clear groups: ${del2.error.message}`);

  // Plugin registrations (enablement + config). `pluginsForWrite` carries the
  // one rule: a plugin whose rows are in the payload is a plugin that is
  // enabled, or the write stores data nothing reads.
  await replacePluginRows(db, id, pluginsForWrite(file));


  // Plugin-owned rows, so a GET → PUT round trip preserves them rather than
  // silently emptying a collection the request never mentioned.
  await replacePluginData(db, id, file.pluginData);

  const itemRows = file.items
    // `start` is optional: a list-created item can exist without a date yet.
    .filter((it) => it.id && it.content)
    .map((it, i) => itemToRow(id, it, i));
  if (itemRows.length) {
    const ins = await db.from('timeline_items').insert(itemRows);
    if (ins.error) throw new Error(`replaceTimeline insert items: ${ins.error.message}`);
  }

  const groupRows = (file.groups ?? []).map((g, i) => groupToRow(id, g, i));
  if (groupRows.length) {
    const ins = await db.from('timeline_groups').insert(groupRows);
    if (ins.error) throw new Error(`replaceTimeline insert groups: ${ins.error.message}`);
  }
}

// ---- item-level writes (the concurrency fix) -------------------------------

async function nextSort(db: SupabaseClient, timelineId: string): Promise<number> {
  const { data } = await db
    .from('timeline_items')
    .select('sort')
    .eq('timeline_id', timelineId)
    .order('sort', { ascending: false, nullsFirst: false })
    .limit(1);
  const top = data?.[0]?.sort;
  return typeof top === 'number' ? top + 1 : 0;
}

/** Insert a new item. Fails if the id already exists. */
export async function addItem(
  db: SupabaseClient,
  timelineId: string,
  item: TimelineFileItem,
  updatedBy?: string,
): Promise<TimelineFileItem> {
  assertExtentOrdered(item);
  const row = itemToRow(timelineId, item, await nextSort(db, timelineId));
  if (updatedBy) {
    row.updated_by = updatedBy;
    row.created_by = updatedBy; // attribute the creation to the same actor
  }
  const { data, error } = await db.from('timeline_items').insert(row).select(ITEM_SELECT).single();
  if (error) throw new Error(`addItem: ${error.message}`);
  return rowToItem(data);
}

/**
 * Order-check an item patch, which needs the *effective* post-patch pair: a
 * partial patch can reverse the extent while carrying only one of the two dates
 * (`PATCH {end}` alone against a later stored `start`), so the counterpart has to
 * come off the stored row. Reads it only when the patch actually leaves one side
 * open — the viewer always sends a full patch (`buildItemPatch`), so that read is
 * the direct-API / MCP-shaped case, not the interactive one.
 *
 * Takes the already-normalised column patch, so a switch to `duration` (which
 * clears `end`, see `updateItem`) is correctly seen as having no `end` left to
 * reverse. A null on either side likewise can't be reversed — clearing a date is
 * always allowed.
 */
async function assertPatchExtentOrdered(
  db: SupabaseClient,
  timelineId: string,
  itemId: string,
  set: Record<string, any>,
): Promise<void> {
  const patchedStart = 'start' in set ? set.start : undefined;
  const patchedEnd = 'end' in set ? set.end : undefined;
  if (patchedStart == null && patchedEnd == null) return;
  let start = patchedStart;
  let end = patchedEnd;
  if (start === undefined || end === undefined) {
    const cur = await getItem(db, timelineId, itemId);
    if (!cur) throw new NotFoundError();
    if (start === undefined) start = cur.start;
    if (end === undefined) end = cur.end;
  }
  assertExtentOrdered({ start, end });
}

/**
 * Patch an existing item. When `expectedVersion` is given, the update only
 * applies if the stored version still matches — otherwise ConflictError, so a
 * concurrent editor's change is never silently overwritten.
 */
export async function updateItem(
  db: SupabaseClient,
  timelineId: string,
  itemId: string,
  patch: Partial<TimelineFileItem>,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<TimelineFileItem> {
  // Build the column patch from provided fields only.
  const full = itemToRow(timelineId, { ...(patch as TimelineFileItem), id: itemId } as TimelineFileItem);
  const set: Record<string, any> = {};
  const map: Record<keyof TimelineFileItem | string, string> = {
    start: 'start', end: 'end', duration: 'duration', content: 'content', group: 'group',
    type: 'type', body: 'body', icon: 'icon', status: 'status', className: 'class_name', metadata: 'metadata',
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) set[col] = full[col];
  }
  // Keep the extent columns mutually exclusive across a *partial* patch: setting
  // one clears the stored other (end wins when both are asserted), so a row can
  // never keep both. This also lets a caller switch an end-based item to
  // duration by sending `duration` alone (the stale `end` column is cleared).
  if (set.end != null) set.duration = null;
  else if (set.duration != null) set.end = null;
  if (updatedBy) set.updated_by = updatedBy;
  if (Object.keys(set).length === 0) {
    const cur = await getItem(db, timelineId, itemId);
    if (!cur) throw new NotFoundError();
    return cur;
  }
  await assertPatchExtentOrdered(db, timelineId, itemId, set);

  let q = db.from('timeline_items').update(set).eq('timeline_id', timelineId).eq('id', itemId);
  if (expectedVersion != null) q = q.eq('version', expectedVersion);
  const { data, error } = await q.select(ITEM_SELECT);
  if (error) throw new Error(`updateItem: ${error.message}`);
  if (!data || data.length === 0) {
    // Either the row is gone or the version moved on.
    const exists = await getItem(db, timelineId, itemId);
    if (!exists) throw new NotFoundError();
    throw new ConflictError(`item ${itemId} changed since version ${expectedVersion}`);
  }
  return rowToItem(data[0]);
}

export async function getItem(
  db: SupabaseClient,
  timelineId: string,
  itemId: string,
): Promise<TimelineFileItem | null> {
  const { data, error } = await db
    .from('timeline_items')
    .select(ITEM_SELECT)
    .eq('timeline_id', timelineId)
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw new Error(`getItem: ${error.message}`);
  return data ? rowToItem(data) : null;
}

export async function deleteItem(db: SupabaseClient, timelineId: string, itemId: string): Promise<void> {
  const { error } = await db.from('timeline_items').delete().eq('timeline_id', timelineId).eq('id', itemId);
  if (error) throw new Error(`deleteItem: ${error.message}`);
}

// ---- group writes ----------------------------------------------------------

export async function upsertGroup(
  db: SupabaseClient,
  timelineId: string,
  group: TimelineGroupDecl,
): Promise<TimelineGroupDecl> {
  const { data, error } = await db
    .from('timeline_groups')
    .upsert(groupToRow(timelineId, group))
    .select('id, content, nested_groups, show_nested, sort')
    .single();
  if (error) throw new Error(`upsertGroup: ${error.message}`);
  return rowToGroup(data);
}

export async function deleteGroup(db: SupabaseClient, timelineId: string, groupId: string): Promise<void> {
  const { error } = await db.from('timeline_groups').delete().eq('timeline_id', timelineId).eq('id', groupId);
  if (error) throw new Error(`deleteGroup: ${error.message}`);
}

// ---- timeline-level meta / phases ------------------------------------------

// Reject overlapping phases before any write persists them, from any path (item
// API PUT, MCP replace_timeline, import). Single invariant, one gate.
function assertPhasesNonOverlapping(phases: TimelinePhase[] | undefined): void {
  const clash = findPhaseOverlap(phases ?? []);
  if (clash) throw new ValidationError(describePhaseOverlap(clash.a, clash.b));
}

export async function updatePhases(db: SupabaseClient, id: string, phases: TimelinePhase[]): Promise<void> {
  assertPhasesNonOverlapping(phases);
  const { error } = await db
    .from('timelines')
    .update({ phases: phases ?? [], updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`updatePhases: ${error.message}`);
}

export async function updateMeta(
  db: SupabaseClient,
  id: string,
  meta: {
    name?: string | null;
    description?: string | null;
    groupBy?: string | null;
    customFields?: CustomFieldDef[] | null;
  },
): Promise<void> {
  const set: Record<string, any> = { updated_at: new Date().toISOString() };
  if ('name' in meta) set.name = meta.name ?? null;
  if ('description' in meta) set.description = meta.description ?? null;
  if ('groupBy' in meta) set.group_by = meta.groupBy ?? null;
  // Custom-field definitions are patched as a unit (like phases). Absent key =
  // leave untouched, so a plain name/description edit never clears them. The
  // pricing model is no longer patched here — it has its own granular tables
  // and endpoints (see the pricing write layer below).
  if ('customFields' in meta) set.custom_fields = meta.customFields ?? [];
  const { error } = await db.from('timelines').update(set).eq('id', id);
  if (error) throw new Error(`updateMeta: ${error.message}`);
}

// ---- pricing writes (granular, the pricing concurrency fix) ----------------
//
// Mirrors the item write layer: one row per feature / tier / highlight with a
// `version` optimistic-lock counter (surfaced to the client as `rowVersion`),
// so a partial edit touches exactly one row instead of the whole model. Matrix
// cells live in pricing_tier_values, one row per (tier, feature) — two editors
// changing different cells never collide. `expectedVersion` is optional: the
// browser passes it (it holds the loaded rowVersion) for true stale-write
// detection; the MCP omits it (an unconditional single-row write, still
// collision-safe versus the old whole-blob clobber).

async function nextSortFor(db: SupabaseClient, table: string, timelineId: string): Promise<number> {
  const { data } = await db
    .from(table)
    .select('sort')
    .eq('timeline_id', timelineId)
    .order('sort', { ascending: false, nullsFirst: false })
    .limit(1);
  const top = (data?.[0] as { sort?: number } | undefined)?.sort;
  return typeof top === 'number' ? top + 1 : 0;
}

// -- features --

/**
 * Pure reorder: return `ids` with `moveId` repositioned immediately after
 * `anchor.after` (preferred when both are given) or immediately before
 * `anchor.before`. DB-free so it can be unit-tested. Throws when `moveId` or the
 * chosen anchor is absent, or when they are the same id (no-op ambiguity).
 */
export function reorderIds(ids: string[], moveId: string, anchor: { after?: string; before?: string }): string[] {
  if (!ids.includes(moveId)) throw new NotFoundError();
  const anchorId = anchor.after ?? anchor.before;
  const useAfter = anchor.after != null;
  if (!anchorId) throw new Error('reorderIds: after or before required');
  if (anchorId === moveId) throw new Error('reorderIds: anchor must differ from the moved feature');
  if (!ids.includes(anchorId)) throw new NotFoundError();
  const without = ids.filter((x) => x !== moveId);
  const at = without.indexOf(anchorId);
  without.splice(useAfter ? at + 1 : at, 0, moveId);
  return without;
}

// -- tiers --

// -- tier×feature values (cell-granular) --

// -- highlights --

// -- versions (ordered label list, whole-replaced like phases) --

/** Replace all plugin registrations for a timeline (wipe + insert). */
export async function replacePluginRows(db: SupabaseClient, id: string, plugins: PluginRef[]): Promise<void> {
  const del = await db.from('timeline_plugins').delete().eq('timeline_id', id);
  if (del.error) throw new Error(`replacePluginRows clear: ${del.error.message}`);
  if (!plugins.length) return;
  const now = new Date().toISOString();
  const rows = plugins.map((p) => ({ timeline_id: id, plugin_id: p.id, config: p.config ?? {}, updated_at: now }));
  const ins = await db.from('timeline_plugins').insert(rows);
  if (ins.error) throw new Error(`replacePluginRows insert: ${ins.error.message}`);
}

// ---- the instance's install registry ---------------------------------------

const INSTALLED_SELECT =
  'plugin_id, version, api_version, artifact_kind, artifact, integrity, capabilities, manifest, enabled, installed_at, updated_at, updated_by';

function rowToInstalled(row: Record<string, any>): InstalledPlugin {
  const out: InstalledPlugin = {
    id: row.plugin_id,
    version: row.version,
    apiVersion: row.api_version,
    artifact: { kind: row.artifact_kind },
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    manifest: (row.manifest ?? {}) as Record<string, unknown>,
    enabled: row.enabled !== false,
  };
  if (row.artifact != null) out.artifact.source = row.artifact;
  if (row.integrity != null) out.artifact.integrity = row.integrity;
  if (row.installed_at != null) out.installedAt = row.installed_at;
  if (row.updated_at != null) out.updatedAt = row.updated_at;
  if (row.updated_by != null) out.updatedBy = row.updated_by;
  return out;
}

export async function listInstalledPlugins(db: SupabaseClient): Promise<InstalledPlugin[]> {
  const { data, error } = await db
    .from('installed_plugins')
    .select(INSTALLED_SELECT)
    .order('plugin_id', { ascending: true });
  if (error) throw new Error(`listInstalledPlugins: ${error.message}`);
  return (data ?? []).map(rowToInstalled);
}

export async function installPlugin(
  db: SupabaseClient,
  plugin: InstalledPlugin,
  updatedBy?: string,
): Promise<InstalledPlugin> {
  // `installed_at` is left out of the payload so the column default fills it on
  // insert and an upsert leaves the existing value alone — re-installing to change
  // a version must not reset the date the plugin first arrived.
  const { data, error } = await db
    .from('installed_plugins')
    .upsert(
      {
        plugin_id: plugin.id,
        version: plugin.version,
        api_version: plugin.apiVersion,
        artifact_kind: plugin.artifact.kind,
        artifact: plugin.artifact.source ?? null,
        integrity: plugin.artifact.integrity ?? null,
        capabilities: plugin.capabilities ?? [],
        manifest: plugin.manifest ?? {},
        enabled: plugin.enabled !== false,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy ?? null,
      },
      { onConflict: 'plugin_id' },
    )
    .select(INSTALLED_SELECT)
    .single();
  if (error) throw new Error(`installPlugin: ${error.message}`);
  return rowToInstalled(data);
}

export async function setPluginInstalledEnabled(
  db: SupabaseClient,
  pluginId: string,
  enabled: boolean,
  updatedBy?: string,
): Promise<void> {
  const { data, error } = await db
    .from('installed_plugins')
    .update({ enabled, updated_at: new Date().toISOString(), updated_by: updatedBy ?? null })
    .eq('plugin_id', pluginId)
    .select('plugin_id');
  if (error) throw new Error(`setPluginInstalledEnabled: ${error.message}`);
  if (!data || data.length === 0) throw new NotFoundError(`plugin „${pluginId}" is not installed`);
}

export async function removeInstalledPlugin(db: SupabaseClient, pluginId: string): Promise<void> {
  const { error } = await db.from('installed_plugins').delete().eq('plugin_id', pluginId);
  if (error) throw new Error(`removeInstalledPlugin: ${error.message}`);
}

// ---- a plugin's enablement on one timeline ---------------------------------

export async function setTimelinePlugin(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
  config: Record<string, unknown>,
  options: { public?: boolean } = {},
): Promise<void> {
  const { data: exists } = await db.from('timelines').select('id').eq('id', timelineId).maybeSingle();
  if (!exists) throw new NotFoundError(`timeline „${timelineId}" not found`);
  // An upsert writes every column it is given, so „say nothing about public" has
  // to mean reading the current value first: reconfiguring a plugin must not
  // silently un-publish a timeline that was already published.
  let isPublic = options.public;
  if (isPublic === undefined) {
    const { data: current } = await db
      .from('timeline_plugins')
      .select('public')
      .eq('timeline_id', timelineId)
      .eq('plugin_id', pluginId)
      .maybeSingle();
    isPublic = (current as { public?: boolean } | null)?.public === true;
  }
  const { error } = await db.from('timeline_plugins').upsert(
    {
      timeline_id: timelineId,
      plugin_id: pluginId,
      config: config ?? {},
      public: isPublic,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'timeline_id,plugin_id' },
  );
  if (error) throw new Error(`setTimelinePlugin: ${error.message}`);
}

export async function getTimelinePlugin(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
): Promise<{ timelineName?: string; config: Record<string, unknown>; public: boolean } | null> {
  const { data, error } = await db
    .from('timeline_plugins')
    .select('config, public')
    .eq('timeline_id', timelineId)
    .eq('plugin_id', pluginId)
    .maybeSingle();
  if (error) throw new Error(`getTimelinePlugin: ${error.message}`);
  if (!data) return null;
  const { data: tl } = await db.from('timelines').select('name').eq('id', timelineId).maybeSingle();
  const name = (tl as { name?: string | null } | null)?.name;
  return {
    ...(name != null ? { timelineName: name } : {}),
    config: ((data as any).config ?? {}) as Record<string, unknown>,
    public: (data as any).public === true,
  };
}

export async function removeTimelinePlugin(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
): Promise<void> {
  const { error } = await db
    .from('timeline_plugins')
    .delete()
    .eq('timeline_id', timelineId)
    .eq('plugin_id', pluginId);
  if (error) throw new Error(`removeTimelinePlugin: ${error.message}`);
}

// ---- plugin-owned rows (the generic store) ---------------------------------
//
// Mirror of the same section in ./timeline-repo.ts, over PostgREST. Three places
// where this driver has to do in two round trips what the native one does in
// one, each because PostgREST has no equivalent:
//
//   - no `on conflict … where`, so a guarded upsert is a read then a write;
//   - no jsonb `||`, so a merge patch is read-modify-write (the version guard on
//     the write still makes a concurrent change a 409 rather than a lost update);
//   - no `?|`, so „items carrying any of these keys" is filtered client-side.
//
// The extra round trip is the price of the driver that works in the Deno edge
// without raw TCP, and all three paths are cold ones (a plugin write, an
// uninstall) rather than the render path.

const PLUGIN_DATA_SELECT = 'row_id, data, version, updated_at, updated_by';

function rowToPluginRow(row: Record<string, any>): PluginDataRow {
  const out: PluginDataRow = { id: row.row_id, data: (row.data ?? {}) as Record<string, unknown> };
  if (row.version != null) out.version = row.version;
  if (row.updated_at != null) out.updatedAt = row.updated_at;
  if (row.updated_by != null) out.updatedBy = row.updated_by;
  return out;
}

export async function listPluginRows(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
  collection: string,
): Promise<PluginDataRow[]> {
  const { data, error } = await db
    .from('plugin_data')
    .select(PLUGIN_DATA_SELECT)
    .eq('timeline_id', timelineId)
    .eq('plugin_id', pluginId)
    .eq('collection', collection)
    .order('sort', { ascending: true, nullsFirst: false })
    .order('row_id', { ascending: true });
  if (error) throw new Error(`listPluginRows: ${error.message}`);
  return (data ?? []).map(rowToPluginRow);
}

export async function listPluginData(
  db: SupabaseClient,
  timelineId: string,
  pluginIds?: string[],
): Promise<PluginData> {
  let ids = pluginIds;
  if (ids == null) {
    const { data: enabled, error: enabledError } = await db
      .from('timeline_plugins')
      .select('plugin_id')
      .eq('timeline_id', timelineId);
    if (enabledError) throw new Error(`listPluginData plugins: ${enabledError.message}`);
    ids = (enabled ?? []).map((r) => (r as { plugin_id: string }).plugin_id);
  }
  if (!ids.length) return {};
  const { data, error } = await db
    .from('plugin_data')
    .select(`plugin_id, collection, ${PLUGIN_DATA_SELECT}`)
    .eq('timeline_id', timelineId)
    .in('plugin_id', ids)
    .order('plugin_id', { ascending: true })
    .order('collection', { ascending: true })
    .order('sort', { ascending: true, nullsFirst: false })
    .order('row_id', { ascending: true });
  if (error) throw new Error(`listPluginData: ${error.message}`);
  const out: PluginData = {};
  for (const row of (data ?? []) as Record<string, any>[]) {
    const byCollection = (out[row.plugin_id] ??= {});
    (byCollection[row.collection] ??= []).push(rowToPluginRow(row));
  }
  return out;
}

async function nextPluginSort(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
  collection: string,
): Promise<number> {
  const { data } = await db
    .from('plugin_data')
    .select('sort')
    .eq('timeline_id', timelineId)
    .eq('plugin_id', pluginId)
    .eq('collection', collection)
    .order('sort', { ascending: false, nullsFirst: false })
    .limit(1);
  const top = (data ?? [])[0] as { sort?: number | null } | undefined;
  return typeof top?.sort === 'number' ? top.sort + 1 : 0;
}

export async function putPluginRow(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
  collection: string,
  row: PluginDataRow,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<PluginDataRow> {
  const key = (q: any) =>
    q.eq('timeline_id', timelineId).eq('plugin_id', pluginId).eq('collection', collection).eq('row_id', row.id);
  const { data: existing } = await key(db.from('plugin_data').select('version')).maybeSingle();

  if (existing) {
    let q = key(db.from('plugin_data').update({ data: row.data ?? {}, updated_by: updatedBy ?? null }));
    if (expectedVersion != null) q = q.eq('version', expectedVersion);
    const { data, error } = await q.select(PLUGIN_DATA_SELECT);
    if (error) throw new Error(`putPluginRow: ${error.message}`);
    if (!data || data.length === 0) {
      throw new ConflictError(`${collection}/${row.id} changed since version ${expectedVersion}`);
    }
    return rowToPluginRow(data[0]);
  }

  const { data, error } = await db
    .from('plugin_data')
    .insert({
      timeline_id: timelineId,
      plugin_id: pluginId,
      collection,
      row_id: row.id,
      data: row.data ?? {},
      sort: await nextPluginSort(db, timelineId, pluginId, collection),
      updated_by: updatedBy ?? null,
    })
    .select(PLUGIN_DATA_SELECT)
    .single();
  if (error) throw new Error(`putPluginRow: ${error.message}`);
  return rowToPluginRow(data);
}

export async function patchPluginRow(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
  collection: string,
  rowId: string,
  patch: Record<string, unknown>,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<PluginDataRow> {
  const key = (q: any) =>
    q.eq('timeline_id', timelineId).eq('plugin_id', pluginId).eq('collection', collection).eq('row_id', rowId);
  const { data: current } = await key(db.from('plugin_data').select('data, version')).maybeSingle();
  if (!current) throw new NotFoundError();

  // A null clears its key rather than storing a JSON null — see the note on the
  // postgres.js implementation for why a merge write needs that to be a removal.
  const merged: Record<string, unknown> = { ...((current as any).data ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }

  // Always gate on a version, falling back to the one just read: without it the
  // read-modify-write above would silently overwrite a change that landed in
  // between, which the native driver's in-statement merge cannot do.
  const guard = expectedVersion ?? ((current as any).version as number);
  const { data, error } = await key(
    db.from('plugin_data').update({ data: merged, updated_by: updatedBy ?? null }),
  )
    .eq('version', guard)
    .select(PLUGIN_DATA_SELECT);
  if (error) throw new Error(`patchPluginRow: ${error.message}`);
  if (!data || data.length === 0) {
    throw new ConflictError(`${collection}/${rowId} changed since version ${guard}`);
  }
  return rowToPluginRow(data[0]);
}

export async function deletePluginRow(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
  collection: string,
  rowId: string,
): Promise<void> {
  const { error } = await db
    .from('plugin_data')
    .delete()
    .eq('timeline_id', timelineId)
    .eq('plugin_id', pluginId)
    .eq('collection', collection)
    .eq('row_id', rowId);
  if (error) throw new Error(`deletePluginRow: ${error.message}`);
}

export async function orderPluginRows(
  db: SupabaseClient,
  timelineId: string,
  pluginId: string,
  collection: string,
  orderedIds: string[],
  updatedBy?: string,
): Promise<void> {
  const { data } = await db
    .from('plugin_data')
    .select('row_id, sort')
    .eq('timeline_id', timelineId)
    .eq('plugin_id', pluginId)
    .eq('collection', collection);
  const current = new Map(((data ?? []) as { row_id: string; sort: number | null }[]).map((r) => [r.row_id, r.sort]));
  for (let i = 0; i < orderedIds.length; i++) {
    if (current.get(orderedIds[i]) === i) continue; // unchanged → skip the version bump
    const set: Record<string, any> = { sort: i };
    if (updatedBy) set.updated_by = updatedBy;
    const { error } = await db
      .from('plugin_data')
      .update(set)
      .eq('timeline_id', timelineId)
      .eq('plugin_id', pluginId)
      .eq('collection', collection)
      .eq('row_id', orderedIds[i]);
    if (error) throw new Error(`orderPluginRows: ${error.message}`);
  }
}

export async function replacePluginData(
  db: SupabaseClient,
  timelineId: string,
  pluginData?: PluginData,
): Promise<void> {
  const { error: wipeError } = await db.from('plugin_data').delete().eq('timeline_id', timelineId);
  if (wipeError) throw new Error(`replacePluginData wipe: ${wipeError.message}`);
  const rows: Record<string, any>[] = [];
  for (const [pluginId, collections] of Object.entries(pluginData ?? {})) {
    for (const [collection, entries] of Object.entries(collections ?? {})) {
      (entries ?? []).forEach((row, i) => {
        if (!row?.id) return;
        rows.push({
          timeline_id: timelineId,
          plugin_id: pluginId,
          collection,
          row_id: row.id,
          data: row.data ?? {},
          sort: i,
          updated_by: row.updatedBy ?? null,
        });
      });
    }
  }
  if (!rows.length) return;
  const { error } = await db.from('plugin_data').insert(rows);
  if (error) throw new Error(`replacePluginData: ${error.message}`);
}

export async function purgePluginData(
  db: SupabaseClient,
  pluginId: string,
  timelineId?: string | null,
): Promise<void> {
  let q = db.from('plugin_data').delete().eq('plugin_id', pluginId);
  if (timelineId != null) q = q.eq('timeline_id', timelineId);
  const { error } = await q;
  if (error) throw new Error(`purgePluginData: ${error.message}`);
}

export async function purgeItemMetadata(
  db: SupabaseClient,
  keys: string[],
  timelineId?: string | null,
): Promise<number> {
  if (!keys.length) return 0;
  let read = db.from('timeline_items').select('timeline_id, id, metadata, version');
  if (timelineId != null) read = read.eq('timeline_id', timelineId);
  const { data, error } = await read;
  if (error) throw new Error(`purgeItemMetadata: ${error.message}`);

  let changed = 0;
  for (const row of (data ?? []) as { timeline_id: string; id: string; metadata: Record<string, unknown> | null }[]) {
    const metadata = row.metadata ?? {};
    if (!keys.some((k) => k in metadata)) continue; // untouched items keep their version
    const next = { ...metadata };
    for (const k of keys) delete next[k];
    const { error: writeError } = await db
      .from('timeline_items')
      .update({ metadata: next })
      .eq('timeline_id', row.timeline_id)
      .eq('id', row.id);
    if (writeError) throw new Error(`purgeItemMetadata: ${writeError.message}`);
    changed++;
  }
  return changed;
}

// ---- saved views -----------------------------------------------------------
//
// PostgREST has no upsert-with-a-guard, so the write is the same read-then-branch
// `putPluginRow` uses next door: an existing row is UPDATEd with the version in
// the filter (zero rows back = stale), a missing one INSERTed. Nothing here asks
// who is reading — see the note on the seam in repo.ts.

const SAVED_VIEW_SELECT =
  'id, name, mode, group_by, filters, owner, visibility, version, created_at, created_by, updated_at, updated_by';

function rowToSavedView(row: Record<string, any>): SavedView {
  const out: SavedView = { id: row.id, name: row.name };
  if (row.mode != null) out.mode = row.mode;
  if (row.group_by != null) out.groupBy = row.group_by;
  const filters = (row.filters ?? {}) as Record<string, string[]>;
  if (Object.keys(filters).length) out.filters = filters;
  if (row.owner != null) out.owner = row.owner;
  out.visibility = row.visibility === 'instance' ? 'instance' : 'private';
  if (row.version != null) out.version = row.version;
  if (row.created_at != null) out.createdAt = row.created_at;
  if (row.created_by != null) out.createdBy = row.created_by;
  if (row.updated_at != null) out.updatedAt = row.updated_at;
  if (row.updated_by != null) out.updatedBy = row.updated_by;
  return out;
}

export async function listSavedViews(db: SupabaseClient, timelineId: string): Promise<SavedView[]> {
  const { data, error } = await db
    .from('saved_views')
    .select(SAVED_VIEW_SELECT)
    .eq('timeline_id', timelineId)
    .order('name', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`listSavedViews: ${error.message}`);
  return (data ?? []).map(rowToSavedView);
}

export async function getSavedView(
  db: SupabaseClient,
  timelineId: string,
  viewId: string,
): Promise<SavedView | null> {
  const { data, error } = await db
    .from('saved_views')
    .select(SAVED_VIEW_SELECT)
    .eq('timeline_id', timelineId)
    .eq('id', viewId)
    .maybeSingle();
  if (error) throw new Error(`getSavedView: ${error.message}`);
  return data ? rowToSavedView(data) : null;
}

export async function putSavedView(
  db: SupabaseClient,
  timelineId: string,
  view: SavedView,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<SavedView> {
  const key = (q: any) => q.eq('timeline_id', timelineId).eq('id', view.id);
  const { data: existing } = await key(db.from('saved_views').select('version')).maybeSingle();

  if (existing) {
    // `owner` and `created_by` are deliberately not in the update: a saved view
    // keeps its author, so an admin fixing somebody's shared view does not take it
    // over — which would also move it out of that person's own list.
    let q = key(
      db.from('saved_views').update({
        name: view.name,
        mode: view.mode ?? null,
        group_by: view.groupBy ?? null,
        filters: view.filters ?? {},
        visibility: view.visibility ?? 'private',
        updated_by: updatedBy ?? null,
      }),
    );
    if (expectedVersion != null) q = q.eq('version', expectedVersion);
    const { data, error } = await q.select(SAVED_VIEW_SELECT);
    if (error) throw new Error(`putSavedView: ${error.message}`);
    if (!data || data.length === 0) {
      throw new ConflictError(`saved view ${view.id} changed since version ${expectedVersion}`);
    }
    return rowToSavedView(data[0]);
  }

  const { data, error } = await db
    .from('saved_views')
    .insert({
      timeline_id: timelineId,
      id: view.id,
      name: view.name,
      mode: view.mode ?? null,
      group_by: view.groupBy ?? null,
      filters: view.filters ?? {},
      owner: view.owner ?? null,
      visibility: view.visibility ?? 'private',
      created_by: updatedBy ?? null,
      updated_by: updatedBy ?? null,
    })
    .select(SAVED_VIEW_SELECT)
    .single();
  if (error) throw new Error(`putSavedView: ${error.message}`);
  return rowToSavedView(data);
}

export async function deleteSavedView(db: SupabaseClient, timelineId: string, viewId: string): Promise<void> {
  const { error } = await db.from('saved_views').delete().eq('timeline_id', timelineId).eq('id', viewId);
  if (error) throw new Error(`deleteSavedView: ${error.message}`);
}

// -- bulk replace (import, MCP set_pricing seed, PUT) --

// ---- TimelineRepo factory (supabase-js) ------------------------------------

/**
 * Bind a supabase-js client to every storage method, yielding a `TimelineRepo`
 * the dispatcher can drive without knowing the driver. Mirror of
 * `makePostgresRepo`; this is the factory the Netlify default resolves.
 */
export function makeSupabaseRepo(db: SupabaseClient): TimelineRepo {
  return {
    listTimelines: () => listTimelines(db),
    listUsers: () => listUsers(db),
    touchUser: (email, name) => touchUser(db, email, name),
    getMember: (email) => getMember(db, email),
    listMembers: () => listMembers(db),
    inviteMember: (input) => inviteMember(db, input),
    updateMemberRole: (email, role) => updateMemberRole(db, email, role),
    setMemberStatus: (email, status) => setMemberStatus(db, email, status),
    getTimeline: (id) => getTimeline(db, id),
    getWatermark: (id) => getWatermark(db, id),
    replaceTimeline: (id, file) => replaceTimeline(db, id, file),
    addItem: (timelineId, item, updatedBy) => addItem(db, timelineId, item, updatedBy),
    updateItem: (timelineId, itemId, patch, expectedVersion, updatedBy) =>
      updateItem(db, timelineId, itemId, patch, expectedVersion, updatedBy),
    getItem: (timelineId, itemId) => getItem(db, timelineId, itemId),
    deleteItem: (timelineId, itemId) => deleteItem(db, timelineId, itemId),
    upsertGroup: (timelineId, group) => upsertGroup(db, timelineId, group),
    deleteGroup: (timelineId, groupId) => deleteGroup(db, timelineId, groupId),
    updatePhases: (id, phases) => updatePhases(db, id, phases),
    updateMeta: (id, meta) => updateMeta(db, id, meta),
    listInstalledPlugins: () => listInstalledPlugins(db),
    installPlugin: (plugin, updatedBy) => installPlugin(db, plugin, updatedBy),
    setPluginInstalledEnabled: (pluginId, enabled, updatedBy) =>
      setPluginInstalledEnabled(db, pluginId, enabled, updatedBy),
    removeInstalledPlugin: (pluginId) => removeInstalledPlugin(db, pluginId),
    setTimelinePlugin: (timelineId, pluginId, config, options) =>
      setTimelinePlugin(db, timelineId, pluginId, config, options),
    getTimelinePlugin: (timelineId, pluginId) => getTimelinePlugin(db, timelineId, pluginId),
    removeTimelinePlugin: (timelineId, pluginId) => removeTimelinePlugin(db, timelineId, pluginId),
    listPluginRows: (timelineId, pluginId, collection) => listPluginRows(db, timelineId, pluginId, collection),
    listPluginData: (timelineId, pluginIds) => listPluginData(db, timelineId, pluginIds),
    putPluginRow: (timelineId, pluginId, collection, row, expectedVersion, updatedBy) =>
      putPluginRow(db, timelineId, pluginId, collection, row, expectedVersion, updatedBy),
    patchPluginRow: (timelineId, pluginId, collection, rowId, patch, expectedVersion, updatedBy) =>
      patchPluginRow(db, timelineId, pluginId, collection, rowId, patch, expectedVersion, updatedBy),
    deletePluginRow: (timelineId, pluginId, collection, rowId) =>
      deletePluginRow(db, timelineId, pluginId, collection, rowId),
    orderPluginRows: (timelineId, pluginId, collection, orderedIds, updatedBy) =>
      orderPluginRows(db, timelineId, pluginId, collection, orderedIds, updatedBy),
    purgePluginData: (pluginId, timelineId) => purgePluginData(db, pluginId, timelineId),
    purgeItemMetadata: (keys, timelineId) => purgeItemMetadata(db, keys, timelineId),
    listSavedViews: (timelineId) => listSavedViews(db, timelineId),
    getSavedView: (timelineId, viewId) => getSavedView(db, timelineId, viewId),
    putSavedView: (timelineId, view, expectedVersion, updatedBy) =>
      putSavedView(db, timelineId, view, expectedVersion, updatedBy),
    deleteSavedView: (timelineId, viewId) => deleteSavedView(db, timelineId, viewId),
  };
}

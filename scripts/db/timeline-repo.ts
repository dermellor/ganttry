// Data-access layer for Postgres-backed timelines.
//
// Runtime-agnostic: every function takes a postgres.js `Sql` handle, so the same
// code serves the Node Vite middleware, the import script, and the Deno edge
// function. Handle creation (env cascade vs. Deno.env) lives in the callers.
//
// Item-level writes with an optimistic `version` check replace the old
// whole-sheet rewrite — concurrent edits on different items no longer clobber.
//
// postgres.js notes obeyed throughout:
//   - jsonb columns (metadata, phases, custom_fields, pricing_versions, value,
//     name_by_version, description_by_version, label_by_version) are written via
//     `sql.json(obj)` — the driver does not auto-serialize objects to jsonb. On
//     read they come back already parsed as JS objects.
//   - reserved-word columns ("end", "group") are quoted automatically by the
//     dynamic `sql(row, ...cols)` helper, and quoted by hand in raw column lists.
//   - the DB trigger bumps `version` (and `updated_at`) on UPDATE for the four
//     entity tables — never set `version` manually; read it back with `returning`.

import type { Sql } from 'postgres';
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
  type TimelineMetaPatch,
  type TimelineRepo,
} from './repo.ts';

// Re-export the shared seam types/classes so existing importers of this module
// (api.ts, mcp/server.ts, the backfill scripts) keep resolving them here.
export { ConflictError, NotFoundError, ValidationError };
export type { TimelineGroupDecl, TimelineMeta };

const ITEM_SELECT =
  'id, start, "end", duration, content, "group", type, body, icon, status, class_name, metadata, version, sort, created_at, created_by, updated_at, updated_by';

// timestamptz columns come back from postgres.js as JS Date objects; the shape
// the client/tests expect is an ISO string (what supabase-js used to return).
function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

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
  if (row.created_at != null) item.createdAt = toIso(row.created_at)!;
  if (row.created_by != null) item.createdBy = row.created_by;
  if (row.updated_at != null) item.updatedAt = toIso(row.updated_at)!;
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

export function rowToGroup(row: Record<string, any>): TimelineGroupDecl {
  const g: TimelineGroupDecl = { id: row.id, content: row.content ?? row.id };
  if (Array.isArray(row.nested_groups) && row.nested_groups.length) g.nestedGroups = row.nested_groups;
  if (row.show_nested != null) g.showNested = row.show_nested;
  if (row.color != null) g.color = row.color;
  return g;
}

export function groupToRow(timelineId: string, g: TimelineGroupDecl, sort?: number): Record<string, any> {
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: g.id,
    content: g.content ?? null,
    nested_groups: g.nestedGroups ?? null,
    show_nested: g.showNested ?? null,
    color: g.color ?? null,
  };
  if (sort != null) row.sort = sort;
  return row;
}

// jsonb columns must be wrapped in sql.json() before an insert/update (the
// driver does not auto-serialize objects). These helpers return a shallow copy
// of a plain row (produced by the pure *ToRow mappers) with the given keys
// wrapped, leaving the mappers themselves DB-free for unit tests.
function jsonRow(sql: Sql, row: Record<string, any>, ...keys: string[]): Record<string, any> {
  const out = { ...row };
  for (const k of keys) if (k in out) out[k] = sql.json(out[k] ?? null);
  return out;
}

/**
 * `sql.json` for a value typed as `unknown`-valued — a plugin's `config` or
 * `data` bag, whose contents we deliberately do not model.
 *
 * postgres.js types the parameter as its own `JSONValue`, which
 * `Record<string, unknown>` does not satisfy structurally even though every
 * legal value does at runtime. The assertion is confined here rather than
 * repeated at each call site, so there is one place to remove it if the driver's
 * type ever widens.
 */
function jsonBag(sql: Sql, value: unknown): ReturnType<Sql['json']> {
  return sql.json(value as Parameters<Sql['json']>[0]);
}

// ---- reads -----------------------------------------------------------------

export async function listTimelines(sql: Sql): Promise<TimelineMeta[]> {
  const rows = await sql`select id, name, description, group_by from timelines order by id`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? undefined,
    description: r.description ?? undefined,
    groupBy: r.group_by ?? undefined,
  }));
}

// ---- user directory (app_users) --------------------------------------------
// Named users first so a picker shows resolvable people before the address-only
// rows the backfill created; alphabetical within each group.

export async function listUsers(sql: Sql): Promise<DirectoryUser[]> {
  const rows = await sql`select email, name from app_users order by name asc nulls last, email asc`;
  return rows.map((r) => (r.name != null ? { email: r.email, name: r.name } : { email: r.email }));
}

export async function touchUser(sql: Sql, email: string, name?: string | null): Promise<void> {
  const clean = email.trim();
  if (!clean) return;
  const label = name?.trim() || null;
  // coalesce(excluded.name, app_users.name): a caller that knows only the address
  // must not wipe a name an earlier visit stored.
  await sql`
    insert into app_users (email, name) values (${clean}, ${label})
    on conflict (email) do update
      set name = coalesce(excluded.name, app_users.name),
          last_seen_at = now()`;
}

// ---- interface language (app_users.language, migration 0025) ---------------
// The one per-person preference the deployment stores. It sits on the directory
// row rather than in a preferences table because that is where per-person facts
// already live, and one nullable column does not earn a table of its own.
//
// Reading returns the **raw** column rather than a resolved locale: „has not
// chosen" and „chose English" are different facts, and only the caller knows the
// instance default to fall back to (src/i18n/locale.ts, `resolveLocale`). A repo
// method that resolved here would have to read the environment, which is exactly
// what this layer does not do.

export async function getUserLanguage(sql: Sql, email: string): Promise<string | null> {
  const clean = email.trim().toLowerCase();
  if (!clean) return null;
  const [row] = await sql`select language from app_users where lower(email) = ${clean}`;
  return row?.language ?? null;
}

/**
 * Record somebody's choice.
 *
 * An upsert, not an update: on an instance with access control **off** there is no
 * invitation flow, so the row is created by `touchUser` on first read — and a
 * person who switches language before anything has touched them would otherwise
 * update nothing and get no error, which reads as „the setting does not stick".
 *
 * `null` clears the choice, which is the way back to following the deployment's
 * own default. That is not the same as writing the default in: a stored value
 * stops tracking `TIMELINES_DEFAULT_LANGUAGE` the moment an operator changes it.
 */
export async function setUserLanguage(sql: Sql, email: string, language: string | null): Promise<void> {
  const clean = email.trim();
  if (!clean) return;
  await sql`
    insert into app_users (email, language) values (${clean}, ${language})
    on conflict (email) do update set language = ${language}`;
}

// ---- membership (app_users, migration 0016) --------------------------------
// The same rows the directory above serves, read through the columns that decide
// what a person may do. One table on purpose: see the migration's header.

const MEMBER_SELECT =
  'email, name, role, status, invited_by, invited_at, accepted_at, invite_expires_at, last_seen_at';

/** Row → `Member`, dropping nulls so an absent field is absent rather than null. */
function toMember(r: Record<string, any>): Member {
  const out: Member = { email: r.email, role: r.role, status: r.status };
  if (r.name != null) out.name = r.name;
  if (r.invited_by != null) out.invitedBy = r.invited_by;
  if (r.invited_at != null) out.invitedAt = toIso(r.invited_at)!;
  if (r.accepted_at != null) out.acceptedAt = toIso(r.accepted_at)!;
  if (r.invite_expires_at != null) out.inviteExpiresAt = toIso(r.invite_expires_at)!;
  if (r.last_seen_at != null) out.lastSeenAt = toIso(r.last_seen_at)!;
  return out;
}

export async function getMember(sql: Sql, email: string): Promise<Member | null> {
  const clean = email.trim().toLowerCase();
  if (!clean) return null;
  const [row] = await sql`
    select ${sql.unsafe(MEMBER_SELECT)} from app_users where lower(email) = ${clean}`;
  return row ? toMember(row) : null;
}

export async function listMembers(sql: Sql): Promise<Member[]> {
  const rows = await sql`
    select ${sql.unsafe(MEMBER_SELECT)} from app_users
    order by name asc nulls last, email asc`;
  return rows.map(toMember);
}

export async function inviteMember(sql: Sql, input: MemberInvite): Promise<Member> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new ValidationError('inviteMember: email required');
  // `status` on conflict keeps an accepted membership accepted: re-inviting is
  // "send the mail again", never a downgrade that would make an active user
  // re-accept. The role IS updated, since correcting it is the other reason an
  // admin re-invites.
  const [row] = await sql`
    insert into app_users (email, role, status, invited_by, invited_at, invite_token_hash, invite_expires_at)
    values (
      ${email}, ${input.role}, 'invited', ${input.invitedBy ?? null}, now(),
      ${input.tokenHash ?? null}, ${input.expiresAt ?? null}
    )
    on conflict (email) do update set
      role = excluded.role,
      status = case when app_users.status = 'active' then 'active' else 'invited' end,
      invited_by = excluded.invited_by,
      invited_at = excluded.invited_at,
      invite_token_hash = excluded.invite_token_hash,
      invite_expires_at = excluded.invite_expires_at
    returning ${sql.unsafe(MEMBER_SELECT)}`;
  return toMember(row);
}

export async function updateMemberRole(sql: Sql, email: string, role: MemberRole): Promise<Member> {
  const [row] = await sql`
    update app_users set role = ${role}
    where lower(email) = ${email.trim().toLowerCase()}
    returning ${sql.unsafe(MEMBER_SELECT)}`;
  if (!row) throw new NotFoundError(`no member ${email}`);
  return toMember(row);
}

export async function setMemberStatus(sql: Sql, email: string, status: MemberStatus): Promise<Member> {
  // Accepting stamps `accepted_at` once and clears the invitation: a spent token
  // must not resolve to a row any more, and keeping the expiry around would let
  // a later expiry check refuse a member who is long since active.
  const [row] = await sql`
    update app_users set
      status = ${status},
      accepted_at = case when ${status} = 'active' and accepted_at is null then now() else accepted_at end,
      invite_token_hash = case when ${status} = 'active' then null else invite_token_hash end,
      invite_expires_at = case when ${status} = 'active' then null else invite_expires_at end
    where lower(email) = ${email.trim().toLowerCase()}
    returning ${sql.unsafe(MEMBER_SELECT)}`;
  if (!row) throw new NotFoundError(`no member ${email}`);
  return toMember(row);
}

export async function getTimeline(sql: Sql, id: string): Promise<TimelineFile | null> {
  // `select *` rather than a column list. A named select fails outright when one of
  // its columns has not been migrated yet, which turns a schema lag into a 500 on
  // the main read path — that is what took the production timeline down on
  // 2026-08-13, for a setting nobody had used. Absent columns are simply absent
  // from the row, and every mapper here guards with `!= null`.
  //
  // Reads tolerant, writes strict: see „Reads survive a schema lag, writes do not"
  // (docs/database.md).
  const [tl] = await sql`
    select * from timelines where id = ${id}`;
  if (!tl) return null;

  const itemRows = await sql`
    select * from timeline_items
    where timeline_id = ${id} order by sort asc nulls first`;

  const groupRows = await sql`
    select * from timeline_groups
    where timeline_id = ${id} order by sort asc nulls first`;

  const pluginRows = await sql`
    select * from timeline_plugins where timeline_id = ${id} order by plugin_id asc`;

  const file: TimelineFile = { items: itemRows.map(rowToItem) };
  if (tl.name != null) file.name = tl.name;
  if (tl.description != null) file.description = tl.description;
  if (tl.group_by != null) file.groupBy = tl.group_by;
  // Only the value the reader acts on is carried through. Anything else in the
  // column degrades to the default rather than travelling to the client as a value
  // it would have to guard against (see src/groupOrder.ts, and the note on the
  // missing check constraint in migration 0024).
  if (tl.group_order === 'declared') file.groupOrder = 'declared';
  if (tl.graph && typeof tl.graph === 'object' && Object.keys(tl.graph).length) {
    file.graph = tl.graph as TimelineFile['graph'];
  }
  const plugins: PluginRef[] = pluginRows.map((r: Record<string, any>) => ({
    id: r.plugin_id,
    config: (r.config ?? {}) as Record<string, unknown>,
    ...(r.public === true ? { public: true } : {}),
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
  // Plugin-owned rows travel with the timeline rather than behind a second
  // request; the reasoning is on `PluginData` in src/types.ts. Only enabled
  // plugins are folded in, which `listPluginData` reads from `timeline_plugins`.
  if (plugins.length) {
    const pluginData = await listPluginData(sql, id);
    if (Object.keys(pluginData).length) file.pluginData = pluginData;
  }
  // Saved views travel with the timeline for the same reason plugin rows do: a
  // static local deploy has no server to ask afterwards, so one payload shape has
  // to serve both kinds of source. What this returns is UNFILTERED — the
  // dispatcher removes the ones this caller may not see, because that rule must
  // exist once rather than once per driver (see src/savedViews.ts).
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
    savedViews = await listSavedViews(sql, id);
  } catch {
    // The saved views are simply absent until the migration lands.
  }
  if (savedViews.length) file.savedViews = savedViews;
  if (groupRows.length) file.groups = groupRows.map(rowToGroup);
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
 *   pv/pn — the same pair over `plugin_data`, so a plugin's rows are covered on
 *       a polling source too. Kept apart from v/n rather than folded into them:
 *       `v` is the item row version and a second counter space mixed into it
 *       would spoil the own-echo hint. Reported as one aggregate over all
 *       plugins, because the poller's only question is "did anything change".
 *
 * NOTE: this still does NOT cover the `pricing_*` tables. Those go away in #17,
 * when product-roadmap moves onto `plugin_data` and is covered by pv/pn like any
 * other plugin; adding a third pair for tables with a scheduled removal date
 * would be work with a shelf life.
 */
export async function getWatermark(sql: Sql, id: string): Promise<Watermark> {
  const [itemRows, tlRows, pluginRows] = await Promise.all([
    sql`select version, updated_at from timeline_items where timeline_id = ${id}`,
    sql`select updated_at from timelines where id = ${id}`,
    sql`select coalesce(max(version), 0) as v, count(*)::int as n, max(updated_at) as t
        from plugin_data where timeline_id = ${id}`,
  ]);

  let v = 0;
  let t: string | null = toIso(tlRows[0]?.updated_at ?? null);
  for (const r of itemRows) {
    if (r.version != null && r.version > v) v = r.version;
    const ru = toIso(r.updated_at);
    if (ru != null && (t == null || ru > t)) t = ru;
  }
  const pluginT = toIso(pluginRows[0]?.t ?? null);
  if (pluginT != null && (t == null || pluginT > t)) t = pluginT;
  const wm: Watermark = { v, n: itemRows.length, t };
  // Omitted entirely when the timeline has no plugin rows, so a compare against
  // a source that has none never sees a 0-vs-undefined difference.
  if ((pluginRows[0]?.n ?? 0) > 0) {
    wm.pv = Number(pluginRows[0].v ?? 0);
    wm.pn = Number(pluginRows[0].n ?? 0);
  }
  return wm;
}


// ---- whole-timeline replace (import, MCP bulk, PUT fallback) ---------------

export async function replaceTimeline(sql: Sql, id: string, file: TimelineFile): Promise<void> {
  assertPhasesNonOverlapping(file.phases);
  // Before the wipe below, not while mapping the rows: this replace deletes the
  // existing items first, so a reversed item discovered mid-map would leave the
  // timeline emptied.
  assertItemExtentsOrdered(file.items);
  const meta = {
    id,
    name: file.name ?? null,
    description: file.description ?? null,
    group_by: file.groupBy ?? null,
    group_order: file.groupOrder ?? null,
    graph: sql.json(file.graph ?? null),
    phases: sql.json(file.phases ?? []),
    custom_fields: sql.json(file.customFields ?? []),
    updated_at: new Date().toISOString(),
  };
  const metaCols = [
    'name',
    'description',
    'group_by',
    'group_order',
    'graph',
    'phases',
    'custom_fields',
    'updated_at',
  ] as const;
  await sql`
    insert into timelines ${sql(meta, 'id', ...metaCols)}
    on conflict (id) do update set ${sql(meta, ...metaCols)}`;

  // Clear children, then re-insert (cascade-free explicit wipe keeps it simple).
  await sql`delete from timeline_items where timeline_id = ${id}`;
  await sql`delete from timeline_groups where timeline_id = ${id}`;

  // Plugin registrations (enablement + config). `pluginsForWrite` carries the
  // one rule: a plugin whose rows are in the payload is a plugin that is
  // enabled, or the write stores data nothing reads.
  await replacePluginRows(sql, id, pluginsForWrite(file));


  // Plugin-owned rows. Same wipe-and-reinsert as everything else here, so a
  // round trip through GET → PUT preserves a plugin's data instead of dropping
  // it — a bulk write that silently emptied one collection would be the worst
  // kind of loss, since nothing in the request said anything about it.
  await replacePluginData(sql, id, file.pluginData);

  const itemRows = file.items
    // `start` is optional: a list-created item can exist without a date yet.
    .filter((it) => it.id && it.content)
    .map((it, i) => jsonRow(sql, itemToRow(id, it, i), 'metadata'));
  if (itemRows.length) {
    await sql`insert into timeline_items ${sql(
      itemRows,
      'timeline_id', 'id', 'start', 'end', 'duration', 'content', 'group', 'type', 'body', 'icon', 'status', 'class_name', 'metadata', 'sort',
    )}`;
  }

  const groupRows = (file.groups ?? []).map((g, i) => groupToRow(id, g, i));
  if (groupRows.length) {
    await sql`insert into timeline_groups ${sql(
      groupRows,
      'timeline_id', 'id', 'content', 'nested_groups', 'show_nested', 'color', 'sort',
    )}`;
  }
}

// ---- item-level writes (the concurrency fix) -------------------------------

async function nextSort(sql: Sql, timelineId: string): Promise<number> {
  const [top] = await sql`
    select sort from timeline_items
    where timeline_id = ${timelineId} order by sort desc nulls last limit 1`;
  return typeof top?.sort === 'number' ? top.sort + 1 : 0;
}

/** Insert a new item. Fails if the id already exists. */
export async function addItem(
  sql: Sql,
  timelineId: string,
  item: TimelineFileItem,
  updatedBy?: string,
): Promise<TimelineFileItem> {
  assertExtentOrdered(item);
  const row = itemToRow(timelineId, item, await nextSort(sql, timelineId));
  if (updatedBy) {
    row.updated_by = updatedBy;
    row.created_by = updatedBy; // attribute the creation to the same actor
  }
  const cols = Object.keys(row);
  const [data] = await sql`
    insert into timeline_items ${sql(jsonRow(sql, row, 'metadata'), ...cols)}
    returning ${sql.unsafe(ITEM_SELECT)}`;
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
  sql: Sql,
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
    const cur = await getItem(sql, timelineId, itemId);
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
  sql: Sql,
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
    const cur = await getItem(sql, timelineId, itemId);
    if (!cur) throw new NotFoundError();
    return cur;
  }
  await assertPatchExtentOrdered(sql, timelineId, itemId, set);
  // jsonb column needs sql.json wrapping.
  if ('metadata' in set) set.metadata = sql.json(set.metadata ?? {});

  const cols = Object.keys(set);
  const versionCond = expectedVersion != null ? sql`and version = ${expectedVersion}` : sql``;
  const data = await sql`
    update timeline_items set ${sql(set, ...cols)}
    where timeline_id = ${timelineId} and id = ${itemId} ${versionCond}
    returning ${sql.unsafe(ITEM_SELECT)}`;
  if (data.length === 0) {
    // Either the row is gone or the version moved on.
    const exists = await getItem(sql, timelineId, itemId);
    if (!exists) throw new NotFoundError();
    throw new ConflictError(`item ${itemId} changed since version ${expectedVersion}`);
  }
  return rowToItem(data[0]);
}

export async function getItem(
  sql: Sql,
  timelineId: string,
  itemId: string,
): Promise<TimelineFileItem | null> {
  const [data] = await sql`
    select ${sql.unsafe(ITEM_SELECT)} from timeline_items
    where timeline_id = ${timelineId} and id = ${itemId}`;
  return data ? rowToItem(data) : null;
}

export async function deleteItem(sql: Sql, timelineId: string, itemId: string): Promise<void> {
  await sql`delete from timeline_items where timeline_id = ${timelineId} and id = ${itemId}`;
}

// ---- group writes ----------------------------------------------------------

export async function upsertGroup(
  sql: Sql,
  timelineId: string,
  group: TimelineGroupDecl,
): Promise<TimelineGroupDecl> {
  const row = groupToRow(timelineId, group);
  // One list for insert and update, and `returning *` for the read back: the column
  // names were written out three times, and adding `color` to the mapper while
  // missing any of the three stores or returns a null without failing anywhere.
  // That is the shape of bug #137 was about.
  const cols = ['content', 'nested_groups', 'show_nested', 'color'] as const;
  const [data] = await sql`
    insert into timeline_groups ${sql(row, 'timeline_id', 'id', ...cols)}
    on conflict (timeline_id, id) do update set ${sql(row, ...cols)}
    returning *`;
  return rowToGroup(data);
}

export async function deleteGroup(sql: Sql, timelineId: string, groupId: string): Promise<void> {
  await sql`delete from timeline_groups where timeline_id = ${timelineId} and id = ${groupId}`;
}

// ---- timeline-level meta / phases ------------------------------------------

// Reject overlapping phases before any write persists them, from any path (item
// API PUT, MCP replace_timeline, import). Single invariant, one gate.
function assertPhasesNonOverlapping(phases: TimelinePhase[] | undefined): void {
  const clash = findPhaseOverlap(phases ?? []);
  if (clash) throw new ValidationError(describePhaseOverlap(clash.a, clash.b));
}

export async function updatePhases(sql: Sql, id: string, phases: TimelinePhase[]): Promise<void> {
  assertPhasesNonOverlapping(phases);
  await sql`
    update timelines set phases = ${sql.json(phases ?? [])}, updated_at = ${new Date().toISOString()}
    where id = ${id}`;
}

export async function updateMeta(sql: Sql, id: string, meta: TimelineMetaPatch): Promise<void> {
  const set: Record<string, any> = { updated_at: new Date().toISOString() };
  if ('name' in meta) set.name = meta.name ?? null;
  if ('description' in meta) set.description = meta.description ?? null;
  if ('groupBy' in meta) set.group_by = meta.groupBy ?? null;
  // Custom-field definitions are patched as a unit (like phases). Absent key =
  // leave untouched, so a plain name/description edit never clears them. The
  // pricing model is no longer patched here — it has its own granular tables
  // and endpoints (see the pricing write layer below).
  if ('customFields' in meta) set.custom_fields = sql.json(meta.customFields ?? []);
  if ('groupOrder' in meta) set.group_order = meta.groupOrder ?? null;
  // `null` clears it; an object replaces it whole. Patching *into* the bag would
  // need a merge rule for a value the caller may not have read first, and „set the
  // graph config" is a small enough statement to make as a unit.
  if ('graph' in meta) set.graph = sql.json(meta.graph ?? null);
  await sql`update timelines set ${sql(set, ...Object.keys(set))} where id = ${id}`;
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

async function nextSortFor(sql: Sql, table: string, timelineId: string): Promise<number> {
  const [top] = await sql`
    select sort from ${sql(table)}
    where timeline_id = ${timelineId} order by sort desc nulls last limit 1`;
  return typeof top?.sort === 'number' ? top.sort + 1 : 0;
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

/**
 * Replace the plugin registrations for a timeline (wipe + insert). The `||`
 * jsonb-merge form in updateVersions is for the granular version-list write;
 * this whole-set replace is used by replaceTimeline.
 */
export async function replacePluginRows(sql: Sql, id: string, plugins: PluginRef[]): Promise<void> {
  await sql`delete from timeline_plugins where timeline_id = ${id}`;
  if (!plugins.length) return;
  const now = new Date().toISOString();
  const rows = plugins.map((p) => ({
    timeline_id: id,
    plugin_id: p.id,
    config: jsonBag(sql, p.config ?? {}),
    public: p.public === true,
    updated_at: now,
  }));
  await sql`insert into timeline_plugins ${sql(rows, 'timeline_id', 'plugin_id', 'config', 'public', 'updated_at')}`;
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
  const installed = toIso(row.installed_at);
  if (installed != null) out.installedAt = installed;
  const updated = toIso(row.updated_at);
  if (updated != null) out.updatedAt = updated;
  if (row.updated_by != null) out.updatedBy = row.updated_by;
  return out;
}

export async function listInstalledPlugins(sql: Sql): Promise<InstalledPlugin[]> {
  const rows = await sql`select ${sql.unsafe(INSTALLED_SELECT)} from installed_plugins order by plugin_id asc`;
  return rows.map(rowToInstalled);
}

/**
 * Upsert one registry row. `installed_at` is set only on insert, so re-installing
 * to change a version keeps the date the plugin first arrived — which is the one
 * an operator is looking for when they ask how long it has been here.
 */
export async function installPlugin(
  sql: Sql,
  plugin: InstalledPlugin,
  updatedBy?: string,
): Promise<InstalledPlugin> {
  const [data] = await sql`
    insert into installed_plugins
      (plugin_id, version, api_version, artifact_kind, artifact, integrity, capabilities, manifest, enabled, updated_by)
    values (
      ${plugin.id}, ${plugin.version}, ${plugin.apiVersion}, ${plugin.artifact.kind},
      ${plugin.artifact.source ?? null}, ${plugin.artifact.integrity ?? null},
      ${jsonBag(sql, plugin.capabilities ?? [])}, ${jsonBag(sql, plugin.manifest ?? {})},
      ${plugin.enabled !== false}, ${updatedBy ?? null}
    )
    on conflict (plugin_id) do update set
      version = excluded.version,
      api_version = excluded.api_version,
      artifact_kind = excluded.artifact_kind,
      artifact = excluded.artifact,
      integrity = excluded.integrity,
      capabilities = excluded.capabilities,
      manifest = excluded.manifest,
      enabled = excluded.enabled,
      updated_at = now(),
      updated_by = excluded.updated_by
    returning ${sql.unsafe(INSTALLED_SELECT)}`;
  return rowToInstalled(data);
}

export async function setPluginInstalledEnabled(
  sql: Sql,
  pluginId: string,
  enabled: boolean,
  updatedBy?: string,
): Promise<void> {
  const rows = await sql`
    update installed_plugins set enabled = ${enabled}, updated_at = now(), updated_by = ${updatedBy ?? null}
    where plugin_id = ${pluginId} returning plugin_id`;
  if (rows.length === 0) throw new NotFoundError(`plugin „${pluginId}" is not installed`);
}

export async function removeInstalledPlugin(sql: Sql, pluginId: string): Promise<void> {
  await sql`delete from installed_plugins where plugin_id = ${pluginId}`;
}

// ---- a plugin's enablement on one timeline ---------------------------------

export async function setTimelinePlugin(
  sql: Sql,
  timelineId: string,
  pluginId: string,
  config: Record<string, unknown>,
  options: { public?: boolean } = {},
): Promise<void> {
  const [exists] = await sql`select id from timelines where id = ${timelineId}`;
  if (!exists) throw new NotFoundError(`timeline „${timelineId}" not found`);
  // `public` is only written when the caller said something about it. An enable
  // that carries no opinion must not silently un-publish a timeline that was
  // already published — reconfiguring a plugin is not consent to change who may
  // read it.
  const publicClause = options.public === undefined ? sql`` : sql`, public = ${options.public}`;
  await sql`
    insert into timeline_plugins (timeline_id, plugin_id, config, public, updated_at)
    values (${timelineId}, ${pluginId}, ${jsonBag(sql, config ?? {})}, ${options.public ?? false}, now())
    on conflict (timeline_id, plugin_id) do update
      set config = excluded.config, updated_at = now() ${publicClause}`;
}

export async function getTimelinePlugin(
  sql: Sql,
  timelineId: string,
  pluginId: string,
): Promise<{ timelineName?: string; config: Record<string, unknown>; public: boolean } | null> {
  const [row] = await sql`
    select tp.config, tp.public, t.name
    from timeline_plugins tp join timelines t on t.id = tp.timeline_id
    where tp.timeline_id = ${timelineId} and tp.plugin_id = ${pluginId}`;
  if (!row) return null;
  return {
    ...(row.name != null ? { timelineName: row.name as string } : {}),
    config: (row.config ?? {}) as Record<string, unknown>,
    public: row.public === true,
  };
}

export async function removeTimelinePlugin(sql: Sql, timelineId: string, pluginId: string): Promise<void> {
  await sql`delete from timeline_plugins where timeline_id = ${timelineId} and plugin_id = ${pluginId}`;
}

// ---- plugin-owned rows (the generic store) ---------------------------------
//
// One table for every plugin (`plugin_data`, migration 0016). The shape rules,
// the references and the ordering are NOT here — they are enforced above the
// repo so the file-backed store is held to the same ones. What is here is the
// storage and the locking, and the locking is the item rule reused verbatim: the
// UPDATE is gated on `version`, zero rows updated means either gone or stale,
// and the follow-up SELECT tells the two apart.

const PLUGIN_DATA_SELECT = 'row_id, data, version, updated_at, updated_by';

function rowToPluginRow(row: Record<string, any>): PluginDataRow {
  const out: PluginDataRow = { id: row.row_id, data: (row.data ?? {}) as Record<string, unknown> };
  if (row.version != null) out.version = row.version;
  const at = toIso(row.updated_at);
  if (at != null) out.updatedAt = at;
  if (row.updated_by != null) out.updatedBy = row.updated_by;
  return out;
}

export async function listPluginRows(
  sql: Sql,
  timelineId: string,
  pluginId: string,
  collection: string,
): Promise<PluginDataRow[]> {
  const rows = await sql`
    select ${sql.unsafe(PLUGIN_DATA_SELECT)} from plugin_data
    where timeline_id = ${timelineId} and plugin_id = ${pluginId} and collection = ${collection}
    order by sort asc nulls last, row_id asc`;
  return rows.map(rowToPluginRow);
}

/**
 * Every collection of the named plugins, grouped for the timeline payload.
 *
 * With no `pluginIds`, the set is „whatever this timeline has enabled" — read
 * from `timeline_plugins` in the same statement. A plugin whose rows survive
 * after it was disabled therefore stops shipping them without them being
 * deleted, which is what makes re-enabling lossless (see #13).
 */
export async function listPluginData(sql: Sql, timelineId: string, pluginIds?: string[]): Promise<PluginData> {
  const scope =
    pluginIds != null
      ? sql`and plugin_id = any(${pluginIds})`
      : sql`and plugin_id in (select plugin_id from timeline_plugins where timeline_id = ${timelineId})`;
  const rows = await sql`
    select plugin_id, collection, ${sql.unsafe(PLUGIN_DATA_SELECT)} from plugin_data
    where timeline_id = ${timelineId} ${scope}
    order by plugin_id asc, collection asc, sort asc nulls last, row_id asc`;
  const out: PluginData = {};
  for (const row of rows) {
    const byCollection = (out[row.plugin_id] ??= {});
    (byCollection[row.collection] ??= []).push(rowToPluginRow(row));
  }
  return out;
}

async function nextPluginSort(sql: Sql, timelineId: string, pluginId: string, collection: string): Promise<number> {
  const [top] = await sql`
    select sort from plugin_data
    where timeline_id = ${timelineId} and plugin_id = ${pluginId} and collection = ${collection}
    order by sort desc nulls last limit 1`;
  return typeof top?.sort === 'number' ? top.sort + 1 : 0;
}

/**
 * Upsert a row's whole `data`.
 *
 * `sort` is assigned on insert only, so a rewrite of an existing row keeps its
 * place — otherwise saving a row would silently move it to the end of an ordered
 * collection. It is assigned even for a collection that declared no order,
 * because insertion order is a better default than none: without it the fallback
 * is the row id, and a list would reshuffle itself as ids are added.
 */
export async function putPluginRow(
  sql: Sql,
  timelineId: string,
  pluginId: string,
  collection: string,
  row: PluginDataRow,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<PluginDataRow> {
  const sort = await nextPluginSort(sql, timelineId, pluginId, collection);
  const guard = expectedVersion != null ? sql`where plugin_data.version = ${expectedVersion}` : sql``;
  const data = await sql`
    insert into plugin_data (timeline_id, plugin_id, collection, row_id, data, sort, updated_by)
    values (${timelineId}, ${pluginId}, ${collection}, ${row.id}, ${jsonBag(sql, row.data ?? {})}, ${sort}, ${updatedBy ?? null})
    on conflict (timeline_id, plugin_id, collection, row_id) do update
      set data = excluded.data, updated_by = excluded.updated_by
      ${guard}
    returning ${sql.unsafe(PLUGIN_DATA_SELECT)}`;
  if (data.length === 0) {
    // Nothing inserted and nothing updated: the row exists and the guard
    // rejected it. (Without a guard the upsert always writes, so this branch is
    // only reachable with an If-Match.)
    throw new ConflictError(`${collection}/${row.id} changed since version ${expectedVersion}`);
  }
  return rowToPluginRow(data[0]);
}

/**
 * Shallow-merge `patch` into a row's `data`.
 *
 * A `null` value REMOVES its key rather than storing a JSON null. That mirrors
 * how an item PATCH treats null (clear the field), and it is the only way a
 * merge-shaped write can delete a key at all — storing null instead would leave
 * the key present and make `required` in a collection's schema unsatisfiable
 * after the first clear.
 */
export async function patchPluginRow(
  sql: Sql,
  timelineId: string,
  pluginId: string,
  collection: string,
  rowId: string,
  patch: Record<string, unknown>,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<PluginDataRow> {
  const set: Record<string, unknown> = {};
  const drop: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) drop.push(key);
    else set[key] = value;
  }
  const versionCond = expectedVersion != null ? sql`and version = ${expectedVersion}` : sql``;
  const data = await sql`
    update plugin_data
    set data = (data || ${jsonBag(sql, set)}::jsonb) - ${drop}::text[],
        updated_by = coalesce(${updatedBy ?? null}, updated_by)
    where timeline_id = ${timelineId} and plugin_id = ${pluginId}
      and collection = ${collection} and row_id = ${rowId} ${versionCond}
    returning ${sql.unsafe(PLUGIN_DATA_SELECT)}`;
  if (data.length === 0) {
    const [exists] = await sql`
      select row_id from plugin_data
      where timeline_id = ${timelineId} and plugin_id = ${pluginId}
        and collection = ${collection} and row_id = ${rowId}`;
    if (!exists) throw new NotFoundError();
    throw new ConflictError(`${collection}/${rowId} changed since version ${expectedVersion}`);
  }
  return rowToPluginRow(data[0]);
}

export async function deletePluginRow(
  sql: Sql,
  timelineId: string,
  pluginId: string,
  collection: string,
  rowId: string,
): Promise<void> {
  await sql`
    delete from plugin_data
    where timeline_id = ${timelineId} and plugin_id = ${pluginId}
      and collection = ${collection} and row_id = ${rowId}`;
}

/**
 * Renumber `sort` to a contiguous 0..n-1 in the given order, writing only the
 * rows that actually move. Skipping the unchanged ones matters because every
 * write bumps a row's version, and bumping all of them would make one reorder
 * invalidate every open editor's If-Match.
 */
export async function orderPluginRows(
  sql: Sql,
  timelineId: string,
  pluginId: string,
  collection: string,
  orderedIds: string[],
  updatedBy?: string,
): Promise<void> {
  const rows = await sql`
    select row_id, sort from plugin_data
    where timeline_id = ${timelineId} and plugin_id = ${pluginId} and collection = ${collection}`;
  const current = new Map(rows.map((r) => [r.row_id as string, r.sort as number | null]));
  for (let i = 0; i < orderedIds.length; i++) {
    if (current.get(orderedIds[i]) === i) continue;
    await sql`
      update plugin_data set sort = ${i}, updated_by = coalesce(${updatedBy ?? null}, updated_by)
      where timeline_id = ${timelineId} and plugin_id = ${pluginId}
        and collection = ${collection} and row_id = ${orderedIds[i]}`;
  }
}

/**
 * Wipe and re-insert every plugin row of a timeline from a whole `PluginData`
 * section. Used by `replaceTimeline`; `sort` follows the array order, which is
 * what makes the file's order authoritative on the way back in.
 */
export async function replacePluginData(sql: Sql, timelineId: string, pluginData?: PluginData): Promise<void> {
  await sql`delete from plugin_data where timeline_id = ${timelineId}`;
  const rows: Record<string, any>[] = [];
  for (const [pluginId, collections] of Object.entries(pluginData ?? {})) {
    for (const [collection, entries] of Object.entries(collections ?? {})) {
      (entries ?? []).forEach((row, i) => {
        if (!row?.id) return; // a row without an id cannot be addressed again
        rows.push({
          timeline_id: timelineId,
          plugin_id: pluginId,
          collection,
          row_id: row.id,
          data: jsonBag(sql, row.data ?? {}),
          sort: i,
          updated_by: row.updatedBy ?? null,
        });
      });
    }
  }
  if (!rows.length) return;
  await sql`insert into plugin_data ${sql(rows, 'timeline_id', 'plugin_id', 'collection', 'row_id', 'data', 'sort', 'updated_by')}`;
}

export async function purgePluginData(sql: Sql, pluginId: string, timelineId?: string | null): Promise<void> {
  if (timelineId != null) {
    await sql`delete from plugin_data where plugin_id = ${pluginId} and timeline_id = ${timelineId}`;
    return;
  }
  await sql`delete from plugin_data where plugin_id = ${pluginId}`;
}

/**
 * Strip `keys` off every item's `metadata`. Returns how many items changed.
 *
 * `metadata ?| keys` restricts the UPDATE to the items that actually carry one,
 * so an uninstall does not bump the version of every item in the timeline and
 * hand every open client a spurious reload.
 */
export async function purgeItemMetadata(sql: Sql, keys: string[], timelineId?: string | null): Promise<number> {
  if (!keys.length) return 0;
  const scope = timelineId != null ? sql`and timeline_id = ${timelineId}` : sql``;
  const rows = await sql`
    update timeline_items set metadata = metadata - ${keys}::text[]
    where metadata ?| ${keys}::text[] ${scope}
    returning id`;
  return rows.length;
}

// ---- saved views -----------------------------------------------------------
//
// The same locking rule as an item: the UPDATE half of the upsert is gated on
// `version`, and zero rows written with a guard present means the row moved on.
// Nothing here asks who is reading — see the note on the seam in repo.ts.

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
  const createdAt = toIso(row.created_at);
  if (createdAt != null) out.createdAt = createdAt;
  if (row.created_by != null) out.createdBy = row.created_by;
  const updatedAt = toIso(row.updated_at);
  if (updatedAt != null) out.updatedAt = updatedAt;
  if (row.updated_by != null) out.updatedBy = row.updated_by;
  return out;
}

export async function listSavedViews(sql: Sql, timelineId: string): Promise<SavedView[]> {
  const rows = await sql`
    select ${sql.unsafe(SAVED_VIEW_SELECT)} from saved_views
    where timeline_id = ${timelineId} order by name asc, id asc`;
  return rows.map(rowToSavedView);
}

export async function getSavedView(sql: Sql, timelineId: string, viewId: string): Promise<SavedView | null> {
  const [row] = await sql`
    select ${sql.unsafe(SAVED_VIEW_SELECT)} from saved_views
    where timeline_id = ${timelineId} and id = ${viewId}`;
  return row ? rowToSavedView(row) : null;
}

export async function putSavedView(
  sql: Sql,
  timelineId: string,
  view: SavedView,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<SavedView> {
  const guard = expectedVersion != null ? sql`where saved_views.version = ${expectedVersion}` : sql``;
  const rows = await sql`
    insert into saved_views (timeline_id, id, name, mode, group_by, filters, owner, visibility, created_by, updated_by)
    values (
      ${timelineId}, ${view.id}, ${view.name}, ${view.mode ?? null}, ${view.groupBy ?? null},
      ${sql.json((view.filters ?? {}) as any)}, ${view.owner ?? null}, ${view.visibility ?? 'private'},
      ${updatedBy ?? null}, ${updatedBy ?? null}
    )
    on conflict (timeline_id, id) do update
      set name = excluded.name,
          mode = excluded.mode,
          group_by = excluded.group_by,
          filters = excluded.filters,
          -- owner and created_by are left out on purpose: a saved view keeps the
          -- author it was created by, so an admin editing somebody's shared view
          -- does not quietly take it over, which would also move it out of that
          -- person's own list.
          visibility = excluded.visibility,
          updated_by = excluded.updated_by
      ${guard}
    returning ${sql.unsafe(SAVED_VIEW_SELECT)}`;
  if (rows.length === 0) {
    throw new ConflictError(`saved view ${view.id} changed since version ${expectedVersion}`);
  }
  return rowToSavedView(rows[0]);
}

export async function deleteSavedView(sql: Sql, timelineId: string, viewId: string): Promise<void> {
  await sql`delete from saved_views where timeline_id = ${timelineId} and id = ${viewId}`;
}

// -- bulk replace (import, MCP set_pricing seed, PUT) --

// ---- TimelineRepo factory (postgres.js) ------------------------------------

/**
 * Bind a postgres.js `Sql` handle to every storage method, yielding a
 * `TimelineRepo` the dispatcher can drive without knowing the driver. The
 * standalone functions above stay exported (tests, import/backfill scripts, the
 * pure-helper importers still use them directly).
 */
export function makePostgresRepo(sql: Sql): TimelineRepo {
  return {
    listTimelines: () => listTimelines(sql),
    listUsers: () => listUsers(sql),
    touchUser: (email, name) => touchUser(sql, email, name),
    getUserLanguage: (email) => getUserLanguage(sql, email),
    setUserLanguage: (email, language) => setUserLanguage(sql, email, language),
    getMember: (email) => getMember(sql, email),
    listMembers: () => listMembers(sql),
    inviteMember: (input) => inviteMember(sql, input),
    updateMemberRole: (email, role) => updateMemberRole(sql, email, role),
    setMemberStatus: (email, status) => setMemberStatus(sql, email, status),
    getTimeline: (id) => getTimeline(sql, id),
    getWatermark: (id) => getWatermark(sql, id),
    replaceTimeline: (id, file) => replaceTimeline(sql, id, file),
    addItem: (timelineId, item, updatedBy) => addItem(sql, timelineId, item, updatedBy),
    updateItem: (timelineId, itemId, patch, expectedVersion, updatedBy) =>
      updateItem(sql, timelineId, itemId, patch, expectedVersion, updatedBy),
    getItem: (timelineId, itemId) => getItem(sql, timelineId, itemId),
    deleteItem: (timelineId, itemId) => deleteItem(sql, timelineId, itemId),
    upsertGroup: (timelineId, group) => upsertGroup(sql, timelineId, group),
    deleteGroup: (timelineId, groupId) => deleteGroup(sql, timelineId, groupId),
    updatePhases: (id, phases) => updatePhases(sql, id, phases),
    updateMeta: (id, meta) => updateMeta(sql, id, meta),
    listInstalledPlugins: () => listInstalledPlugins(sql),
    installPlugin: (plugin, updatedBy) => installPlugin(sql, plugin, updatedBy),
    setPluginInstalledEnabled: (pluginId, enabled, updatedBy) =>
      setPluginInstalledEnabled(sql, pluginId, enabled, updatedBy),
    removeInstalledPlugin: (pluginId) => removeInstalledPlugin(sql, pluginId),
    setTimelinePlugin: (timelineId, pluginId, config, options) =>
      setTimelinePlugin(sql, timelineId, pluginId, config, options),
    getTimelinePlugin: (timelineId, pluginId) => getTimelinePlugin(sql, timelineId, pluginId),
    removeTimelinePlugin: (timelineId, pluginId) => removeTimelinePlugin(sql, timelineId, pluginId),
    listPluginRows: (timelineId, pluginId, collection) => listPluginRows(sql, timelineId, pluginId, collection),
    listPluginData: (timelineId, pluginIds) => listPluginData(sql, timelineId, pluginIds),
    putPluginRow: (timelineId, pluginId, collection, row, expectedVersion, updatedBy) =>
      putPluginRow(sql, timelineId, pluginId, collection, row, expectedVersion, updatedBy),
    patchPluginRow: (timelineId, pluginId, collection, rowId, patch, expectedVersion, updatedBy) =>
      patchPluginRow(sql, timelineId, pluginId, collection, rowId, patch, expectedVersion, updatedBy),
    deletePluginRow: (timelineId, pluginId, collection, rowId) =>
      deletePluginRow(sql, timelineId, pluginId, collection, rowId),
    orderPluginRows: (timelineId, pluginId, collection, orderedIds, updatedBy) =>
      orderPluginRows(sql, timelineId, pluginId, collection, orderedIds, updatedBy),
    purgePluginData: (pluginId, timelineId) => purgePluginData(sql, pluginId, timelineId),
    purgeItemMetadata: (keys, timelineId) => purgeItemMetadata(sql, keys, timelineId),
    listSavedViews: (timelineId) => listSavedViews(sql, timelineId),
    getSavedView: (timelineId, viewId) => getSavedView(sql, timelineId, viewId),
    putSavedView: (timelineId, view, expectedVersion, updatedBy) =>
      putSavedView(sql, timelineId, view, expectedVersion, updatedBy),
    deleteSavedView: (timelineId, viewId) => deleteSavedView(sql, timelineId, viewId),
  };
}

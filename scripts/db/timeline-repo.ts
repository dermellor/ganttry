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
import type {
  CustomFieldDef,
  DirectoryUser,
  InstalledPlugin,
  PluginData,
  PluginDataRow,
  PluginRef,
  Pricing,
  PricingFeature,
  PricingHighlight,
  PricingTier,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
  Watermark,
} from '../../src/types';
import { statusOrDefault } from '../../src/status.ts';
import { describePhaseOverlap, findPhaseOverlap } from '../../src/phaseOverlap.ts';
import { describeReversedExtent, findReversedExtent, hasReversedExtent } from '../../src/itemExtent.ts';
import { PRODUCT_ROADMAP_PLUGIN, resolveWritePlugins, versionsFromConfig } from '../../src/plugins/product-roadmap/plugin.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type PublicPricing,
  type TimelineGroupDecl,
  type TimelineMeta,
  type TimelineRepo,
} from './repo.ts';

// Re-export the shared seam types/classes so existing importers of this module
// (api.ts, mcp/server.ts, the backfill scripts) keep resolving them here.
export { ConflictError, NotFoundError, ValidationError };
export type { PublicPricing, TimelineGroupDecl, TimelineMeta };

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

export async function getTimeline(sql: Sql, id: string): Promise<TimelineFile | null> {
  const [tl] = await sql`
    select id, name, description, group_by, phases, custom_fields
    from timelines where id = ${id}`;
  if (!tl) return null;

  const itemRows = await sql`
    select ${sql.unsafe(ITEM_SELECT)} from timeline_items
    where timeline_id = ${id} order by sort asc nulls first`;

  const groupRows = await sql`
    select id, content, nested_groups, show_nested, sort from timeline_groups
    where timeline_id = ${id} order by sort asc nulls first`;

  const pluginRows = await sql`
    select plugin_id, config, public from timeline_plugins where timeline_id = ${id} order by plugin_id asc`;

  const file: TimelineFile = { items: itemRows.map(rowToItem) };
  if (tl.name != null) file.name = tl.name;
  if (tl.description != null) file.description = tl.description;
  if (tl.group_by != null) file.groupBy = tl.group_by;
  const plugins: PluginRef[] = pluginRows.map((r: Record<string, any>) => ({
    id: r.plugin_id,
    config: (r.config ?? {}) as Record<string, unknown>,
    ...(r.public === true ? { public: true } : {}),
  }));
  if (plugins.length) file.plugins = plugins;
  if (Array.isArray(tl.phases) && tl.phases.length) file.phases = tl.phases as TimelinePhase[];
  if (Array.isArray(tl.custom_fields) && tl.custom_fields.length)
    file.customFields = tl.custom_fields as CustomFieldDef[];
  // Assemble the pricing model from the normalized tables. The ordered version
  // list now lives in the product-roadmap plugin's config (was the dropped
  // pricing_versions column). Only surface a populated model — matches the old
  // behaviour of surfacing pricing only when it carried tiers/features.
  // rowVersion is included here (editable path) so the client can send If-Match.
  const versions = versionsFromConfig(plugins.find((p) => p.id === PRODUCT_ROADMAP_PLUGIN)?.config);
  const pricing = await assemblePricing(sql, id, versions);
  if (pricing && (pricing.features.length || pricing.tiers.length)) file.pricing = pricing;
  // Plugin-owned rows travel with the timeline rather than behind a second
  // request; the reasoning is on `PluginData` in src/types.ts. Only enabled
  // plugins are folded in, which `listPluginData` reads from `timeline_plugins`.
  if (plugins.length) {
    const pluginData = await listPluginData(sql, id);
    if (Object.keys(pluginData).length) file.pluginData = pluginData;
  }
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

// ---- public pricing (marketing sites consume this) -------------------------

/**
 * Pricing-only view of a product timeline for public consumption (e.g. the Astro
 * pricing page). Returns just name + the pricing model — never roadmap items or
 * status. Null when the timeline isn't a product timeline or has no pricing, so
 * the caller can 404. This is the single source of truth for external pages.
 */
export async function getPublicPricing(sql: Sql, id: string): Promise<PublicPricing | null> {
  const [data] = await sql`select name from timelines where id = ${id}`;
  if (!data) return null;
  const [plugin] = await sql`
    select config from timeline_plugins where timeline_id = ${id} and plugin_id = ${PRODUCT_ROADMAP_PLUGIN}`;
  if (!plugin) return null;
  const versions = versionsFromConfig(plugin.config as Record<string, unknown>);
  const pricing = await assemblePricing(sql, id, versions);
  if (!pricing || !pricing.tiers.length) return null;
  // Public consumers don't need the internal lock counters.
  stripRowVersions(pricing);
  const out: PublicPricing = { id, pricing };
  if (data.name != null) out.name = data.name;
  return out;
}

// ---- pricing assembly (normalized tables → the Pricing shape) --------------

function rowToFeature(row: Record<string, any>): PricingFeature {
  const f: PricingFeature = { id: row.id, name: row.name ?? '' };
  if (row.group != null) f.group = row.group;
  if (row.description != null) f.description = row.description;
  if (row.available_from != null) f.version = row.available_from;
  if (row.name_by_version && Object.keys(row.name_by_version).length) f.nameByVersion = row.name_by_version;
  if (row.description_by_version && Object.keys(row.description_by_version).length)
    f.descriptionByVersion = row.description_by_version;
  if (row.version != null) f.rowVersion = row.version;
  return f;
}

function rowToTier(
  row: Record<string, any>,
  values: Record<string, string | boolean>,
  valueVersions?: Record<string, string>,
): PricingTier {
  const t: PricingTier = { id: row.id, name: row.name ?? '', price: row.price ?? '', values };
  if (row.tagline != null) t.tagline = row.tagline;
  if (row.use_case != null) t.useCase = row.use_case;
  if (row.target_group != null) t.targetGroup = row.target_group;
  if (valueVersions && Object.keys(valueVersions).length) t.valueVersions = valueVersions;
  if (row.version != null) t.rowVersion = row.version;
  return t;
}

function rowToHighlight(row: Record<string, any>): PricingHighlight {
  const h: PricingHighlight = {
    id: row.id,
    label: row.label ?? '',
    featureIds: Array.isArray(row.feature_ids) ? row.feature_ids : [],
  };
  if (row.section != null) h.section = row.section;
  if (row.icon != null) h.icon = row.icon;
  if (row.description != null) h.description = row.description;
  if (row.label_by_version && Object.keys(row.label_by_version).length) h.labelByVersion = row.label_by_version;
  if (row.version != null) h.rowVersion = row.version;
  return h;
}

/** Drop the server-managed rowVersion counters (public output / diffs). */
export function stripRowVersions(pricing: Pricing): void {
  for (const f of pricing.features) delete f.rowVersion;
  for (const t of pricing.tiers) delete t.rowVersion;
  for (const h of pricing.highlights ?? []) delete h.rowVersion;
}

const FEATURE_SELECT =
  'id, name, "group", description, available_from, name_by_version, description_by_version, sort, version';
const TIER_SELECT = 'id, name, tagline, use_case, target_group, price, sort, version';
const HIGHLIGHT_SELECT = 'id, label, section, icon, feature_ids, description, label_by_version, sort, version';

/**
 * Pure reconstruction of the Pricing shape from the normalized rows. Kept
 * DB-free so it can be unit-tested for a lossless round-trip against the *ToRow
 * mappers. `valueRows` are the (tier_id, feature_id, value) cells.
 */
export function rowsToPricing(
  featureRows: Record<string, any>[],
  tierRows: Record<string, any>[],
  valueRows: { tier_id: string; feature_id: string; value: string | boolean; available_from?: string | null }[],
  highlightRows: Record<string, any>[],
  versions: string[],
): Pricing {
  const valuesByTier = new Map<string, Record<string, string | boolean>>();
  const versionsByTier = new Map<string, Record<string, string>>();
  for (const v of valueRows) {
    let bucket = valuesByTier.get(v.tier_id);
    if (!bucket) valuesByTier.set(v.tier_id, (bucket = {}));
    bucket[v.feature_id] = v.value;
    if (v.available_from != null) {
      let vb = versionsByTier.get(v.tier_id);
      if (!vb) versionsByTier.set(v.tier_id, (vb = {}));
      vb[v.feature_id] = v.available_from;
    }
  }
  const pricing: Pricing = {
    features: featureRows.map(rowToFeature),
    tiers: tierRows.map((t) => rowToTier(t, valuesByTier.get(t.id) ?? {}, versionsByTier.get(t.id))),
  };
  const highlights = highlightRows.map(rowToHighlight);
  if (highlights.length) pricing.highlights = highlights;
  if (versions.length) pricing.versions = versions;
  return pricing;
}

/**
 * Reassemble the full Pricing model from the normalized tables. `versions` is
 * passed in from the `timelines.pricing_versions` column (the caller already
 * fetched the row). An empty model comes back as { features: [], tiers: [] } so
 * callers can decide whether to surface it. rowVersion is included on the
 * editable path (getTimeline) and stripped for public output (getPublicPricing).
 */
export async function assemblePricing(
  sql: Sql,
  id: string,
  versions: string[],
): Promise<Pricing> {
  const [featRows, tierRows, valRows, hlRows] = await Promise.all([
    sql`select ${sql.unsafe(FEATURE_SELECT)} from pricing_features where timeline_id = ${id} order by sort asc nulls first`,
    sql`select ${sql.unsafe(TIER_SELECT)} from pricing_tiers where timeline_id = ${id} order by sort asc nulls first`,
    sql`select tier_id, feature_id, value, available_from from pricing_tier_values where timeline_id = ${id}`,
    sql`select ${sql.unsafe(HIGHLIGHT_SELECT)} from pricing_highlights where timeline_id = ${id} order by sort asc nulls first`,
  ]);

  return rowsToPricing(
    featRows as Record<string, any>[],
    tierRows as Record<string, any>[],
    valRows as unknown as { tier_id: string; feature_id: string; value: string | boolean; available_from?: string | null }[],
    hlRows as Record<string, any>[],
    versions,
  );
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
    phases: sql.json(file.phases ?? []),
    custom_fields: sql.json(file.customFields ?? []),
    updated_at: new Date().toISOString(),
  };
  await sql`
    insert into timelines ${sql(meta, 'id', 'name', 'description', 'group_by', 'phases', 'custom_fields', 'updated_at')}
    on conflict (id) do update set ${sql(meta, 'name', 'description', 'group_by', 'phases', 'custom_fields', 'updated_at')}`;

  // Clear children, then re-insert (cascade-free explicit wipe keeps it simple).
  await sql`delete from timeline_items where timeline_id = ${id}`;
  await sql`delete from timeline_groups where timeline_id = ${id}`;

  // Plugin registrations (enablement + config, incl. the version list). Replaces
  // the former type/pricing_versions columns. `resolveWritePlugins` folds a
  // populated pricing model into a product-roadmap row.
  await replacePluginRows(sql, id, resolveWritePlugins(file));

  // Pricing tables (wipe + re-insert).
  await replacePricingRows(sql, id, file.pricing);

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
      'timeline_id', 'id', 'content', 'nested_groups', 'show_nested', 'sort',
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
  const [data] = await sql`
    insert into timeline_groups ${sql(row, 'timeline_id', 'id', 'content', 'nested_groups', 'show_nested')}
    on conflict (timeline_id, id) do update set ${sql(row, 'content', 'nested_groups', 'show_nested')}
    returning id, content, nested_groups, show_nested, sort`;
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

export async function updateMeta(
  sql: Sql,
  id: string,
  meta: {
    name?: string;
    description?: string;
    groupBy?: string;
    customFields?: CustomFieldDef[];
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
  if ('customFields' in meta) set.custom_fields = sql.json(meta.customFields ?? []);
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

export function featureToRow(timelineId: string, f: PricingFeature, sort?: number): Record<string, any> {
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: f.id,
    name: f.name ?? '',
    group: f.group ?? null,
    description: f.description ?? null,
    available_from: f.version ?? null,
    name_by_version: f.nameByVersion ?? {},
    description_by_version: f.descriptionByVersion ?? {},
  };
  if (sort != null) row.sort = sort;
  return row;
}

export function tierToRow(timelineId: string, t: PricingTier, sort?: number): Record<string, any> {
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: t.id,
    name: t.name ?? '',
    tagline: t.tagline ?? null,
    use_case: t.useCase ?? null,
    target_group: t.targetGroup ?? null,
    price: t.price ?? '',
  };
  if (sort != null) row.sort = sort;
  return row;
}

export function highlightToRow(timelineId: string, h: PricingHighlight, sort?: number): Record<string, any> {
  const row: Record<string, any> = {
    timeline_id: timelineId,
    id: h.id,
    label: h.label ?? '',
    section: h.section ?? null,
    icon: h.icon ?? null,
    feature_ids: h.featureIds ?? [],
    description: h.description ?? null,
    label_by_version: h.labelByVersion ?? {},
  };
  if (sort != null) row.sort = sort;
  return row;
}

/**
 * Shared optimistic-lock UPDATE for a versioned pricing row. Applies `set`
 * (already column-keyed, jsonb values already sql.json-wrapped) to
 * (timeline_id, id), gated on `version` when `expectedVersion` is given, and
 * disambiguates row-gone (NotFound) from stale (Conflict) exactly like updateItem.
 */
async function updatePricingRow(
  sql: Sql,
  table: string,
  select: string,
  timelineId: string,
  rowId: string,
  set: Record<string, any>,
  expectedVersion: number | undefined,
): Promise<Record<string, any>> {
  if (Object.keys(set).length === 0) {
    const [data] = await sql`select ${sql.unsafe(select)} from ${sql(table)} where timeline_id = ${timelineId} and id = ${rowId}`;
    if (!data) throw new NotFoundError();
    return data as Record<string, any>;
  }
  const versionCond = expectedVersion != null ? sql`and version = ${expectedVersion}` : sql``;
  const data = await sql`
    update ${sql(table)} set ${sql(set, ...Object.keys(set))}
    where timeline_id = ${timelineId} and id = ${rowId} ${versionCond}
    returning ${sql.unsafe(select)}`;
  if (data.length === 0) {
    const [exists] = await sql`select id from ${sql(table)} where timeline_id = ${timelineId} and id = ${rowId}`;
    if (!exists) throw new NotFoundError();
    throw new ConflictError(`${table} ${rowId} changed since version ${expectedVersion}`);
  }
  return data[0] as Record<string, any>;
}

// -- features --

export async function addFeature(
  sql: Sql,
  timelineId: string,
  feature: PricingFeature,
  updatedBy?: string,
): Promise<PricingFeature> {
  const row = featureToRow(timelineId, feature, await nextSortFor(sql, 'pricing_features', timelineId));
  if (updatedBy) row.updated_by = updatedBy;
  const cols = Object.keys(row);
  const [data] = await sql`
    insert into pricing_features ${sql(jsonRow(sql, row, 'name_by_version', 'description_by_version'), ...cols)}
    returning ${sql.unsafe(FEATURE_SELECT)}`;
  return rowToFeature(data);
}

export async function updateFeature(
  sql: Sql,
  timelineId: string,
  featureId: string,
  patch: Partial<PricingFeature>,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<PricingFeature> {
  const set: Record<string, any> = {};
  if ('name' in patch) set.name = patch.name ?? '';
  if ('group' in patch) set.group = patch.group ?? null;
  if ('description' in patch) set.description = patch.description ?? null;
  if ('version' in patch) set.available_from = patch.version ?? null;
  if ('nameByVersion' in patch) set.name_by_version = sql.json(patch.nameByVersion ?? {});
  if ('descriptionByVersion' in patch) set.description_by_version = sql.json(patch.descriptionByVersion ?? {});
  if (updatedBy) set.updated_by = updatedBy;
  const data = await updatePricingRow(sql, 'pricing_features', FEATURE_SELECT, timelineId, featureId, set, expectedVersion);
  return rowToFeature(data);
}

export async function deleteFeature(sql: Sql, timelineId: string, featureId: string): Promise<void> {
  // Value rows cascade away via FK; highlights keep raw id arrays (not
  // FK-enforced), so strip the id from any highlight that referenced it.
  const hls = await sql`
    select id, feature_ids from pricing_highlights
    where timeline_id = ${timelineId} and ${featureId} = any(feature_ids)`;
  for (const h of hls) {
    const next = (h.feature_ids as string[]).filter((x) => x !== featureId);
    await sql`update pricing_highlights set feature_ids = ${next} where timeline_id = ${timelineId} and id = ${h.id}`;
  }
  await sql`delete from pricing_features where timeline_id = ${timelineId} and id = ${featureId}`;
}

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

/**
 * Reposition a feature in the matrix row order relative to another feature.
 * Loads the current order (by `sort`), computes the new sequence via
 * `reorderIds`, and renumbers `sort` to a contiguous 0..n-1 — writing only the
 * rows whose position actually changed (each write bumps the row version).
 * Returns the new ordered id list.
 */
export async function moveFeature(
  sql: Sql,
  timelineId: string,
  featureId: string,
  anchor: { after?: string; before?: string },
  updatedBy?: string,
): Promise<string[]> {
  const rows = await sql`
    select id, sort from pricing_features
    where timeline_id = ${timelineId} order by sort asc nulls first`;
  const currentSort = new Map(rows.map((r) => [r.id as string, r.sort as number | null]));
  const nextOrder = reorderIds(rows.map((r) => r.id as string), featureId, anchor);
  for (let i = 0; i < nextOrder.length; i++) {
    const fid = nextOrder[i];
    if (currentSort.get(fid) === i) continue; // unchanged → skip write
    const set: Record<string, any> = { sort: i };
    if (updatedBy) set.updated_by = updatedBy;
    await sql`update pricing_features set ${sql(set, ...Object.keys(set))} where timeline_id = ${timelineId} and id = ${fid}`;
  }
  return nextOrder;
}

// -- tiers --

export async function addTier(
  sql: Sql,
  timelineId: string,
  tier: PricingTier,
  updatedBy?: string,
): Promise<PricingTier> {
  const row = tierToRow(timelineId, tier, await nextSortFor(sql, 'pricing_tiers', timelineId));
  if (updatedBy) row.updated_by = updatedBy;
  const cols = Object.keys(row);
  const [data] = await sql`
    insert into pricing_tiers ${sql(row, ...cols)}
    returning ${sql.unsafe(TIER_SELECT)}`;
  // Seed any values supplied with the tier (e.g. from a bulk-ish add).
  const values = tier.values ?? {};
  const valueVersions = tier.valueVersions ?? {};
  for (const [featureId, value] of Object.entries(values)) {
    await setTierValue(sql, timelineId, tier.id, featureId, value, updatedBy, valueVersions[featureId]);
  }
  return rowToTier(data, values, valueVersions);
}

export async function updateTier(
  sql: Sql,
  timelineId: string,
  tierId: string,
  patch: Partial<PricingTier>,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<PricingTier> {
  const set: Record<string, any> = {};
  if ('name' in patch) set.name = patch.name ?? '';
  if ('tagline' in patch) set.tagline = patch.tagline ?? null;
  if ('useCase' in patch) set.use_case = patch.useCase ?? null;
  if ('targetGroup' in patch) set.target_group = patch.targetGroup ?? null;
  if ('price' in patch) set.price = patch.price ?? '';
  if (updatedBy) set.updated_by = updatedBy;
  const data = await updatePricingRow(sql, 'pricing_tiers', TIER_SELECT, timelineId, tierId, set, expectedVersion);
  // `values` are not tier columns — apply any provided cells individually. A
  // provided `valueVersions[fid]` gates that cell's availability (see setTierValue).
  if (patch.values) {
    const vv = patch.valueVersions ?? {};
    for (const [featureId, value] of Object.entries(patch.values)) {
      await setTierValue(sql, timelineId, tierId, featureId, value, updatedBy, vv[featureId]);
    }
  }
  const valRows = await sql`
    select feature_id, value, available_from from pricing_tier_values
    where timeline_id = ${timelineId} and tier_id = ${tierId}`;
  const values: Record<string, string | boolean> = {};
  const valueVersions: Record<string, string> = {};
  for (const v of valRows) {
    values[v.feature_id] = v.value as string | boolean;
    if (v.available_from != null) valueVersions[v.feature_id] = v.available_from as string;
  }
  return rowToTier(data, values, valueVersions);
}

export async function deleteTier(sql: Sql, timelineId: string, tierId: string): Promise<void> {
  // Value rows cascade away via FK.
  await sql`delete from pricing_tiers where timeline_id = ${timelineId} and id = ${tierId}`;
}

// -- tier×feature values (cell-granular) --

/**
 * Set one matrix cell. A boolean `true` or a non-empty string is stored; a
 * `false` / `null` / empty value clears the cell (deletes the row) — both render
 * as "–" anyway, so there's no reason to keep a falsy row around.
 *
 * `availableFrom` gates *when* the cell counts as included (a version label, or
 * null/undefined = from the start). It rides along with the value on the same
 * row, so it is dropped automatically when the cell is cleared.
 */
export async function setTierValue(
  sql: Sql,
  timelineId: string,
  tierId: string,
  featureId: string,
  value: string | boolean | null | undefined,
  updatedBy?: string,
  availableFrom?: string | null,
): Promise<void> {
  if (value === false || value === null || value === undefined || value === '') {
    await clearTierValue(sql, timelineId, tierId, featureId);
    return;
  }
  const row = {
    timeline_id: timelineId,
    tier_id: tierId,
    feature_id: featureId,
    value: sql.json(value),
    available_from: availableFrom ?? null,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy ?? null,
  };
  await sql`
    insert into pricing_tier_values ${sql(row, 'timeline_id', 'tier_id', 'feature_id', 'value', 'available_from', 'updated_at', 'updated_by')}
    on conflict (timeline_id, tier_id, feature_id) do update set ${sql(row, 'value', 'available_from', 'updated_at', 'updated_by')}`;
}

export async function clearTierValue(
  sql: Sql,
  timelineId: string,
  tierId: string,
  featureId: string,
): Promise<void> {
  await sql`
    delete from pricing_tier_values
    where timeline_id = ${timelineId} and tier_id = ${tierId} and feature_id = ${featureId}`;
}

// -- highlights --

export async function addHighlight(
  sql: Sql,
  timelineId: string,
  highlight: PricingHighlight,
  updatedBy?: string,
): Promise<PricingHighlight> {
  const row = highlightToRow(timelineId, highlight, await nextSortFor(sql, 'pricing_highlights', timelineId));
  if (updatedBy) row.updated_by = updatedBy;
  const cols = Object.keys(row);
  const [data] = await sql`
    insert into pricing_highlights ${sql(jsonRow(sql, row, 'label_by_version'), ...cols)}
    returning ${sql.unsafe(HIGHLIGHT_SELECT)}`;
  return rowToHighlight(data);
}

export async function updateHighlight(
  sql: Sql,
  timelineId: string,
  highlightId: string,
  patch: Partial<PricingHighlight>,
  expectedVersion?: number,
  updatedBy?: string,
): Promise<PricingHighlight> {
  const set: Record<string, any> = {};
  if ('label' in patch) set.label = patch.label ?? '';
  if ('section' in patch) set.section = patch.section ?? null;
  if ('icon' in patch) set.icon = patch.icon ?? null;
  if ('featureIds' in patch) set.feature_ids = patch.featureIds ?? [];
  if ('description' in patch) set.description = patch.description ?? null;
  if ('labelByVersion' in patch) set.label_by_version = sql.json(patch.labelByVersion ?? {});
  if (updatedBy) set.updated_by = updatedBy;
  const data = await updatePricingRow(sql, 'pricing_highlights', HIGHLIGHT_SELECT, timelineId, highlightId, set, expectedVersion);
  return rowToHighlight(data);
}

export async function deleteHighlight(sql: Sql, timelineId: string, highlightId: string): Promise<void> {
  await sql`delete from pricing_highlights where timeline_id = ${timelineId} and id = ${highlightId}`;
}

// -- versions (ordered label list, whole-replaced like phases) --

export async function updateVersions(sql: Sql, id: string, versions: string[]): Promise<void> {
  // The version list lives in the product-roadmap plugin's config now (was the
  // dropped pricing_versions column). Upsert so setting versions on a timeline
  // that has no plugin row yet enables the plugin (seeding pricing goes through
  // here via replacePricing).
  await sql`
    insert into timeline_plugins (timeline_id, plugin_id, config, updated_at)
    values (${id}, ${PRODUCT_ROADMAP_PLUGIN}, ${sql.json({ versions: versions ?? [] })}, ${new Date().toISOString()})
    on conflict (timeline_id, plugin_id) do update
      set config = timeline_plugins.config || ${sql.json({ versions: versions ?? [] })},
          updated_at = ${new Date().toISOString()}`;
}

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

// -- bulk replace (import, MCP set_pricing seed, PUT) --

/**
 * Wipe and re-insert every pricing row for a timeline from a full Pricing model.
 * Does NOT touch the `pricing_versions` column (callers set it alongside). Used
 * by replaceTimeline and the MCP bulk `set_pricing` seed.
 */
export async function replacePricingRows(
  sql: Sql,
  id: string,
  pricing: Pricing | undefined,
): Promise<void> {
  // Values first (FK children), then the parents + highlights.
  for (const table of ['pricing_tier_values', 'pricing_features', 'pricing_tiers', 'pricing_highlights']) {
    await sql`delete from ${sql(table)} where timeline_id = ${id}`;
  }
  if (!pricing) return;

  const featureRows = (pricing.features ?? [])
    .filter((f) => f.id)
    .map((f, i) => jsonRow(sql, featureToRow(id, f, i), 'name_by_version', 'description_by_version'));
  if (featureRows.length) {
    await sql`insert into pricing_features ${sql(
      featureRows,
      'timeline_id', 'id', 'name', 'group', 'description', 'available_from', 'name_by_version', 'description_by_version', 'sort',
    )}`;
  }

  const tierRows = (pricing.tiers ?? [])
    .filter((t) => t.id)
    .map((t, i) => tierToRow(id, t, i));
  if (tierRows.length) {
    await sql`insert into pricing_tiers ${sql(
      tierRows,
      'timeline_id', 'id', 'name', 'tagline', 'use_case', 'target_group', 'price', 'sort',
    )}`;
  }

  // Value cells: only those whose feature id exists, so a dangling ref in the
  // source model can't abort the insert on the FK.
  const featureIds = new Set((pricing.features ?? []).map((f) => f.id));
  const valueRows: Record<string, any>[] = [];
  for (const t of pricing.tiers ?? []) {
    if (!t.id) continue;
    const vv = t.valueVersions ?? {};
    for (const [featureId, value] of Object.entries(t.values ?? {})) {
      if (value === false || value == null || value === '') continue; // falsy = not-included
      if (!featureIds.has(featureId)) continue;
      valueRows.push({ timeline_id: id, tier_id: t.id, feature_id: featureId, value: sql.json(value), available_from: vv[featureId] ?? null });
    }
  }
  if (valueRows.length) {
    await sql`insert into pricing_tier_values ${sql(
      valueRows,
      'timeline_id', 'tier_id', 'feature_id', 'value', 'available_from',
    )}`;
  }

  const highlightRows = (pricing.highlights ?? [])
    .filter((h) => h.id)
    .map((h, i) => jsonRow(sql, highlightToRow(id, h, i), 'label_by_version'));
  if (highlightRows.length) {
    await sql`insert into pricing_highlights ${sql(
      highlightRows,
      'timeline_id', 'id', 'label', 'section', 'icon', 'feature_ids', 'description', 'label_by_version', 'sort',
    )}`;
  }
}

/** Full pricing replace incl. the versions array — used by the MCP set_pricing seed. */
export async function replacePricing(
  sql: Sql,
  id: string,
  pricing: Pricing,
): Promise<void> {
  await updateVersions(sql, id, pricing.versions ?? []);
  await replacePricingRows(sql, id, pricing);
}

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
    getTimeline: (id) => getTimeline(sql, id),
    getWatermark: (id) => getWatermark(sql, id),
    getPublicPricing: (id) => getPublicPricing(sql, id),
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
    addFeature: (timelineId, feature, updatedBy) => addFeature(sql, timelineId, feature, updatedBy),
    updateFeature: (timelineId, featureId, patch, expectedVersion, updatedBy) =>
      updateFeature(sql, timelineId, featureId, patch, expectedVersion, updatedBy),
    deleteFeature: (timelineId, featureId) => deleteFeature(sql, timelineId, featureId),
    moveFeature: (timelineId, featureId, anchor, updatedBy) =>
      moveFeature(sql, timelineId, featureId, anchor, updatedBy),
    addTier: (timelineId, tier, updatedBy) => addTier(sql, timelineId, tier, updatedBy),
    updateTier: (timelineId, tierId, patch, expectedVersion, updatedBy) =>
      updateTier(sql, timelineId, tierId, patch, expectedVersion, updatedBy),
    deleteTier: (timelineId, tierId) => deleteTier(sql, timelineId, tierId),
    setTierValue: (timelineId, tierId, featureId, value, updatedBy, availableFrom) =>
      setTierValue(sql, timelineId, tierId, featureId, value, updatedBy, availableFrom),
    clearTierValue: (timelineId, tierId, featureId) => clearTierValue(sql, timelineId, tierId, featureId),
    addHighlight: (timelineId, highlight, updatedBy) => addHighlight(sql, timelineId, highlight, updatedBy),
    updateHighlight: (timelineId, highlightId, patch, expectedVersion, updatedBy) =>
      updateHighlight(sql, timelineId, highlightId, patch, expectedVersion, updatedBy),
    deleteHighlight: (timelineId, highlightId) => deleteHighlight(sql, timelineId, highlightId),
    updateVersions: (id, versions) => updateVersions(sql, id, versions),
    replacePricing: (id, pricing) => replacePricing(sql, id, pricing),
  };
}

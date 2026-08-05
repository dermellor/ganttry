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
import type {
  CustomFieldDef,
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
import { PRODUCT_ROADMAP_PLUGIN, resolveWritePlugins, versionsFromConfig } from '../../src/plugins.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type PublicPricing,
  type TimelineGroupDecl,
  type TimelineMeta,
  type TimelineRepo,
} from './repo.ts';

// Shared seam types/classes (single definition — see ./repo.ts). Re-exported for
// symmetry with ./timeline-repo.ts.
export { ConflictError, NotFoundError, ValidationError };
export type { PublicPricing, TimelineGroupDecl, TimelineMeta };

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
    .select('plugin_id, config')
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
  }));
  if (plugins.length) file.plugins = plugins;
  if (Array.isArray(tl.phases) && tl.phases.length) file.phases = tl.phases as TimelinePhase[];
  if (Array.isArray(tl.custom_fields) && tl.custom_fields.length)
    file.customFields = tl.custom_fields as CustomFieldDef[];
  // Assemble the pricing model from the normalized tables. The ordered version
  // list now lives in the product-roadmap plugin's config (was the dropped
  // pricing_versions column). Only surface a populated model — matches the old
  // behaviour of surfacing pricing only when it carried tiers/features.
  const versions = versionsFromConfig(plugins.find((p) => p.id === PRODUCT_ROADMAP_PLUGIN)?.config);
  const pricing = await assemblePricing(db, id, versions);
  if (pricing && (pricing.features.length || pricing.tiers.length)) file.pricing = pricing;
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
 * NOTE: this covers items + timeline meta (incl. phases). Pricing-table edits
 * are NOT reflected here yet — no poll source is a product timeline today, and
 * Realtime still covers pricing. Folding pricing into the watermark is a
 * follow-up (see AGENTS.md „Live-Update-Naht").
 */
export async function getWatermark(db: SupabaseClient, id: string): Promise<Watermark> {
  const [itemsRes, tlRes] = await Promise.all([
    db.from('timeline_items').select('version, updated_at').eq('timeline_id', id),
    db.from('timelines').select('updated_at').eq('id', id).maybeSingle(),
  ]);
  if (itemsRes.error) throw new Error(`getWatermark items: ${itemsRes.error.message}`);
  if (tlRes.error) throw new Error(`getWatermark timeline: ${tlRes.error.message}`);

  const rows = (itemsRes.data ?? []) as { version: number | null; updated_at: string | null }[];
  let v = 0;
  let t: string | null = (tlRes.data as { updated_at?: string | null } | null)?.updated_at ?? null;
  for (const r of rows) {
    if (r.version != null && r.version > v) v = r.version;
    if (r.updated_at != null && (t == null || r.updated_at > t)) t = r.updated_at;
  }
  return { v, n: rows.length, t };
}

// ---- public pricing (marketing sites consume this) -------------------------

/**
 * Pricing-only view of a product timeline for public consumption (e.g. the Astro
 * pricing page). Returns just name + the pricing model — never roadmap items or
 * status. Null when the timeline isn't a product timeline or has no pricing, so
 * the caller can 404. This is the single source of truth for external pages.
 */
export async function getPublicPricing(db: SupabaseClient, id: string): Promise<PublicPricing | null> {
  const { data, error } = await db
    .from('timelines')
    .select('name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getPublicPricing: ${error.message}`);
  if (!data) return null;
  const { data: plugin, error: plgErr } = await db
    .from('timeline_plugins')
    .select('config')
    .eq('timeline_id', id)
    .eq('plugin_id', PRODUCT_ROADMAP_PLUGIN)
    .maybeSingle();
  if (plgErr) throw new Error(`getPublicPricing plugin: ${plgErr.message}`);
  if (!plugin) return null;
  const versions = versionsFromConfig(plugin.config as Record<string, unknown>);
  const pricing = await assemblePricing(db, id, versions);
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
  db: SupabaseClient,
  id: string,
  versions: string[],
): Promise<Pricing> {
  const [featRes, tierRes, valRes, hlRes] = await Promise.all([
    db.from('pricing_features').select(FEATURE_SELECT).eq('timeline_id', id).order('sort', { ascending: true, nullsFirst: true }),
    db.from('pricing_tiers').select(TIER_SELECT).eq('timeline_id', id).order('sort', { ascending: true, nullsFirst: true }),
    db.from('pricing_tier_values').select('tier_id, feature_id, value, available_from').eq('timeline_id', id),
    db.from('pricing_highlights').select(HIGHLIGHT_SELECT).eq('timeline_id', id).order('sort', { ascending: true, nullsFirst: true }),
  ]);
  if (featRes.error) throw new Error(`assemblePricing features: ${featRes.error.message}`);
  if (tierRes.error) throw new Error(`assemblePricing tiers: ${tierRes.error.message}`);
  if (valRes.error) throw new Error(`assemblePricing values: ${valRes.error.message}`);
  if (hlRes.error) throw new Error(`assemblePricing highlights: ${hlRes.error.message}`);

  return rowsToPricing(
    featRes.data ?? [],
    tierRes.data ?? [],
    (valRes.data ?? []) as { tier_id: string; feature_id: string; value: string | boolean; available_from?: string | null }[],
    hlRes.data ?? [],
    versions,
  );
}

// ---- whole-timeline replace (import, MCP bulk, PUT fallback) ---------------

export async function replaceTimeline(db: SupabaseClient, id: string, file: TimelineFile): Promise<void> {
  assertPhasesNonOverlapping(file.phases);
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

  // Plugin registrations (enablement + config incl. the version list). Replaces
  // the former type/pricing_versions columns; resolveWritePlugins folds a
  // populated pricing model into a product-roadmap row.
  await replacePluginRows(db, id, resolveWritePlugins(file));

  // Pricing tables (wipe + re-insert).
  await replacePricingRows(db, id, file.pricing);

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
 * (already column-keyed) to (timeline_id, id), gated on `version` when
 * `expectedVersion` is given, and disambiguates row-gone (NotFound) from stale
 * (Conflict) exactly like updateItem.
 */
async function updatePricingRow(
  db: SupabaseClient,
  table: string,
  select: string,
  timelineId: string,
  rowId: string,
  set: Record<string, any>,
  expectedVersion: number | undefined,
): Promise<Record<string, any>> {
  if (Object.keys(set).length === 0) {
    const { data } = await db.from(table).select(select).eq('timeline_id', timelineId).eq('id', rowId).maybeSingle();
    if (!data) throw new NotFoundError();
    return data as Record<string, any>;
  }
  let q = db.from(table).update(set).eq('timeline_id', timelineId).eq('id', rowId);
  if (expectedVersion != null) q = q.eq('version', expectedVersion);
  const { data, error } = await q.select(select);
  if (error) throw new Error(`update ${table}: ${error.message}`);
  if (!data || data.length === 0) {
    const { data: exists } = await db.from(table).select('id').eq('timeline_id', timelineId).eq('id', rowId).maybeSingle();
    if (!exists) throw new NotFoundError();
    throw new ConflictError(`${table} ${rowId} changed since version ${expectedVersion}`);
  }
  return data[0] as Record<string, any>;
}

// -- features --

export async function addFeature(
  db: SupabaseClient,
  timelineId: string,
  feature: PricingFeature,
  updatedBy?: string,
): Promise<PricingFeature> {
  const row = featureToRow(timelineId, feature, await nextSortFor(db, 'pricing_features', timelineId));
  if (updatedBy) row.updated_by = updatedBy;
  const { data, error } = await db.from('pricing_features').insert(row).select(FEATURE_SELECT).single();
  if (error) throw new Error(`addFeature: ${error.message}`);
  return rowToFeature(data);
}

export async function updateFeature(
  db: SupabaseClient,
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
  if ('nameByVersion' in patch) set.name_by_version = patch.nameByVersion ?? {};
  if ('descriptionByVersion' in patch) set.description_by_version = patch.descriptionByVersion ?? {};
  if (updatedBy) set.updated_by = updatedBy;
  const data = await updatePricingRow(db, 'pricing_features', FEATURE_SELECT, timelineId, featureId, set, expectedVersion);
  return rowToFeature(data);
}

export async function deleteFeature(db: SupabaseClient, timelineId: string, featureId: string): Promise<void> {
  // Value rows cascade away via FK; highlights keep raw id arrays (not
  // FK-enforced), so strip the id from any highlight that referenced it.
  const { data: hls, error: hlErr } = await db
    .from('pricing_highlights')
    .select('id, feature_ids')
    .eq('timeline_id', timelineId)
    .contains('feature_ids', [featureId]);
  if (hlErr) throw new Error(`deleteFeature scan highlights: ${hlErr.message}`);
  for (const h of hls ?? []) {
    const next = (h.feature_ids as string[]).filter((x) => x !== featureId);
    const { error } = await db
      .from('pricing_highlights')
      .update({ feature_ids: next })
      .eq('timeline_id', timelineId)
      .eq('id', h.id);
    if (error) throw new Error(`deleteFeature strip highlight ${h.id}: ${error.message}`);
  }
  const { error } = await db.from('pricing_features').delete().eq('timeline_id', timelineId).eq('id', featureId);
  if (error) throw new Error(`deleteFeature: ${error.message}`);
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
  db: SupabaseClient,
  timelineId: string,
  featureId: string,
  anchor: { after?: string; before?: string },
  updatedBy?: string,
): Promise<string[]> {
  const { data, error } = await db
    .from('pricing_features')
    .select('id, sort')
    .eq('timeline_id', timelineId)
    .order('sort', { ascending: true, nullsFirst: true });
  if (error) throw new Error(`moveFeature load: ${error.message}`);
  const rows = (data ?? []) as { id: string; sort: number | null }[];
  const currentSort = new Map(rows.map((r) => [r.id, r.sort]));
  const nextOrder = reorderIds(rows.map((r) => r.id), featureId, anchor);
  for (let i = 0; i < nextOrder.length; i++) {
    const fid = nextOrder[i];
    if (currentSort.get(fid) === i) continue; // unchanged → skip write
    const set: Record<string, any> = { sort: i };
    if (updatedBy) set.updated_by = updatedBy;
    const { error: upErr } = await db
      .from('pricing_features')
      .update(set)
      .eq('timeline_id', timelineId)
      .eq('id', fid);
    if (upErr) throw new Error(`moveFeature renumber ${fid}: ${upErr.message}`);
  }
  return nextOrder;
}

// -- tiers --

export async function addTier(
  db: SupabaseClient,
  timelineId: string,
  tier: PricingTier,
  updatedBy?: string,
): Promise<PricingTier> {
  const row = tierToRow(timelineId, tier, await nextSortFor(db, 'pricing_tiers', timelineId));
  if (updatedBy) row.updated_by = updatedBy;
  const { data, error } = await db.from('pricing_tiers').insert(row).select(TIER_SELECT).single();
  if (error) throw new Error(`addTier: ${error.message}`);
  // Seed any values supplied with the tier (e.g. from a bulk-ish add).
  const values = tier.values ?? {};
  const valueVersions = tier.valueVersions ?? {};
  for (const [featureId, value] of Object.entries(values)) {
    await setTierValue(db, timelineId, tier.id, featureId, value, updatedBy, valueVersions[featureId]);
  }
  return rowToTier(data, values, valueVersions);
}

export async function updateTier(
  db: SupabaseClient,
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
  const data = await updatePricingRow(db, 'pricing_tiers', TIER_SELECT, timelineId, tierId, set, expectedVersion);
  // `values` are not tier columns — apply any provided cells individually. A
  // provided `valueVersions[fid]` gates that cell's availability (see setTierValue).
  if (patch.values) {
    const vv = patch.valueVersions ?? {};
    for (const [featureId, value] of Object.entries(patch.values)) {
      await setTierValue(db, timelineId, tierId, featureId, value, updatedBy, vv[featureId]);
    }
  }
  const { data: valRows } = await db
    .from('pricing_tier_values')
    .select('feature_id, value, available_from')
    .eq('timeline_id', timelineId)
    .eq('tier_id', tierId);
  const values: Record<string, string | boolean> = {};
  const valueVersions: Record<string, string> = {};
  for (const v of valRows ?? []) {
    values[v.feature_id] = v.value as string | boolean;
    if (v.available_from != null) valueVersions[v.feature_id] = v.available_from as string;
  }
  return rowToTier(data, values, valueVersions);
}

export async function deleteTier(db: SupabaseClient, timelineId: string, tierId: string): Promise<void> {
  // Value rows cascade away via FK.
  const { error } = await db.from('pricing_tiers').delete().eq('timeline_id', timelineId).eq('id', tierId);
  if (error) throw new Error(`deleteTier: ${error.message}`);
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
  db: SupabaseClient,
  timelineId: string,
  tierId: string,
  featureId: string,
  value: string | boolean | null | undefined,
  updatedBy?: string,
  availableFrom?: string | null,
): Promise<void> {
  if (value === false || value === null || value === undefined || value === '') {
    await clearTierValue(db, timelineId, tierId, featureId);
    return;
  }
  const { error } = await db.from('pricing_tier_values').upsert({
    timeline_id: timelineId,
    tier_id: tierId,
    feature_id: featureId,
    value,
    available_from: availableFrom ?? null,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy ?? null,
  });
  if (error) throw new Error(`setTierValue: ${error.message}`);
}

export async function clearTierValue(
  db: SupabaseClient,
  timelineId: string,
  tierId: string,
  featureId: string,
): Promise<void> {
  const { error } = await db
    .from('pricing_tier_values')
    .delete()
    .eq('timeline_id', timelineId)
    .eq('tier_id', tierId)
    .eq('feature_id', featureId);
  if (error) throw new Error(`clearTierValue: ${error.message}`);
}

// -- highlights --

export async function addHighlight(
  db: SupabaseClient,
  timelineId: string,
  highlight: PricingHighlight,
  updatedBy?: string,
): Promise<PricingHighlight> {
  const row = highlightToRow(timelineId, highlight, await nextSortFor(db, 'pricing_highlights', timelineId));
  if (updatedBy) row.updated_by = updatedBy;
  const { data, error } = await db.from('pricing_highlights').insert(row).select(HIGHLIGHT_SELECT).single();
  if (error) throw new Error(`addHighlight: ${error.message}`);
  return rowToHighlight(data);
}

export async function updateHighlight(
  db: SupabaseClient,
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
  if ('labelByVersion' in patch) set.label_by_version = patch.labelByVersion ?? {};
  if (updatedBy) set.updated_by = updatedBy;
  const data = await updatePricingRow(db, 'pricing_highlights', HIGHLIGHT_SELECT, timelineId, highlightId, set, expectedVersion);
  return rowToHighlight(data);
}

export async function deleteHighlight(db: SupabaseClient, timelineId: string, highlightId: string): Promise<void> {
  const { error } = await db.from('pricing_highlights').delete().eq('timeline_id', timelineId).eq('id', highlightId);
  if (error) throw new Error(`deleteHighlight: ${error.message}`);
}

// -- versions (ordered label list, whole-replaced like phases) --

export async function updateVersions(db: SupabaseClient, id: string, versions: string[]): Promise<void> {
  // The version list lives in the product-roadmap plugin's config now (was the
  // dropped pricing_versions column). Merge it into any existing config and
  // upsert, so setting versions on a timeline without a plugin row enables the
  // plugin (seeding pricing reaches here via replacePricing).
  const { data: existing, error: readErr } = await db
    .from('timeline_plugins')
    .select('config')
    .eq('timeline_id', id)
    .eq('plugin_id', PRODUCT_ROADMAP_PLUGIN)
    .maybeSingle();
  if (readErr) throw new Error(`updateVersions read: ${readErr.message}`);
  const config = { ...((existing?.config as Record<string, unknown>) ?? {}), versions: versions ?? [] };
  const { error } = await db
    .from('timeline_plugins')
    .upsert({ timeline_id: id, plugin_id: PRODUCT_ROADMAP_PLUGIN, config, updated_at: new Date().toISOString() });
  if (error) throw new Error(`updateVersions: ${error.message}`);
}

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

// -- bulk replace (import, MCP set_pricing seed, PUT) --

/**
 * Wipe and re-insert every pricing row for a timeline from a full Pricing model.
 * Does NOT touch the `pricing_versions` column (callers set it alongside). Used
 * by replaceTimeline and the MCP bulk `set_pricing` seed.
 */
export async function replacePricingRows(
  db: SupabaseClient,
  id: string,
  pricing: Pricing | undefined,
): Promise<void> {
  // Values first (FK children), then the parents + highlights.
  for (const table of ['pricing_tier_values', 'pricing_features', 'pricing_tiers', 'pricing_highlights']) {
    const { error } = await db.from(table).delete().eq('timeline_id', id);
    if (error) throw new Error(`replacePricingRows clear ${table}: ${error.message}`);
  }
  if (!pricing) return;

  const featureRows = (pricing.features ?? [])
    .filter((f) => f.id)
    .map((f, i) => featureToRow(id, f, i));
  if (featureRows.length) {
    const { error } = await db.from('pricing_features').insert(featureRows);
    if (error) throw new Error(`replacePricingRows insert features: ${error.message}`);
  }

  const tierRows = (pricing.tiers ?? [])
    .filter((t) => t.id)
    .map((t, i) => tierToRow(id, t, i));
  if (tierRows.length) {
    const { error } = await db.from('pricing_tiers').insert(tierRows);
    if (error) throw new Error(`replacePricingRows insert tiers: ${error.message}`);
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
      valueRows.push({ timeline_id: id, tier_id: t.id, feature_id: featureId, value, available_from: vv[featureId] ?? null });
    }
  }
  if (valueRows.length) {
    const { error } = await db.from('pricing_tier_values').insert(valueRows);
    if (error) throw new Error(`replacePricingRows insert values: ${error.message}`);
  }

  const highlightRows = (pricing.highlights ?? [])
    .filter((h) => h.id)
    .map((h, i) => highlightToRow(id, h, i));
  if (highlightRows.length) {
    const { error } = await db.from('pricing_highlights').insert(highlightRows);
    if (error) throw new Error(`replacePricingRows insert highlights: ${error.message}`);
  }
}

/** Full pricing replace incl. the versions array — used by the MCP set_pricing seed. */
export async function replacePricing(
  db: SupabaseClient,
  id: string,
  pricing: Pricing,
): Promise<void> {
  await updateVersions(db, id, pricing.versions ?? []);
  await replacePricingRows(db, id, pricing);
}

// ---- TimelineRepo factory (supabase-js) ------------------------------------

/**
 * Bind a supabase-js client to every storage method, yielding a `TimelineRepo`
 * the dispatcher can drive without knowing the driver. Mirror of
 * `makePostgresRepo`; this is the factory the Netlify default resolves.
 */
export function makeSupabaseRepo(db: SupabaseClient): TimelineRepo {
  return {
    listTimelines: () => listTimelines(db),
    getTimeline: (id) => getTimeline(db, id),
    getWatermark: (id) => getWatermark(db, id),
    getPublicPricing: (id) => getPublicPricing(db, id),
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
    addFeature: (timelineId, feature, updatedBy) => addFeature(db, timelineId, feature, updatedBy),
    updateFeature: (timelineId, featureId, patch, expectedVersion, updatedBy) =>
      updateFeature(db, timelineId, featureId, patch, expectedVersion, updatedBy),
    deleteFeature: (timelineId, featureId) => deleteFeature(db, timelineId, featureId),
    moveFeature: (timelineId, featureId, anchor, updatedBy) =>
      moveFeature(db, timelineId, featureId, anchor, updatedBy),
    addTier: (timelineId, tier, updatedBy) => addTier(db, timelineId, tier, updatedBy),
    updateTier: (timelineId, tierId, patch, expectedVersion, updatedBy) =>
      updateTier(db, timelineId, tierId, patch, expectedVersion, updatedBy),
    deleteTier: (timelineId, tierId) => deleteTier(db, timelineId, tierId),
    setTierValue: (timelineId, tierId, featureId, value, updatedBy, availableFrom) =>
      setTierValue(db, timelineId, tierId, featureId, value, updatedBy, availableFrom),
    clearTierValue: (timelineId, tierId, featureId) => clearTierValue(db, timelineId, tierId, featureId),
    addHighlight: (timelineId, highlight, updatedBy) => addHighlight(db, timelineId, highlight, updatedBy),
    updateHighlight: (timelineId, highlightId, patch, expectedVersion, updatedBy) =>
      updateHighlight(db, timelineId, highlightId, patch, expectedVersion, updatedBy),
    deleteHighlight: (timelineId, highlightId) => deleteHighlight(db, timelineId, highlightId),
    updateVersions: (id, versions) => updateVersions(db, id, versions),
    replacePricing: (id, pricing) => replacePricing(db, id, pricing),
  };
}

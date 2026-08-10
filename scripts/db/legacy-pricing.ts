// The four `pricing_*` tables, read one last time. **Migration-only, and dated.**
//
// `pricing_features`, `pricing_tiers`, `pricing_tier_values` and
// `pricing_highlights` were one plugin's schema in the core database, served by
// fifteen methods on `TimelineRepo` across two drivers. Issue #17 removed all of
// that: the plugin's rows live in `plugin_data` like anybody else's, and the
// interface carries no plugin-specific method (a CI check asserts it).
//
// What could not be removed with them is the ability to READ the old tables,
// because `npm run migrate:pricing` reads its source from there. So the read
// path moved here rather than staying in the drivers: this module has exactly
// one consumer, it is the only file left that names those tables, and it is
// deleted by the same migration that drops them.
//
// It sits in `scripts/db/` rather than in the plugin folder because it is SQL
// against tables the plugin no longer owns, and it imports the plugin's types
// rather than the other way round — a driver importing a plugin is the coupling
// being removed, a dated migration helper doing it for one release is not.

import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PRODUCT_ROADMAP_PLUGIN, versionsFromConfig } from '../../src/plugins/product-roadmap/plugin.ts';
import type {
  Pricing,
  PricingFeature,
  PricingHighlight,
  PricingTier,
} from '../../src/plugins/product-roadmap/types.ts';

const FEATURE_SELECT =
  'id, name, "group", description, available_from, name_by_version, description_by_version, sort, version';
const TIER_SELECT = 'id, name, tagline, use_case, target_group, price, sort, version';
const HIGHLIGHT_SELECT = 'id, label, section, icon, feature_ids, description, label_by_version, sort, version';

type CellRow = {
  tier_id: string;
  feature_id: string;
  value: string | boolean;
  available_from?: string | null;
};

function rowToFeature(row: Record<string, any>): PricingFeature {
  const f: PricingFeature = { id: row.id, name: row.name ?? '' };
  if (row.group != null) f.group = row.group;
  if (row.description != null) f.description = row.description;
  // `available_from` is the domain label and `version` is the lock counter. The
  // column names are the wrong way round from what the model calls them, which
  // is exactly the confusion the new store avoids by keeping the counter in the
  // row envelope.
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

/**
 * The normalized rows as the model, DB-free so both drivers share one answer.
 *
 * Folding each cell into its tier's `values` is the step that made the old
 * public endpoint impossible to replace with a generic alias: it is the plugin's
 * knowledge, and the host has none of it.
 */
function rowsToPricing(
  featureRows: Record<string, any>[],
  tierRows: Record<string, any>[],
  valueRows: CellRow[],
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

/** Null when the timeline is unknown or carries no legacy model to move. */
export async function readLegacyPricingSql(sql: Sql, id: string): Promise<Pricing | null> {
  const [exists] = await sql`select 1 from timelines where id = ${id}`;
  if (!exists) return null;
  const [plugin] = await sql`
    select config from timeline_plugins where timeline_id = ${id} and plugin_id = ${PRODUCT_ROADMAP_PLUGIN}`;
  const [featRows, tierRows, valRows, hlRows] = await Promise.all([
    sql`select ${sql.unsafe(FEATURE_SELECT)} from pricing_features where timeline_id = ${id} order by sort asc nulls first`,
    sql`select ${sql.unsafe(TIER_SELECT)} from pricing_tiers where timeline_id = ${id} order by sort asc nulls first`,
    sql`select tier_id, feature_id, value, available_from from pricing_tier_values where timeline_id = ${id}`,
    sql`select ${sql.unsafe(HIGHLIGHT_SELECT)} from pricing_highlights where timeline_id = ${id} order by sort asc nulls first`,
  ]);
  const pricing = rowsToPricing(
    featRows as Record<string, any>[],
    tierRows as Record<string, any>[],
    valRows as unknown as CellRow[],
    hlRows as Record<string, any>[],
    versionsFromConfig(plugin?.config as Record<string, unknown> | undefined),
  );
  return pricing.features.length || pricing.tiers.length ? pricing : null;
}

/** The same read over PostgREST, for an instance on the supabase-js driver. */
export async function readLegacyPricingSupabase(db: SupabaseClient, id: string): Promise<Pricing | null> {
  const exists = await db.from('timelines').select('id').eq('id', id).maybeSingle();
  if (exists.error) throw new Error(`legacy pricing, timeline: ${exists.error.message}`);
  if (!exists.data) return null;

  const plugin = await db
    .from('timeline_plugins')
    .select('config')
    .eq('timeline_id', id)
    .eq('plugin_id', PRODUCT_ROADMAP_PLUGIN)
    .maybeSingle();
  if (plugin.error) throw new Error(`legacy pricing, config: ${plugin.error.message}`);

  const order = { ascending: true, nullsFirst: true } as const;
  const [featRes, tierRes, valRes, hlRes] = await Promise.all([
    db.from('pricing_features').select(FEATURE_SELECT).eq('timeline_id', id).order('sort', order),
    db.from('pricing_tiers').select(TIER_SELECT).eq('timeline_id', id).order('sort', order),
    db.from('pricing_tier_values').select('tier_id, feature_id, value, available_from').eq('timeline_id', id),
    db.from('pricing_highlights').select(HIGHLIGHT_SELECT).eq('timeline_id', id).order('sort', order),
  ]);
  for (const [what, res] of [
    ['features', featRes],
    ['tiers', tierRes],
    ['cells', valRes],
    ['highlights', hlRes],
  ] as const) {
    if (res.error) throw new Error(`legacy pricing, ${what}: ${res.error.message}`);
  }

  const pricing = rowsToPricing(
    (featRes.data ?? []) as Record<string, any>[],
    (tierRes.data ?? []) as Record<string, any>[],
    (valRes.data ?? []) as unknown as CellRow[],
    (hlRes.data ?? []) as Record<string, any>[],
    versionsFromConfig((plugin.data?.config ?? undefined) as Record<string, unknown> | undefined),
  );
  return pricing.features.length || pricing.tiers.length ? pricing : null;
}

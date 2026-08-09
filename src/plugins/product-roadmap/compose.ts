// The pricing model as generic rows, and back.
//
// `assemblePricing` used to do this in the repo, in SQL-shaped code, for one
// plugin — which is exactly the privilege issue #17 removes. The knowledge that a
// matrix cell belongs inside its tier under `values` is the PLUGIN's, so it lives
// in the plugin, and the host stores four undistinguished collections.
//
// Both directions are here and both are pure, because the migration needs the
// round trip to be provable: rows → model → rows has to be a fixed point, or the
// move loses something that only shows up in somebody's published price list.
//
// The four collection ids are the plugin's own vocabulary and come from its
// manifest, so a rename happens in one place.

import { PRICING_COLLECTIONS } from './manifest';
import { PRODUCT_ROADMAP_PLUGIN, versionsFromConfig } from './plugin.ts';
import type {
  Pricing,
  PricingFeature,
  PricingHighlight,
  PricingTier,
  PluginCollectionData,
  PluginDataRow,
} from '../../types';

const { features: FEATURES, tiers: TIERS, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

/** The stored shape of one matrix cell. Its id is derived from the two ids. */
type CellData = { tierId: string; featureId: string; value?: string | boolean; availableFrom?: string };

const rows = (data: PluginCollectionData | undefined, collection: string): PluginDataRow[] =>
  data?.[collection] ?? [];

/**
 * The entity of one row: its id, its stored `data`, and the host's lock counter.
 *
 * `rowVersion` has to come out of the ENVELOPE rather than out of `data` — it is
 * the host's counter, and a feature's own `version` field is the domain „ab
 * Version" label. Carrying it is what lets a form send `If-Match` on the first
 * edit after a load; without it every edit would be a blind write and a
 * concurrent change would be overwritten silently instead of answering 409.
 * It never travels back into storage (`collectionsFromPricing` drops it), so the
 * round trip stays a fixed point.
 */
function entity<T>(row: PluginDataRow): T {
  const out = compact({ id: row.id, ...(row.data as object) }) as Record<string, unknown>;
  if (row.version != null) out.rowVersion = row.version;
  return out as T;
}

/** Drop keys the plugin does not set, so a round trip does not grow `undefined`s. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out as T;
}

/**
 * Compose the model the views render from the rows the host stored.
 *
 * `versions` comes from the plugin's config rather than a collection: it is a
 * short ordered list that is always replaced wholesale, which is what config is
 * for. That was already true before the move (`timeline_plugins.config`).
 *
 * Cells are folded into their tier here — the one piece of knowledge the generic
 * layer deliberately does not have, and the reason `/api/pricing/<id>` cannot be
 * a plugin-free alias (see docs/plugin-public-read.md).
 */
export function pricingFromCollections(
  data: PluginCollectionData | undefined,
  versions: string[] = [],
): Pricing {
  const valuesByTier = new Map<string, Record<string, string | boolean>>();
  const versionsByTier = new Map<string, Record<string, string>>();

  for (const row of rows(data, CELLS)) {
    const cell = row.data as CellData;
    if (!cell?.tierId || !cell.featureId) continue;
    // A cell with no value is not „included with an empty value", it is a cell
    // that was cleared. Storing it and rendering it are different questions, and
    // the renderer's answer to „absent" and „false" is the same dash.
    if (cell.value === undefined || cell.value === null || cell.value === false) continue;
    let bucket = valuesByTier.get(cell.tierId);
    if (!bucket) valuesByTier.set(cell.tierId, (bucket = {}));
    bucket[cell.featureId] = cell.value;
    if (cell.availableFrom) {
      let vb = versionsByTier.get(cell.tierId);
      if (!vb) versionsByTier.set(cell.tierId, (vb = {}));
      vb[cell.featureId] = cell.availableFrom;
    }
  }

  const pricing: Pricing = {
    features: rows(data, FEATURES).map((row) => entity<PricingFeature>(row)),
    tiers: rows(data, TIERS).map((row) => {
      // `values` is assigned AFTER compacting, and that is not a style choice:
      // `compact` drops empty objects (so an unused `nameByVersion` does not grow
      // back on every round trip), but `values` is a required field of
      // `PricingTier` that the renderer reads. A tier with no cells still has an
      // empty one, or the round trip loses it and the type is a lie.
      const tier = entity<PricingTier>(row);
      tier.values = valuesByTier.get(row.id) ?? {};
      const valueVersions = versionsByTier.get(row.id);
      if (valueVersions) tier.valueVersions = valueVersions;
      return tier;
    }),
  };
  const highlights = rows(data, HIGHLIGHTS).map((row) => entity<PricingHighlight>(row));
  if (highlights.length) pricing.highlights = highlights;
  if (versions.length) pricing.versions = versions;
  return pricing;
}

/**
 * The pricing model of a timeline, composed from what the host stored.
 *
 * **The one place the plugin asks „what is the model here".** Every view, form and
 * field goes through it, so there is exactly one answer and one place to change
 * when the storage does — which is what made this migration a change to one
 * function rather than to twenty call sites.
 *
 * It reads `pluginData`, never `file.pricing`: after #17 the core file type has no
 * pricing field, and a plugin reading one would be the plugin still being special.
 */
export function currentPricing(file: { pluginData?: Record<string, PluginCollectionData>; plugins?: { id: string; config?: Record<string, unknown> }[] } | null | undefined): Pricing {
  const versions = versionsFromConfig(file?.plugins?.find((p) => p.id === PRODUCT_ROADMAP_PLUGIN)?.config);
  return pricingFromCollections(file?.pluginData?.[PRODUCT_ROADMAP_PLUGIN], versions);
}

/** Does this timeline carry a model worth showing a view for? */
export function hasPricingModel(file: Parameters<typeof currentPricing>[0]): boolean {
  const data = file?.pluginData?.[PRODUCT_ROADMAP_PLUGIN];
  return !!(data?.[TIERS]?.length || data?.[FEATURES]?.length);
}

/** The row id of a matrix cell: its coordinates, encoded the way the host does. */
export function cellId(tierId: string, featureId: string): string {
  return `${encodeURIComponent(tierId)}:${encodeURIComponent(featureId)}`;
}

/**
 * The inverse: a whole model as rows to store.
 *
 * Used by the migration and by any bulk write. `id` moves out of `data` and into
 * the row's own id, because that is where the host keeps identity — leaving a copy
 * inside `data` would give every row two ids that can disagree.
 *
 * `values` and `valueVersions` are expanded back into one cell per pair. A falsy
 * value produces no cell at all, matching what the old storage did: the server
 * cleared a cell on a falsy write, so „false" was never a row.
 */
export function collectionsFromPricing(pricing: Pricing | undefined): PluginCollectionData {
  const out: PluginCollectionData = { [FEATURES]: [], [TIERS]: [], [CELLS]: [], [HIGHLIGHTS]: [] };
  if (!pricing) return out;

  for (const feature of pricing.features ?? []) {
    const { id, rowVersion: _rv, ...data } = feature;
    out[FEATURES].push({ id, data: compact(data as Record<string, unknown>) });
  }
  for (const tier of pricing.tiers ?? []) {
    const { id, rowVersion: _rv, values, valueVersions, ...data } = tier;
    out[TIERS].push({ id, data: compact(data as Record<string, unknown>) });
    for (const [featureId, value] of Object.entries(values ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      const availableFrom = valueVersions?.[featureId];
      out[CELLS].push({
        id: cellId(id, featureId),
        data: compact({ tierId: id, featureId, value, ...(availableFrom ? { availableFrom } : {}) }),
      });
    }
  }
  for (const highlight of pricing.highlights ?? []) {
    const { id, rowVersion: _rv, ...data } = highlight;
    out[HIGHLIGHTS].push({ id, data: compact(data as Record<string, unknown>) });
  }
  return out;
}

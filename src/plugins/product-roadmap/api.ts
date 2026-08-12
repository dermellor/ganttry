// This plugin's writes, through the host's data API.
//
// They used to live in `src/editor.ts` — core code carrying one plugin's endpoints,
// which is the coupling #17 removed. #117 removed the other half of it: the routes
// were already the generic ones, but this module reached them with the app's own
// fetch wrapper, so `HostApi.data` — the thing every third-party plugin has to use
// — was untested by the only plugin that existed.
//
// The host owns the transport now. What that buys beyond parity:
//
//   - the plugin id and the source id are bound by the host, so no call here can
//     name another plugin's collections or another timeline;
//   - the capability gate becomes real: without `data:own` there is no `data`
//     object, rather than a request that gets refused server-side;
//   - `DataApi.patch` exists because this module needed it. A partial row update
//     where `null` clears a key had no method on the contract, which is exactly the
//     gap that building a plugin in-house is supposed to surface.
//
// The entity ↔ row translation is `./compose.ts`, so a write and a read agree on
// what a row looks like by construction rather than by two people remembering the
// same thing.

import { hostApi } from './host';
import { PRICING_COLLECTIONS } from './manifest';
import { cellId } from './compose';
import type { DataApi, PluginRow } from '../../pluginHost/api';
import type { PricingFeature, PricingHighlight, PricingTier } from './types';

const { features: FEATURES, tiers: TIERS, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

/**
 * The host's data API, or a refusal that names the cause.
 *
 * Absent means the manifest did not ask for `data:own` — a declaration mistake, and
 * one worth failing loudly on rather than turning every write into a silent no-op.
 */
function data(): DataApi {
  const api = hostApi().data;
  if (!api) throw new Error('product-roadmap: the manifest is missing the "data:own" capability');
  return api;
}

/**
 * Strip what the host owns before sending an entity as a row's `data`.
 *
 * `rowVersion` in particular: on a feature, `version` is the domain „ab Version"
 * label rather than the lock counter, and putting the two in one object is how they
 * get confused. The counter travels as an argument instead, and the host puts it in
 * the `If-Match` header where the store keeps it.
 */
function toData<T extends object>(entity: T): Record<string, unknown> {
  const { id: _id, rowVersion: _rv, ...rest } = entity as Record<string, unknown>;
  return rest;
}

// ---- features ---------------------------------------------------------------

/**
 * Create a feature; returns the ROW the host stored.
 *
 * Every write here returns a row rather than an entity, and that is deliberate:
 * the caller's next step is to put it into `file.pluginData` through `./store`,
 * because that is where the state lives. Handing back an entity invited the
 * caller to merge it into a composed model instead — which is exactly the write
 * that never reached the screen (see the note at the top of ./store.ts).
 */
export async function apiAddFeature(feature: PricingFeature): Promise<PluginRow> {
  return data().put(FEATURES, { id: feature.id, data: toData(feature) });
}

/**
 * Patch a feature with optimistic locking. A `null` in the patch clears the field —
 * `DataApi.patch` deletes a key written as null, which is what the forms rely on to
 * make an emptied input actually empty rather than leaving the old value.
 */
export async function apiUpdateFeature(
  featureId: string,
  update: Partial<PricingFeature>,
  rowVersion?: number,
): Promise<PluginRow> {
  return data().patch(FEATURES, featureId, toData(update), rowVersion);
}

/**
 * Delete a feature. Its cells go with it and it is removed from every highlight
 * that listed it — both declared in the manifest (`onDelete: cascade` and
 * `unlink`), applied by the host, where a hand-written loop in the repo used to
 * do it for this plugin alone.
 */
export async function apiDeleteFeature(featureId: string): Promise<void> {
  await data().remove(FEATURES, featureId);
}

/**
 * Reposition a feature relative to exactly one anchor. The host owns the order
 * and returns the resulting full id list, so the caller adopts that rather than
 * guessing at the new order itself.
 */
export async function apiMoveFeature(
  featureId: string,
  anchor: { after?: string; before?: string },
): Promise<string[]> {
  return data().move(FEATURES, featureId, anchor);
}

// ---- tiers ------------------------------------------------------------------

/** Create a tier (a matrix column). It starts with no cells: they are their own rows. */
export async function apiAddTier(tier: PricingTier): Promise<PluginRow> {
  return data().put(TIERS, { id: tier.id, data: toData(withoutCells(tier)) });
}

/**
 * Patch a tier's Stammdaten. `values` is not part of it, deliberately: cells are
 * their own rows, which is what lets two people edit two cells of one tier
 * without colliding — and what keeps a tier rename from touching a single cell.
 */
export async function apiUpdateTier(
  tierId: string,
  update: Partial<PricingTier>,
  rowVersion?: number,
): Promise<PluginRow> {
  return data().patch(TIERS, tierId, toData(withoutCells(update)), rowVersion);
}

export async function apiDeleteTier(tierId: string): Promise<void> {
  await data().remove(TIERS, tierId);
}

function withoutCells(tier: Partial<PricingTier>): Partial<PricingTier> {
  const { values: _v, valueVersions: _vv, ...rest } = tier;
  return rest;
}

// ---- matrix cells -----------------------------------------------------------

/**
 * Write one matrix cell (tier × feature), or clear it.
 *
 * No lock counter, deliberately, and the reason survives every move this code has
 * made: a cell is a single atomic value, so two people editing different cells
 * never collide. Clearing DELETES the row rather than storing a falsy value — „not
 * included" is the absence of a cell, which is what `pricingFromCollections` reads.
 * `availableFrom` gates from which version the cell counts as included.
 */
export async function apiSetTierValue(
  tierId: string,
  featureId: string,
  value: string | boolean | null,
  availableFrom: string | null,
): Promise<PluginRow | null> {
  const id = cellId(tierId, featureId);
  if (value === null || value === false || value === '') {
    // Clearing a cell that was never set is not an error: the endpoint answers the
    // same either way, and the UI reaches this on every „nicht enthalten" click
    // regardless of what was there before. `null` back means „there is no row now",
    // which is what the caller mirrors.
    await data().remove(CELLS, id).catch(() => {});
    return null;
  }
  return data().put(CELLS, {
    id,
    data: {
      tierId,
      featureId,
      value,
      ...(availableFrom ? { availableFrom } : {}),
    },
  });
}

// ---- highlights -------------------------------------------------------------
//
// No UI writes these yet (they are authored through MCP), but they are one of the
// plugin's four collections and the route is the same one. Having them here is
// what keeps the next caller from reaching past this module.

export async function apiAddHighlight(highlight: PricingHighlight): Promise<PluginRow> {
  return data().put(HIGHLIGHTS, { id: highlight.id, data: toData(highlight) });
}

export async function apiUpdateHighlight(
  highlightId: string,
  update: Partial<PricingHighlight>,
  rowVersion?: number,
): Promise<PluginRow> {
  return data().patch(HIGHLIGHTS, highlightId, toData(update), rowVersion);
}

export async function apiDeleteHighlight(highlightId: string): Promise<void> {
  await data().remove(HIGHLIGHTS, highlightId);
}

// This plugin's writes, against the generic plugin-data routes.
//
// These functions used to live in `src/editor.ts` — core code carrying one
// plugin's endpoints, which is the coupling issue #17 removes. They now speak the
// same API any third-party plugin speaks:
//
//   POST   /api/source/<id>/plugin/product-roadmap/<collection>
//   PATCH  /api/source/<id>/plugin/product-roadmap/<collection>/<rowId>
//   DELETE /api/source/<id>/plugin/product-roadmap/<collection>/<rowId>
//   POST   /api/source/<id>/plugin/product-roadmap/<collection>/move
//
// The consequence that matters beyond tidiness: those routes are implemented on
// the repo seam, so editing a pricing model on a `data/*.json` timeline works
// instead of answering 501 the way the pricing-specific repo methods did.
//
// The entity ↔ row translation is `./compose.ts`, so a write and a read agree on
// what a row looks like by construction rather than by two people remembering the
// same thing.

import { apiJson, ConflictError } from '../../editor';
import { PRICING_COLLECTIONS } from './manifest';
import { cellId } from './compose';
import { PRODUCT_ROADMAP_PLUGIN } from './plugin';
import type { PluginDataRow } from '../../types';
import type { PricingFeature, PricingHighlight, PricingTier } from './types';

export { ConflictError };

const { features: FEATURES, tiers: TIERS, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

const base = (sourceId: string, collection: string) =>
  `/api/source/${sourceId}/plugin/${PRODUCT_ROADMAP_PLUGIN}/${collection}`;

/**
 * The lock counter always travels as `If-Match`, never in the body.
 *
 * On a feature, `version` is the domain „ab Version" label rather than the lock
 * counter, and putting the two in one object is how they get confused. The store
 * keeps its counter in the row envelope for the same reason, which is where
 * `./compose.ts` reads it from when it hands the model back out as `rowVersion`.
 */
function headers(rowVersion?: number): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' };
  if (rowVersion != null) out['If-Match'] = String(rowVersion);
  return out;
}

/** Strip what the host owns before sending an entity as a row's `data`. */
function toData<T extends object>(entity: T): Record<string, unknown> {
  const { id: _id, rowVersion: _rv, ...data } = entity as Record<string, unknown>;
  return data;
}

async function put(
  sourceId: string,
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<PluginDataRow> {
  return apiJson(
    await fetch(base(sourceId, collection), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id, data }),
    }),
  );
}

async function patch(
  sourceId: string,
  collection: string,
  id: string,
  data: Record<string, unknown>,
  rowVersion?: number,
): Promise<PluginDataRow> {
  return apiJson(
    await fetch(`${base(sourceId, collection)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: headers(rowVersion),
      body: JSON.stringify({ data }),
    }),
  );
}

async function remove(sourceId: string, collection: string, id: string): Promise<void> {
  await apiJson(
    await fetch(`${base(sourceId, collection)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );
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
export async function apiAddFeature(sourceId: string, feature: PricingFeature): Promise<PluginDataRow> {
  return put(sourceId, FEATURES, feature.id, toData(feature));
}

/**
 * Patch a feature with optimistic locking. A `null` in the patch clears the field
 * — the generic PATCH deletes a key written as null, which is what the forms rely
 * on to make an emptied input actually empty rather than leaving the old value.
 */
export async function apiUpdateFeature(
  sourceId: string,
  featureId: string,
  update: Partial<PricingFeature>,
  rowVersion?: number,
): Promise<PluginDataRow> {
  return patch(sourceId, FEATURES, featureId, toData(update), rowVersion);
}

/**
 * Delete a feature. Its cells go with it and it is removed from every highlight
 * that listed it — both declared in the manifest (`onDelete: cascade` and
 * `unlink`), applied by the host, where a hand-written loop in the repo used to
 * do it for this plugin alone.
 */
export async function apiDeleteFeature(sourceId: string, featureId: string): Promise<void> {
  await remove(sourceId, FEATURES, featureId);
}

/**
 * Reposition a feature relative to exactly one anchor. The host owns the order
 * and returns the resulting full id list, so the caller adopts that rather than
 * guessing at the new order itself.
 */
export async function apiMoveFeature(
  sourceId: string,
  featureId: string,
  anchor: { after?: string; before?: string },
): Promise<string[]> {
  const res = await apiJson(
    await fetch(`${base(sourceId, FEATURES)}/move`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: featureId, ...anchor }),
    }),
  );
  return (res?.order ?? []) as string[];
}

// ---- tiers ------------------------------------------------------------------

/** Create a tier (a matrix column). It starts with no cells: they are their own rows. */
export async function apiAddTier(sourceId: string, tier: PricingTier): Promise<PluginDataRow> {
  return put(sourceId, TIERS, tier.id, toData(withoutCells(tier)));
}

/**
 * Patch a tier's Stammdaten. `values` is not part of it, deliberately: cells are
 * their own rows, which is what lets two people edit two cells of one tier
 * without colliding — and what keeps a tier rename from touching a single cell.
 */
export async function apiUpdateTier(
  sourceId: string,
  tierId: string,
  update: Partial<PricingTier>,
  rowVersion?: number,
): Promise<PluginDataRow> {
  return patch(sourceId, TIERS, tierId, toData(withoutCells(update)), rowVersion);
}

export async function apiDeleteTier(sourceId: string, tierId: string): Promise<void> {
  await remove(sourceId, TIERS, tierId);
}

function withoutCells(tier: Partial<PricingTier>): Partial<PricingTier> {
  const { values: _v, valueVersions: _vv, ...rest } = tier;
  return rest;
}

// ---- matrix cells -----------------------------------------------------------

/**
 * Write one matrix cell (tier × feature), or clear it.
 *
 * No lock counter, deliberately, and the reason survives the move: a cell is a
 * single atomic value, so two people editing different cells never collide.
 * Clearing DELETES the row rather than storing a falsy value — „not included" is
 * the absence of a cell, which is what `pricingFromCollections` reads.
 * `availableFrom` gates from which version the cell counts as included.
 */
export async function apiSetTierValue(
  sourceId: string,
  tierId: string,
  featureId: string,
  value: string | boolean | null,
  availableFrom: string | null,
): Promise<PluginDataRow | null> {
  const id = cellId(tierId, featureId);
  if (value === null || value === false || value === '') {
    // Clearing a cell that was never set is not an error: the old endpoint
    // answered the same either way, and the UI reaches this on every „nicht
    // enthalten" click regardless of what was there before. `null` back means
    // „there is no row now", which is what the caller mirrors.
    await remove(sourceId, CELLS, id).catch(() => {});
    return null;
  }
  return put(sourceId, CELLS, id, {
    tierId,
    featureId,
    value,
    ...(availableFrom ? { availableFrom } : {}),
  });
}

// ---- highlights -------------------------------------------------------------
//
// No UI writes these yet (they are authored through MCP), but they are one of the
// plugin's four collections and the route is the same one. Having them here is
// what keeps the next caller from reaching past this module.

export async function apiAddHighlight(sourceId: string, highlight: PricingHighlight): Promise<PluginDataRow> {
  return put(sourceId, HIGHLIGHTS, highlight.id, toData(highlight));
}

export async function apiUpdateHighlight(
  sourceId: string,
  highlightId: string,
  update: Partial<PricingHighlight>,
  rowVersion?: number,
): Promise<PluginDataRow> {
  return patch(sourceId, HIGHLIGHTS, highlightId, toData(update), rowVersion);
}

export async function apiDeleteHighlight(sourceId: string, highlightId: string): Promise<void> {
  await remove(sourceId, HIGHLIGHTS, highlightId);
}

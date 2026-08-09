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
import type { PluginDataRow, PricingFeature, PricingHighlight, PricingTier } from '../../types';

export { ConflictError };

const { features: FEATURES, tiers: TIERS, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

/**
 * What a write gives back: the row the host stored, as this plugin's entity.
 *
 * Partial rather than the full type, because a row carries only what was written
 * — a tier's `values` live in their own collection and are not re-read on a tier
 * PATCH. The forms `Object.assign` this over their in-memory copy, so an absent
 * key has to mean „unchanged" rather than „cleared".
 */
export type Saved<T> = Partial<T> & { id: string; rowVersion?: number };

const base = (sourceId: string, collection: string) =>
  `/api/source/${sourceId}/plugin/${PRODUCT_ROADMAP_PLUGIN}/${collection}`;

/**
 * The lock counter always travels as `If-Match`, never in the body.
 *
 * On a feature, `version` is the domain „ab Version" label rather than the lock
 * counter, and putting the two in one object is how they get confused. The store
 * keeps its counter in the row envelope for the same reason, which is why
 * `fromRow` below reads `row.version` and writes it out as `rowVersion`.
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

/** The stored row as an entity again: the envelope's id and lock counter, plus `data`. */
function fromRow<T>(row: PluginDataRow | undefined): Saved<T> {
  const id = row?.id ?? '';
  return { id, ...(row?.data ?? {}), ...(row?.version != null ? { rowVersion: row.version } : {}) } as Saved<T>;
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
 * Create a feature; returns it with what the host filled in (its lock counter).
 *
 * Merged over what was sent rather than returned bare, because the caller pushes
 * the result straight into the model: a row echoes back only its stored `data`,
 * and a `Partial` there would make every required field optional at the one call
 * site that needs them all.
 */
export async function apiAddFeature(sourceId: string, feature: PricingFeature): Promise<PricingFeature> {
  const saved = fromRow<PricingFeature>(await put(sourceId, FEATURES, feature.id, toData(feature)));
  return { ...feature, ...saved };
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
): Promise<Saved<PricingFeature>> {
  return fromRow<PricingFeature>(await patch(sourceId, FEATURES, featureId, toData(update), rowVersion));
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

/**
 * Create a tier (a matrix column). It starts with no cells, which is why the
 * returned entity carries an empty `values`: the caller pushes it straight into
 * the model, and the renderer reads that field.
 */
export async function apiAddTier(sourceId: string, tier: PricingTier): Promise<PricingTier> {
  const saved = fromRow<PricingTier>(await put(sourceId, TIERS, tier.id, toData(withoutCells(tier))));
  return { ...tier, ...saved, values: {} };
}

/**
 * Patch a tier's Stammdaten. `values` is not part of it, deliberately: cells are
 * their own rows, which is what lets two people edit two cells of one tier
 * without colliding. The response therefore has no `values` either, and the
 * caller's in-memory copy keeps the one it has.
 */
export async function apiUpdateTier(
  sourceId: string,
  tierId: string,
  update: Partial<PricingTier>,
  rowVersion?: number,
): Promise<Saved<PricingTier>> {
  return fromRow<PricingTier>(await patch(sourceId, TIERS, tierId, toData(withoutCells(update)), rowVersion));
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
): Promise<void> {
  const id = cellId(tierId, featureId);
  if (value === null || value === false || value === '') {
    // Clearing a cell that was never set is not an error: the old endpoint
    // answered the same either way, and the UI reaches this on every „nicht
    // enthalten" click regardless of what was there before.
    await remove(sourceId, CELLS, id).catch(() => {});
    return;
  }
  await put(sourceId, CELLS, id, {
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

export async function apiAddHighlight(
  sourceId: string,
  highlight: PricingHighlight,
): Promise<PricingHighlight> {
  const saved = fromRow<PricingHighlight>(await put(sourceId, HIGHLIGHTS, highlight.id, toData(highlight)));
  return { ...highlight, ...saved };
}

export async function apiUpdateHighlight(
  sourceId: string,
  highlightId: string,
  update: Partial<PricingHighlight>,
  rowVersion?: number,
): Promise<Saved<PricingHighlight>> {
  return fromRow<PricingHighlight>(await patch(sourceId, HIGHLIGHTS, highlightId, toData(update), rowVersion));
}

export async function apiDeleteHighlight(sourceId: string, highlightId: string): Promise<void> {
  await remove(sourceId, HIGHLIGHTS, highlightId);
}

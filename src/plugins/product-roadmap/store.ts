// The in-memory mirror of a write, applied where the state actually lives.
//
// This module exists because of a bug the read-path migration introduced, and
// the bug is worth stating because nothing about it is visible at a call site:
//
// `currentPricing(file)` COMPOSES a fresh model out of the stored rows on every
// call. Before the migration it returned `file.pricing` — one object, held by the
// file, so `tier.values[featureId] = value` after a successful write updated the
// state the next repaint read. Afterwards the same line mutates an object that is
// discarded on the next line. The write reached the server, the file on disk was
// correct, and the matrix kept showing the old value until a reload. Nothing
// threw, nothing logged.
//
// So the mirror has to be applied in ROW space, to `file.pluginData`, which is
// the state. The functions here do exactly what the server did to the store, and
// the views keep composing from it. Two consequences worth keeping:
//
// - a form no longer mutates the model it renders from, so „did I update the
//   right copy" stops being a question anybody can get wrong;
// - `apiUpdateFeature` and friends return the stored ROW, and the row goes
//   straight in here — what the server wrote is what the client holds, rather
//   than a hand-merged approximation of it.

import { PRODUCT_ROADMAP_PLUGIN } from './plugin';
import type { PluginCollectionData, PluginDataRow, TimelineFile } from '../../types';

/** The plugin's collections on this file, created on first write. */
function collections(file: TimelineFile): PluginCollectionData {
  const all = (file.pluginData ??= {});
  return (all[PRODUCT_ROADMAP_PLUGIN] ??= {});
}

function rowsOf(file: TimelineFile, collection: string): PluginDataRow[] {
  const own = collections(file);
  return (own[collection] ??= []);
}

/**
 * Insert or replace one row.
 *
 * A new row is appended, which is where the host puts it too: an ordered
 * collection assigns the next sort position, so „at the end" is the same answer
 * both sides give. An existing row is replaced in place, so its position holds.
 */
export function applyRow(file: TimelineFile | null | undefined, collection: string, row: PluginDataRow): void {
  if (!file) return;
  const rows = rowsOf(file, collection);
  const at = rows.findIndex((r) => r.id === row.id);
  if (at === -1) rows.push(row);
  else rows[at] = row;
}

/** Drop one row. Silent when it is not there — a delete of nothing is a no-op. */
export function dropRow(file: TimelineFile | null | undefined, collection: string, rowId: string): void {
  if (!file) return;
  const own = file.pluginData?.[PRODUCT_ROADMAP_PLUGIN];
  const rows = own?.[collection];
  if (!rows) return;
  own[collection] = rows.filter((r) => r.id !== rowId);
}

/**
 * Drop every row of a collection whose `data` matches — the client's half of a
 * declared cascade.
 *
 * The host already applied it, so this is not a second decision: it mirrors what
 * the response said happened, so the matrix repaints without a reload.
 */
export function dropRowsWhere(
  file: TimelineFile | null | undefined,
  collection: string,
  matches: (data: Record<string, unknown>) => boolean,
): void {
  if (!file) return;
  const own = file.pluginData?.[PRODUCT_ROADMAP_PLUGIN];
  const rows = own?.[collection];
  if (!rows) return;
  own[collection] = rows.filter((r) => !matches(r.data));
}

/** Edit each row of a collection in place — the mirror of a declared `unlink`. */
export function patchRows(
  file: TimelineFile | null | undefined,
  collection: string,
  edit: (data: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!file) return;
  const rows = file.pluginData?.[PRODUCT_ROADMAP_PLUGIN]?.[collection];
  if (!rows) return;
  for (const row of rows) row.data = edit(row.data);
}

/**
 * Adopt the order the host returned.
 *
 * Rows it did not mention keep their relative place at the end rather than
 * disappearing: the host returns the full list, so an id missing from it means
 * the two sides disagree about what exists, and dropping a row over that would
 * turn a disagreement into data loss on screen.
 */
export function orderRows(file: TimelineFile | null | undefined, collection: string, orderedIds: string[]): void {
  if (!file) return;
  const own = file.pluginData?.[PRODUCT_ROADMAP_PLUGIN];
  const rows = own?.[collection];
  if (!rows) return;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ranked = orderedIds.map((id) => byId.get(id)).filter((r): r is PluginDataRow => !!r);
  const seen = new Set(orderedIds);
  own[collection] = [...ranked, ...rows.filter((r) => !seen.has(r.id))];
}

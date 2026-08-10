// The rules a plugin's collections are held to, as pure functions.
//
// Postgres enforces four things for a built-in plugin's own tables: the column
// shape, the foreign keys with their cascade, the row order, and a composite
// primary key for a row that has no id of its own. A runtime-installed plugin
// ships neither DDL nor server code, so those four move into the manifest as
// declarations and are enforced here — above the repo, so one implementation
// covers the `plugin_data` table, a JSON file and a Markdown directory alike.
//
// Everything in this module is DOM-free and store-free on purpose: it decides
// *what* must happen, the caller performs it. That is what lets the dispatcher
// apply the same cascade to three backing stores without three copies of the
// rule (AGENTS.md → „A rule lives in exactly one place").

import { validateRow } from './dataSchema.ts';
import type { CollectionDecl, PluginManifest, ReferenceDecl } from './manifest';

export type Row = { id: string; data: Record<string, unknown> };

/** The collection a plugin declared under this id, or null when it did not. */
export function collectionOf(manifest: PluginManifest, collectionId: string): CollectionDecl | null {
  return (manifest.collections ?? []).find((c) => c.id === collectionId) ?? null;
}

/**
 * The row id for a piece of data.
 *
 * With `keyFields`, the row IS its coordinates — a matrix cell is one row per
 * (tier, feature) pair — so the id is derived from them and a second write to
 * the same coordinates updates rather than duplicates. That is what
 * `pricing_tier_values`' composite primary key does today.
 *
 * The parts are percent-encoded before being joined, because a row id travels in
 * a URL path and an unencoded `/` in a key value would silently split into two
 * segments and address a different row. Values without special characters encode
 * to themselves, so an id stays readable (`pro:calls`).
 */
export function rowIdFor(collection: CollectionDecl, data: Record<string, unknown>, fallbackId?: string): string {
  const keys = collection.keyFields;
  if (!keys?.length) {
    const own = fallbackId ?? (typeof data.id === 'string' ? data.id : '');
    return own;
  }
  return keys
    .map((k) => {
      const v = data[k];
      return encodeURIComponent(v == null ? '' : String(v));
    })
    .join(':');
}

/** Problems with a row's shape, empty when the collection declared no schema. */
export function rowProblems(collection: CollectionDecl, data: unknown): string[] {
  return validateRow(collection.schema, data);
}

/**
 * The key fields a composite-keyed collection needs, that this data lacks.
 *
 * Checked separately from the schema because it is the identity, not the shape:
 * a cell missing `tierId` does not get a degraded id, it has no id at all, and
 * storing it would produce a row nothing can address again.
 */
export function missingKeyFields(collection: CollectionDecl, data: Record<string, unknown>): string[] {
  return (collection.keyFields ?? []).filter((k) => {
    const v = data[k];
    return v == null || String(v) === '';
  });
}

/** References pointing AT this collection — the ones a delete has to answer for. */
export function referencesTo(manifest: PluginManifest, collectionId: string): ReferenceDecl[] {
  return (manifest.references ?? []).filter((r) => r.to === collectionId);
}

/** References this collection holds — the ones a write has to be able to resolve. */
export function referencesFrom(manifest: PluginManifest, collectionId: string): ReferenceDecl[] {
  return (manifest.references ?? []).filter((r) => r.from === collectionId);
}

export type CascadeStep = { collection: string; rowIds: string[] };
/** One row whose reference is cleared instead of the row being deleted. */
export type UnlinkStep = {
  collection: string;
  rowId: string;
  field: string;
  /** The field's new value: the array minus the gone ids, or null for a scalar. */
  value: string[] | null;
};

/** The ids a reference field holds, whether or not it is declared as an array. */
export function referenceTargets(reference: ReferenceDecl, data: Record<string, unknown>): string[] {
  const raw = data[reference.field];
  if (reference.array) return Array.isArray(raw) ? raw.filter((v) => v != null).map(String) : [];
  return raw == null || raw === '' ? [] : [String(raw)];
}

/**
 * What deleting `rowId` from `collectionId` does to the rows referencing it.
 *
 * Three outcomes, and they come from ONE pass so a delete never half-applies: a
 * `restrict` violation is known before the first row is touched.
 *
 *   - `remove` — rows that go with it (`onDelete: cascade`, the default).
 *   - `unlink` — rows that stay, with the reference cleared. For an array field
 *     that means the one id dropped from the list, which is the only correct
 *     answer for a bundle: a highlight naming five features must survive losing
 *     one of them.
 *   - `blockedBy` — references declared `restrict`, which refuse the delete.
 *
 * `rowsOf` hands back the rows of one collection, which the caller reads from
 * whichever store it has. Recursion is deliberate — a cascade may reach a
 * collection that is itself referenced — and guarded against a reference cycle,
 * which the manifest does not forbid and would otherwise hang the request.
 */
export function cascadeFor(
  manifest: PluginManifest,
  collectionId: string,
  rowId: string,
  rowsOf: (collection: string) => Row[],
): {
  remove: CascadeStep[];
  unlink: UnlinkStep[];
  blockedBy: { reference: ReferenceDecl; rowIds: string[] }[];
} {
  const remove: CascadeStep[] = [];
  const unlink: UnlinkStep[] = [];
  const blockedBy: { reference: ReferenceDecl; rowIds: string[] }[] = [];
  const seen = new Set<string>([`${collectionId} ${rowId}`]);

  const walk = (collection: string, ids: string[]): void => {
    for (const reference of referencesTo(manifest, collection)) {
      const matching = rowsOf(reference.from).filter((row) =>
        referenceTargets(reference, row.data).some((target) => ids.includes(target)),
      );
      if (!matching.length) continue;
      if (reference.onDelete === 'restrict') {
        blockedBy.push({ reference, rowIds: matching.map((r) => r.id) });
        continue;
      }
      if (reference.onDelete === 'unlink') {
        for (const row of matching) {
          unlink.push({
            collection: reference.from,
            rowId: row.id,
            field: reference.field,
            value: reference.array
              ? referenceTargets(reference, row.data).filter((t) => !ids.includes(t))
              : null,
          });
        }
        // The row survives, so nothing that references IT changes — no recursion.
        continue;
      }
      const fresh = matching.map((r) => r.id).filter((id) => !seen.has(`${reference.from} ${id}`));
      if (!fresh.length) continue;
      for (const id of fresh) seen.add(`${reference.from} ${id}`);
      remove.push({ collection: reference.from, rowIds: fresh });
      walk(reference.from, fresh);
    }
  };

  walk(collectionId, [rowId]);
  return { remove, unlink, blockedBy };
}

/**
 * Reposition `moveId` immediately after `anchor.after` or before `anchor.before`.
 *
 * A copy of the item-order rule rather than a shared import, because the one in
 * the pricing driver throws DB-flavoured errors and lives behind postgres.js.
 * Returns null when the move cannot be resolved, so the caller decides the status
 * code — this module never throws.
 */
export function reorder(ids: string[], moveId: string, anchor: { after?: string; before?: string }): string[] | null {
  if (!ids.includes(moveId)) return null;
  const anchorId = anchor.after ?? anchor.before;
  if (!anchorId || anchorId === moveId || !ids.includes(anchorId)) return null;
  const without = ids.filter((x) => x !== moveId);
  const at = without.indexOf(anchorId);
  without.splice(anchor.after != null ? at + 1 : at, 0, moveId);
  return without;
}

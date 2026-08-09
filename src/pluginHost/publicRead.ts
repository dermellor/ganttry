// What a plugin may publish, and what the host removes before publishing it.
//
// `GET /api/pricing/<id>` is public, unauthenticated and consumed by external
// pages, and it is served by a dedicated endpoint plus a repo method that strips
// the internal lock counters by hand. A third-party plugin cannot have any of
// that, so publishing becomes a declared capability of the generic layer.
//
// Pure, and that matters more here than elsewhere: this is the code that decides
// what leaves the building. A projection with a database call in the middle is one
// nobody can test exhaustively, and the failure mode is not a broken page, it is
// data on somebody else's website.
//
// Three fields are ALWAYS removed, whatever a plugin declares. They are
// host-managed bookkeeping (`version`, `updatedAt`, `updatedBy`), and `updatedBy`
// in particular is an e-mail address: publishing it would leak who works on a
// timeline to anyone who fetches the endpoint. `stripRowVersions` does the first
// of those three by hand today, for one plugin.

import { grants, type PluginManifest } from './manifest.ts';
import type { PluginCollectionData, PluginDataRow } from '../types';

/** A published row: the plugin's own object, projected. No host fields. */
export type PublicRow = { id: string; data: Record<string, unknown> };

/** Published collections, keyed by collection id. */
export type PublicCollections = Record<string, PublicRow[]>;

/**
 * May this plugin publish at all?
 *
 * Both halves are required and neither implies the other: the capability is what
 * the operator granted at install, the declaration is what the plugin asks to
 * expose. A plugin with the capability and no declaration publishes nothing,
 * which is the correct reading of „it may, but it did not ask to".
 */
export function mayPublish(manifest: PluginManifest): boolean {
  return grants(manifest, 'public:read') && (manifest.publicRead?.collections?.length ?? 0) > 0;
}

/** The collection ids this plugin declared as publicly readable. */
export function publicCollections(manifest: PluginManifest): string[] {
  if (!mayPublish(manifest)) return [];
  const declared = manifest.publicRead?.collections ?? [];
  // Intersected with the collections that actually exist, so a stale entry in
  // `publicRead` cannot open a collection the plugin later renamed away.
  const known = new Set((manifest.collections ?? []).map((c) => c.id));
  return declared.filter((c) => known.has(c));
}

/** Is this collection published by this plugin? */
export function isPublicCollection(manifest: PluginManifest, collection: string): boolean {
  return publicCollections(manifest).includes(collection);
}

/**
 * One row, projected for publication.
 *
 * With a field list for the collection, ONLY those fields survive: an allowlist,
 * because a plugin that later stores something extra in a row must not have it
 * published by a projection that only knew what to remove. Without a list, the
 * plugin's whole `data` object is published — which is what „expose this
 * collection" plainly means, and the host fields are removed either way.
 */
export function projectRow(manifest: PluginManifest, collection: string, row: PluginDataRow): PublicRow {
  const allow = manifest.publicRead?.fields?.[collection];
  if (!allow) return { id: row.id, data: { ...row.data } };
  const data: Record<string, unknown> = {};
  for (const field of allow) {
    if (field in row.data) data[field] = row.data[field];
  }
  return { id: row.id, data };
}

/**
 * Everything this plugin publishes, from everything it stored.
 *
 * Undeclared collections are dropped rather than emptied: an empty array would
 * tell a reader the collection exists, and „what exists" is itself something the
 * declaration decides.
 */
export function projectCollections(
  manifest: PluginManifest,
  stored: PluginCollectionData | undefined,
): PublicCollections {
  const out: PublicCollections = {};
  for (const collection of publicCollections(manifest)) {
    out[collection] = (stored?.[collection] ?? []).map((row) => projectRow(manifest, collection, row));
  }
  return out;
}

/**
 * The same declaration applied to a file that is about to be served verbatim.
 *
 * A static `local` deploy materializes the whole timeline under `public/`, so for
 * `db` the question is „what may be served" and here it is **„what has to be
 * removed"**. Same field, two implementations, and this is the one that leaks if
 * it is forgotten.
 *
 * The inversion is total: a collection that is NOT published must be stripped, and
 * a published collection keeps only its projected fields. `publishing: false`
 * strips the plugin's data entirely — otherwise opting out would change nothing
 * about a file that is copied as it is.
 */
/**
 * A whole timeline file, made safe to serve verbatim.
 *
 * The build materializes a local source to `public/<data dir>/sources/<id>.json`,
 * and a static deploy hands that file to anyone who asks. So every plugin's rows
 * in it are published whether or not anybody decided that — which is why the
 * per-timeline opt-in cannot be the only guard on a local source.
 *
 * Fail closed on an unknown plugin: if no manifest is available, its data is
 * dropped. The alternative is publishing rows whose public projection nobody can
 * evaluate, and „we could not check" must not resolve to „ship it".
 *
 * NOTE the one thing this does not touch: `file.pricing`. That is
 * `product-roadmap`'s data in its pre-generic shape, and it has always been
 * materialized as-is. It comes under this rule when that plugin moves onto the
 * generic store (issue #17); until then, a local timeline's pricing model is as
 * public as its file is.
 */
export function stripFileForPublication<T extends { plugins?: { id: string; public?: boolean }[]; pluginData?: Record<string, PluginCollectionData> }>(
  file: T,
  manifestFor: (pluginId: string) => PluginManifest | null,
): T {
  if (!file.pluginData) return file;
  const out: Record<string, PluginCollectionData> = {};
  for (const [pluginId, collections] of Object.entries(file.pluginData)) {
    const manifest = manifestFor(pluginId);
    if (!manifest) continue;
    const publishing = (file.plugins ?? []).find((p) => p.id === pluginId)?.public === true;
    const kept = stripForMaterialization(manifest, collections, publishing);
    if (kept) out[pluginId] = kept;
  }
  const next = { ...file };
  if (Object.keys(out).length) next.pluginData = out;
  else delete next.pluginData;
  return next;
}

export function stripForMaterialization(
  manifest: PluginManifest,
  stored: PluginCollectionData | undefined,
  publishing: boolean,
): PluginCollectionData | undefined {
  if (!stored) return undefined;
  if (!publishing) return undefined;
  const keep = new Set(publicCollections(manifest));
  const out: PluginCollectionData = {};
  for (const [collection, rows] of Object.entries(stored)) {
    if (!keep.has(collection)) continue;
    out[collection] = rows.map((row) => {
      const projected = projectRow(manifest, collection, row);
      // Host fields go too: the materialized copy is what a static deploy serves,
      // so `updatedBy` in it is the same leak it would be over the API.
      return { id: projected.id, data: projected.data } as PluginDataRow;
    });
  }
  return Object.keys(out).length ? out : undefined;
}

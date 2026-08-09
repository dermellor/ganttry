// The generic plugin-data endpoints, and the rules enforced in front of them.
//
// This sits ABOVE the repo on purpose. A `plugin_data` table, a JSON file and a
// Markdown directory store rows differently, but they must be held to the same
// declarations — shape, composite identity, references with cascade, ordering —
// so those checks run once here rather than three times below. Every client
// (browser, MCP, a third-party integration) then gets the same answers, because
// they all arrive through this dispatcher.
//
// Nothing here names a plugin. What a plugin may store comes from its manifest,
// which the runtime supplies through a lookup; today that lookup reads the
// in-tree manifests, and issue #13 swaps it for the instance's install registry
// without this file changing.

import type { PluginData, PluginDataRow } from '../../src/types';
import type { PluginManifest } from '../../src/pluginHost/manifest';
import { grants } from '../../src/pluginHost/manifest.ts';
import {
  cascadeFor,
  collectionOf,
  missingKeyFields,
  referenceTargets,
  referencesFrom,
  reorder,
  rowIdFor,
  rowProblems,
} from '../../src/pluginHost/dataStore.ts';
import { ConflictError, NotFoundError, ValidationError, type TimelineRepo } from './repo.ts';

/** Where the dispatcher looks up what a plugin declared. Null = not installed. */
export type ManifestSource = (pluginId: string) => PluginManifest | null;

export type PluginPath = { pluginId: string; collection?: string; rowId?: string };

export type PluginApiRequest = {
  method: string;
  timelineId: string;
  path: PluginPath;
  body?: unknown;
  ifMatch?: number;
  updatedBy?: string;
};

export type PluginApiResult = { status: number; json: unknown };

const ok = (json: unknown, status = 200): PluginApiResult => ({ status, json });
const err = (status: number, error: string, extra?: Record<string, unknown>): PluginApiResult => ({
  status,
  json: { error, ...extra },
});

/**
 * The path segment that means „reorder this collection" instead of „this row".
 *
 * It shadows nothing: a row whose id happens to be `move` is still created by
 * POSTing to the collection, and still addressed by PATCH and DELETE on
 * `…/<collection>/move`. Only POST to that path is the reorder.
 */
export const MOVE_SEGMENT = 'move';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read every collection of one plugin once, and answer per collection from that.
 *
 * Reference checks and cascades both ask about collections other than the one
 * being written, and asking the store separately each time turns one delete into
 * a query per declared reference.
 */
function collectionReader(repo: TimelineRepo, timelineId: string, pluginId: string) {
  let all: PluginData | null = null;
  return {
    async load(): Promise<void> {
      if (all == null) all = await repo.listPluginData(timelineId, [pluginId]);
    },
    rows(collection: string): PluginDataRow[] {
      return all?.[pluginId]?.[collection] ?? [];
    },
  };
}

/**
 * Every declared reference this row holds that points at nothing.
 *
 * The host has to check this because the database no longer can: a plugin ships
 * no DDL, so there is no foreign key. Without the check a cell could name a tier
 * that does not exist, and the dangling row would only surface as a hole in
 * somebody's matrix months later.
 */
async function danglingReferences(
  manifest: PluginManifest,
  collection: string,
  data: Record<string, unknown>,
  reader: ReturnType<typeof collectionReader>,
): Promise<string[]> {
  const references = referencesFrom(manifest, collection);
  if (!references.length) return [];
  await reader.load();
  const problems: string[] = [];
  for (const reference of references) {
    // An unset reference is not a dangling one, and an array reference is checked
    // entry by entry — one bad id in a bundle of five has to name itself.
    for (const target of referenceTargets(reference, data)) {
      if (!reader.rows(reference.to).some((row) => row.id === target)) {
        problems.push(`${reference.field} „${target}" is not a row of "${reference.to}"`);
      }
    }
  }
  return problems;
}

/**
 * Serve one request under `/api/source/<id>/plugin/<pluginId>/…`.
 *
 * Refusals are fail-closed and specific, because the alternative — a write that
 * lands somewhere unexpected — is the failure that cannot be traced back: a
 * plugin the instance has not installed gets 404, one that never asked for
 * `data:own` gets 403, and a collection its manifest does not declare gets 404
 * rather than a new collection created by typo.
 */
export async function handlePluginApi(
  repo: TimelineRepo,
  manifests: ManifestSource,
  req: PluginApiRequest,
): Promise<PluginApiResult> {
  const { method, timelineId, path } = req;
  const manifest = manifests(path.pluginId);
  if (!manifest) return err(404, 'unknown_plugin', { message: `no plugin „${path.pluginId}" is installed` });
  if (!grants(manifest, 'data:own')) {
    return err(403, 'capability_missing', {
      message: `plugin „${path.pluginId}" did not declare the "data:own" capability`,
    });
  }
  if (!path.collection) return err(400, 'collection required');
  const decl = collectionOf(manifest, path.collection);
  if (!decl) {
    return err(404, 'unknown_collection', {
      message: `plugin „${path.pluginId}" declares no collection „${path.collection}"`,
    });
  }

  const reader = collectionReader(repo, timelineId, path.pluginId);
  const body = req.body;

  try {
    // ---- list ---------------------------------------------------------------
    if (method === 'GET' && !path.rowId) {
      return ok({ rows: await repo.listPluginRows(timelineId, path.pluginId, path.collection) });
    }

    // ---- reorder ------------------------------------------------------------
    if (method === 'POST' && path.rowId === MOVE_SEGMENT) {
      if (!decl.ordered) {
        return err(400, 'not_ordered', {
          message: `collection „${path.collection}" is not declared ordered, so its rows have no position to move`,
        });
      }
      const anchor = (body ?? {}) as { id?: string; after?: string; before?: string };
      if (!anchor.id) return err(400, 'move needs id');
      if (!anchor.after && !anchor.before) return err(400, 'move needs after or before');
      const current = await repo.listPluginRows(timelineId, path.pluginId, path.collection);
      const next = reorder(current.map((r) => r.id), anchor.id, anchor);
      if (!next) return err(404, 'not found', { message: 'the row or its anchor is not in this collection' });
      await repo.orderPluginRows(timelineId, path.pluginId, path.collection, next, req.updatedBy);
      return ok({ ok: true, order: next });
    }

    // ---- create / replace ---------------------------------------------------
    if (method === 'POST' || (method === 'PUT' && !path.rowId)) {
      if (!isPlainObject(body)) return err(400, 'expected an object with a "data" object');
      const data = isPlainObject(body.data) ? body.data : null;
      if (!data) return err(400, 'expected an object with a "data" object');

      const missing = missingKeyFields(decl, data);
      if (missing.length) {
        return err(400, 'invalid_request', {
          message: `collection „${path.collection}" is keyed by ${decl.keyFields?.join(' + ')}; missing ${missing.join(', ')}`,
        });
      }
      const rowId = rowIdFor(decl, data, typeof body.id === 'string' ? body.id : undefined);
      if (!rowId) return err(400, 'invalid_request', { message: 'row needs an id' });

      const problems = [
        ...rowProblems(decl, data),
        ...(await danglingReferences(manifest, path.collection, data, reader)),
      ];
      if (problems.length) return err(400, 'invalid_request', { message: problems.join('; ') });

      const row = await repo.putPluginRow(
        timelineId,
        path.pluginId,
        path.collection,
        { id: rowId, data },
        req.ifMatch,
        req.updatedBy,
      );
      return ok(row, 201);
    }

    if (!path.rowId) return err(405, 'method not allowed');

    // ---- merge --------------------------------------------------------------
    if (method === 'PATCH') {
      if (!isPlainObject(body) || !isPlainObject(body.data)) {
        return err(400, 'expected an object with a "data" object');
      }
      const patch = body.data;
      await reader.load();
      const stored = reader.rows(path.collection).find((r) => r.id === path.rowId);
      if (!stored) return err(404, 'not found');

      // The shape is checked against the RESULT of the merge, not the patch: a
      // patch is legal in isolation and can still leave the row invalid, and a
      // row that fails its own schema is exactly what the declaration exists to
      // keep out of the store.
      const merged: Record<string, unknown> = { ...stored.data };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      // A composite key is identity: changing one of its fields would silently
      // make this a different row, leaving the original behind under its old id.
      const keyChange = (decl.keyFields ?? []).filter((k) => k in patch);
      if (keyChange.length) {
        return err(400, 'invalid_request', {
          message: `${keyChange.join(', ')} form the identity of „${path.collection}"; delete the row and write the new one instead`,
        });
      }
      const problems = [
        ...rowProblems(decl, merged),
        ...(await danglingReferences(manifest, path.collection, merged, reader)),
      ];
      if (problems.length) return err(400, 'invalid_request', { message: problems.join('; ') });

      return ok(
        await repo.patchPluginRow(
          timelineId,
          path.pluginId,
          path.collection,
          path.rowId,
          patch,
          req.ifMatch,
          req.updatedBy,
        ),
      );
    }

    // ---- delete, with the declared cascade ----------------------------------
    if (method === 'DELETE') {
      await reader.load();
      const { remove, unlink, blockedBy } = cascadeFor(manifest, path.collection, path.rowId, (c) => reader.rows(c));
      if (blockedBy.length) {
        const detail = blockedBy
          .map((b) => `${b.reference.from} (${b.rowIds.length} row${b.rowIds.length === 1 ? '' : 's'})`)
          .join(', ');
        return err(409, 'reference_restrict', { message: `still referenced by ${detail}` });
      }
      // Unlinks first: they are edits to rows that SURVIVE, so doing them before
      // the deletes means an interrupted request never leaves a surviving row
      // pointing at something that is already gone.
      for (const step of unlink) {
        await repo.patchPluginRow(
          timelineId,
          path.pluginId,
          step.collection,
          step.rowId,
          { [step.field]: step.value },
          undefined,
          req.updatedBy,
        );
      }
      // Then children before the parent, so a half-applied delete leaves a parent
      // with fewer children rather than orphans pointing at nothing.
      for (const step of remove) {
        for (const id of step.rowIds) {
          await repo.deletePluginRow(timelineId, path.pluginId, step.collection, id);
        }
      }
      await repo.deletePluginRow(timelineId, path.pluginId, path.collection, path.rowId);
      return ok({ ok: true, cascaded: remove, unlinked: unlink });
    }

    return err(405, 'method not allowed');
  } catch (e) {
    if (e instanceof ConflictError) return err(409, 'version_conflict', { message: e.message });
    if (e instanceof NotFoundError) return err(404, 'not found');
    if (e instanceof ValidationError) return err(400, 'invalid_request', { message: e.message });
    throw e; // the caller's catch maps NotSupportedError and the 500 case
  }
}

/**
 * Remove every trace of a plugin: its rows, and the item `metadata` keys it
 * declared as its own. `timelineId` scopes it to one timeline; omitting it is
 * the instance-wide uninstall.
 *
 * The second half is the one that is easy to forget and impossible to clean up
 * later: without it a plugin's keys stay on every item that ever carried one,
 * where they surface as unexplained entries in the raw metadata box and no
 * longer have anything that knows what they meant.
 *
 * Deliberately not an endpoint here. Uninstalling is an instance-level act with
 * its own permission question and its own confirmation, both of which belong to
 * the install registry (#13); this is the operation that issue wires up.
 */
export async function purgePlugin(
  repo: TimelineRepo,
  manifest: PluginManifest,
  timelineId?: string | null,
): Promise<{ metadataKeysStrippedFrom: number }> {
  await repo.purgePluginData(manifest.id, timelineId ?? null);
  const keys = manifest.metadataKeys ?? [];
  const stripped = keys.length ? await repo.purgeItemMetadata(keys, timelineId ?? null) : 0;
  return { metadataKeysStrippedFrom: stripped };
}

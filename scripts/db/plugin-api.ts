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
// which arrives through a lookup over the instance's install registry
// (./plugin-manifests.ts).
//
// The file carries three levels of the same subject, which is why they are
// together: the rows a plugin owns (`handlePluginApi`), whether a plugin is on
// for one timeline (`handlePluginLifecycle`), and whether the instance has it at
// all (`handlePluginsApi`). Splitting them would put the „is it installed" check
// in one file and the „may it write" check in another, and those two answers have
// to stay consistent.

import type { InstalledPlugin, PluginData, PluginDataRow } from '../../src/types';
import type { PluginManifest } from '../../src/pluginHost/manifest';
import { grants, validateManifest } from '../../src/pluginHost/manifest.ts';
import { validateRow } from '../../src/pluginHost/dataSchema.ts';
import { pluginStatus } from '../../src/pluginHost/installed.ts';
import { mayPublish, projectCollections, publicCollections } from '../../src/pluginHost/publicRead.ts';
import { originOf } from '../../src/pluginHost/csp.ts';
import { installedPluginStatuses, makeManifestSource, type ManifestSource } from './plugin-manifests.ts';
import { isOperator, operatorRefusal, type Caller } from './operator.ts';
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
import { ConflictError, NotFoundError, NotSupportedError, ValidationError, type TimelineRepo } from './repo.ts';

export type { ManifestSource } from './plugin-manifests.ts';

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
  const installed = await manifests(path.pluginId);
  if (!installed) return err(404, 'unknown_plugin', { message: `no plugin „${path.pluginId}" is installed` });
  const { manifest } = installed;
  if (!grants(manifest, 'data:own')) {
    return err(403, 'capability_missing', {
      message: `plugin „${path.pluginId}" did not declare the "data:own" capability`,
    });
  }
  // Switched off instance-wide: reads stay open so the data can still be
  // inspected — before an uninstall, that is exactly when someone looks at it —
  // but writes stop, because „off" has to mean something. Refusing the read too
  // would leave an operator deciding about data they cannot see.
  if (!installed.enabled && method !== 'GET') {
    return err(403, 'plugin_disabled', {
      message: `plugin „${path.pluginId}" is switched off for this instance; its data is readable but not writable`,
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
 * Turning one plugin on or off for ONE timeline.
 *
 * The path this closes is the one that only existed as „now run some SQL": until
 * now, enabling a single plugin without rewriting the whole timeline meant direct
 * SQL or a bulk `replace_timeline`, and a bulk write is exactly what loses a
 * concurrent edit. It is documented as an open follow-up in docs/database.md.
 *
 *   GET    → is it enabled here, and with what config
 *   PUT    → enable, or replace the config
 *   DELETE → disable, keeping every row the plugin owns
 *
 * A plugin has to be INSTALLED before it can be enabled anywhere, which is why an
 * unknown id is a 404 rather than a row quietly created for a plugin nothing can
 * load.
 */
export async function handlePluginLifecycle(
  repo: TimelineRepo,
  manifests: ManifestSource,
  req: PluginApiRequest,
): Promise<PluginApiResult> {
  const { method, timelineId, path } = req;
  const installed = await manifests(path.pluginId);
  if (!installed) {
    return err(404, 'unknown_plugin', {
      message: `no plugin „${path.pluginId}" is installed on this instance; install it before enabling it on a timeline`,
    });
  }

  try {
    if (method === 'GET') {
      // `getTimelinePlugin` rather than `getTimeline`: the latter loads every item
      // to answer a question about one row.
      const entry = await repo.getTimelinePlugin(timelineId, path.pluginId);
      return ok({
        pluginId: path.pluginId,
        installed: true,
        instanceEnabled: installed.enabled,
        enabled: !!entry,
        config: entry?.config ?? {},
        public: entry?.public ?? false,
      });
    }

    if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
      if (!installed.enabled) {
        return err(403, 'plugin_disabled', {
          message: `plugin „${path.pluginId}" is switched off for this instance; switch it on before enabling it on a timeline`,
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Accept either `{ config: {...} }` or the bare bag. A caller that sends the
      // config directly is not wrong, and a 400 there would be pedantry.
      const config = (isPlainObject(body.config) ? body.config : body) as Record<string, unknown>;
      const problems = configProblems(installed.manifest, config);
      if (problems.length) {
        return err(400, 'invalid_config', { message: problems.join('; ') });
      }
      // Publishing is its own decision and is only touched when the caller says
      // so. Refused outright when the plugin declares nothing public: silently
      // storing a flag that can never have an effect invites somebody to believe
      // their data is being served.
      const wantsPublic = typeof body.public === 'boolean' ? body.public : undefined;
      if (wantsPublic === true && !mayPublish(installed.manifest)) {
        return err(400, 'not_publishable', {
          message: `plugin „${path.pluginId}" declares no publicRead collections, so there is nothing to publish`,
        });
      }
      await repo.setTimelinePlugin(timelineId, path.pluginId, config, { public: wantsPublic });
      const stored = await repo.getTimelinePlugin(timelineId, path.pluginId);
      return ok({
        ok: true,
        pluginId: path.pluginId,
        enabled: true,
        config,
        public: stored?.public ?? false,
      });
    }

    if (method === 'DELETE') {
      // Deliberately not idempotency-checked: „it was already off" and „it is off
      // now" are the same state, and a 404 for the first would make a retry look
      // like a failure.
      await repo.removeTimelinePlugin(timelineId, path.pluginId);
      return ok({ ok: true, pluginId: path.pluginId, enabled: false });
    }

    return err(405, 'method not allowed');
  } catch (e) {
    if (e instanceof ConflictError) return err(409, 'version_conflict', { message: e.message });
    if (e instanceof NotFoundError) return err(404, 'not found');
    if (e instanceof ValidationError) return err(400, 'invalid_request', { message: e.message });
    throw e;
  }
}

/**
 * Problems with a plugin's config bag, against the `configSchema` its manifest
 * declares.
 *
 * Checked at the API rather than left to the plugin, because the alternative is a
 * bad config failing inside a render — where it reads as a broken plugin, and the
 * person who typed the config is not the person looking at the stack trace.
 */
export function configProblems(manifest: PluginManifest, config: unknown): string[] {
  if (manifest.configSchema == null) return [];
  return validateRow(manifest.configSchema, config ?? {}, 'config');
}

// ---------------------------------------------------------------------------
// Public, unauthenticated reads: /api/public/plugin/<pluginId>/<timelineId>
// ---------------------------------------------------------------------------

export type PublicApiRequest = {
  method: string;
  pluginId: string;
  timelineId: string;
  /** Narrow to one collection. A query parameter, not a path segment — see below. */
  collection?: string;
};

/**
 * Serve a plugin's declared public collections, without authentication.
 *
 * Three gates, all of which must pass, and every failure answers **404**:
 *
 *   1. the instance has the plugin installed and it is switched on;
 *   2. the plugin declares `publicRead` and was granted `public:read`;
 *   3. THIS timeline consented to publishing that plugin's data.
 *
 * One status code for all of them on purpose. This endpoint is reachable by
 * anyone, so distinguishing „no such timeline" from „exists but is not published"
 * would turn it into a probe for which timelines exist — and the id is often a
 * customer name.
 *
 * The path is `…/<pluginId>/<timelineId>` with the collection as a QUERY
 * parameter rather than a trailing segment, which is where this departs from the
 * sketch in the issue. A timeline id may contain slashes (`acme/foo`), so
 * `…/acme/foo/features` is genuinely ambiguous: it could be the timeline
 * `acme/foo` narrowed to `features`, or the timeline `acme/foo/features` in full.
 * A query parameter has no such reading.
 */
export async function handlePublicPluginApi(
  repo: TimelineRepo,
  manifests: ManifestSource,
  req: PublicApiRequest,
): Promise<PluginApiResult> {
  if (req.method !== 'GET') return err(405, 'method not allowed');

  const notFound = () => err(404, 'not found');

  const installed = await manifests(req.pluginId);
  if (!installed || !installed.enabled) return notFound();
  const { manifest } = installed;
  if (!mayPublish(manifest)) return notFound();

  const entry = await repo.getTimelinePlugin(req.timelineId, req.pluginId);
  // Fail closed: not enabled here, or enabled without consent, both answer the
  // same as „no such thing".
  if (!entry || !entry.public) return notFound();

  if (req.collection && !publicCollections(manifest).includes(req.collection)) return notFound();

  const stored = await repo.listPluginData(req.timelineId, [req.pluginId]);
  const collections = projectCollections(manifest, stored[req.pluginId]);
  const narrowed = req.collection ? { [req.collection]: collections[req.collection] ?? [] } : collections;

  return ok({
    id: req.timelineId,
    ...(entry.timelineName ? { name: entry.timelineName } : {}),
    plugin: req.pluginId,
    // The plugin's own config travels with it: for product-roadmap that is the
    // ordered version list, which the payload is unreadable without. It is
    // operator-authored configuration rather than anybody's content.
    config: entry.config,
    collections: narrowed,
  });
}

// ---------------------------------------------------------------------------
// The instance's registry: /api/plugins
// ---------------------------------------------------------------------------

export type PluginsApiRequest = {
  method: string;
  /** Present for the single-plugin operations. */
  pluginId?: string;
  body?: unknown;
  /** Query parameters, which is where a DELETE carries its confirmation. */
  params?: Record<string, string>;
  caller: Caller;
  /** The configured operator list, read from the env by the runtime glue. */
  operators: string[];
  /**
   * The origins this instance's Content-Security-Policy allows a plugin artifact
   * to be fetched from (`PLUGIN_ALLOWED_ORIGINS`), read from the env by the
   * runtime glue like `operators`.
   *
   * Undefined means „the runtime did not say", and the check below is skipped —
   * a caller that cannot supply the list must not have installs refused by a
   * rule it cannot see.
   */
  allowedOrigins?: string[];
};

/**
 * List, install, switch off and uninstall plugins for the whole instance.
 *
 * Reading is open to anyone past the auth gate, because it is what the interface
 * shows: which plugins exist, which are off, which the host outgrew. Every WRITE
 * is operator-only — see ./operator.ts for why that cannot be the same permission
 * as editing a timeline.
 */
export async function handlePluginsApi(
  repo: TimelineRepo,
  req: PluginsApiRequest,
): Promise<PluginApiResult> {
  const { method, pluginId } = req;

  if (method === 'GET' && !pluginId) {
    return ok({ plugins: await installedPluginStatuses(repo) });
  }

  const mayWrite = isOperator(req.caller, req.operators);
  if (!mayWrite) return err(403, 'forbidden', { message: operatorRefusal(req.operators) });

  try {
    // ---- install / re-install ----------------------------------------------
    if (method === 'POST' && !pluginId) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = isPlainObject(body.manifest) ? body.manifest : null;
      if (!raw) return err(400, 'invalid_request', { message: 'install needs a "manifest" object' });

      // Validated against THIS host before anything is stored. An artifact whose
      // contract range the host cannot satisfy is refused at install rather than
      // written and then refused at every boot — the second reads as a broken
      // plugin, and the reason is a scroll away from where it is noticed.
      const result = validateManifest(raw);
      if (!result.ok) {
        return err(400, 'invalid_manifest', { message: result.problems.join('; ') });
      }
      const manifest = result.manifest;

      const artifact = isPlainObject(body.artifact) ? body.artifact : {};
      const kind = typeof artifact.kind === 'string' ? artifact.kind : 'builtin';
      if (!(['builtin', 'url', 'package', 'vendored'] as string[]).includes(kind)) {
        return err(400, 'invalid_request', { message: `unknown artifact kind "${kind}"` });
      }
      // An artifact that is fetched has to say from where, and a remote one has to
      // be pinned: without an integrity hash „version 1.2.0" names whatever that
      // URL serves today, which is not a version at all.
      if (kind !== 'builtin' && typeof artifact.source !== 'string') {
        return err(400, 'invalid_request', { message: `artifact kind "${kind}" needs a source` });
      }
      if (kind === 'url' && typeof artifact.integrity !== 'string') {
        return err(400, 'invalid_request', {
          message: 'a url artifact needs an integrity hash, or the pinned version means nothing',
        });
      }
      // **Refused at install, not discovered in a browser console.** The
      // Content-Security-Policy decides which origins an artifact may be fetched
      // from, and it is deployment configuration: installing from an origin the
      // policy does not allow stores a row that is guaranteed never to load, and
      // the only symptom is a CSP violation in the console of whoever opens the
      // app next. The registry knows the URL and the host knows its own policy,
      // so the two questions are asked in the right order here.
      //
      // A vendored artifact is same-origin by construction and a builtin is not
      // fetched at all, so neither is checked.
      if ((kind === 'url' || kind === 'package') && req.allowedOrigins) {
        const origin = originOf(artifact.source as string);
        if (!origin) {
          return err(400, 'invalid_request', { message: `„${artifact.source}" is not an absolute URL` });
        }
        if (!req.allowedOrigins.includes(origin)) {
          return err(400, 'origin_not_allowed', {
            message:
              `this instance does not allow plugin artifacts from ${origin}. Add it to ` +
              'PLUGIN_ALLOWED_ORIGINS and redeploy, then install again — the policy is a response ' +
              'header, so it cannot be changed from here.',
          });
        }
      }

      // Capabilities are GRANTED, not claimed: the stored list is what the
      // operator allowed, and a plugin that later declares more does not get more.
      // Without an explicit grant the manifest's own list is taken as approved,
      // which is the same thing the install dialog will show.
      const granted = Array.isArray(body.capabilities)
        ? body.capabilities.filter((c): c is string => typeof c === 'string')
        : [...(manifest.capabilities ?? [])];
      const overreach = (manifest.capabilities ?? []).filter((c) => !granted.includes(c));
      if (overreach.length) {
        return err(400, 'capability_missing', {
          message:
            `plugin „${manifest.id}" declares ${overreach.join(', ')}, which this install does not grant. ` +
            'Grant them or install a plugin that does not need them — a plugin running with less than it ' +
            'declared fails somewhere far from the cause.',
        });
      }

      const stored = await repo.installPlugin(
        {
          id: manifest.id,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          artifact: {
            kind: kind as InstalledPlugin['artifact']['kind'],
            ...(typeof artifact.source === 'string' ? { source: artifact.source } : {}),
            ...(typeof artifact.integrity === 'string' ? { integrity: artifact.integrity } : {}),
          },
          capabilities: granted,
          manifest: manifest as unknown as Record<string, unknown>,
          enabled: body.enabled !== false,
        },
        req.caller.email ?? (req.caller.mcp ? 'mcp' : undefined),
      );
      return ok(pluginStatus(stored), 201);
    }

    if (!pluginId) return err(405, 'method not allowed');

    // ---- the instance-level off switch -------------------------------------
    if (method === 'PATCH' || method === 'PUT') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.enabled !== 'boolean') {
        return err(400, 'invalid_request', { message: 'send { "enabled": true | false }' });
      }
      await repo.setPluginInstalledEnabled(
        pluginId,
        body.enabled,
        req.caller.email ?? (req.caller.mcp ? 'mcp' : undefined),
      );
      return ok({ ok: true, pluginId, enabled: body.enabled });
    }

    // ---- uninstall ---------------------------------------------------------
    if (method === 'DELETE') {
      // The confirmation is the plugin's own id, echoed back. A boolean flag is
      // too easy to send by accident from a script iterating a list, and this is
      // the one operation that can delete data nothing else can recover.
      const confirm = req.params?.confirm;
      if (confirm !== pluginId) {
        return err(400, 'confirmation_required', {
          message: `uninstalling removes „${pluginId}" from this instance; repeat its id as ?confirm=${pluginId}`,
        });
      }
      // Purging is opt-IN. The default keeps the rows, so an uninstall meant as
      // „stop running this" cannot silently discard a pricing model; an operator
      // who wants it gone says so.
      const purgeData = req.params?.purgeData === 'true';
      const record = await makeManifestSource(repo)(pluginId);
      let purged: { metadataKeysStrippedFrom: number } | null = null;
      if (purgeData && record) purged = await purgePlugin(repo, record.manifest);
      await repo.removeInstalledPlugin(pluginId);
      return ok({
        ok: true,
        pluginId,
        dataPurged: purgeData,
        ...(purged ? { metadataKeysStrippedFrom: purged.metadataKeysStrippedFrom } : {}),
        ...(purgeData
          ? {}
          : { note: 'the rows this plugin owned were kept; re-installing it makes them visible again' }),
      });
    }

    return err(405, 'method not allowed');
  } catch (e) {
    if (e instanceof NotFoundError) return err(404, 'not found', { message: `plugin „${pluginId}" is not installed` });
    if (e instanceof ValidationError) return err(400, 'invalid_request', { message: e.message });
    if (e instanceof NotSupportedError) return err(501, 'not_supported', { message: e.message });
    return err(500, 'server_error', { message: e instanceof Error ? e.message : String(e) });
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

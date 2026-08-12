// Runtime-agnostic dispatcher for the timeline API. The Node Vite middleware
// and the Deno edge function each parse their native request into ApiRequest,
// call handleTimelineApi(), and write the ApiResult back. All storage logic and
// the item-level optimistic-locking semantics live here — one implementation.

import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SourceCapabilities,
  SourceLive,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
} from '../../src/types';
import {
  DEFAULT_ROLE,
  normalizeMemberRole,
  normalizeMemberStatus,
  wouldOrphanInstance,
  type MemberRole,
  type MemberStatus,
} from '../../src/access.ts';
import {
  ConflictError,
  NotFoundError,
  NotSupportedError,
  ValidationError,
  type TimelineGroupDecl,
  type TimelineRepo,
} from './repo.ts';
// Both driver factories are imported for their runtime value, but each impl
// module imports ITS client only as a type (`import type { Sql }` /
// `import type { SupabaseClient }`), so pulling them in here drags NO concrete
// driver into a bundle — the drivers arrive through the glue that constructs a
// real handle (Node factories / edge esm.sh imports). This keeps both adapters
// resolvable from one `resolveAdapter` while the Deno edge bundle stays clean.
import { nextItemId } from '../../src/itemId.ts';
import { makePostgresRepo } from './timeline-repo.ts';
import { makeSupabaseRepo } from './timeline-repo-supabase.ts';
import { handlePluginApi, handlePluginLifecycle, type PluginPath } from './plugin-api.ts';
import { handleSavedViewApi, withVisibleSavedViews } from './saved-views-api.ts';
import type { SavedViewCaller } from '../../src/savedViews.ts';
import { makeManifestSource, type ManifestSource } from './plugin-manifests.ts';

/** Sub-resource kinds addressable under /api/source/<id>/. */
/**
 * The sub-resources under /api/source/<id>/. One list, used both as the type and
 * as the runtime matcher in parseSourcePath — those used to be two hand-kept
 * copies of the same names. It is exported so the OpenAPI coverage test can
 * assert the spec documents every one of them.
 */
export const SUB_KINDS = [
  'item',
  'group',
  'phases',
  'watermark',
  'plugin',
  'saved-view',
] as const;

export type SubKind = (typeof SUB_KINDS)[number];

export type ApiRequest = {
  method: string;
  /** timeline id, e.g. "acme/foo"; empty string means the collection (/api/sources) */
  id: string;
  /** sub-resource: item / group / phases / watermark / a plugin's rows, with optional child id */
  sub?: { kind: SubKind; childId?: string; plugin?: PluginPath };
  body?: unknown;
  /** optimistic-lock version (from If-Match header or body.version) */
  ifMatch?: number;
  /** attribution for updated_by */
  updatedBy?: string;
  /**
   * Who is asking, as the runtime's authorization step already resolved them.
   *
   * Every other sub-resource answers the same thing to everybody past the gate, so
   * the dispatcher never needed this. A saved view does not: which ones exist is a
   * property of the caller. Resolved once in `authorize` and passed down rather
   * than looked up again here, because a second member read per request would be a
   * second chance for the two answers to differ.
   *
   * Absent means „no identity and no role model", which is what an unauthenticated
   * runtime and an instance with access control off both are: everybody past the
   * gate may do everything, which is the behaviour those instances already have.
   */
  caller?: SavedViewCaller;
  /**
   * What a plugin declared, so the dispatcher can enforce it without executing
   * the plugin. Injected rather than imported: today it reads the manifests this
   * build shipped with, and #13 points it at the instance's install registry.
   * Defaults to the built-in set, so every existing caller keeps working.
   */
  manifests?: ManifestSource;
};

export type ApiResult = { status: number; json: unknown };

const ok = (json: unknown, status = 200): ApiResult => ({ status, json });
const err = (status: number, error: string, extra?: Record<string, unknown>): ApiResult => ({
  status,
  json: { error, ...extra },
});

/**
 * `GET /api/users` — the user directory an item's Owner links to.
 *
 * Serving the read also **registers the caller** (`repo.touchUser`), which is
 * what keeps the directory filled without a seeding step or a membership list to
 * maintain: the client asks this once per load, so anyone who opens the app is
 * assignable from then on. `/api/me` would be the more obvious registration
 * point, but it deliberately has no DB wiring (a second edge bundle carrying a
 * driver, for one upsert), and this endpoint needs the connection anyway.
 *
 * `caller` is the identity the runtime already resolved for `updated_by`. Only an
 * address-shaped one registers — the same filter the 0015 backfill applies, and
 * for the same reason: `updated_by` also carries non-person actors (`mcp`) and
 * the dev server's placeholder `local`, and a local `npm run dev` points at the
 * live DB, so an unfiltered upsert would put "local" in the real directory. To
 * test the picker locally, set an address-shaped dev identity:
 *   document.cookie = 'dev_user=alice@example.com'; location.reload()
 */
export async function handleUsersApi(
  repo: TimelineRepo,
  req: { method: string; caller?: { email: string; name?: string | null } },
): Promise<ApiResult> {
  if (req.method !== 'GET') return err(405, 'method not allowed');
  const email = req.caller?.email?.trim() ?? '';
  if (email.includes('@')) {
    // Registration is a side effect, the read is the job — so a failing upsert
    // must not cost the caller the directory. It would otherwise blank every
    // owner picker over something the reader cannot act on.
    try {
      await repo.touchUser(email, req.caller?.name ?? null);
    } catch {
      // ignore: the caller just won't be assignable until their next visit
    }
  }
  try {
    return ok({ users: await repo.listUsers() });
  } catch (e) {
    return err(500, 'server_error', { message: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Membership administration (/api/members)
// ---------------------------------------------------------------------------
//
// Its own path rather than more methods on /api/users, because the two answer
// different questions about the same rows. /api/users is the OWNER PICKER's
// directory: every active member may read it, and it carries a name and an
// address. /api/members is administration: it needs `manage`, and it carries
// roles, statuses and invitation state. Sharing a path would make one `GET`
// mean two things depending on who asked, and the authorization rule would have
// to inspect a query string to tell them apart.
//
// There is no DELETE, and that is the model rather than an omission: removing
// somebody is `status: 'removed'`, because an item's `metadata.owner` stores an
// address and a deleted row would leave attributions pointing at nothing.
//
// The address travels in the BODY, not the path. An e-mail carries `@` and dots,
// and the same reasoning already keeps dotted ids out of the pricing matrix's
// paths ("Body carries the coordinates so no dotted ids ever land in the path").

/** How long an invitation stands unless the caller says otherwise. */
const INVITE_TTL_DAYS = 14;

/**
 * A fresh invitation token and its hash.
 *
 * Web Crypto rather than `node:crypto`, because this module is bundled for the
 * Deno edge as well. Only the hash is ever stored, so a database read cannot
 * yield a usable invitation; the plain token is returned to the admin ONCE, in
 * the response that created it.
 */
async function mintInviteToken(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
  );
  const hash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { token, hash };
}

/**
 * Would this change leave the instance with no active admin?
 *
 * Checked before every demotion and every status change, because an instance
 * without one cannot invite, cannot restore anybody, and is recoverable only
 * through the bootstrap environment variable. Cheaper to refuse than to explain.
 */
async function orphansInstance(
  repo: TimelineRepo,
  email: string,
  next: { role?: MemberRole; status?: MemberStatus },
): Promise<boolean> {
  const all = await repo.listMembers();
  const others = all.filter((m) => m.email.toLowerCase() !== email.toLowerCase());
  const changed = { role: next.role ?? 'viewer', status: next.status ?? 'removed' };
  // The row being changed counts under its NEW values: promoting somebody to
  // admin in the same call that demotes the last one is not an orphaning.
  return wouldOrphanInstance([...others, changed]);
}

/** `GET|POST|PATCH /api/members` — the administration surface. Needs `manage`. */
export async function handleMembersApi(
  repo: TimelineRepo,
  req: { method: string; caller?: { email: string; name?: string | null }; body?: unknown },
): Promise<ApiResult> {
  if (req.method === 'GET') {
    try {
      return ok({ members: await repo.listMembers() });
    } catch (e) {
      return err(500, 'server_error', { message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (req.method !== 'POST' && req.method !== 'PATCH') return err(405, 'method not allowed');

  const body = (req.body ?? {}) as {
    email?: string;
    role?: string;
    status?: string;
    resend?: boolean;
    expiresInDays?: number;
  };
  const email = (body.email ?? '').trim().toLowerCase();
  // Shape only. Proving an address belongs to somebody is the identity
  // provider's job at sign-in, and a stricter pattern here would reject valid
  // addresses without buying any security.
  if (!email || !email.includes('@')) return err(400, 'invalid_request', { message: 'email required' });

  try {
    if (req.method === 'POST') {
      const role = normalizeMemberRole(body.role) ?? DEFAULT_ROLE;
      const { token, hash } = await mintInviteToken();
      const days = Number.isFinite(body.expiresInDays) ? Number(body.expiresInDays) : INVITE_TTL_DAYS;
      const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
      const member = await repo.inviteMember({
        email,
        role,
        invitedBy: req.caller?.email ?? null,
        tokenHash: hash,
        expiresAt,
      });
      // The token is in this response and nowhere else, ever again.
      return ok({ member, inviteToken: token }, 201);
    }

    // PATCH: role, status, or a fresh invitation for somebody who has not
    // accepted yet.
    const role = body.role === undefined ? undefined : normalizeMemberRole(body.role);
    if (body.role !== undefined && !role) return err(400, 'invalid_request', { message: `unknown role "${body.role}"` });
    const status = body.status === undefined ? undefined : normalizeMemberStatus(body.status);
    if (body.status !== undefined && !status) return err(400, 'invalid_request', { message: `unknown status "${body.status}"` });

    const current = await repo.getMember(email);
    if (!current) return err(404, 'not found');

    if ((role || status) && await orphansInstance(repo, email, {
      role: role ?? current.role,
      status: status ?? current.status,
    })) {
      return err(409, 'last_admin', {
        message: 'This would leave the instance without an active admin.',
      });
    }

    let member = current;
    if (role) member = await repo.updateMemberRole(email, role);
    if (status) member = await repo.setMemberStatus(email, status);

    if (body.resend) {
      // Only for somebody who has not accepted. Re-issuing a token for an active
      // member would put a live invitation on a membership that needs none, and
      // the link would do nothing for them anyway.
      if (member.status !== 'invited') {
        return err(409, 'nothing_to_resend', {
          message: 'This membership is not awaiting an invitation.',
        });
      }
      const { token, hash } = await mintInviteToken();
      const days = Number.isFinite(body.expiresInDays) ? Number(body.expiresInDays) : INVITE_TTL_DAYS;
      member = await repo.inviteMember({
        email,
        role: member.role,
        invitedBy: req.caller?.email ?? null,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
      });
      return ok({ member, inviteToken: token });
    }

    return ok({ member });
  } catch (e) {
    if (e instanceof NotFoundError) return err(404, 'not found');
    if (e instanceof ValidationError) return err(400, 'invalid_request', { message: e.message });
    if (e instanceof NotSupportedError) return err(501, 'not_supported', { message: e.message });
    return err(500, 'server_error', { message: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The caller a request carries, or the one an unauthenticated runtime implies.
 *
 * „No caller" resolves to full rights rather than none: a dev server, a
 * self-hosted deployment behind its own gate and an instance with access control
 * off all reach here without a role, and refusing them would take saved views away
 * from exactly the instances that have no member list to consult (see
 * docs/users.md → „The one switch").
 */
function callerOf(req: ApiRequest): SavedViewCaller {
  return req.caller ?? { email: req.updatedBy ?? null, canWrite: true, canManage: true };
}

export async function handleTimelineApi(repo: TimelineRepo, req: ApiRequest): Promise<ApiResult> {
  // Collection: GET /api/sources
  if (req.id === '') {
    if (req.method !== 'GET') return err(405, 'method not allowed');
    return ok({ sources: await repo.listTimelines() });
  }

  const { method, id, sub } = req;

  try {
    // ---- whole timeline ---------------------------------------------------
    if (!sub) {
      if (method === 'GET') {
        const file = await repo.getTimeline(id);
        // The repo hands over every saved view; this is where the ones the caller
        // may not see come out, and it is the only gate — see `withVisibleSavedViews`.
        return file ? ok(withVisibleSavedViews(file, callerOf(req))) : err(404, 'not found');
      }
      if (method === 'PUT') {
        const body = req.body as TimelineFile;
        if (!body || !Array.isArray(body.items)) return err(400, 'expected object with "items" array');
        // `savedViews` in the body is deliberately ignored, unlike `pluginData`.
        // What a caller holds is what THEY were allowed to see, so honouring it
        // would let a round trip through GET → PUT delete every private view of
        // everybody else on the timeline. They are written one at a time, through
        // the sub-resource that knows who is asking.
        await repo.replaceTimeline(id, body);
        return ok({ ok: true });
      }
      if (method === 'PATCH') {
        await repo.updateMeta(id, (req.body ?? {}) as any);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- items ------------------------------------------------------------
    if (sub.kind === 'item') {
      if (method === 'POST') {
        const item = req.body as TimelineFileItem;
        // `start` is optional (a list-created item may have no date yet); only
        // `content` is required.
        if (!item || !item.content) return err(400, 'item needs content');
        // An id is optional too, and used not to be: without one the row reached
        // the driver with `id: undefined` and failed there — postgres.js with
        // UNDEFINED_VALUE, PostgREST with a not-null violation. Two error
        // messages for one missing rule, and it contradicted the documented MCP
        // contract, which asks only for `start` and `content`.
        //
        // Deriving it needs the ids already in use, hence the read. It happens
        // only on the path that used to 500, so nothing that worked before pays
        // for it; a repo method for "just the ids" would have to be written three
        // times (postgres, supabase, file) to save one query on a create.
        if (!item.id) {
          const file = await repo.getTimeline(id);
          if (!file) return err(404, 'not found');
          item.id = nextItemId(file.items.map((i) => i.id).filter(Boolean) as string[]);
        }
        return ok(await repo.addItem(id, item, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'item id required');
      if (method === 'PATCH') {
        const body = (req.body ?? {}) as Partial<TimelineFileItem> & { version?: number };
        const version = req.ifMatch ?? body.version;
        const { version: _v, ...patch } = body;
        return ok(await repo.updateItem(id, sub.childId, patch, version, req.updatedBy));
      }
      if (method === 'DELETE') {
        await repo.deleteItem(id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- groups -----------------------------------------------------------
    if (sub.kind === 'group') {
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        const g = req.body as TimelineGroupDecl;
        if (!g || !g.id) return err(400, 'group needs id');
        return ok(await repo.upsertGroup(id, g));
      }
      if (method === 'DELETE') {
        if (!sub.childId) return err(400, 'group id required');
        await repo.deleteGroup(id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- phases (replaced as a unit) --------------------------------------
    if (sub.kind === 'phases') {
      if (method === 'PUT') {
        const body = req.body as { phases?: TimelinePhase[] } | TimelinePhase[];
        const phases = Array.isArray(body) ? body : (body?.phases ?? []);
        await repo.updatePhases(id, phases);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- watermark (cheap change-detection for polling clients) -----------
    if (sub.kind === 'watermark') {
      if (method === 'GET') return ok(await repo.getWatermark(id));
      return err(405, 'method not allowed');
    }

    // ---- saved views ------------------------------------------------------
    // The one sub-resource whose answer depends on who is asking, which is why the
    // caller travels on the request at all (see `ApiRequest.caller`).
    if (sub.kind === 'saved-view') {
      // `return await`, not `return`: the repo throws ConflictError on a stale
      // If-Match, and a promise returned out of a try block rejects after the
      // function has already returned — so the catch below never sees it and a
      // 409 escapes as an unhandled rejection instead.
      return await handleSavedViewApi(repo, {
        method,
        timelineId: id,
        viewId: sub.childId,
        body: req.body,
        ifMatch: req.ifMatch,
        updatedBy: req.updatedBy,
        caller: callerOf(req),
      });
    }

    // ---- plugin-owned rows (the generic store) ----------------------------
    // Everything under here is namespaced by plugin id, so no plugin's names can
    // collide with a sub-resource above — which is also why the parser stops
    // interpreting segments once it has seen `plugin`.
    if (sub.kind === 'plugin') {
      if (!sub.plugin) return err(400, 'plugin id required');
      const pluginReq = {
        method,
        timelineId: id,
        path: sub.plugin,
        body: req.body,
        ifMatch: req.ifMatch,
        updatedBy: req.updatedBy,
      };
      const manifests = req.manifests ?? makeManifestSource(repo);
      // With no collection the request is about the plugin ITSELF on this timeline
      // (enable / reconfigure / disable); with one it is about the rows it owns.
      return sub.plugin.collection
        ? handlePluginApi(repo, manifests, pluginReq)
        : handlePluginLifecycle(repo, manifests, pluginReq);
    }

    return err(404, 'unknown sub-resource');
  } catch (e) {
    if (e instanceof ConflictError) return err(409, 'version_conflict', { message: e.message });
    if (e instanceof NotFoundError) return err(404, 'not found');
    if (e instanceof ValidationError) return err(400, 'invalid_request', { message: e.message });
    if (e instanceof NotSupportedError) return err(501, 'not_supported', { message: e.message });
    return err(500, 'server_error', { message: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Source adapters
// ---------------------------------------------------------------------------
// The runtime glue (Vite middleware / edge function) no longer calls
// handleTimelineApi directly — it resolves a SourceAdapter for the requested id
// and dispatches through it. The DB-backed source has two interchangeable
// drivers behind the same adapter: native postgres.js (opt-in) and supabase-js
// (the Netlify default). Genuine file sources are static and never reach the
// API. New API-served kinds register in resolveAdapter without touching the glue.

// SourceLive / SourceCapabilities now live in src/types.ts so the client and the
// Deno-bundled server share one definition (re-exported here for existing call
// sites that import them from this module).
export type { SourceLive, SourceCapabilities } from '../../src/types';

export interface SourceAdapter {
  readonly kind: string;
  readonly capabilities: SourceCapabilities;
  handle(req: ApiRequest): Promise<ApiResult>;
}

/** Connections a runtime may have available; the glue supplies whichever it built. */
export type DbConnections = {
  sql?: Sql | null;
  supabase?: SupabaseClient | null;
  // Optional per-source postgres.js resolver (Phase 4): maps a timeline id to
  // its namespace's dedicated pool, falling back to the default. Set by the
  // Node glue; the edge functions leave it unset (single global connection).
  sqlFor?: (id: string) => Sql | null;
  /**
   * File-backed local sources, supplied by a runtime that HAS a filesystem.
   *
   * Injected rather than imported so this module stays free of `node:fs`: it is
   * bundled for the Deno edge functions too, and a filesystem import there is
   * both meaningless and a bundle break. The Node glue constructs the repo and
   * passes it; the edge functions leave this unset, which is exactly why a
   * static deploy serves local sources read-only.
   */
  local?: { has(id: string): boolean; repo: TimelineRepo };
};

/** Which driver serves a timeline id, with the handle it was selected by. */
type ResolvedDriver =
  | { kind: 'postgres'; sql: Sql }
  | { kind: 'supabase'; db: SupabaseClient };

/**
 * The driver selection, in one place: native postgres.js when a `sql` handle is
 * present, else supabase-js. When `sqlFor` is set (per-source routing), it
 * chooses the pool for `id` (namespace → dedicated connection, else default);
 * without an `id` or `sqlFor` it uses the default `sql` handle.
 *
 * Separate from `resolveRepo` because two decisions hang off the *same* choice —
 * which repo to build, and which live-update mode a source can honestly claim
 * (see `defaultLive`). Deriving them independently is how the two drift apart.
 */
function resolveDriver(conns: DbConnections, id?: string): ResolvedDriver | null {
  const sql = conns.sqlFor && id != null ? conns.sqlFor(id) : conns.sql;
  if (sql) return { kind: 'postgres', sql };
  if (conns.supabase) return { kind: 'supabase', db: conns.supabase };
  return null;
}

/**
 * Pick the storage repo for a timeline id from the available connection(s).
 * Null when neither driver is configured (the glue then surfaces the "no DB"
 * path — 404/503, no fallback).
 */
export function resolveRepo(conns: DbConnections, id?: string): TimelineRepo | null {
  const driver = resolveDriver(conns, id);
  if (!driver) return null;
  return driver.kind === 'postgres' ? makePostgresRepo(driver.sql) : makeSupabaseRepo(driver.db);
}

/**
 * The live-update mode a DB source advertises when the runtime states no
 * preference.
 *
 * Supabase Realtime needs a Supabase project, so „is one configured" is the
 * honest signal — not which driver won. A deployment may deliberately run
 * postgres.js *against* a Supabase database (`TIMELINES_DATABASE_URL` wins over
 * the Supabase vars, see docs/database.md), and Realtime still works there;
 * keying off the driver would silently downgrade exactly that setup.
 *
 * This used to default to 'realtime' unconditionally, which broke the plain
 * self-hosted Postgres case in the quietest possible way: the server claimed
 * realtime, the client looked for `VITE_SUPABASE_ANON_KEY`, found none, and did
 * nothing at all. Other people's edits then appeared on reload only, with
 * nothing anywhere saying why. Polling needs no anon key (the watermark endpoint
 * is server-gated), so it is the mode a bare Postgres can actually keep.
 */
export function defaultLive(conns: DbConnections): SourceLive {
  return conns.supabase ? 'realtime' : 'poll';
}

/**
 * Parse a runtime's `TIMELINES_DB_LIVE` into an explicit override, or undefined
 * to leave the choice to `defaultLive`. Both runtimes read their own env (Node
 * `process.env` / Deno `Deno.env`) but must agree on what the value means.
 *
 * Deliberately three-way: an unrecognised value yields undefined rather than
 * being coerced to a mode. The old `=== 'poll' ? 'poll' : 'realtime'` turned
 * every typo into "realtime", so `TIMELINES_DB_LIVE=polling` silently disabled
 * live updates on a Postgres deployment.
 */
export function liveOverride(raw: string | undefined | null): SourceLive | undefined {
  return raw === 'poll' || raw === 'realtime' ? raw : undefined;
}

function dbAdapter(repo: TimelineRepo, live: SourceLive): SourceAdapter {
  return {
    kind: 'db',
    capabilities: { editable: true, live },
    handle: (req) => handleTimelineApi(repo, req),
  };
}

/**
 * The DB-backed source via native postgres.js. `live` defaults to 'poll': a
 * connection string on its own says nothing about a Realtime channel being
 * available, and the watermark endpoint works against any Postgres. Pass
 * 'realtime' when the database behind it is a Supabase project. The value flows
 * to the client via the X-Source-Live response header.
 */
export function createPostgresSource(sql: Sql, live: SourceLive = 'poll'): SourceAdapter {
  return dbAdapter(makePostgresRepo(sql), live);
}

/**
 * A local file-backed source. `live: 'poll'` because the client learns about an
 * external edit (an editor, a `git checkout`) through the watermark, which the
 * file repo answers with the file's mtime. There is no push channel over a
 * filesystem, so claiming 'realtime' would leave a stale view looking live.
 */
function localAdapter(repo: TimelineRepo): SourceAdapter {
  return {
    kind: 'local',
    capabilities: { editable: true, live: 'poll' },
    handle: (req) => handleTimelineApi(repo, req),
  };
}

/** The DB-backed source via supabase-js / PostgREST (the Netlify default). */
export function createSupabaseSource(db: SupabaseClient, live: SourceLive = 'realtime'): SourceAdapter {
  return dbAdapter(makeSupabaseRepo(db), live);
}

/**
 * Resolve the adapter that serves a given timeline id through the API. It picks
 * the driver from the available connection(s) — postgres.js when a `sql` handle
 * is present, else supabase-js — so both runtimes select the same way. The `id`
 * argument is the seam future kinds key off (a registry lookup / prefix match)
 * without changing callers.
 *
 * `live` is an OVERRIDE, not the mode: the glue passes what its runtime's
 * `TIMELINES_DB_LIVE` says (through `liveOverride`) and undefined otherwise, so
 * the sane mode for the configured backend comes from `defaultLive` rather than
 * from each runtime deciding for itself.
 */
export function resolveAdapter(conns: DbConnections, id: string, live?: SourceLive): SourceAdapter {
  // A local file wins for its own id. It cannot shadow a DB timeline in
  // practice, because `build-data.ts` already drops a file view whose id
  // collides with a discovered DB timeline — so an id that reaches here as a
  // local file is one the DB does not have. Checking the DB first instead would
  // mean that configuring any database at all makes every local file read-only,
  // which is the opposite of what an instance with both is for.
  if (conns.local?.has(id)) return localAdapter(conns.local.repo);
  const repo = resolveRepo(conns, id);
  // With no DB but a filesystem, the collection is still answerable: it is the
  // list of local timelines. Without either there is nothing to serve.
  if (!repo && conns.local && id === '') return localAdapter(conns.local.repo);
  if (!repo) throw new Error('resolveAdapter: no DB connection (set TIMELINES_DATABASE_URL, or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY)');
  return dbAdapter(repo, live ?? defaultLive(conns));
}

/** Decode one path part, leaving a malformed escape as the literal it was. */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A lone `%` is not a valid escape. Failing the whole request over it would
    // turn a typo into a 400 with no useful message; the lookup that follows
    // rejects the unknown name anyway, and says which one.
    return part;
  }
}

/**
 * Parse `/api/public/plugin/<pluginId>/<timelineId…>`.
 *
 * The timeline id is the whole tail and may contain slashes; the collection, when
 * one is wanted, is the `collection` query parameter. A trailing path segment
 * would be ambiguous against a namespaced id — see `handlePublicPluginApi`.
 */
export function parsePublicPluginPath(pathname: string): { pluginId: string; timelineId: string } | null {
  const rest = pathname.replace(/^\/api\/public\/plugin\/?/, '').replace(/^\/+|\/+$/g, '');
  if (!rest) return null;
  const [rawPlugin, ...tail] = rest.split('/');
  if (!rawPlugin || !tail.length) return null;
  return { pluginId: decodePart(rawPlugin), timelineId: tail.join('/') };
}

/** Parse a `/api/source/<id>[/<subkind>[/<childId>]]` path into id + sub. */
export function parseSourcePath(path: string): { id: string; sub?: ApiRequest['sub'] } | null {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const segs = clean.split('/').filter(Boolean);

  // `plugin` opens a namespace: everything after it is named by the plugin, so
  // it must NOT be matched against the sub-resource list. A collection called
  // `item` would otherwise be read as the core sub-resource and the timeline id
  // would swallow `…/plugin/<pluginId>`. The rightmost occurrence wins, for
  // the same reason the loop below scans from the right — a timeline id may
  // itself contain a segment that looks like a marker.
  const pluginAt = segs.lastIndexOf('plugin');
  if (pluginAt > 0 && pluginAt < segs.length - 1) {
    // Each part is decoded exactly once, which is what lets a scoped plugin id
    // (`@acme/sprints`) and a composite row id (`pro:calls`) survive a path: the
    // client sends `encodeURIComponent(part)`, and a value that itself contains a
    // separator arrives double-encoded and comes back out intact. The timeline id
    // above is deliberately NOT decoded — it keeps the literal-segment rule it has
    // always had, because that one does reach the filesystem.
    const [pluginId, collection, ...rest] = segs.slice(pluginAt + 1).map(decodePart);
    const plugin: PluginPath = { pluginId };
    if (collection) plugin.collection = collection;
    // At most one segment may follow the collection. Joining several would accept
    // a path no client can produce, and would make `a/b` and `a%2Fb` two spellings
    // of one row id.
    if (rest.length === 1) plugin.rowId = rest[0];
    else if (rest.length > 1) return null;
    return {
      id: segs.slice(0, pluginAt).join('/'),
      sub: { kind: 'plugin', childId: segs.slice(pluginAt + 1).join('/'), plugin },
    };
  }

  // find a trailing sub-resource marker
  for (let i = segs.length - 1; i >= 0; i--) {
    if ((SUB_KINDS as readonly string[]).includes(segs[i])) {
      const kind = segs[i] as SubKind;
      const idParts = segs.slice(0, i);
      const childParts = segs.slice(i + 1);
      if (idParts.length === 0) return null;
      return {
        id: idParts.join('/'),
        sub: { kind, childId: childParts.length ? childParts.join('/') : undefined },
      };
    }
  }
  if (segs.length === 0) return null;
  return { id: segs.join('/') };
}

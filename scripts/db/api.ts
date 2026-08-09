// Runtime-agnostic dispatcher for the timeline API. The Node Vite middleware
// and the Deno edge function each parse their native request into ApiRequest,
// call handleTimelineApi(), and write the ApiResult back. All storage logic and
// the item-level optimistic-locking semantics live here — one implementation.

import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Pricing,
  PricingFeature,
  PricingHighlight,
  PricingTier,
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
  'pricing',
  'feature',
  'feature-move',
  'tier',
  'tier-value',
  'highlight',
  'pversion',
] as const;

export type SubKind = (typeof SUB_KINDS)[number];

export type ApiRequest = {
  method: string;
  /** timeline id, e.g. "acme/foo"; empty string means the collection (/api/sources) */
  id: string;
  /** sub-resource: item / group / phases / pricing entities, with optional child id */
  sub?: { kind: SubKind; childId?: string };
  body?: unknown;
  /** optimistic-lock version (from If-Match header or body.version) */
  ifMatch?: number;
  /** attribution for updated_by */
  updatedBy?: string;
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
  req: {
    method: string;
    caller?: { email: string; name?: string | null };
    body?: unknown;
  },
): Promise<ApiResult> {
  if (req.method === 'POST' || req.method === 'PATCH') return manageMember(repo, req);
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
// Membership management (`POST` / `PATCH` on /api/users)
// ---------------------------------------------------------------------------
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

async function manageMember(
  repo: TimelineRepo,
  req: { method: string; caller?: { email: string; name?: string | null }; body?: unknown },
): Promise<ApiResult> {
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
        return file ? ok(file) : err(404, 'not found');
      }
      if (method === 'PUT') {
        const body = req.body as TimelineFile;
        if (!body || !Array.isArray(body.items)) return err(400, 'expected object with "items" array');
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

    // ---- pricing: whole model (bulk seed / rewrite) ----------------------
    if (sub.kind === 'pricing') {
      if (method === 'PUT') {
        // Accept either the bare Pricing object or { pricing: … }.
        const raw = (req.body ?? {}) as Record<string, unknown>;
        const pricing = ('features' in raw ? raw : (raw.pricing as unknown)) as Pricing | undefined;
        if (!pricing || !Array.isArray(pricing.tiers) || !Array.isArray(pricing.features)) {
          return err(400, 'pricing needs features[] and tiers[]');
        }
        await repo.replacePricing(id, pricing);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: features -----------------------------------------------
    // NOTE: the optimistic-lock version for pricing entities comes ONLY from the
    // If-Match header, never body.version — for features `version` is the domain
    // "available from" label, not the lock counter. So the patch body is passed
    // through untouched.
    if (sub.kind === 'feature') {
      if (method === 'POST') {
        const f = req.body as PricingFeature;
        if (!f || !f.id) return err(400, 'feature needs id');
        return ok(await repo.addFeature(id, f, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'feature id required');
      if (method === 'PATCH') {
        return ok(await repo.updateFeature(id, sub.childId, (req.body ?? {}) as Partial<PricingFeature>, req.ifMatch, req.updatedBy));
      }
      if (method === 'DELETE') {
        await repo.deleteFeature(id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: reorder a feature (relative to another) -----------------
    // POST { featureId, after? | before? }. Exactly one anchor; `after` wins if
    // both are sent. Renumbers the matrix row order server-side.
    if (sub.kind === 'feature-move') {
      if (method === 'POST' || method === 'PUT') {
        const b = (req.body ?? {}) as { featureId?: string; after?: string; before?: string };
        if (!b.featureId) return err(400, 'feature-move needs featureId');
        if (!b.after && !b.before) return err(400, 'feature-move needs after or before');
        const order = await repo.moveFeature(id, b.featureId, { after: b.after, before: b.before }, req.updatedBy);
        return ok({ ok: true, order });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: tiers ---------------------------------------------------
    if (sub.kind === 'tier') {
      if (method === 'POST') {
        const t = req.body as PricingTier;
        if (!t || !t.id) return err(400, 'tier needs id');
        return ok(await repo.addTier(id, t, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'tier id required');
      if (method === 'PATCH') {
        return ok(await repo.updateTier(id, sub.childId, (req.body ?? {}) as Partial<PricingTier>, req.ifMatch, req.updatedBy));
      }
      if (method === 'DELETE') {
        await repo.deleteTier(id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: a single matrix cell (tier × feature) -------------------
    // PUT the value; a false/null/empty value clears the cell. Body carries the
    // coordinates so no dotted ids ever land in the path.
    if (sub.kind === 'tier-value') {
      if (method === 'PUT' || method === 'POST') {
        const b = (req.body ?? {}) as {
          tierId?: string;
          featureId?: string;
          value?: string | boolean | null;
          availableFrom?: string | null;
        };
        if (!b.tierId || !b.featureId) return err(400, 'tier-value needs tierId and featureId');
        await repo.setTierValue(id, b.tierId, b.featureId, b.value ?? null, req.updatedBy, b.availableFrom ?? null);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: highlights ----------------------------------------------
    if (sub.kind === 'highlight') {
      if (method === 'POST') {
        const h = req.body as PricingHighlight;
        if (!h || !h.id) return err(400, 'highlight needs id');
        return ok(await repo.addHighlight(id, h, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'highlight id required');
      if (method === 'PATCH') {
        return ok(await repo.updateHighlight(id, sub.childId, (req.body ?? {}) as Partial<PricingHighlight>, req.ifMatch, req.updatedBy));
      }
      if (method === 'DELETE') {
        await repo.deleteHighlight(id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: versions (ordered label list, replaced as a unit) -------
    if (sub.kind === 'pversion') {
      if (method === 'PUT') {
        const body = req.body as { versions?: string[] } | string[];
        const versions = Array.isArray(body) ? body : (body?.versions ?? []);
        await repo.updateVersions(id, versions);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
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

/** Parse a `/api/source/<id>[/<subkind>[/<childId>]]` path into id + sub. */
export function parseSourcePath(path: string): { id: string; sub?: ApiRequest['sub'] } | null {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const segs = clean.split('/').filter(Boolean);
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

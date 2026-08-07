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
  ConflictError,
  NotFoundError,
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
import { makePostgresRepo } from './timeline-repo.ts';
import { makeSupabaseRepo } from './timeline-repo-supabase.ts';

/** Sub-resource kinds addressable under /api/source/<id>/. */
export type SubKind =
  | 'item'
  | 'group'
  | 'phases'
  | 'watermark'
  | 'pricing'
  | 'feature'
  | 'feature-move'
  | 'tier'
  | 'tier-value'
  | 'highlight'
  | 'pversion';

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
};

/**
 * Pick the storage repo for a timeline id from the available connection(s):
 * native postgres.js when a `sql` handle is present, else supabase-js. Null when
 * neither is configured (the glue then surfaces the "no DB" path — 404/503, no
 * fallback). When `sqlFor` is set (per-source routing), it chooses the pool for
 * `id` (namespace → dedicated connection, else default); without an `id` or
 * `sqlFor` it uses the default `sql` handle.
 */
export function resolveRepo(conns: DbConnections, id?: string): TimelineRepo | null {
  const sql = conns.sqlFor && id != null ? conns.sqlFor(id) : conns.sql;
  if (sql) return makePostgresRepo(sql);
  if (conns.supabase) return makeSupabaseRepo(conns.supabase);
  return null;
}

function dbAdapter(repo: TimelineRepo, live: SourceLive): SourceAdapter {
  return {
    kind: 'db',
    capabilities: { editable: true, live },
    handle: (req) => handleTimelineApi(repo, req),
  };
}

/**
 * The DB-backed source via native postgres.js. `live` defaults to 'realtime'
 * (Supabase Realtime pushes row changes over a WebSocket). Pass 'poll' for a
 * Postgres without Realtime enabled — clients then poll the watermark endpoint
 * instead. The value flows to the client via the X-Source-Live response header.
 */
export function createPostgresSource(sql: Sql, live: SourceLive = 'realtime'): SourceAdapter {
  return dbAdapter(makePostgresRepo(sql), live);
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
 * without changing callers. `live` is read from the runtime's env by the glue
 * (TIMELINES_DB_LIVE) and threaded through so both runtimes agree on the mode.
 */
export function resolveAdapter(conns: DbConnections, id: string, live: SourceLive = 'realtime'): SourceAdapter {
  const repo = resolveRepo(conns, id);
  if (!repo) throw new Error('resolveAdapter: no DB connection (set TIMELINES_DATABASE_URL, or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY)');
  return dbAdapter(repo, live);
}

/** Parse a `/api/source/<id>[/<subkind>[/<childId>]]` path into id + sub. */
export function parseSourcePath(path: string): { id: string; sub?: ApiRequest['sub'] } | null {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const segs = clean.split('/').filter(Boolean);
  const subKinds = ['item', 'group', 'phases', 'watermark', 'pricing', 'feature', 'feature-move', 'tier', 'tier-value', 'highlight', 'pversion'] as const;
  // find a trailing sub-resource marker
  for (let i = segs.length - 1; i >= 0; i--) {
    if ((subKinds as readonly string[]).includes(segs[i])) {
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

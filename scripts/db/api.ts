// Runtime-agnostic dispatcher for the timeline API. The Node Vite middleware
// and the Deno edge function each parse their native request into ApiRequest,
// call handleTimelineApi(), and write the ApiResult back. All storage logic and
// the item-level optimistic-locking semantics live here — one implementation.

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Pricing,
  PricingFeature,
  PricingHighlight,
  PricingTier,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
} from '../../src/types';
import {
  ConflictError,
  NotFoundError,
  addFeature,
  addHighlight,
  addItem,
  addTier,
  deleteFeature,
  deleteGroup,
  deleteHighlight,
  deleteItem,
  deleteTier,
  getTimeline,
  listTimelines,
  replacePricing,
  replaceTimeline,
  setTierValue,
  updateFeature,
  updateHighlight,
  updateItem,
  updateMeta,
  updatePhases,
  updateTier,
  updateVersions,
  upsertGroup,
  type TimelineGroupDecl,
} from './timeline-repo.ts';

/** Sub-resource kinds addressable under /api/source/<id>/. */
export type SubKind =
  | 'item'
  | 'group'
  | 'phases'
  | 'pricing'
  | 'feature'
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

export async function handleTimelineApi(db: SupabaseClient, req: ApiRequest): Promise<ApiResult> {
  // Collection: GET /api/sources
  if (req.id === '') {
    if (req.method !== 'GET') return err(405, 'method not allowed');
    return ok({ sources: await listTimelines(db) });
  }

  const { method, id, sub } = req;

  try {
    // ---- whole timeline ---------------------------------------------------
    if (!sub) {
      if (method === 'GET') {
        const file = await getTimeline(db, id);
        return file ? ok(file) : err(404, 'not found');
      }
      if (method === 'PUT') {
        const body = req.body as TimelineFile;
        if (!body || !Array.isArray(body.items)) return err(400, 'expected object with "items" array');
        await replaceTimeline(db, id, body);
        return ok({ ok: true });
      }
      if (method === 'PATCH') {
        await updateMeta(db, id, (req.body ?? {}) as any);
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
        return ok(await addItem(db, id, item, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'item id required');
      if (method === 'PATCH') {
        const body = (req.body ?? {}) as Partial<TimelineFileItem> & { version?: number };
        const version = req.ifMatch ?? body.version;
        const { version: _v, ...patch } = body;
        return ok(await updateItem(db, id, sub.childId, patch, version, req.updatedBy));
      }
      if (method === 'DELETE') {
        await deleteItem(db, id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- groups -----------------------------------------------------------
    if (sub.kind === 'group') {
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        const g = req.body as TimelineGroupDecl;
        if (!g || !g.id) return err(400, 'group needs id');
        return ok(await upsertGroup(db, id, g));
      }
      if (method === 'DELETE') {
        if (!sub.childId) return err(400, 'group id required');
        await deleteGroup(db, id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- phases (replaced as a unit) --------------------------------------
    if (sub.kind === 'phases') {
      if (method === 'PUT') {
        const body = req.body as { phases?: TimelinePhase[] } | TimelinePhase[];
        const phases = Array.isArray(body) ? body : (body?.phases ?? []);
        await updatePhases(db, id, phases);
        return ok({ ok: true });
      }
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
        await replacePricing(db, id, pricing);
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
        return ok(await addFeature(db, id, f, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'feature id required');
      if (method === 'PATCH') {
        return ok(await updateFeature(db, id, sub.childId, (req.body ?? {}) as Partial<PricingFeature>, req.ifMatch, req.updatedBy));
      }
      if (method === 'DELETE') {
        await deleteFeature(db, id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: tiers ---------------------------------------------------
    if (sub.kind === 'tier') {
      if (method === 'POST') {
        const t = req.body as PricingTier;
        if (!t || !t.id) return err(400, 'tier needs id');
        return ok(await addTier(db, id, t, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'tier id required');
      if (method === 'PATCH') {
        return ok(await updateTier(db, id, sub.childId, (req.body ?? {}) as Partial<PricingTier>, req.ifMatch, req.updatedBy));
      }
      if (method === 'DELETE') {
        await deleteTier(db, id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: a single matrix cell (tier × feature) -------------------
    // PUT the value; a false/null/empty value clears the cell. Body carries the
    // coordinates so no dotted ids ever land in the path.
    if (sub.kind === 'tier-value') {
      if (method === 'PUT' || method === 'POST') {
        const b = (req.body ?? {}) as { tierId?: string; featureId?: string; value?: string | boolean | null };
        if (!b.tierId || !b.featureId) return err(400, 'tier-value needs tierId and featureId');
        await setTierValue(db, id, b.tierId, b.featureId, b.value ?? null, req.updatedBy);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: highlights ----------------------------------------------
    if (sub.kind === 'highlight') {
      if (method === 'POST') {
        const h = req.body as PricingHighlight;
        if (!h || !h.id) return err(400, 'highlight needs id');
        return ok(await addHighlight(db, id, h, req.updatedBy), 201);
      }
      if (!sub.childId) return err(400, 'highlight id required');
      if (method === 'PATCH') {
        return ok(await updateHighlight(db, id, sub.childId, (req.body ?? {}) as Partial<PricingHighlight>, req.ifMatch, req.updatedBy));
      }
      if (method === 'DELETE') {
        await deleteHighlight(db, id, sub.childId);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    // ---- pricing: versions (ordered label list, replaced as a unit) -------
    if (sub.kind === 'pversion') {
      if (method === 'PUT') {
        const body = req.body as { versions?: string[] } | string[];
        const versions = Array.isArray(body) ? body : (body?.versions ?? []);
        await updateVersions(db, id, versions);
        return ok({ ok: true });
      }
      return err(405, 'method not allowed');
    }

    return err(404, 'unknown sub-resource');
  } catch (e) {
    if (e instanceof ConflictError) return err(409, 'version_conflict', { message: e.message });
    if (e instanceof NotFoundError) return err(404, 'not found');
    return err(500, 'server_error', { message: e instanceof Error ? e.message : String(e) });
  }
}

/** Parse a `/api/source/<id>[/<subkind>[/<childId>]]` path into id + sub. */
export function parseSourcePath(path: string): { id: string; sub?: ApiRequest['sub'] } | null {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const segs = clean.split('/').filter(Boolean);
  const subKinds = ['item', 'group', 'phases', 'pricing', 'feature', 'tier', 'tier-value', 'highlight', 'pversion'] as const;
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

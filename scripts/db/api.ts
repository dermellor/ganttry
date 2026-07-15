// Runtime-agnostic dispatcher for the timeline API. The Node Vite middleware
// and the Deno edge function each parse their native request into ApiRequest,
// call handleTimelineApi(), and write the ApiResult back. All storage logic and
// the item-level optimistic-locking semantics live here — one implementation.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TimelineFile, TimelineFileItem, TimelinePhase } from '../../src/types';
import {
  ConflictError,
  NotFoundError,
  addItem,
  deleteGroup,
  deleteItem,
  getTimeline,
  listTimelines,
  replaceTimeline,
  updateItem,
  updateMeta,
  updatePhases,
  upsertGroup,
  type TimelineGroupDecl,
} from './timeline-repo.ts';

export type ApiRequest = {
  method: string;
  /** timeline id, e.g. "acme/foo"; empty string means the collection (/api/sources) */
  id: string;
  /** sub-resource: item / group / phases, with optional child id */
  sub?: { kind: 'item' | 'group' | 'phases'; childId?: string };
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

    return err(404, 'unknown sub-resource');
  } catch (e) {
    if (e instanceof ConflictError) return err(409, 'version_conflict', { message: e.message });
    if (e instanceof NotFoundError) return err(404, 'not found');
    return err(500, 'server_error', { message: e instanceof Error ? e.message : String(e) });
  }
}

/** Parse a `/api/source/<id>[/item|group|phases[/<childId>]]` path into id + sub. */
export function parseSourcePath(path: string): { id: string; sub?: ApiRequest['sub'] } | null {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const segs = clean.split('/').filter(Boolean);
  const subKinds = ['item', 'group', 'phases'] as const;
  // find a trailing sub-resource marker
  for (let i = segs.length - 1; i >= 0; i--) {
    if ((subKinds as readonly string[]).includes(segs[i])) {
      const kind = segs[i] as 'item' | 'group' | 'phases';
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

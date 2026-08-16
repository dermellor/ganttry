// The write path for saved views: one dispatcher above the repo, so all three
// backing stores are held to the same rules.
//
// It sits beside `plugin-api.ts` for the same reason that one exists: the rules
// worth enforcing here — who may see a row, who may change it, who may put one in
// front of the whole instance — are not properties of Postgres, and a per-driver
// implementation would mean the file-backed store quietly answering a different
// question. The pure half lives in `src/savedViews.ts` and is shared with the
// client, so the picker hides exactly what the API refuses.

import type { SavedView } from '../../src/types';
import {
  canEditSavedView,
  canPublishSavedView,
  canSeeSavedView,
  canonicalEdges,
  canonicalFilters,
  uniqueSavedViewId,
  visibleSavedViews,
  type SavedViewCaller,
} from '../../src/savedViews.ts';
import { sanitizeEdgeSelection } from '../../src/linkEdges.ts';
import type { TimelineRepo } from './repo.ts';

export type SavedViewRequest = {
  method: string;
  timelineId: string;
  /** Absent addresses the collection; present, one view. */
  viewId?: string;
  body?: unknown;
  ifMatch?: number;
  updatedBy?: string;
  caller: SavedViewCaller;
};

export type SavedViewResult = { status: number; json: unknown };

const ok = (json: unknown, status = 200): SavedViewResult => ({ status, json });
const err = (status: number, error: string, message?: string): SavedViewResult => ({
  status,
  json: message ? { error, message } : { error },
});

/** The fields a caller may state, already narrowed to what this endpoint accepts. */
type SavedViewInput = {
  id?: string;
  name?: string;
  mode?: string | null;
  groupBy?: string | null;
  filters?: Record<string, string[]> | null;
  edges?: Record<string, string> | null;
  orderFrom?: string | null;
  owner?: string;
  visibility?: string;
};

function readInput(body: unknown): SavedViewInput {
  return (body ?? {}) as SavedViewInput;
}

/**
 * Apply a patch to a view, key by key.
 *
 * An absent key leaves the field alone and an explicit `null` clears it — the same
 * two-way rule `updateMeta` follows, and for the same reason: „open this in the
 * list" and „stop caring which presentation this opens in" are different edits, and
 * a shape that cannot express the second makes a mode impossible to remove once set.
 */
function merged(current: SavedView, input: SavedViewInput): SavedView {
  const next: SavedView = { ...current };
  if (input.name !== undefined) next.name = String(input.name).trim();
  if (input.mode !== undefined) {
    if (input.mode) next.mode = input.mode;
    else delete next.mode;
  }
  if (input.groupBy !== undefined) {
    if (input.groupBy) next.groupBy = input.groupBy;
    else delete next.groupBy;
  }
  if (input.filters !== undefined) {
    const filters = canonicalFilters(input.filters ?? {});
    if (Object.keys(filters).length) next.filters = filters;
    else delete next.filters;
  }
  // Canonicalised on the way in like `filters`, which drops the fields left at
  // the default direction: „said nothing about Hints" and „set Hints back to
  // incoming" are one state, and storing the second makes a view look drifted
  // against a display that matches it.
  if (input.edges !== undefined) {
    const edges = canonicalEdges(sanitizeEdgeSelection(input.edges ?? {}));
    if (Object.keys(edges).length) next.edges = edges;
    else delete next.edges;
  }
  // Named here rather than carried through by a spread, like every field above it:
  // this function builds the stored view from a whitelist, so a field the client
  // sends and nobody names is accepted, answered 200, and silently not stored.
  if (input.orderFrom !== undefined) {
    const orderFrom = typeof input.orderFrom === 'string' ? input.orderFrom.trim() : '';
    if (orderFrom) next.orderFrom = orderFrom;
    else delete next.orderFrom;
  }
  if (input.visibility !== undefined) {
    next.visibility = input.visibility === 'instance' ? 'instance' : 'private';
  }
  if (input.owner !== undefined) next.owner = input.owner.trim();
  return next;
}

/**
 * Who may be named as the owner.
 *
 * Writing somebody else's address needs `write`, not `manage`, and that is the
 * decision this feature turns on: an agent creating a view **for** a person is the
 * ordinary case (docs/mcp.md), and owning a saved view grants nothing — an editor
 * can already set an item's `metadata.owner` to any address in the directory. What
 * it decides is whose list the view appears in, which is a display fact.
 */
function ownerRefused(input: SavedViewInput, caller: SavedViewCaller): boolean {
  if (input.owner === undefined) return false;
  const same = input.owner.trim().toLowerCase() === (caller.email ?? '').trim().toLowerCase();
  return !same && !caller.canWrite;
}

export async function handleSavedViewApi(
  repo: TimelineRepo,
  req: SavedViewRequest,
): Promise<SavedViewResult> {
  const { method, timelineId, viewId, caller } = req;

  if (!viewId) {
    if (method === 'GET') {
      return ok({ savedViews: visibleSavedViews(await repo.listSavedViews(timelineId), caller) });
    }
    if (method !== 'POST') return err(405, 'method not allowed');

    const input = readInput(req.body);
    const name = (input.name ?? '').trim();
    if (!name) return err(400, 'invalid_request', 'a saved view needs a name');
    if (input.visibility === 'instance' && !canPublishSavedView(caller)) {
      return err(403, 'forbidden', 'sharing a view with the instance needs write access');
    }
    if (ownerRefused(input, caller)) {
      return err(403, 'forbidden', 'creating a view for somebody else needs write access');
    }

    const existing = await repo.listSavedViews(timelineId);
    const taken = new Set(existing.map((v) => v.id));
    // An id the caller states is honoured rather than uniquified: a client that
    // names one means that one, and silently storing `q3-2` would leave it holding
    // an id that addresses nothing. Derived ids count up instead — two people
    // naming a view „Q3" is ordinary and not something either can act on.
    const id = input.id ? input.id.trim() : uniqueSavedViewId(name, taken);
    if (input.id && taken.has(id)) {
      return err(409, 'saved_view_exists', `a saved view „${id}" already exists here`);
    }

    const view = merged(
      { id, name, owner: input.owner?.trim() ?? caller.email ?? '', visibility: 'private' },
      input,
    );
    return ok(await repo.putSavedView(timelineId, view, undefined, req.updatedBy), 201);
  }

  const current = await repo.getSavedView(timelineId, viewId);
  // „Not there" and „not yours" answer identically, the same way the membership
  // refusal does: the difference is only useful to somebody probing what exists.
  if (!current || !canSeeSavedView(current, caller)) return err(404, 'not found');

  if (method === 'GET') return ok(current);

  if (method === 'PATCH') {
    if (!canEditSavedView(current, caller)) {
      return err(403, 'forbidden', 'this saved view belongs to somebody else');
    }
    const input = readInput(req.body);
    if (input.visibility === 'instance' && !canPublishSavedView(caller)) {
      return err(403, 'forbidden', 'sharing a view with the instance needs write access');
    }
    if (ownerRefused(input, caller)) {
      return err(403, 'forbidden', 'handing a view to somebody else needs write access');
    }
    const next = merged(current, input);
    if (!next.name) return err(400, 'invalid_request', 'a saved view needs a name');
    // The id is not patchable: changing it would make the row a different one and
    // leave every link that carries `sv=<old>` pointing at nothing. Same refusal a
    // plugin row's key fields get.
    if (input.id !== undefined && input.id !== current.id) {
      return err(400, 'invalid_request', 'a saved view keeps the id it was created with');
    }
    return ok(await repo.putSavedView(timelineId, next, req.ifMatch, req.updatedBy));
  }

  if (method === 'DELETE') {
    if (!canEditSavedView(current, caller)) {
      return err(403, 'forbidden', 'this saved view belongs to somebody else');
    }
    await repo.deleteSavedView(timelineId, viewId);
    return ok({ ok: true });
  }

  return err(405, 'method not allowed');
}

/**
 * The saved views of a timeline payload, narrowed to what this caller may see.
 *
 * `GET /api/source/<id>` folds them in (see `SavedView` in src/types.ts), and the
 * repo hands over every one of them — so this is the gate, and it is the only one.
 * Skipping it puts another member's private view into the payload of a timeline
 * anybody may read.
 */
export function withVisibleSavedViews<T extends { savedViews?: SavedView[] }>(
  file: T,
  caller: SavedViewCaller,
): T {
  if (!file.savedViews) return file;
  const kept = visibleSavedViews(file.savedViews, caller);
  const next = { ...file };
  if (kept.length) next.savedViews = kept;
  else delete next.savedViews;
  return next;
}

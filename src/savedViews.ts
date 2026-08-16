// The rules a saved view follows, with no DOM, no storage and no request in
// sight.
//
// A saved view is read by five different things — the client's control, the API
// dispatcher, both repo implementations, the MCP tools and the build that
// materializes a local source — and each of them needs the same three answers:
// who may see this one, who may change it, and does it still describe what is on
// screen. Written down once here, they are the same answers everywhere; written
// down per caller, the one that gets fixed is the client and the one that leaks is
// the API („a rule lives in exactly one place", AGENTS.md).
//
// The visibility rule in particular has the shape that argues for this: it decides
// what leaves the building, exactly like `publicRead.ts` does for a plugin's rows,
// and a projection with a database call in the middle is one nobody can test
// exhaustively.

import type { SavedView, SavedViewVisibility } from './types';
// `.ts` because this module is reachable from an edge function, where Deno
// resolves an extensionless specifier to nothing (see scripts/ci/edge-imports.test.ts).
import { DEFAULT_EDGE_DIRECTION, isEdgeDirection, type EdgeSelection } from './linkEdges.ts';

/** What one caller may do, as the runtime that authenticated them resolved it. */
export type SavedViewCaller = {
  /** The caller's address, or null when the deployment has no identity at all. */
  email?: string | null;
  /**
   * May they write timeline content? That is what publishing a view needs — a
   * `viewer` keeps private ones. With access control off this is true for
   * everybody past the gate, which is the behaviour that instance already has.
   */
  canWrite: boolean;
  /** May they administer the instance? Decides who may touch somebody else's view. */
  canManage: boolean;
};

/** The visibility an absent field means. Older files and rows spell it that way. */
export const DEFAULT_VISIBILITY: SavedViewVisibility = 'private';

export function visibilityOf(view: Pick<SavedView, 'visibility'>): SavedViewVisibility {
  return view.visibility === 'instance' ? 'instance' : DEFAULT_VISIBILITY;
}

/**
 * Is this the same person?
 *
 * Addresses are compared case-insensitively, like every other address in the
 * product. Two absent ones count as a match rather than as a mismatch: a
 * self-hosted instance with no gate has no identity to store, and treating
 * „nobody" as a different person from „nobody" would leave the only user of such
 * an instance unable to reopen the view they had just saved.
 */
function sameActor(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** May this caller see it at all? The one gate the API filters every read through. */
export function canSeeSavedView(view: SavedView, caller: SavedViewCaller): boolean {
  return visibilityOf(view) === 'instance' || sameActor(view.owner, caller.email);
}

/**
 * May this caller change or delete it?
 *
 * The owner always may. Somebody else needs `manage`, published or not — a shared
 * view is still a statement its author made, and „anybody who may write items may
 * rewrite everybody's saved views" is a wider door than sharing one asks for.
 */
export function canEditSavedView(view: SavedView, caller: SavedViewCaller): boolean {
  return sameActor(view.owner, caller.email) || caller.canManage;
}

/**
 * May this caller put a view in front of the whole instance?
 *
 * Separate from editing, because it is the one action whose effect is on other
 * people's screens. Creating and keeping private ones needs only `read`, or a
 * `viewer` could save nothing at all.
 */
export function canPublishSavedView(caller: SavedViewCaller): boolean {
  return caller.canWrite;
}

/** Everything this caller may see, in the order a picker should list it. */
export function visibleSavedViews(views: SavedView[], caller: SavedViewCaller): SavedView[] {
  return sortSavedViews(views.filter((v) => canSeeSavedView(v, caller)));
}

/**
 * By name, case- and accent-insensitively.
 *
 * There is no stored order and deliberately no way to make one: an explicit order
 * needs a move endpoint, a `sort` column and a rule for what happens to somebody
 * else's position when you reorder a shared list. A list of names sorted by name
 * needs none of that and is findable, which is the only job the order has here.
 */
export function sortSavedViews(views: SavedView[]): SavedView[] {
  return [...views].sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
}

/**
 * The comparable form of a selection: no empty dimensions, everything ordered.
 *
 * Exported because the write path stores this form too. Two selections that narrow
 * identically must be one value, or „has this view drifted" answers yes to the
 * order two checkboxes happened to be ticked in.
 */
export function canonicalFilters(filters: Record<string, string[]> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(filters ?? {}).sort()) {
    const values = (filters?.[key] ?? []).filter((v) => typeof v === 'string');
    if (values.length) out[key] = [...values].sort();
  }
  return out;
}

/** What the interface is showing right now, in the shape a saved view stores. */
export type DisplayState = {
  mode: string;
  groupBy: string;
  filters: Record<string, string[]>;
  edges?: EdgeSelection;
  orderFrom?: string;
};

/**
 * The edge selection in one comparable form: fields at the default direction are
 * dropped, so „said nothing about Hints" and „set Hints back to incoming" are one
 * value. Without it the drift marker would appear for a round trip that changed
 * nothing on screen.
 */
export function canonicalEdges(edges: EdgeSelection | undefined): EdgeSelection {
  const out: EdgeSelection = {};
  for (const key of Object.keys(edges ?? {}).sort()) {
    const dir = edges?.[key];
    if (isEdgeDirection(dir) && dir !== DEFAULT_EDGE_DIRECTION) out[key] = dir;
  }
  return out;
}

/**
 * Does the view still describe what is on screen?
 *
 * Only the fields the view actually declares are compared. A view that says
 * nothing about the presentation is not „drifted" the moment somebody switches to
 * the list — it never had an opinion about that, and reporting one would make the
 * drift marker mean „you changed something" instead of „this is no longer the
 * saved view".
 */
export function savedViewMatches(view: SavedView, current: DisplayState): boolean {
  if (view.mode !== undefined && view.mode !== current.mode) return false;
  if (view.groupBy !== undefined && view.groupBy !== current.groupBy) return false;
  // The filter is the exception, and storage is why: the column is
  // `NOT NULL DEFAULT '{}'`, so „states no filter" and „states the empty
  // selection" are one value there and cannot be told apart on the way back. An
  // empty selection is therefore a statement — „no restriction" — rather than an
  // absence, which is also what somebody saving an unfiltered view means.
  if (JSON.stringify(canonicalFilters(view.filters)) !== JSON.stringify(canonicalFilters(current.filters))) {
    return false;
  }
  // Compared like the filter and for the same reason: an absent selection is the
  // default one, not „no opinion". A view saved before this existed therefore
  // matches a timeline drawing every field incoming, which is what it was showing.
  if (JSON.stringify(canonicalEdges(view.edges)) !== JSON.stringify(canonicalEdges(current.edges))) {
    return false;
  }
  // Also compared as an absence rather than as „no opinion", like the two above:
  // a view saved before this existed states no order, and a timeline showing none
  // is exactly what it was showing.
  if ((view.orderFrom ?? '') !== (current.orderFrom ?? '')) return false;
  return true;
}

/**
 * An id derived from the name, so a link is readable and a hand-written file can
 * name one. Falls back to `view` for a name that carries no usable characters at
 * all (an emoji, a script this transliterates nothing of), because an empty id is
 * not addressable.
 */
export function savedViewSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'view';
}

/**
 * A free id for `name` among `taken`. Counting up rather than refusing: two people
 * naming a view „Q3" is ordinary, and a collision is not something the person
 * saving one can act on.
 */
export function uniqueSavedViewId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = savedViewSlug(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Keep only well-typed fields, the way `viewPrefs.ts` sanitizes stored display
 * state: a malformed entry reads as its default rather than throwing, because a
 * saved view must never be what keeps a timeline from rendering. Returns null when
 * there is not even an id and a name, which is the minimum that can be shown.
 */
export function sanitizeSavedView(raw: unknown): SavedView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  if (!id || !name) return null;
  const out: SavedView = { id, name };
  if (typeof rec.mode === 'string' && rec.mode) out.mode = rec.mode;
  if (typeof rec.groupBy === 'string' && rec.groupBy) out.groupBy = rec.groupBy;
  const filters = canonicalFilters(
    rec.filters && typeof rec.filters === 'object' && !Array.isArray(rec.filters)
      ? (Object.fromEntries(
          Object.entries(rec.filters as Record<string, unknown>).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [],
          ]),
        ))
      : undefined,
  );
  if (Object.keys(filters).length) out.filters = filters;
  if (typeof rec.orderFrom === 'string' && rec.orderFrom) out.orderFrom = rec.orderFrom;
  if (typeof rec.owner === 'string' && rec.owner) out.owner = rec.owner;
  out.visibility = rec.visibility === 'instance' ? 'instance' : 'private';
  if (typeof rec.version === 'number' && Number.isFinite(rec.version)) out.version = rec.version;
  for (const key of ['createdAt', 'createdBy', 'updatedAt', 'updatedBy'] as const) {
    if (typeof rec[key] === 'string' && rec[key]) out[key] = rec[key] as string;
  }
  return out;
}

/** Every well-formed entry of a stored array, ignoring the rest. */
export function sanitizeSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeSavedView).filter((v): v is SavedView => v != null);
}

/**
 * A file made safe to serve verbatim, for the same reason
 * `stripFileForPublication` exists next to it: a static deploy materializes a
 * local source under `public/`, so everything left in the file is world-readable
 * whether or not anybody decided that.
 *
 * Private views go, and so does the `owner` of the ones that stay — it is an
 * e-mail address, and publishing it would leak who works on a timeline to anyone
 * who fetches the file. Same three host fields as a published plugin row.
 */
export function stripSavedViewsForPublication<T extends { savedViews?: SavedView[] }>(file: T): T {
  if (!file.savedViews) return file;
  const kept = file.savedViews
    .filter((v) => visibilityOf(v) === 'instance')
    .map(({ owner: _owner, version: _version, createdBy: _cb, updatedBy: _ub, ...rest }) => rest);
  const next = { ...file };
  if (kept.length) next.savedViews = kept;
  else delete next.savedViews;
  return next;
}

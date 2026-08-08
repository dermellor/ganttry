import { dataUrl } from './data-base';
import type {
  PricingFeature,
  PricingTier,
  SourceLive,
  TimelineFile,
  TimelineFileItem,
  TimelinePhase,
  ViewSource,
} from './types';

export type LoadResult = { file: TimelineFile; editable: boolean; live: SourceLive };

const LIVE_MODES: readonly SourceLive[] = ['realtime', 'poll', 'none'];
function parseLive(header: string | null): SourceLive {
  // Default to 'realtime' for a DB source whose server didn't send the header
  // (older glue) — matches the pre-Phase-2 behaviour.
  return LIVE_MODES.includes(header as SourceLive) ? (header as SourceLive) : 'realtime';
}

/** Thrown when an item PATCH is rejected because it changed server-side (409). */
export class ConflictError extends Error {
  constructor(message = 'version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Session expired mid-use: the auth gate answers an /api/* call with 401 once
 * the cookie is gone (rather than a cross-origin redirect the fetch can't
 * follow). Send the top window to the login, preserving the current view so
 * the user lands back where they were — beats the edit silently vanishing.
 */
function handleSessionExpired(): never {
  const here = `${location.pathname}${location.search}${location.hash}`;
  const login = `/auth/login?redirect=${encodeURIComponent(here)}`;
  // Guard against a redirect loop if several queued calls all 401 at once.
  if (!sessionRedirectStarted) {
    sessionRedirectStarted = true;
    location.assign(login);
  }
  throw new Error('Session abgelaufen — bitte neu einloggen.');
}
let sessionRedirectStarted = false;

async function apiJson(res: Response): Promise<any> {
  if (res.status === 401) handleSessionExpired();
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) throw new ConflictError((data as any).message || 'version conflict');
  // Prefer the server's human message (e.g. the overlapping-phases reason) over
  // the terse error code.
  if (!res.ok) throw new Error((data as any).message || (data as any).error || `HTTP ${res.status}`);
  return data;
}

/** Create a new item; returns the stored item (with version). */
export async function apiAddItem(sourceId: string, item: TimelineFileItem): Promise<TimelineFileItem> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    }),
  );
}

/** Patch an item with optimistic locking. Throws ConflictError on stale version. */
export async function apiUpdateItem(
  sourceId: string,
  itemId: string,
  // Values may be `null` to explicitly clear a column (an omitted key leaves the
  // stored value untouched), so this is wider than Partial<TimelineFileItem>.
  patch: Record<string, unknown>,
  version?: number,
): Promise<TimelineFileItem> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (version != null) headers['If-Match'] = String(version);
  return apiJson(
    await fetch(`/api/source/${sourceId}/item/${itemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    }),
  );
}

export async function apiDeleteItem(sourceId: string, itemId: string): Promise<void> {
  await apiJson(await fetch(`/api/source/${sourceId}/item/${itemId}`, { method: 'DELETE' }));
}

export async function apiPutPhases(sourceId: string, phases: TimelinePhase[]): Promise<void> {
  await apiJson(
    await fetch(`/api/source/${sourceId}/phases`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phases }),
    }),
  );
}

// Pricing is edited row-by-row through the granular endpoints (like items), not
// as a whole-model blob — so a single feature edit no longer clobbers concurrent
// changes. The browser edits the matrix (features, tiers, cells); highlights and
// the version list are still authored via MCP.
//
// The optimistic-lock counter for a pricing entity is ALWAYS sent as If-Match and
// never in the body: on a feature, `version` is the domain "available from" label,
// not the lock counter (see the same note in scripts/db/api.ts).
function lockHeaders(rowVersion?: number): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (rowVersion != null) headers['If-Match'] = String(rowVersion);
  return headers;
}

/**
 * Patch a single pricing feature with optimistic locking. `rowVersion` is the
 * feature's server-managed lock counter (sent as If-Match). Throws ConflictError
 * on a stale version. Returns the stored feature (with the bumped rowVersion).
 */
export async function apiUpdateFeature(
  sourceId: string,
  featureId: string,
  patch: Partial<PricingFeature>,
  rowVersion?: number,
): Promise<PricingFeature> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/feature/${featureId}`, {
      method: 'PATCH',
      headers: lockHeaders(rowVersion),
      body: JSON.stringify(patch),
    }),
  );
}

export async function apiDeleteFeature(sourceId: string, featureId: string): Promise<void> {
  await apiJson(await fetch(`/api/source/${sourceId}/feature/${featureId}`, { method: 'DELETE' }));
}

/** Create a pricing feature; returns the stored row (with its rowVersion). */
export async function apiAddFeature(sourceId: string, feature: PricingFeature): Promise<PricingFeature> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feature),
    }),
  );
}

/**
 * Reposition a feature relative to exactly one anchor feature. The server holds
 * the `sort` column and renumbers, returning the resulting full id order — so the
 * caller adopts that rather than guessing at the new order itself.
 */
export async function apiMoveFeature(
  sourceId: string,
  featureId: string,
  anchor: { after?: string; before?: string },
): Promise<string[]> {
  const res = await apiJson(
    await fetch(`/api/source/${sourceId}/feature-move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId, ...anchor }),
    }),
  );
  return (res?.order ?? []) as string[];
}

/** Create a pricing tier (matrix column); returns the stored row. */
export async function apiAddTier(sourceId: string, tier: PricingTier): Promise<PricingTier> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/tier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tier),
    }),
  );
}

/** Patch a tier's Stammdaten with optimistic locking on its `rowVersion`. */
export async function apiUpdateTier(
  sourceId: string,
  tierId: string,
  patch: Partial<PricingTier>,
  rowVersion?: number,
): Promise<PricingTier> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/tier/${tierId}`, {
      method: 'PATCH',
      headers: lockHeaders(rowVersion),
      body: JSON.stringify(patch),
    }),
  );
}

export async function apiDeleteTier(sourceId: string, tierId: string): Promise<void> {
  await apiJson(await fetch(`/api/source/${sourceId}/tier/${tierId}`, { method: 'DELETE' }));
}

/**
 * Write one matrix cell (tier × feature). A `false`/`null` value clears it. There
 * is no locking here on purpose: a cell is a single atomic value, so the server
 * keeps no rowVersion for it and two people editing different cells never
 * collide. `availableFrom` gates from which version the cell counts as included
 * (null = from the start).
 */
export async function apiSetTierValue(
  sourceId: string,
  tierId: string,
  featureId: string,
  value: string | boolean | null,
  availableFrom: string | null,
): Promise<void> {
  await apiJson(
    await fetch(`/api/source/${sourceId}/tier-value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId, featureId, value, availableFrom }),
    }),
  );
}

export async function loadSource(source: ViewSource): Promise<LoadResult> {
  const { kind, id } = source;

  if (kind === 'local') {
    // A file the user owns. Which of the two paths applies was decided by the
    // build (see ViewSource.editable), so there is no probing here: an editable
    // local source that cannot reach the API fails loudly rather than quietly
    // dropping to the built copy. Falling back would show a stale snapshot that
    // looks exactly like the live file, the same trap the DB path below avoids.
    if (source.editable) {
      const res = await fetch(`/api/source/${id}`).catch(() => null);
      if (res && res.ok) {
        return { file: await res.json(), editable: true, live: parseLive(res.headers.get('X-Source-Live')) };
      }
      const reason = res ? `HTTP ${res.status}` : 'keine Verbindung zur API';
      throw new Error(`Lokale Quelle „${id}“ konnte nicht geladen werden (${reason}).`);
    }
    // Static deploy: no process to write with, so the built copy is served
    // read-only. The file genuinely IS the source here, not a snapshot of
    // something live, which is why loading it is correct rather than a fallback.
    const res = await fetch(dataUrl(`sources/${id}.json`)).catch(() => null);
    if (res && res.ok) {
      return { file: await res.json(), editable: false, live: 'none' };
    }
    const reason = res ? `HTTP ${res.status}` : 'keine Verbindung';
    throw new Error(`Datei-Quelle „${id}“ konnte nicht geladen werden (${reason}).`);
  }

  // DB source: served only live from the DB via the API. There is deliberately
  // NO static /data/sources fallback here — a stale committed snapshot is
  // visually indistinguishable from live data and was repeatedly mistaken for
  // the real thing (a DB outage, or an id mismatch that 404s). Any failure to
  // read from the DB surfaces loudly instead of silently showing old data.
  const apiRes = await fetch(`/api/source/${id}`).catch(() => null);
  if (apiRes && apiRes.ok) {
    return { file: await apiRes.json(), editable: true, live: parseLive(apiRes.headers.get('X-Source-Live')) };
  }
  // Session lapsed while the tab was open (a live-reload re-fetch) — send the
  // user to the login instead of surfacing a bare "HTTP 401".
  if (apiRes && apiRes.status === 401) handleSessionExpired();
  const reason = apiRes ? `HTTP ${apiRes.status}` : 'keine Verbindung zur API';
  throw new Error(
    `Timeline „${id}“ konnte nicht aus der DB geladen werden (${reason}).`,
  );
}

export function ensureItemIds(file: TimelineFile): boolean {
  let changed = false;
  const used = new Set(file.items.map((i) => i.id).filter(Boolean) as string[]);
  let counter = 1;
  for (const item of file.items) {
    if (item.id) continue;
    let candidate = `i${counter}`;
    while (used.has(candidate)) {
      counter += 1;
      candidate = `i${counter}`;
    }
    item.id = candidate;
    used.add(candidate);
    changed = true;
  }
  return changed;
}

export function generateNewId(file: TimelineFile, prefix = 'i'): string {
  const used = new Set(file.items.map((i) => i.id).filter(Boolean) as string[]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// Date ⇄ calendar-day conversion lives in one place — see src/date.ts. Re-export
// so existing `import { isoDateOnly } from './editor'` call sites keep working.
export { isoDateOnly } from './date';

export function findItemIndex(file: TimelineFile, id: string): number {
  return file.items.findIndex((it) => it.id === id);
}

export function parseDependsOn(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

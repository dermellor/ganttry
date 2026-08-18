import { dataUrl } from './data-base';
import { ConflictError } from './pluginHost/errors';
import { assignMissingItemIds, nextItemId } from './itemId';
import { t } from './i18n';
import type {
  SavedView,
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

// Thrown when a write is rejected because the row changed server-side (409).
//
// The class moved into `pluginHost/errors.ts`, which is part of the plugin
// contract: a plugin sending `If-Match` through the host API has to be able to
// catch this, and it cannot import the app's editor. Re-exported from here because
// this is the path the app's own call sites use.
export { ConflictError } from './pluginHost/errors';

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

export async function apiJson(res: Response): Promise<any> {
  if (res.status === 401) handleSessionExpired();
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) throw new ConflictError((data as any).message || 'version conflict');
  // Prefer the server's human message (e.g. the overlapping-phases reason) over
  // the terse error code.
  if (!res.ok) throw new Error((data as any).message || (data as any).error || `HTTP ${res.status}`);
  return data;
}

// ---- saved views -----------------------------------------------------------
//
// The endpoint answers per caller (a private view of somebody else is never in
// the list), so nothing here filters: what arrives is what this person may see.

/** Create one. `name` is required; the server derives the id and owns it. */
export async function apiCreateSavedView(
  sourceId: string,
  view: Record<string, unknown>,
): Promise<SavedView> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/saved-view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(view),
    }),
  );
}

/**
 * Patch one, with the same optimistic lock every other write here uses: an
 * explicit `null` clears `mode` / `groupBy` / `filters`, an absent key leaves it.
 */
export async function apiUpdateSavedView(
  sourceId: string,
  viewId: string,
  patch: Record<string, unknown>,
  version?: number,
): Promise<SavedView> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (version != null) headers['If-Match'] = String(version);
  return apiJson(
    await fetch(`/api/source/${sourceId}/saved-view/${encodeURIComponent(viewId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    }),
  );
}

export async function apiDeleteSavedView(sourceId: string, viewId: string): Promise<void> {
  await apiJson(
    await fetch(`/api/source/${sourceId}/saved-view/${encodeURIComponent(viewId)}`, {
      method: 'DELETE',
    }),
  );
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

/**
 * Patch the timeline's own metadata: name, description, groupBy, customFields.
 *
 * Only the keys present are touched, and an explicit `null` clears one
 * (`'name' in meta` plus `?? null` in the repo), which is why the caller sends a
 * cleared field as null rather than as an empty string. No `If-Match`: this route
 * has none, unlike an item PATCH — the fields are independent scalars rather than a
 * row two people edit in the same second, and inventing a version for them would
 * mean inventing one in three repositories.
 */
export async function apiUpdateMeta(
  sourceId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await apiJson(
    await fetch(`/api/source/${sourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

/**
 * Whether a plugin is switched on for this timeline, and what it was given.
 *
 * A GET rather than a read off the loaded file, because the answer includes two
 * facts the file does not carry: whether the instance has the plugin installed at
 * all, and whether the instance has it enabled. A timeline can only switch on what
 * the instance offers (docs/plugin-lifecycle.md).
 */
export async function apiGetPlugin(
  sourceId: string,
  pluginId: string,
): Promise<{
  installed: boolean;
  instanceEnabled: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  public: boolean;
}> {
  return apiJson(
    await fetch(`/api/source/${sourceId}/plugin/${encodeURIComponent(pluginId)}`),
  );
}

/**
 * Switch a plugin on for this timeline, or write its config again.
 *
 * The same call for both, because the row is the enablement: writing it is an
 * upsert on `timeline_plugins` and there is no separate „enabled" flag to toggle.
 */
export async function apiEnablePlugin(
  sourceId: string,
  pluginId: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  await apiJson(
    await fetch(`/api/source/${sourceId}/plugin/${encodeURIComponent(pluginId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config }),
    }),
  );
}

/**
 * Switch a plugin off for this timeline.
 *
 * Deletes the row and nothing else. The rows the plugin owns stay where they are,
 * so switching it on again finds its data — see „What an uninstall does to the
 * data" (docs/plugin-lifecycle.md). Destroying that data is a separate, explicit
 * operation and deliberately not reachable from here.
 */
export async function apiDisablePlugin(sourceId: string, pluginId: string): Promise<void> {
  await apiJson(
    await fetch(`/api/source/${sourceId}/plugin/${encodeURIComponent(pluginId)}`, {
      method: 'DELETE',
    }),
  );
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
      const reason = res ? `HTTP ${res.status}` : t('sync.noApi');
      throw new Error(t('refusal.source.localFailed', { id, reason }));
    }
    // Static deploy: no process to write with, so the built copy is served
    // read-only. The file genuinely IS the source here, not a snapshot of
    // something live, which is why loading it is correct rather than a fallback.
    const res = await fetch(dataUrl(`sources/${id}.json`)).catch(() => null);
    if (res && res.ok) {
      return { file: await res.json(), editable: false, live: 'none' };
    }
    const reason = res ? `HTTP ${res.status}` : t('sync.offline');
    throw new Error(t('refusal.source.fileFailed', { id, reason }));
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
  // A refusal is not a malfunction, and „HTTP 403" reads like one. The person
  // in front of it can do exactly one thing about it, so the message says that
  // instead of a status code. Deliberately NOT a redirect: they are signed in,
  // and sending them back to a login they already passed is a loop.
  if (apiRes && apiRes.status === 403) {
    throw new Error(t('refusal.source.forbidden', { id }));
  }
  const reason = apiRes ? `HTTP ${apiRes.status}` : t('sync.noApi');
  throw new Error(t('refusal.source.dbFailed', { id, reason }));
}

// Both wrap the shared rule in ./itemId.ts, which the server's granular create
// uses as well — the id scheme is one rule, not one per runtime.
export function ensureItemIds(file: TimelineFile): boolean {
  return assignMissingItemIds(file.items);
}

export function generateNewId(file: TimelineFile, prefix = 'i'): string {
  return nextItemId(file.items.map((i) => i.id).filter(Boolean) as string[], prefix);
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

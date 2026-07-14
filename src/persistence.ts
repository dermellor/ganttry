// Persistence, realtime sync, and the live-edit throttle. Diffs the in-memory
// source against the last-saved snapshot and issues item-level writes so
// concurrent edits don't clobber each other.

import type { TimelineFileItem } from './types';
import {
  apiAddItem,
  apiUpdateItem,
  apiDeleteItem,
  apiPutPhases,
  ConflictError,
} from './editor';
import { isRealtimeEnabled, subscribeTimeline, joinPresence } from './realtime';
import { renderPresence } from './presence';
import { state, els, setStatus, PERSIST_THROTTLE_MS } from './state';
import { renderTimeline } from './render';
import { applyItemForm, refreshItemAudit } from './itemForm';

export function schedulePersist(): void {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(persist, 250);
}

// Order-independent deep clone used for canonical serialization: sorts object
// keys at every level (arrays keep their order — element order is meaningful,
// e.g. tags / dependsOn). A recursive sort, NOT a JSON.stringify array-replacer:
// an array replacer whitelists keys and, applied to nested objects too, silently
// dropped everything inside `metadata` (tags, dependsOn, owner, jira, custom
// fields) from the diff — so metadata-only edits looked unchanged and never
// persisted. Sorting recursively keeps that content while staying stable against
// key-order churn between the server row and the in-memory model.
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// Canonical JSON of an item with the server-managed audit fields stripped, so
// content changes (including inside `metadata`) are detected but a version bump
// / re-attribution alone is not.
export function canonicalItem(item: TimelineFileItem): string {
  const { version: _v, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...rest } =
    item;
  return JSON.stringify(sortDeep(rest));
}

// Optional item columns that can be cleared. A PATCH only touches a column when
// the key is present, so a field the user emptied (e.g. removed the last
// `metadata.dependsOn`, which drops `metadata` entirely) must be sent as an
// explicit `null` — otherwise the omitted key leaves the stale DB value intact
// and it reappears on reload.
const CLEARABLE_ITEM_FIELDS: (keyof TimelineFileItem)[] = [
  'end',
  'duration',
  'group',
  'title',
  'type',
  'className',
  'icon',
  'body',
  'metadata',
];

// Build the PATCH body for an item update: all current fields (minus id +
// server-managed audit) plus an explicit `null` for every clearable field the
// item no longer carries, so the server resets those columns.
function buildItemPatch(item: TimelineFileItem): Record<string, unknown> {
  const { id: _id, version: _v, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...rest } =
    item;
  const patch: Record<string, unknown> = { ...rest };
  for (const k of CLEARABLE_ITEM_FIELDS) {
    if (!(k in patch)) patch[k] = null;
  }
  return patch;
}

// Copy the server-managed audit fields from a saved item back onto the
// in-memory item, then refresh the open form's audit block if it's showing it.
function adoptAudit(target: TimelineFileItem, saved: TimelineFileItem): void {
  target.version = saved.version;
  if (saved.createdAt != null) target.createdAt = saved.createdAt;
  if (saved.createdBy != null) target.createdBy = saved.createdBy;
  if (saved.updatedAt != null) target.updatedAt = saved.updatedAt;
  if (saved.updatedBy != null) target.updatedBy = saved.updatedBy;
  if (target.id && target.id === state.activeFormItemId) refreshItemAudit(target);
}

// Rebuild the saved-state snapshot from the current in-memory file. Called
// after a load and after every successful persist.
export function snapshotSaved(): void {
  state.savedItems = new Map();
  state.savedItemVersions = new Map();
  for (const it of state.activeSourceFile?.items ?? []) {
    if (!it.id) continue;
    state.savedItems.set(it.id, canonicalItem(it));
    if (it.version != null) state.savedItemVersions.set(it.id, it.version);
  }
  state.savedPhasesJson = JSON.stringify(state.activeSourceFile?.phases ?? []);
}

// True when the in-memory model differs from the last-saved snapshot, i.e. there
// are local edits not yet written to the server. Mirrors the diff persist() uses
// (add / change / delete / phases). Used to stop a remote refresh from
// clobbering an edit the user just made but that hasn't persisted yet.
export function hasUnsavedChanges(): boolean {
  const file = state.activeSourceFile;
  if (!file) return false;
  const currentIds = new Set<string>();
  for (const it of file.items) {
    if (!it.id) continue;
    currentIds.add(it.id);
    const prev = state.savedItems.get(it.id);
    if (prev === undefined || prev !== canonicalItem(it)) return true;
  }
  for (const id of state.savedItems.keys()) if (!currentIds.has(id)) return true;
  return JSON.stringify(file.phases ?? []) !== state.savedPhasesJson;
}

export async function persist(): Promise<void> {
  if (!state.activeSourceId || !state.activeSourceFile) return;
  if (state.persisting) {
    state.persistAgain = true; // coalesce edits that land mid-save
    return;
  }
  state.persisting = true;
  const sourceId = state.activeSourceId;
  const file = state.activeSourceFile;
  try {
    const currentIds = new Set(file.items.map((it) => it.id).filter(Boolean) as string[]);

    // Additions + updates.
    for (const it of file.items) {
      if (!it.id) continue;
      const canon = canonicalItem(it);
      const prev = state.savedItems.get(it.id);
      if (prev === undefined) {
        setStatus('Speichere…');
        const saved = await apiAddItem(sourceId, it);
        adoptAudit(it, saved);
        state.savedItems.set(it.id, canonicalItem(it));
        if (saved.version != null) state.savedItemVersions.set(it.id, saved.version);
      } else if (prev !== canon) {
        setStatus('Speichere…');
        const patch = buildItemPatch(it);
        const saved = await apiUpdateItem(sourceId, it.id, patch, state.savedItemVersions.get(it.id));
        adoptAudit(it, saved);
        state.savedItems.set(it.id, canonicalItem(it));
        if (saved.version != null) state.savedItemVersions.set(it.id, saved.version);
      }
    }

    // Deletions.
    for (const oldId of [...state.savedItems.keys()]) {
      if (!currentIds.has(oldId)) {
        setStatus('Speichere…');
        await apiDeleteItem(sourceId, oldId);
        state.savedItems.delete(oldId);
        state.savedItemVersions.delete(oldId);
      }
    }

    // Phases (replaced as a unit — small, rarely edited).
    const phasesJson = JSON.stringify(file.phases ?? []);
    if (phasesJson !== state.savedPhasesJson) {
      setStatus('Speichere…');
      await apiPutPhases(sourceId, file.phases ?? []);
      state.savedPhasesJson = phasesJson;
    }

    setStatus(`Gespeichert · ${file.items.length} items`);
  } catch (err) {
    if (err instanceof ConflictError) {
      // Someone edited the same item concurrently — reload authoritative state.
      setStatus('Konflikt: extern geändert, lade neu…');
      state.persisting = false;
      state.persistAgain = false;
      if (state.activeView) await renderTimeline(state.activeView);
      return;
    }
    console.error(err);
    setStatus(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.persisting = false;
    if (state.persistAgain) {
      state.persistAgain = false;
      void persist();
    }
  }
}

// Reload the active source from the server and re-render, preserving the
// current viewport. Used when a remote change arrives via realtime.
export function scheduleRemoteRefresh(): void {
  if (state.realtimeRefreshTimer) clearTimeout(state.realtimeRefreshTimer);
  state.realtimeRefreshTimer = setTimeout(async () => {
    if (!state.activeView) return;
    // A remote refresh reloads the source from the server and rebuilds the
    // timeline — which would silently discard any local edit that hasn't been
    // persisted yet (e.g. a drag whose 250 ms save debounce is still pending).
    // Flush first, then reload; if edits are still in flight afterwards, defer.
    if (state.persisting || hasUnsavedChanges()) {
      await persist();
      // Still saving (in-flight or coalesced) → retry shortly.
      if (state.persisting || state.persistAgain) {
        scheduleRemoteRefresh();
        return;
      }
      // Persist finished but we're still dirty → the write failed. Keep the
      // local edits and skip the reload rather than discard them or busy-loop;
      // the next realtime event or user action will retry.
      if (hasUnsavedChanges()) return;
    }
    if (!state.activeView) return;
    const win = state.timeline?.getWindow();
    if (win) state.pendingWindow = { start: new Date(win.start), end: new Date(win.end) };
    void renderTimeline(state.activeView);
  }, 400);
}

// (Re)subscribe to realtime changes for the active editable DB source.
export function setupRealtime(): void {
  if (state.realtimeUnsub) {
    state.realtimeUnsub();
    state.realtimeUnsub = null;
  }

  const editableSourceId =
    isRealtimeEnabled() && state.activeSourceId && state.activeSourceEditable
      ? state.activeSourceId
      : null;

  // Presence lifecycle: only (re)join when the source actually changes.
  // setupRealtime re-runs on every same-view re-render (live edits, remote
  // refreshes); re-subscribing each time would flap the header badge and
  // broadcast a leave/join churn to the other connected clients.
  if (editableSourceId !== state.presenceSourceId) {
    if (state.presenceUnsub) {
      state.presenceUnsub();
      state.presenceUnsub = null;
    }
    renderPresence([], state.currentUser?.email ?? null);
    state.presenceSourceId = editableSourceId;
    if (editableSourceId) {
      // Fall back to an anonymous identity when /api/me returned nothing.
      const me = state.currentUser ?? { email: 'anon', name: 'Gast' };
      state.presenceUnsub = joinPresence(editableSourceId, me, (users) => {
        if (state.presenceSourceId !== editableSourceId) return; // stale
        renderPresence(users, me.email);
      });
    }
  }

  if (!editableSourceId) return;
  const sourceId = editableSourceId;
  state.realtimeUnsub = subscribeTimeline(sourceId, (change) => {
    if (state.activeSourceId !== sourceId) return; // stale event after a view switch
    // Suppress our own echo: we already hold this exact version.
    if (
      change.table === 'timeline_items' &&
      change.version != null &&
      state.savedItemVersions.get(change.id) === change.version
    ) {
      return;
    }
    // Don't clobber a form the user is editing — just flag it.
    if (change.table === 'timeline_items' && change.id === state.activeFormItemId) {
      setStatus('Dieser Eintrag wurde extern geändert — beim Speichern wird neu geladen.');
      return;
    }
    scheduleRemoteRefresh();
  });
}

// Applies the open item form to the in-memory model (no DB write) and clears
// the pending live-edit tick. Shared by the live-edit tick and the commit path.
export function flushLiveEditToModel(): void {
  if (state.liveEditTimer) {
    clearTimeout(state.liveEditTimer);
    state.liveEditTimer = null;
  }
  if (!state.activeFormItemId) return;
  // The form's DOM is being torn down/rebuilt (item switch). The focusout the
  // teardown fires must not commit the outgoing form onto the incoming item.
  if (state.formRebuilding) return;
  const form = els.detailBody.querySelector<HTMLFormElement>('form.item-form');
  if (!form) return;
  // Write the form's values back to the item the form was actually built for
  // (its own data-id), not to state.activeFormItemId. When switching items,
  // activeFormItemId is updated before the form HTML is swapped; tearing down
  // the old (focused) form fires a focusout → commit whose activeFormItemId is
  // already the *new* item, which would otherwise overwrite it with the old
  // form's values. The data-id is the single source of truth for the form.
  const formId = form.dataset.id ?? state.activeFormItemId;
  applyItemForm(formId, form);
}

export function scheduleThrottledPersist(): void {
  if (state.throttlePersistTimer) return; // a write is already queued in this window
  const wait = Math.max(0, PERSIST_THROTTLE_MS - (Date.now() - state.lastFormPersistAt));
  state.throttlePersistTimer = setTimeout(() => {
    state.throttlePersistTimer = null;
    state.lastFormPersistAt = Date.now();
    void persist();
  }, wait);
}

export function cancelThrottledPersist(): void {
  if (state.throttlePersistTimer) {
    clearTimeout(state.throttlePersistTimer);
    state.throttlePersistTimer = null;
  }
}

export function scheduleLiveEdit(): void {
  if (state.liveEditTimer) clearTimeout(state.liveEditTimer);
  state.liveEditTimer = setTimeout(() => {
    flushLiveEditToModel();
    // Periodic DB write so collaborators see edits while the field stays focused.
    scheduleThrottledPersist();
  }, 100);
}

// Flushes any pending live edit and persists the source immediately. Called on
// field blur and whenever the item sidebar is left (closed, another item
// opened, view switched, unload).
export function commitItemForm(): void {
  cancelThrottledPersist();
  flushLiveEditToModel();
  if (!state.activeFormItemId) return;
  state.lastFormPersistAt = Date.now();
  void persist();
}

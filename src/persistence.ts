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
import { isRealtimeEnabled, subscribeTimeline } from './realtime';
import { state, els, setStatus, PERSIST_THROTTLE_MS } from './state';
import { renderTimeline } from './render';
import { applyItemForm } from './itemForm';

export function schedulePersist(): void {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(persist, 250);
}

// Canonical JSON of an item with the server-managed `version` stripped, so
// content changes are detected but a version bump alone is not.
export function canonicalItem(item: TimelineFileItem): string {
  const { version: _v, ...rest } = item;
  return JSON.stringify(rest, Object.keys(rest).sort());
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
        it.version = saved.version;
        state.savedItems.set(it.id, canonicalItem(it));
        if (saved.version != null) state.savedItemVersions.set(it.id, saved.version);
      } else if (prev !== canon) {
        setStatus('Speichere…');
        const { id: _id, version: _v, ...patch } = it;
        const saved = await apiUpdateItem(sourceId, it.id, patch, state.savedItemVersions.get(it.id));
        it.version = saved.version;
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
  state.realtimeRefreshTimer = setTimeout(() => {
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
  if (!isRealtimeEnabled() || !state.activeSourceId || !state.activeSourceEditable) return;
  const sourceId = state.activeSourceId;
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
  const form = els.detailBody.querySelector<HTMLFormElement>('form.item-form');
  if (form) applyItemForm(state.activeFormItemId, form);
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

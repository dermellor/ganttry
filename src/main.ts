// App entry point: loads config + notes, wires the header/footer controls and
// URL-state syncing, and delegates rendering and editing to the feature modules
// (render, itemForm, phaseForm, detailPanel, persistence). Shared mutable state
// and DOM refs live in state.ts.

import 'vis-timeline/styles/vis-timeline-graph2d.css';
import { escapeHtml } from './buildItems';
import type { Config, NotesData } from './types';
import {
  onExternalUrlStateChange,
  readUrlState,
  type UrlState,
} from './urlState';
import {
  state,
  els,
  setStatus,
  syncUrl,
  isEditableView,
  BRAND_MODE,
  DEFAULT_BRAND,
  MILESTONES_ONLY_KEY,
  VIEW_MODE_KEY,
  type ViewMode,
} from './state';
import {
  renderTimeline,
  filterBuildForDisplay,
  timelineItems,
  applyBuildToDataSets,
  statusFor,
  addNewItem,
  repackLanes,
} from './render';
import { commitItemForm } from './persistence';
import type { PresenceUser } from './presence';
import { deleteItem } from './itemForm';
import { hideDetail, showDetailForId } from './detailPanel';
import { renderListView, setupListView } from './listView';

// Is the keyboard focus currently in a place where a keystroke means "type",
// not "act on the selected item"? Guards the global Delete shortcut so it never
// fires while editing a form field.
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

async function loadConfig(): Promise<Config> {
  const res = await fetch('/data/config.json');
  if (!res.ok) throw new Error(`Could not load config: ${res.status}`);
  return res.json();
}

async function loadNotes(): Promise<NotesData> {
  const res = await fetch('/data/notes.json');
  if (!res.ok) throw new Error(`Could not load notes data: ${res.status}`);
  return res.json();
}

// Who am I? Powers the header presence badge (labels our own avatar). Best-effort:
// any failure just leaves the identity unknown, presence still works anonymously.
async function loadCurrentUser(): Promise<PresenceUser | null> {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: unknown; name?: unknown };
    if (typeof data.email === 'string' && data.email) {
      return { email: data.email, name: typeof data.name === 'string' ? data.name : undefined };
    }
    return null;
  } catch {
    return null;
  }
}

function applyBrand(brand: string) {
  document.body.dataset.brand = brand;
  state.currentBrand = brand;
  if (BRAND_MODE === 'select') {
    localStorage.setItem('timelines.brand', brand);
  }
  els.brandSelect.value = brand;
  syncUrl();
}

async function applyView(viewId: string) {
  if (!state.config) return;
  const view = state.config.views.find((v) => v.id === viewId);
  if (!view) return;
  // Switching views leaves any open item form → persist it first.
  commitItemForm();
  localStorage.setItem('timelines.view', viewId);
  els.viewSelect.value = viewId;
  hideDetail();
  await renderTimeline(view);
  syncUrl();
}

// Reflect the active view mode on the segmented icon toggle (aria-pressed drives
// the highlighted state via CSS).
function setModeButtons(mode: ViewMode) {
  els.modeTimelineBtn.setAttribute('aria-pressed', String(mode === 'timeline'));
  els.modeListBtn.setAttribute('aria-pressed', String(mode === 'list'));
}

// Switch between the timeline and the list rendering of the same build. The
// timeline instance is kept alive (just hidden) so all edit machinery — drags,
// the form, persistence — keeps working; the list is a second view of the same
// data. `persist` is false during bootstrap/external-URL application where the
// caller drives localStorage + URL syncing itself.
function applyViewMode(mode: ViewMode, { persist = true }: { persist?: boolean } = {}) {
  state.viewMode = mode;
  setModeButtons(mode);
  const list = mode === 'list';
  els.timeline.hidden = list;
  els.list.hidden = !list;
  if (list) {
    renderListView();
  } else {
    // The timeline was display:none while the list showed, so vis-timeline
    // couldn't size itself. Redraw + re-pack point lanes now that it's visible.
    state.timeline?.redraw();
    repackLanes();
  }
  if (persist) {
    localStorage.setItem(VIEW_MODE_KEY, mode);
    syncUrl();
  }
}

async function handleExport() {
  if (!state.activeView || !state.activeBuild) return;
  const brand = document.body.dataset.brand || 'marcel-mellor';
  const original = els.exportBtn.textContent;
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = 'Exportiere…';
  try {
    const { exportTimelineHtml } = await import('./export');
    const filtered = filterBuildForDisplay(state.activeBuild);
    // The export renders a vis-timeline too, so start-less items are excluded
    // (they can't be placed) — mirroring the live timeline view.
    await exportTimelineHtml({
      view: state.activeView,
      build: { ...state.activeBuild, items: timelineItems(filtered.items), groups: filtered.groups },
      brand,
    });
  } catch (err) {
    console.error(err);
    alert(`Export fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    els.exportBtn.disabled = false;
    els.exportBtn.textContent = original;
  }
}

async function bootstrap() {
  setStatus('Lade Konfiguration & Notizen…');

  const [cfg, notesData, currentUser] = await Promise.all([
    loadConfig(),
    loadNotes(),
    loadCurrentUser(),
  ]);
  state.config = cfg;
  state.allNotes = notesData.notes;
  state.currentUser = currentUser;

  els.viewSelect.innerHTML = cfg.views
    .map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`)
    .join('');

  const urlState = readUrlState();

  const savedView = localStorage.getItem('timelines.view') ?? cfg.defaultView;
  const initialView = urlState.view && cfg.views.some((v) => v.id === urlState.view)
    ? urlState.view
    : cfg.views.some((v) => v.id === savedView)
      ? savedView
      : cfg.defaultView;

  let brand: string;
  if (BRAND_MODE === 'fixed') {
    brand = DEFAULT_BRAND;
  } else {
    brand = urlState.brand ?? localStorage.getItem('timelines.brand') ?? DEFAULT_BRAND;
  }

  if (BRAND_MODE === 'fixed') {
    els.brandControl.remove();
  }

  if (urlState.milestones != null) {
    state.milestonesOnly = !!urlState.milestones;
    localStorage.setItem(MILESTONES_ONLY_KEY, String(state.milestonesOnly));
  }

  if (urlState.mode) {
    state.viewMode = urlState.mode;
    localStorage.setItem(VIEW_MODE_KEY, urlState.mode);
  }
  setModeButtons(state.viewMode);
  setupListView();

  state.pendingItem = urlState.item ?? null;
  if (urlState.from && urlState.to) {
    const startD = new Date(urlState.from);
    const endD = new Date(urlState.to);
    if (!Number.isNaN(startD.getTime()) && !Number.isNaN(endD.getTime())) {
      state.pendingWindow = { start: startD, end: endD };
    }
  }

  state.suppressUrlSync = true;
  applyBrand(brand);
  await applyView(initialView);
  applyViewMode(state.viewMode, { persist: false });
  state.suppressUrlSync = false;
  syncUrl();

  // Safety net: flush + persist an open item form if the tab closes mid-edit.
  window.addEventListener('beforeunload', () => commitItemForm());

  els.milestonesOnly.checked = state.milestonesOnly;
  els.milestonesOnly.addEventListener('change', () => {
    state.milestonesOnly = els.milestonesOnly.checked;
    localStorage.setItem(MILESTONES_ONLY_KEY, String(state.milestonesOnly));
    if (state.activeView && state.activeBuild) {
      applyBuildToDataSets();
      setStatus(statusFor(state.activeView, state.activeBuild));
      state.timeline?.redraw();
    }
    syncUrl();
  });

  els.viewSelect.addEventListener('change', () => {
    state.selectedItemId = null;
    state.userWindow = null;
    state.pendingItem = null;
    state.pendingWindow = null;
    applyView(els.viewSelect.value);
  });
  els.modeTimelineBtn.addEventListener('click', () => applyViewMode('timeline'));
  els.modeListBtn.addEventListener('click', () => applyViewMode('list'));
  els.brandSelect.addEventListener('change', () => applyBrand(els.brandSelect.value));
  els.detailClose.addEventListener('click', () => {
    commitItemForm();
    state.selectedItemId = null;
    state.timeline?.setSelection([]);
    hideDetail();
    if (state.viewMode === 'list') renderListView();
    syncUrl();
  });
  els.addBtn.addEventListener('click', () => addNewItem());
  els.exportBtn.addEventListener('click', handleExport);

  // Delete key (and Mac's ⌫) removes the item whose edit form is open — as long
  // as focus is not inside a form field. deleteItem() shows its own confirm.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;
    if (!isEditableView() || !state.activeFormItemId) return;
    e.preventDefault();
    deleteItem(state.activeFormItemId);
  });

  onExternalUrlStateChange((incoming) => applyExternalState(incoming));
}

async function applyExternalState(incoming: UrlState): Promise<void> {
  if (!state.config) return;
  state.suppressUrlSync = true;
  try {
    if (BRAND_MODE === 'select') {
      const brand = incoming.brand ?? DEFAULT_BRAND;
      if (brand !== state.currentBrand) applyBrand(brand);
    }

    const wantMilestones = !!incoming.milestones;
    if (wantMilestones !== state.milestonesOnly) {
      state.milestonesOnly = wantMilestones;
      els.milestonesOnly.checked = wantMilestones;
      localStorage.setItem(MILESTONES_ONLY_KEY, String(wantMilestones));
      if (state.activeView && state.activeBuild) {
        applyBuildToDataSets();
        setStatus(statusFor(state.activeView, state.activeBuild));
        state.timeline?.redraw();
      }
    }

    const wantMode: ViewMode = incoming.mode === 'list' ? 'list' : 'timeline';

    const targetViewId = incoming.view ?? state.config.defaultView;
    const targetWindow = incoming.from && incoming.to
      ? (() => {
          const s = new Date(incoming.from!);
          const e = new Date(incoming.to!);
          return !Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())
            ? { start: s, end: e }
            : null;
        })()
      : null;

    if (state.activeView?.id !== targetViewId) {
      state.pendingItem = incoming.item ?? null;
      state.pendingWindow = targetWindow;
      await applyView(targetViewId);
    } else {
      if (incoming.item && incoming.item !== state.selectedItemId) {
        state.selectedItemId = incoming.item;
        try {
          state.timeline?.setSelection([incoming.item]);
        } catch {
          /* ignore */
        }
        showDetailForId(incoming.item);
      } else if (!incoming.item && state.selectedItemId) {
        state.timeline?.setSelection([]);
        state.selectedItemId = null;
        hideDetail();
      }
      if (targetWindow && state.timeline) {
        state.timeline.setWindow(targetWindow.start, targetWindow.end, { animation: false });
        state.userWindow = targetWindow;
      }
    }

    if (wantMode !== state.viewMode) localStorage.setItem(VIEW_MODE_KEY, wantMode);
    applyViewMode(wantMode, { persist: false });
  } finally {
    state.suppressUrlSync = false;
  }
}

bootstrap().catch((err) => {
  console.error(err);
  setStatus(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
});

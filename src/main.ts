// App entry point: loads the discovered config, wires the header/footer controls and
// URL-state syncing, and delegates rendering and editing to the feature modules
// (render, itemForm, phaseForm, detailPanel, persistence). Shared mutable state
// and DOM refs live in state.ts.

import 'vis-timeline/styles/vis-timeline-graph2d.css';
import { escapeHtml } from './buildItems';
import type { BuiltConfig } from './types';
import {
  onExternalUrlStateChange,
  parseUrlWindow,
  readUrlState,
  type UrlState,
} from './urlState';
import {
  state,
  els,
  setStatus,
  syncUrl,
  isEditableView,
  MILESTONES_ONLY_KEY,
  VIEW_MODE_KEY,
  GROUP_BY_KEY,
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
  applyGrouping,
  displayIdsFor,
} from './render';
import { GROUP_DIM } from './listGrouping';
import { commitItemForm } from './persistence';
import type { PresenceUser } from './presence';
import { loadUserDirectory } from './users';
import { deleteItem } from './itemForm';
import { hideDetail, showDetailForId } from './detailPanel';
import { renderListView, setupListView } from './listView';
import { setupFilterControl } from './filterControl';
import {
  activePlugins,
  ensurePluginLoaded,
  legacyViewMode,
  pluginAppliesTo,
  pluginViews,
  resolveViewMode,
  type PluginView,
} from './pluginHost/registry';
import { parsePluginViewMode, pluginViewMode, readViewMode } from './pluginHost/viewMode';
import {
  pluginViewButton,
  pluginViewButtons,
  pluginViewSection,
  showOnlyPluginSection,
} from './pluginHost/views';
import { dataUrl } from './data-base';
import { hideTimelineSkeleton, showTimelineSkeleton } from './timelineSkeleton';

// Is the keyboard focus currently in a place where a keystroke means "type",
// not "act on the selected item"? Guards the global Delete shortcut so it never
// fires while editing a form field.
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

async function loadConfig(): Promise<BuiltConfig> {
  const res = await fetch(dataUrl('config.json'));
  if (!res.ok) throw new Error(`Could not load config: ${res.status}`);
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
  updatePluginViews();
  syncUrl();
}

// Reflect the active view mode on the segmented icon toggle (aria-pressed drives
// the highlighted state via CSS).
function setModeButtons(mode: ViewMode) {
  els.modeTimelineBtn.setAttribute('aria-pressed', String(mode === 'timeline'));
  els.modeListBtn.setAttribute('aria-pressed', String(mode === 'list'));
  for (const [btnMode, btn] of pluginViewButtons()) {
    btn.setAttribute('aria-pressed', String(mode === btnMode));
  }
}

// Show a plugin's view button only while its plugin applies to the active
// timeline. If the current mode belongs to a plugin that no longer applies (e.g.
// after switching views), fall back to 'timeline' so the user isn't stuck on an
// empty section.
export function updatePluginViews(): void {
  // `activePlugins` is a cheap data check — it pulls in no plugin view code (that
  // only loads when a view is entered), so a generic timeline never downloads a
  // plugin's chunk.
  const available = new Set<string>();
  for (const plugin of activePlugins(state.activeSourceFile)) {
    const pluginId = plugin.manifest.id;
    for (const view of pluginViews(plugin)) {
      available.add(pluginViewMode(pluginId, view.id));
      pluginViewButton(els.modeToggle, pluginId, view, (m) => applyViewMode(m as ViewMode)).hidden = false;
      pluginViewSection(els.contentArea, pluginId, view);
    }
  }
  for (const [mode, btn] of pluginViewButtons()) {
    if (!available.has(mode)) btn.hidden = true;
  }
  const current = parsePluginViewMode(state.viewMode);
  if (!current) return;
  if (available.has(state.viewMode)) {
    // The plugin applies (again): enter the view the user last chose. A DB source
    // assembles its plugin model after the first paint, so this is the moment a
    // restored mode actually becomes renderable.
    applyViewMode(state.viewMode, { persist: false });
    return;
  }
  // Not available. Two different situations, and conflating them is what made a
  // restored view flicker away on load:
  //   - the plugin is still enabled here, its model just hasn't been assembled
  //     yet (DB sources do that a tick after the first paint) → wait, keep the
  //     mode, and this function renders it on the next call;
  //   - the plugin is not on this timeline at all (the user switched to a generic
  //     one) → leave the view for real, but without persisting: the stored choice
  //     belongs to the timeline the user picked it on.
  showOnlyPluginSection(null);
  els.timeline.hidden = false;
  els.viewToolbar.hidden = false;
  setModeButtons('timeline');
  if (!pluginAppliesTo(state.activeSourceFile, current.pluginId)) {
    state.viewMode = 'timeline';
  }
}

// Switch between the timeline and the list rendering of the same build. The
// timeline instance is kept alive (just hidden) so all edit machinery — drags,
// the form, persistence — keeps working; the list is a second view of the same
// data. `persist` is false during bootstrap/external-URL application where the
// caller drives localStorage + URL syncing itself.
function applyViewMode(mode: ViewMode, { persist = true }: { persist?: boolean } = {}) {
  // Guard: a plugin view is only valid while its plugin applies to this timeline.
  // A stale deep link or a stored mode from another timeline lands here.
  const parsed = parsePluginViewMode(mode);
  const target = parsed ? resolveViewMode(state.activeSourceFile, parsed.pluginId, parsed.viewId) : null;
  if (parsed && !target) mode = 'timeline';
  state.viewMode = mode;
  setModeButtons(mode);
  const list = mode === 'list';
  const plugin = target ? mode : null;
  els.timeline.hidden = list || !!plugin;
  els.list.hidden = !list;
  showOnlyPluginSection(plugin);
  // The grouping toolbar is shared by the timeline and list views; a plugin view
  // has to ask for it, because most of them render something other than the item
  // list and an inert toolbar above it implies otherwise.
  els.viewToolbar.hidden = !!plugin && !target?.view.toolbar;
  if (list) {
    renderListView();
  } else if (target && parsed) {
    // Lazy-load the plugin's chunk, then render — but only if we're still in that
    // mode by the time it resolves (the user may have switched away).
    const container = pluginViewSection(els.contentArea, parsed.pluginId, target.view);
    void ensurePluginLoaded(target.plugin).then((m) => {
      if (state.viewMode === mode) m.renderView(container, target.view.id);
    });
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
  setStatus('Lade Konfiguration…');
  // Before the config and the user directory are even in, so the first painted
  // frame shows the placeholder rather than an empty area. renderTimeline()
  // keeps it up for its own source fetch and takes it down when the chart is
  // built, which makes the two loads read as one.
  showTimelineSkeleton(els.timeline);

  const [cfg, currentUser] = await Promise.all([
    loadConfig(),
    loadCurrentUser(),
    // The user directory an item's Owner resolves against. Loaded once, up front,
    // because both the list's Owner column and the item form's picker read it
    // synchronously; fetching it also registers us in it (see src/users.ts).
    loadUserDirectory(),
  ]);
  state.config = cfg;
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

  if (urlState.milestones != null) {
    state.milestonesOnly = !!urlState.milestones;
    localStorage.setItem(MILESTONES_ONLY_KEY, String(state.milestonesOnly));
  }

  if (urlState.mode) {
    // A shared link may carry a pre-plugin mode id (`mode=pricing`), so it goes
    // through the same legacy lookup as the stored value.
    state.viewMode = readViewMode(urlState.mode, legacyViewMode);
    localStorage.setItem(VIEW_MODE_KEY, state.viewMode);
  }
  setModeButtons(state.viewMode);
  setupListView();
  setupFilterControl();

  state.pendingItem = urlState.item ?? null;
  state.pendingWindow = parseUrlWindow(urlState);

  state.suppressUrlSync = true;
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
      repackLanes();
      setStatus(statusFor(state.activeView, state.activeBuild));
      state.timeline?.redraw();
    }
    syncUrl();
  });

  els.viewSelect.addEventListener('change', () => {
    // Cleared before the switch so the presence re-join announces no item (the
    // old selection belongs to the view we're leaving).
    state.selectedItemId = null;
    state.userWindow = null;
    state.pendingItem = null;
    state.pendingWindow = null;
    applyView(els.viewSelect.value);
  });
  els.modeTimelineBtn.addEventListener('click', () => applyViewMode('timeline'));
  els.modeListBtn.addEventListener('click', () => applyViewMode('list'));
  // Shared grouping dropdown: drives both the timeline lanes and the list
  // sections. Persist the choice, then repaint whichever view is active.
  els.groupBy.addEventListener('change', () => {
    state.groupBy = els.groupBy.value || GROUP_DIM;
    localStorage.setItem(GROUP_BY_KEY, state.groupBy);
    if (state.viewMode === 'list') renderListView();
    else applyGrouping();
  });
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

    const wantMode: ViewMode = readViewMode(incoming.mode, legacyViewMode);

    const targetViewId = incoming.view ?? state.config.defaultView;
    const targetWindow = parseUrlWindow(incoming);

    if (state.activeView?.id !== targetViewId) {
      state.pendingItem = incoming.item ?? null;
      state.pendingWindow = targetWindow;
      await applyView(targetViewId);
    } else {
      if (incoming.item && incoming.item !== state.selectedItemId) {
        state.selectedItemId = incoming.item;
        try {
          state.timeline?.setSelection(displayIdsFor(incoming.item));
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
  // Same reason as in renderTimeline's load failure: a placeholder that outlives
  // the load it stands for keeps promising a timeline that is not coming.
  hideTimelineSkeleton(els.timeline);
  setStatus(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
});

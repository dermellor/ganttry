// App entry point: loads the discovered config, wires the header/footer controls and
// URL-state syncing, and delegates rendering and editing to the feature modules
// (render, itemForm, phaseForm, detailPanel, persistence). Shared mutable state
// and DOM refs live in state.ts.

import 'vis-timeline/styles/vis-timeline-graph2d.css';
// The two stylesheets that are not the design system: vis-timeline's own
// furniture as this app dresses it, and the handful of app-level compositions
// that are not components. The design system's own CSS arrives with the
// components that use it (see src/design-system/index.ts).
import './styles/timeline.css';
import './styles/app.css';
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
  loadViewPrefs,
  saveViewPrefs,
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
import { loadPluginStatuses, renderPluginList } from './pluginPanel';
import { browserDeps, loadInstalledPlugins } from './pluginHost/loader';
import { commitItemForm } from './persistence';
import type { PresenceUser } from './presence';
import { loadUserDirectory } from './users';
import { normalizeMemberRole, roleAllows } from './access';
import { settingsSection, showSettings, wireSettingsArea } from './settingsArea';
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
import { viewAccessories } from './pluginHost/manifest';
import {
  pluginViewButton,
  pluginViewButtons,
  pluginViewSection,
  renderPluginViewInto,
  showOnlyPluginSection,
} from './pluginHost/views';
import { dataUrl } from './data-base';
import { MILESTONES_ONLY_SELECTION } from './viewPrefs';
import { hideTimelineSkeleton, showTimelineSkeleton } from './timelineSkeleton';
import { hostApiFor } from './pluginHost/hostBackend';
import { setTimelineRefresh } from './pluginHost/refresh';

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
    const data = (await res.json()) as { email?: unknown; name?: unknown; role?: unknown; status?: unknown };
    // The role rides along on the same probe. It is absent whenever access
    // control is off, which is exactly when there is nothing to administer.
    state.currentRole =
      data.status === 'active' ? (normalizeMemberRole(data.role) ?? null) : null;
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
  // Before the render that reads them: presentation, grouping and filter belong to
  // the timeline being opened, and a link may override them (state.pendingPrefs).
  // Both halves have to be in place first, or the first paint shows the previous
  // timeline's filter.
  loadViewPrefs(viewId);
  const wanted = state.pendingPrefs;
  state.pendingPrefs = null;
  if (wanted) {
    if (wanted.mode) state.viewMode = wanted.mode;
    // A link's narrowing joins the stored one rather than replacing it, because
    // that is what `m=1` did: it composed with whatever filter was set.
    if (wanted.filters) state.filters = { ...state.filters, ...wanted.filters };
    // A followed link becomes this timeline's stored state, exactly as the
    // instance-wide key used to be written when a link carried a mode.
    saveViewPrefs(viewId);
  }
  setModeButtons(state.viewMode);
  await renderTimeline(view);
  // The mode is per timeline now, so a switch can change it: the sections have to
  // follow, not just the buttons. Persisting here would write the stored value
  // straight back, so it stays off.
  applyViewMode(state.viewMode, { persist: false });
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
  // Back on the timeline, so the accessories are the built-in ones. Read from the
  // same function rather than set to `false` by hand: two places deciding what a
  // presentation's bar holds is how one of them ends up stale.
  const builtin = viewAccessories();
  els.groupByControl.hidden = !builtin.grouping;
  els.filterControl.hidden = !builtin.filter;
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
  // The bar is built from what the presentation declares, per control. Nothing
  // here asks „is this a plugin view?" any more: `viewAccessories` answers for
  // built-in and declared views alike, so a second plugin view needs no change in
  // this file. A control that does not apply is hidden rather than left inert,
  // because an inert control claims the view supports something it does not.
  const accessories = viewAccessories(target?.view);
  els.groupByControl.hidden = !accessories.grouping;
  els.filterControl.hidden = !accessories.filter;
  els.exportBtn.hidden = !accessories.export;
  // Editability is the other half and stays where it is (render.ts): a presentation
  // may allow creating an item while this source does not.
  els.addBtn.hidden = !accessories.create || !isEditableView();
  if (list) {
    renderListView();
  } else if (target && parsed) {
    // Lazy-load the plugin's chunk, then render — but only if we're still in that
    // mode by the time it resolves (the user may have switched away).
    const container = pluginViewSection(els.contentArea, parsed.pluginId, target.view);
    void ensurePluginLoaded(target.plugin).then((m) => {
      if (state.viewMode === mode) {
        renderPluginViewInto(container, parsed.pluginId, target.view.id, m, hostApiFor(target.plugin.manifest));
      }
    });
  } else {
    // The timeline was display:none while the list showed, so vis-timeline
    // couldn't size itself. Redraw + re-pack point lanes now that it's visible.
    state.timeline?.redraw();
    repackLanes();
  }
  if (persist) {
    saveViewPrefs();
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

  // Load the plugins the instance installed, BEFORE the first view is applied:
  // their contributed fields and view buttons have to exist by the time a view is
  // built, or the first paint is missing them and only a switch away and back
  // brings them in. Awaited for the same reason, and it is a small set.
  //
  // Failures are collected rather than thrown. A plugin that cannot load must
  // cost the user that plugin and nothing else; the reasons are what the footer's
  // plugin list shows.
  // A plugin's write goes through the host, so the host is what reloads after it.
  // Registered rather than imported: hostBackend.ts calling render.ts would close
  // a cycle (render → views → hostBackend → render). See pluginHost/refresh.ts.
  setTimelineRefresh(() => {
    if (state.activeView) void renderTimeline(state.activeView);
  });

  state.pluginLoad = await loadInstalledPlugins(
    await loadPluginStatuses(cfg.plugins),
    browserDeps(),
    (pluginId, error) => console.error(`[plugin ${pluginId}]`, error),
  );

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

  // What the link asks for, held until applyView has loaded the opened timeline's
  // own state and can let the link win over it. Only keys the link actually
  // carries: an absent one means „whatever this timeline remembers", which is why
  // this is not simply read as false / 'timeline'.
  if (urlState.milestones || urlState.mode) {
    state.pendingPrefs = {
      // `m=1` predates the type dimension and sits in every link ever shared, so
      // it is still read: it means „narrow the type dimension to Meilenstein".
      // Nothing writes it any more (see syncUrl).
      ...(urlState.milestones && { filters: MILESTONES_ONLY_SELECTION }),
      // A shared link may carry a pre-plugin mode id (`mode=pricing`), so it goes
      // through the same legacy lookup as the stored value.
      ...(urlState.mode && { mode: readViewMode(urlState.mode, legacyViewMode) }),
    };
  }
  setupListView();
  setupFilterControl();

  state.pendingItem = urlState.item ?? null;
  state.pendingWindow = parseUrlWindow(urlState);

  // Recorded BEFORE the first syncUrl below, which rewrites the hash from
  // `state`: read afterwards, the section a deep link named would be stripped
  // out of the URL it arrived in, and the next reload would land on the timeline.
  // Mounting still happens further down — this is only the state.
  state.settingsSection = urlState.settings != null ? settingsSection(urlState.settings) : null;

  state.suppressUrlSync = true;
  // applyView loads that timeline's display state and applies the mode itself.
  await applyView(initialView);
  state.suppressUrlSync = false;
  syncUrl();

  // Only an admin is offered the area. Hiding it is an affordance, never the
  // permission: /api/settings and /api/members refuse anybody else regardless of
  // what is on screen.
  wireSettingsArea();
  if (state.currentRole && roleAllows(state.currentRole, 'manage')) {
    els.settingsBtn.hidden = false;
  }

  // …but the deep link opens it for anybody who follows one, and the sections
  // then show whatever the server answers. That is deliberate: `#settings` on an
  // instance with access control off answers „the switch is off, here is the
  // variable", which is the exact question somebody follows that link to ask. A
  // silently ignored link would leave them with a timeline and no explanation.
  if (state.settingsSection) await showSettings(state.settingsSection);

  // Safety net: flush + persist an open item form if the tab closes mid-edit.
  window.addEventListener('beforeunload', () => commitItemForm());

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
    saveViewPrefs();
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

  // The plugin list answers „why is that view not there?", so it is built fresh
  // on open: the registry can change under a long-lived tab (an operator installs
  // something), and the timeline it reports on changes with every view switch.
  els.pluginsBtn.addEventListener('click', async () => {
    const open = !els.pluginsPanel.hidden;
    if (open) {
      els.pluginsPanel.hidden = true;
      els.pluginsBtn.setAttribute('aria-expanded', 'false');
      return;
    }
    els.pluginsPanel.hidden = false;
    els.pluginsBtn.setAttribute('aria-expanded', 'true');
    renderPluginList(
      els.pluginsPanel,
      await loadPluginStatuses(state.config?.plugins),
      state.activeSourceFile,
      state.pluginLoad,
    );
  });
  document.addEventListener('click', (e) => {
    if (els.pluginsPanel.hidden) return;
    const target = e.target as Node;
    if (els.pluginsPanel.contains(target) || els.pluginsBtn.contains(target)) return;
    els.pluginsPanel.hidden = true;
    els.pluginsBtn.setAttribute('aria-expanded', 'false');
  });

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
    // The area first: back/forward out of it has to put the timeline back before
    // the view work below redraws into a container that is still display:none.
    const wantSettings = incoming.settings != null ? settingsSection(incoming.settings) : null;
    if (wantSettings !== state.settingsSection) {
      state.settingsSection = wantSettings;
      await showSettings(wantSettings);
    }

    // An incoming hash is authoritative about what it carries: no `mode` means the
    // timeline, which is what makes back/forward reverse a switch to the list.
    //
    // It is deliberately NOT authoritative about the filter. The filter has never
    // been in the hash, and `m=1` — the one narrowing that was — is no longer
    // written, so an absent `m` says nothing about the type dimension. Reading it
    // as „no type filter" would clear a selection the user made in the panel on
    // every back step.
    const wantMode: ViewMode = readViewMode(incoming.mode, legacyViewMode);

    const targetViewId = incoming.view ?? state.config.defaultView;
    const targetWindow = parseUrlWindow(incoming);
    const switching = state.activeView?.id !== targetViewId;

    // On a switch these go through pendingPrefs, or applyView's load would
    // overwrite them with the target timeline's stored state.
    if (switching) {
      state.pendingPrefs = {
        mode: wantMode,
        ...(incoming.milestones && { filters: MILESTONES_ONLY_SELECTION }),
      };
    } else if (incoming.milestones) {
      // An old link pasted into the running app: add the narrowing it asks for.
      state.filters = { ...state.filters, ...MILESTONES_ONLY_SELECTION };
      saveViewPrefs();
      if (state.activeView && state.activeBuild) {
        applyBuildToDataSets();
        setStatus(statusFor(state.activeView, state.activeBuild));
        state.timeline?.redraw();
      }
    }

    if (switching) {
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

    // applyView already applied the mode from pendingPrefs on the switching path;
    // on the same-view path this is where the incoming mode lands.
    if (!switching) {
      if (wantMode !== state.viewMode) {
        state.viewMode = wantMode;
        saveViewPrefs();
      }
      applyViewMode(wantMode, { persist: false });
    }
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

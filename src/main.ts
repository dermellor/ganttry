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
// The built-in plugins' view loaders. A side-effect import, and the only place the
// browser entry says where a plugin's view lives — see ./pluginHost/builtInViews.ts
// for why the descriptor must not.
import './pluginHost/builtInViews';
import type { BuiltConfig } from './types';
import { initLocale, t } from './i18n';
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
  loadPresentationPrefs,
  loadViewPrefs,
  saveViewPrefs,
  type ViewMode,
} from './state';
import {
  renderTimeline,
  applyBuildToDataSets,
  statusFor,
  addNewItem,
  repackLanes,
  applyGrouping,
  displayIdsFor,
  repaintActiveView,
} from './render';
import { GROUP_DIM } from './listGrouping';
import { loadPluginStatuses, renderPluginList } from './pluginPanel';
import { browserDeps, loadInstalledPlugins } from './pluginHost/loader';
import { commitItemForm } from './persistence';
import type { PresenceUser } from './presence';
import { loadUserDirectory } from './users';
import { normalizeMemberRole, roleAllows } from './access';
import { settingsSection, showSettings, wireSettingsArea } from './settingsArea';
import { refreshAppMenu, wireAppMenu } from './appMenu';
import {
  showTimelineSettings,
  timelineSection,
  wireTimelineSettings,
} from './timelineSettings';
import { deleteItem } from './itemForm';
import { hideDetail, pluginPanelBackend, showDetailForId } from './detailPanel';
import { renderListView, setupListView } from './listView';
import { renderGraphView, syncGraphSelection } from './graphView';
import { setupFilterControl } from './filterControl';
import { setupEdgeControl } from './edgeControl';
import { setupOrderControl } from './orderControl';
import {
  applySavedView,
  setupSavedViewsControl,
  syncSavedViewsControl,
} from './savedViewsControl';
import {
  activePlugins,
  ensurePluginLoaded,
  legacyViewMode,
  pluginAppliesTo,
  pluginViews,
  resolveViewMode,
  type PluginView,
} from './pluginHost/registry';
import {
  parsePluginViewMode,
  pluginViewMode,
  readViewMode,
  type BuiltinViewMode,
} from './pluginHost/viewMode';
import { viewAccessories } from './pluginHost/manifest';
import {
  pluginViewButtons,
  pluginViewGroup,
  pluginViewGroups,
  setActivePluginGroup,
  pluginViewSection,
  renderPluginViewInto,
  showOnlyPluginSection,
} from './pluginHost/views';
import { dataUrl } from './data-base';
import {
  setSwitcherActive,
  setSwitcherViews,
  wireTimelineSwitcher,
} from './timelineSwitcher';
import { MILESTONES_ONLY_SELECTION } from './viewPrefs';
import { hideTimelineSkeleton, showTimelineSkeleton } from './timelineSkeleton';
import { hostApiFor } from './pluginHost/hostBackend';
import { setTimelineRefresh } from './pluginHost/refresh';
import { setPanelBackend } from './pluginHost/panel';

// Is the keyboard focus currently in a place where a keystroke means "type",
// not "act on the selected item"? Guards the global Delete shortcut so it never
// fires while editing a form field.
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The language this person stored, or `null` when they never chose one.
 *
 * Best-effort by design, like the user directory beside it: a deployment that
 * cannot answer (no database, no identity, a schema predating the column, a
 * self-hosted server that does not serve the route) leaves the device's answer
 * standing. Booting must not depend on a preference existing.
 */
async function loadChosenLanguage(): Promise<string | null> {
  try {
    const res = await fetch('/api/preferences');
    if (!res.ok) return null;
    const data = (await res.json()) as { language?: unknown };
    return typeof data.language === 'string' ? data.language : null;
  } catch {
    return null;
  }
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
    const data = (await res.json()) as {
      email?: unknown;
      name?: unknown;
      role?: unknown;
      status?: unknown;
      session?: unknown;
      accessControl?: unknown;
    };
    // „Does this instance have roles at all", which `role` cannot answer: it is
    // absent both on an instance with access control off and for a caller who is
    // not a member of one that has it on. The interface needs the two apart, or a
    // control gated on „may manage" is gated on something nobody can satisfy.
    state.accessControl = data.accessControl === true;
    // Not derived from `email`: the dev server hands out an identity with no gate
    // behind it (vite.config.ts), so an address here says nothing about whether
    // there is a session to end. Only the gated deployment sets this, and it is
    // what „Abmelden" hangs on — see netlify/edge-functions/me.ts.
    state.hasSession = data.session === true;
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
  setSwitcherActive(viewId);
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
  // A saved view belongs to the timeline it was saved on, so opening another one
  // leaves it — before the render, or the drift marker would briefly claim the
  // new timeline is showing the old timeline's view.
  state.activeSavedViewId = null;
  await renderTimeline(view);
  // The mode is per timeline now, so a switch can change it: the sections have to
  // follow, not just the buttons. Persisting here would write the stored value
  // straight back, so it stays off.
  applyViewMode(state.viewMode, { persist: false });
  updatePluginViews();
  // After the source is loaded, because which saved views exist arrives with it.
  // An id the timeline does not carry is dropped rather than reported: a link can
  // outlive the view it names, and it still has to open the timeline.
  const wantedView = state.pendingSavedView;
  state.pendingSavedView = null;
  const savedView = wantedView
    ? state.activeSourceFile?.savedViews?.find((v) => v.id === wantedView)
    : undefined;
  if (savedView) applySavedView(savedView);
  else syncSavedViewsControl();
  syncUrl();
}

// Reflect the active view mode on the segmented icon toggle (aria-pressed drives
// the highlighted state via CSS).
function setModeButtons(mode: ViewMode) {
  els.modeTimelineBtn.setAttribute('aria-pressed', String(mode === 'timeline'));
  els.modeListBtn.setAttribute('aria-pressed', String(mode === 'list'));
  els.modeGraphBtn.setAttribute('aria-pressed', String(mode === 'graph'));
  for (const [btnMode, btn] of pluginViewButtons()) {
    btn.setAttribute('aria-pressed', String(mode === btnMode));
  }
  // …and the control the active segment sits in, so the row says whose view it is.
  setActivePluginGroup(mode);
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
  const applying = new Set<string>();
  for (const plugin of activePlugins(state.activeSourceFile)) {
    const pluginId = plugin.manifest.id;
    const views = pluginViews(plugin);
    if (!views.length) continue;
    applying.add(pluginId);
    for (const view of views) {
      available.add(pluginViewMode(pluginId, view.id));
      pluginViewSection(els.contentArea, pluginId, view);
    }
    // One control for the whole plugin, so its views arrive and go together — which
    // is how enablement works: a plugin applies to a timeline or it does not.
    pluginViewGroup(els.pluginViewBar, pluginId, plugin.manifest.name, views, (m) =>
      applyViewMode(m as ViewMode),
    ).hidden = false;
  }
  for (const [pluginId, group] of pluginViewGroups()) {
    if (!applying.has(pluginId)) group.hidden = true;
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
function applyViewMode(
  mode: ViewMode,
  {
    persist = true,
    keepPrefs = false,
  }: {
    persist?: boolean;
    /**
     * Leave perspective and extent alone across the switch, because the caller is
     * about to set them itself.
     *
     * Applying a saved view is the one case: it names a presentation AND what to
     * group and narrow by, so loading that presentation's stored pair first would
     * overwrite the view's with the last thing somebody happened to leave there —
     * and the view would apply everything except its own two values.
     */
    keepPrefs?: boolean;
  } = {},
) {
  // Guard: a plugin view is only valid while its plugin applies to this timeline.
  // A stale deep link or a stored mode from another timeline lands here.
  const parsed = parsePluginViewMode(mode);
  const target = parsed ? resolveViewMode(state.activeSourceFile, parsed.pluginId, parsed.viewId) : null;
  if (parsed && !target) mode = 'timeline';
  const switching = state.viewMode !== mode;
  state.viewMode = mode;
  // Perspective and extent belong to the presentation, so they travel with the
  // switch. Before the renders below, or the new presentation would paint once with
  // the previous one's grouping and then again with its own.
  if (switching && !keepPrefs) loadPresentationPrefs(mode);
  setModeButtons(mode);
  const list = mode === 'list';
  const graph = mode === 'graph';
  const plugin = target ? mode : null;
  els.timeline.hidden = list || graph || !!plugin;
  els.list.hidden = !list;
  els.graph.hidden = !graph;
  showOnlyPluginSection(plugin);
  // The bar is built from what the presentation declares, per control. Nothing
  // here asks „is this a plugin view?" any more: `viewAccessories` answers for
  // built-in and declared views alike, so a second plugin view needs no change in
  // this file. A control that does not apply is hidden rather than left inert,
  // because an inert control claims the view supports something it does not.
  // A built-in presentation names itself; only a plugin view hands over its
  // declaration. Both answers come out of the same function, which is what keeps
  // „which controls apply" from being decided twice.
  const accessories = viewAccessories(target?.view ?? (plugin ? null : (mode as BuiltinViewMode)));
  els.groupByControl.hidden = !accessories.grouping;
  els.filterControl.hidden = !accessories.filter;
  // Editability is the other half and stays where it is (render.ts): a presentation
  // may allow creating an item while this source does not.
  els.addBtn.hidden = !accessories.create || !isEditableView();
  // A switch changed the grouping and the filter, so the display set has to be
  // recomputed rather than only redrawn — the lanes and the visible items both
  // follow from them.
  if (switching) applyGrouping();
  if (list) {
    renderListView();
  } else if (graph) {
    renderGraphView();
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

async function bootstrap() {
  // The language, before anything is drawn. Synchronous and from the device only:
  // the authoritative answer for a signed-in person is a round trip away, and
  // waiting for it would mean either a blank app or a first paint in the wrong
  // language followed by a visible re-render — the second is the one people report
  // as a bug. The device's last answer paints; the two lines further down
  // reconcile it with the deployment's default and with the profile.
  initLocale();
  setStatus(t('app.loadingConfig'));
  // Before the config and the user directory are even in, so the first painted
  // frame shows the placeholder rather than an empty area. renderTimeline()
  // keeps it up for its own source fetch and takes it down when the chart is
  // built, which makes the two loads read as one.
  showTimelineSkeleton(els.timeline);

  const [cfg, currentUser, chosenLanguage] = await Promise.all([
    loadConfig(),
    loadCurrentUser(),
    // The language this person chose, asked for **alongside** the config rather
    // than after it. Boot already waits on three requests in parallel, so a
    // fourth costs nothing — and asking afterwards is what re-rendered the whole
    // interface into another language in front of every existing user on their
    // first visit.
    loadChosenLanguage(),
    // The user directory an item's Owner resolves against. Loaded once, up front,
    // because both the list's Owner column and the item form's picker read it
    // synchronously; fetching it also registers us in it (see src/users.ts).
    loadUserDirectory(),
  ]);
  state.config = cfg;
  state.currentUser = currentUser;

  // Now with all three sources: this person's stored choice, the deployment's
  // answer for somebody who never chose, and the product default underneath.
  // Nothing has been drawn in the interface's own language yet — only the status
  // line, which the first `initLocale` above already painted from the device.
  initLocale({ chosen: chosenLanguage, instanceDefault: cfg.defaultLanguage });

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
  // The detail drawer, for the same reason and by the same route: a plugin opens
  // its form through `HostApi.panel`, and the implementation is registered rather
  // than imported because hostBackend.ts reaching detailPanel.ts closes a cycle
  // through the item form. See pluginHost/panel.ts.
  setPanelBackend(pluginPanelBackend);

  state.pluginLoad = await loadInstalledPlugins(
    await loadPluginStatuses(cfg.plugins),
    browserDeps(),
    (pluginId, error) => console.error(`[plugin ${pluginId}]`, error),
  );

  setSwitcherViews(cfg.views);

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
  setupEdgeControl();
  // The order changes what the graph draws and nothing else, so a change repaints
  // through the same path a grouping change does rather than reloading the source.
  setupOrderControl(() => applyGrouping());
  // The presentation switch is handed over rather than reimplemented: applying a
  // view may enter a plugin view, which needs the mode resolved against this
  // timeline's plugins and its chunk loaded.
  setupSavedViewsControl((mode) => applyViewMode(mode, { keepPrefs: true }));

  state.pendingSavedView = urlState.savedView ?? null;

  state.pendingItem = urlState.item ?? null;
  state.pendingWindow = parseUrlWindow(urlState);

  // Recorded BEFORE the first syncUrl below, which rewrites the hash from
  // `state`: read afterwards, the section a deep link named would be stripped
  // out of the URL it arrived in, and the next reload would land on the timeline.
  // Mounting still happens further down — this is only the state.
  state.settingsSection = urlState.settings != null ? settingsSection(urlState.settings) : null;
  state.tlSection =
    urlState.timelineSettings != null ? timelineSection(urlState.timelineSettings) : null;

  state.suppressUrlSync = true;
  // applyView loads that timeline's display state and applies the mode itself.
  await applyView(initialView);
  state.suppressUrlSync = false;
  syncUrl();

  // Only an admin is offered the area. Hiding it is an affordance, never the
  // permission: /api/settings and /api/members refuse anybody else regardless of
  // what is on screen.
  wireSettingsArea();
  wireTimelineSettings();
  wireAppMenu();
  // „Einstellungen" on two different grounds, because the instance area answers two
  // different questions. With access control ON it administers, so a role that may
  // manage is the gate. With it OFF there are no roles to gate on, and the area's
  // whole content is the sentence „access control is off on this instance, set
  // TIMELINES_ACCESS_CONTROL=true" — gating that on `manage` hid it from everybody
  // on exactly the instances where somebody needs to read it, reachable only by
  // typing the hash by hand. /api/settings answers 503 with that same sentence, so
  // the entry leads somewhere designed rather than to a refusal.
  const mayManage = state.currentRole != null && roleAllows(state.currentRole, 'manage');
  if (!state.accessControl || mayManage) {
    els.settingsBtn.hidden = false;
  }
  // „Abmelden" follows the session, not the role and not the identity. The auth
  // gate is the only thing that serves `/auth/logout`, and the only thing that
  // reports `session: true` — a static deploy, an ungated instance and the dev
  // server all know an identity while having no session to end. Offering the row
  // on an address instead would put a link to a 404 in the menu on every machine
  // this is developed on.
  if (state.hasSession) {
    els.logoutBtn.hidden = false;
  }
  // After both rows are decided: the trigger appears only if either did.
  refreshAppMenu();
  // The timeline's own settings are offered wherever a timeline is: the area states
  // for itself that a read-only source cannot be changed, and reading its name and
  // default grouping is useful to anybody who can read the timeline. Access control
  // off leaves `currentRole` null, which is exactly the instance where everybody
  // past the gate may write anyway.
  els.tlSettingsBtn.hidden = false;

  // …but the deep link opens it for anybody who follows one, and the sections
  // then show whatever the server answers. That is deliberate: `#settings` on an
  // instance with access control off answers „the switch is off, here is the
  // variable", which is the exact question somebody follows that link to ask. A
  // silently ignored link would leave them with a timeline and no explanation.
  if (state.settingsSection) await showSettings(state.settingsSection);
  // Mounted after the first view, because this area reads the loaded timeline: a
  // deep link to it would otherwise render „keine Timeline geladen" and stay that
  // way.
  if (state.tlSection) await showTimelineSettings(state.tlSection);

  // Safety net: flush + persist an open item form if the tab closes mid-edit.
  window.addEventListener('beforeunload', () => commitItemForm());

  wireTimelineSwitcher((viewId) => {
    // Cleared before the switch so the presence re-join announces no item (the
    // old selection belongs to the view we're leaving).
    state.selectedItemId = null;
    state.userWindow = null;
    state.pendingItem = null;
    state.pendingWindow = null;
    void applyView(viewId);
  });
  els.modeTimelineBtn.addEventListener('click', () => applyViewMode('timeline'));
  els.modeListBtn.addEventListener('click', () => applyViewMode('list'));
  els.modeGraphBtn.addEventListener('click', () => applyViewMode('graph'));
  // Shared grouping dropdown: drives both the timeline lanes and the list
  // sections. Persist the choice, then repaint whichever view is active.
  els.groupBy.addEventListener('change', () => {
    state.groupBy = els.groupBy.value || GROUP_DIM;
    saveViewPrefs();
    // The timeline turns the dimension into lanes; every other presentation
    // rebuilds from it (the graph's columns *are* the dimension).
    if (state.viewMode === 'timeline') applyGrouping();
    else repaintActiveView();
  });
  els.detailClose.addEventListener('click', () => {
    commitItemForm();
    state.selectedItemId = null;
    state.timeline?.setSelection([]);
    hideDetail();
    // Un-mark the node/row the panel belonged to. The graph re-marks in place
    // rather than redrawing: a full repaint would drop the hover highlight and
    // re-run the layout for a change that moves nothing.
    if (state.viewMode === 'list') renderListView();
    else if (state.viewMode === 'graph') syncGraphSelection();
    syncUrl();
  });
  els.addBtn.addEventListener('click', () => addNewItem());

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
    const wantTl = incoming.timelineSettings != null ? timelineSection(incoming.timelineSettings) : null;
    if (wantTl !== state.tlSection) {
      state.tlSection = wantTl;
      await showTimelineSettings(wantTl);
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
      state.pendingSavedView = incoming.savedView ?? null;
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

    // An incoming hash is authoritative about the saved view it names, the way it
    // is about the mode: that is what makes back reverse „apply Q3" instead of
    // leaving it standing. An id this timeline does not have leaves the display
    // alone and only drops the marker.
    if (!switching) {
      const wanted = incoming.savedView ?? null;
      const view = wanted
        ? state.activeSourceFile?.savedViews?.find((v) => v.id === wanted)
        : undefined;
      // Re-applied even when that view is already the active one, because the
      // interesting case is exactly that: somebody drifted away from it and then
      // opened the link again. Comparing against `activeSavedViewId` first made
      // pasting the link a no-op, which reads as the link not working.
      if (view) applySavedView(view);
      else if (state.activeSavedViewId) {
        state.activeSavedViewId = null;
        syncSavedViewsControl();
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

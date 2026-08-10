// Shared application state and DOM references for the viewer.
//
// main.ts used to be one 1900-line module; splitting it into feature modules
// (render, itemForm, phaseForm, detailPanel, persistence) means the mutable
// state they all touch has to live somewhere neutral. ES modules make imported
// `let` bindings read-only, so the state can't be a set of exported `let`s that
// other modules reassign — it lives on a single mutable `state` object instead,
// and every reader/writer goes through `state.x`.
//
// The feature modules import each other freely; the resulting cycles are safe
// because every cross-module call happens inside a function body (invoked long
// after all modules have finished evaluating), never at module top level.

import type { Timeline } from 'vis-timeline/standalone';
import type { BuiltConfig, SourceLive, TimelineFile, View } from './types';
import type { BuildResult } from './buildItems';
import type { JiraIssue } from './jira';
import type { PresenceUser } from './presence';
import type { MemberRole } from './access';
// Type-only, so it is erased: a value import would make the cycle with
// settingsArea.ts (which reads `els` and `state` from here) a real one.
import type { SettingsSection } from './settingsArea';
import type { PresenceHandle } from './realtime';
import { mountAppShell } from './appShell';
import { isoDateOnly } from './editor';
import { writeUrlState, type UrlState } from './urlState';
import { legacyViewMode } from './pluginHost/registry';
import { readViewMode, type ViewMode } from './pluginHost/viewMode';

// The frame is built rather than looked up: `index.html` carries no markup any
// more, because `src/export.ts` needs the same frame and two hand-kept copies of
// it had already drifted (see appShell.ts). Mounting here — at the top of the
// module every feature module imports for its DOM references — is what
// guarantees the shell exists before anything reaches for a node in it.
//
// `contentArea` is where plugin views mount: the host creates one section per
// declared view (see main.ts), rather than the frame carrying a container per
// plugin it may not have.
export const els = mountAppShell();

export const MILESTONES_ONLY_KEY = 'timelines.milestonesOnly';
export const VIEW_MODE_KEY = 'timelines.viewMode';
// Which dimension both the timeline and list views group by. 'group' (default),
// 'tag', or a custom field key (e.g. 'cf:tier'). Persisted; validated against the
// active build on render, falling back to 'group' when the chosen dimension isn't
// available. The localStorage key keeps its historical name for back-compat.
export const GROUP_BY_KEY = 'timelines.listGroupBy';
// The filter dimension ('' = off) and the selected values within it. Independent
// of the grouping dimension: you can group by one dimension and filter by
// another. Both shared across the timeline and list views. Persisted.
export const FILTER_DIM_KEY = 'timelines.filterDim';
export const FILTER_VALUES_KEY = 'timelines.filterValues';
// Which parent items have their subtree folded away, per source: item ids are
// only unique within one timeline, so a flat list would fold an unrelated item
// in the next source that happens to share an id. Persisted because a fold is a
// statement about how you want to read this timeline, like the grouping and the
// filter next to it — and unlike them it would otherwise be undone by every
// reload, which is what makes folding a large tree not worth doing.
export const COLLAPSED_ITEMS_KEY = 'timelines.collapsedItems';

// Re-exported so the modules that already imported it from here keep working; the
// encoding itself lives in the plugin host, next to the parser both the URL and
// the persisted key go through.
export type { ViewMode };

// Tag pills collapse to plain coloured dots once the view gets too dense to
// read their text: below this many pixels per day the label text is more
// clutter than help, so we swap it for a dot (CSS `.is-tags-compact`). Zoom in
// past the threshold and the full text comes back. Tunable single knob.
export const TAG_TEXT_MIN_PX_PER_DAY = 12;
export const MS_PER_DAY = 1000 * 60 * 60 * 24;

// While an item form is open we persist at most once per this interval — enough
// for live collaboration without a DB round-trip per keystroke. Leaving a field
// (focusout) or the sidebar flushes immediately (see commitItemForm).
export const PERSIST_THROTTLE_MS = 10_000;

export interface AppState {
  // The live vis-timeline instance. render.ts owns construction (and keeps a
  // non-null local during setup); everyone else reads it through state.
  timeline: Timeline | null;
  // arrows, phaseBand and the vis DataSets are render-internal — they live as
  // module-level state in render.ts, not here.
  config: BuiltConfig | null;
  activeView: View | null;
  activeSourceId: string | null;
  activeSourceFile: TimelineFile | null;
  activeSourceEditable: boolean;
  // How the active source delivers other people's changes (from loadSource):
  // drives the live-update seam (realtime channel vs. watermark polling vs. off).
  activeSourceLive: SourceLive;
  activeBuild: BuildResult | null;
  // Snapshot of the last successfully persisted state, diffed on persist() so we
  // only send the items/phases that actually changed (item-level writes instead
  // of a whole-document rewrite — concurrent edits no longer clobber).
  savedItems: Map<string, string>; // id -> canonical JSON (version stripped)
  savedItemVersions: Map<string, number>; // id -> last known version
  savedPhasesJson: string;
  activeFormItemId: string | null;
  activeFormPhaseIndex: number | null;
  // Feature id whose Stammdaten form is open in the detail drawer (pricing
  // matrix), mutually exclusive with activeFormItemId / activeFormPhaseIndex.
  activeFormFeatureId: string | null;
  // Tier id whose Stammdaten form is open in the detail drawer (pricing matrix
  // column head) — mutually exclusive with the other activeForm* slots.
  activeFormTierId: string | null;
  // True while showItemForm is swapping the form's DOM. Removing the old
  // (focused) form fires a focusout → commit; suppress it so the previous
  // form's values aren't written onto the item being switched to.
  formRebuilding: boolean;
  // Linked JIRA issues for the form currently open. Mutated by the autosuggest
  // chips; read back in applyItemForm.
  formJiraIssues: JiraIssue[];
  // dependsOn IDs for the form currently open. Mutated by the deps autosuggest
  // chips; read back in applyItemForm.
  formDependsOn: string[];
  // The parent item id for the form currently open ('' = none). A scalar, not a
  // list: an item has at most one parent, which is what storing the link on the
  // child buys (see itemHierarchy.ts).
  formParent: string;
  // Tags for the form currently open. Mutated by the tags autosuggest chips;
  // read back in applyItemForm.
  formTags: string[];
  // Selected values per multi-select custom field for the form currently open,
  // keyed by field key. Mutated by the custom-field chip editors; read back in
  // applyItemForm. Scalar (text/select) fields are read straight from the DOM.
  formCustomMulti: Record<string, string[]>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  realtimeUnsub: (() => void) | null;
  // Handle on the joined presence channel: used to leave it and to amend our own
  // activity (which item we have open / are editing) — see publishSelfPresence.
  presenceHandle: PresenceHandle | null;
  // Source id the presence channel is currently joined to (null = none). Lets
  // setupRealtime skip a re-join on same-view re-renders (avoids badge flicker
  // and leave/join churn broadcast to other clients).
  presenceSourceId: string | null;
  // Signed-in user (from /api/me); labels our own presence avatar. Null when the
  // site isn't gated / identity is unknown.
  currentUser: PresenceUser | null;
  // What this instance says the current user may do, from the same probe. Null
  // when access control is off, which is also what the interface reads as „no
  // membership screen": there is nothing to administer then. Only ever an
  // affordance hint — every route enforces for itself.
  currentRole: MemberRole | null;
  // Which section of the settings area is open; null means it is closed. Held
  // here rather than in the area's own module because `syncUrl` writes it into
  // the hash alongside the view, and the view is what the area is closed back to.
  settingsSection: SettingsSection | null;
  realtimeRefreshTimer: ReturnType<typeof setTimeout> | null;
  // Debounce for reactive form edits: coalesces rapid keystrokes into one
  // model update + live rebuild (see scheduleLiveEdit).
  liveEditTimer: ReturnType<typeof setTimeout> | null;
  selectedItemId: string | null;
  userWindow: { start: Date; end: Date } | null;
  pendingItem: string | null;
  pendingWindow: { start: Date; end: Date } | null;
  suppressUrlSync: boolean;
  milestonesOnly: boolean;
  viewMode: ViewMode;
  // Shared grouping dimension for the timeline and list views (see GROUP_BY_KEY).
  groupBy: string;
  // Shared value filter (see FILTER_DIM_KEY): the dimension to filter on ('' =
  // off) and the selected bucket values within it.
  filterDim: string;
  filterValues: string[];
  // Parent items whose children are folded away in the ACTIVE source (see
  // COLLAPSED_ITEMS_KEY). Swapped wholesale by loadCollapsedItems on every view
  // change, so nothing here ever refers to another timeline's ids.
  collapsedItems: Set<string>;
  persisting: boolean;
  persistAgain: boolean;
  lastFormPersistAt: number;
  throttlePersistTimer: ReturnType<typeof setTimeout> | null;
}

export const state: AppState = {
  timeline: null,
  config: null,
  activeView: null,
  activeSourceId: null,
  activeSourceFile: null,
  activeSourceEditable: false,
  activeSourceLive: 'none',
  activeBuild: null,
  savedItems: new Map(),
  savedItemVersions: new Map(),
  savedPhasesJson: '[]',
  activeFormItemId: null,
  activeFormPhaseIndex: null,
  activeFormFeatureId: null,
  activeFormTierId: null,
  formRebuilding: false,
  formJiraIssues: [],
  formDependsOn: [],
  formParent: '',
  formTags: [],
  formCustomMulti: {},
  saveTimer: null,
  realtimeUnsub: null,
  presenceHandle: null,
  presenceSourceId: null,
  currentUser: null,
  currentRole: null,
  settingsSection: null,
  realtimeRefreshTimer: null,
  liveEditTimer: null,
  selectedItemId: null,
  userWindow: null,
  pendingItem: null,
  pendingWindow: null,
  suppressUrlSync: false,
  milestonesOnly: localStorage.getItem(MILESTONES_ONLY_KEY) === 'true',
  // A stored mode may predate addressable plugin views (`pricing`), so it goes
  // through the legacy lookup rather than a bare comparison: renaming the encoding
  // without it would silently reset every user's saved view.
  viewMode: readViewMode(localStorage.getItem(VIEW_MODE_KEY), legacyViewMode),
  groupBy: localStorage.getItem(GROUP_BY_KEY) || 'group',
  filterDim: localStorage.getItem(FILTER_DIM_KEY) || '',
  filterValues: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(FILTER_VALUES_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  })(),
  collapsedItems: new Set(),
  persisting: false,
  persistAgain: false,
  lastFormPersistAt: 0,
  throttlePersistTimer: null,
};

// The whole per-source fold store, `{ [sourceId]: itemId[] }`. A malformed or
// absent entry reads as „nothing folded" rather than throwing: a fold is a view
// preference, and losing one must never keep a timeline from rendering.
function readCollapsedStore(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_ITEMS_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Swap `state.collapsedItems` to the folds saved for `sourceId`. */
export function loadCollapsedItems(sourceId: string | null): void {
  const stored = sourceId ? readCollapsedStore()[sourceId] : undefined;
  state.collapsedItems = new Set(Array.isArray(stored) ? stored.filter((v) => typeof v === 'string') : []);
}

/**
 * Fold or unfold one parent item and persist the result. The entry is deleted
 * rather than stored empty once the last fold is undone, so the store does not
 * grow a key per timeline anybody ever opened.
 */
export function toggleItemCollapsed(itemId: string): void {
  if (state.collapsedItems.has(itemId)) state.collapsedItems.delete(itemId);
  else state.collapsedItems.add(itemId);
  const sourceId = state.activeSourceId;
  if (!sourceId) return;
  const store = readCollapsedStore();
  if (state.collapsedItems.size) store[sourceId] = [...state.collapsedItems];
  else delete store[sourceId];
  try {
    localStorage.setItem(COLLAPSED_ITEMS_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled localStorage must not break folding for this session.
  }
}

export function setStatus(text: string): void {
  els.status.textContent = text;
}

// The detail/edit panel is an overlay (see detail.css): opening it no longer
// resizes the timeline, so vis-timeline never re-fits and nothing on the bars
// moves — the zoom-preserving compensation this used to need is gone.
//
// The one thing the overlay *does* cost is that an item near the right edge can
// end up behind the panel. When we open the panel for a specific item, pan the
// window horizontally so that item stays in the visible area to the left of the
// overlay. This keeps the zoom (the span is unchanged, only shifted) and is a
// no-op whenever the item is already clear of the panel.
export function revealBesidePanel(startMs: number, endMs?: number): void {
  const tl = state.timeline;
  if (!tl || state.viewMode === 'list') return;
  const center = els.timeline.querySelector<HTMLElement>('.vis-panel.vis-center');
  const width = center?.clientWidth || els.timeline.clientWidth;
  if (width <= 0) return;
  // Measure the overlay's actual footprint; bail if it isn't showing.
  const panelW = els.detail && !els.detail.hidden ? els.detail.getBoundingClientRect().width : 0;
  if (panelW <= 0) return;
  const usable = width - panelW; // width to the left of the overlay
  if (usable <= 0) return;

  const win = tl.getWindow();
  const winStart = win.start.getTime();
  const range = win.end.getTime() - winStart;
  if (range <= 0) return;

  const start = startMs;
  const end = endMs != null && endMs > startMs ? endMs : startMs;
  const xStart = ((start - winStart) / range) * width;
  const xEnd = ((end - winStart) / range) * width;
  // Only act when the item's start sits at or past the panel edge — i.e. the
  // whole item is hidden behind (or off to the right of) the overlay. If any
  // part of it still shows in the usable area (including an item that runs off
  // the left edge, like a wide phase), it's visible enough; leave the view put.
  if (xStart < usable) return;

  // Place the item's start ~40% into the usable area, keeping the span; for an
  // item wider than the usable area, anchor its start at the left edge instead.
  const targetX = Math.min(usable * 0.4, Math.max(0, usable - (xEnd - xStart)));
  const newStart = start - (targetX / width) * range;
  tl.setWindow(new Date(newStart), new Date(newStart + range), {
    animation: { duration: 220, easingFunction: 'easeOutCubic' },
  });
}

export function isEditableView(): boolean {
  return !!state.activeSourceFile && !!state.activeSourceId && state.activeSourceEditable;
}

// The detail drawer shows one form at a time, so the activeForm* slots are
// mutually exclusive: opening any form clears the rest. Both halves of that rule
// live here rather than being spelled out at each call site — otherwise every new
// form kind (feature, tier, …) means hunting down four places that enumerate the
// slots, and the one that gets missed leaves a stale form marked open.

/** Clear every detail-form slot. Callers then set the one they are opening. */
export function clearFormSlots(): void {
  state.activeFormItemId = null;
  state.activeFormPhaseIndex = null;
  state.activeFormFeatureId = null;
  state.activeFormTierId = null;
}

/** True while any detail form is open (an edit in progress). */
export function isAnyFormOpen(): boolean {
  return (
    state.activeFormItemId != null ||
    state.activeFormPhaseIndex != null ||
    state.activeFormFeatureId != null ||
    state.activeFormTierId != null
  );
}

export function syncUrl(): void {
  if (state.suppressUrlSync || !state.activeView) return;
  const urlState: UrlState = { view: state.activeView.id };
  if (state.selectedItemId) urlState.item = state.selectedItemId;
  if (state.userWindow) {
    urlState.from = isoDateOnly(state.userWindow.start);
    urlState.to = isoDateOnly(state.userWindow.end);
  }
  if (state.milestonesOnly) urlState.milestones = true;
  if (state.viewMode !== 'timeline') urlState.mode = state.viewMode;
  // Written alongside everything else: the view, item and window stay in the
  // hash while the area is open, so closing it returns to the timeline the
  // operator left rather than to the default view.
  if (state.settingsSection) urlState.settings = state.settingsSection;
  writeUrlState(urlState);
}

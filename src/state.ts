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
import type { Config, Note, TimelineFile, View } from './types';
import type { BuildResult } from './buildItems';
import type { JiraIssue } from './jira';
import type { PresenceUser } from './presence';
import { isoDateOnly } from './editor';
import { writeUrlState, type UrlState } from './urlState';

export const els = {
  timeline: document.getElementById('timeline') as HTMLDivElement,
  list: document.getElementById('list') as HTMLElement,
  listBody: document.getElementById('list-body') as HTMLElement,
  listGroupBy: document.getElementById('list-groupby') as HTMLSelectElement,
  viewSelect: document.getElementById('view-select') as HTMLSelectElement,
  modeTimelineBtn: document.getElementById('mode-timeline') as HTMLButtonElement,
  modeListBtn: document.getElementById('mode-list') as HTMLButtonElement,
  brandControl: document.getElementById('brand-control') as HTMLLabelElement,
  brandSelect: document.getElementById('brand-select') as HTMLSelectElement,
  milestonesOnly: document.getElementById('milestones-only') as HTMLInputElement,
  presence: document.getElementById('presence') as HTMLDivElement,
  addBtn: document.getElementById('add-btn') as HTMLButtonElement,
  exportBtn: document.getElementById('export-btn') as HTMLButtonElement,
  status: document.getElementById('status') as HTMLSpanElement,
  detail: document.getElementById('detail') as HTMLElement,
  detailTitle: document.getElementById('detail-title') as HTMLHeadingElement,
  detailMeta: document.getElementById('detail-meta') as HTMLDListElement,
  detailBody: document.getElementById('detail-body') as HTMLElement,
  detailClose: document.getElementById('detail-close') as HTMLButtonElement,
};

export const MILESTONES_ONLY_KEY = 'timelines.milestonesOnly';
export const VIEW_MODE_KEY = 'timelines.viewMode';
// Which dimension the list view groups by. 'group' (default), 'tag', or a custom
// field key (e.g. 'cf:tier'). Persisted; validated against the active build on
// render, falling back to 'group' when the chosen dimension isn't available.
export const LIST_GROUP_BY_KEY = 'timelines.listGroupBy';

export type ViewMode = 'timeline' | 'list';

// Tag pills collapse to plain coloured dots once the view gets too dense to
// read their text: below this many pixels per day the label text is more
// clutter than help, so we swap it for a dot (CSS `.is-tags-compact`). Zoom in
// past the threshold and the full text comes back. Tunable single knob.
export const TAG_TEXT_MIN_PX_PER_DAY = 12;
export const MS_PER_DAY = 1000 * 60 * 60 * 24;

export const BRAND_MODE = (import.meta.env.VITE_BRAND_MODE ?? 'select') as 'select' | 'fixed';
export const DEFAULT_BRAND = (import.meta.env.VITE_DEFAULT_BRAND ?? 'marcel-mellor') as string;

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
  allNotes: Note[];
  config: Config | null;
  activeView: View | null;
  activeSourceId: string | null;
  activeSourceFile: TimelineFile | null;
  activeSourceEditable: boolean;
  activeBuild: BuildResult | null;
  // Snapshot of the last successfully persisted state, diffed on persist() so we
  // only send the items/phases that actually changed (item-level writes instead
  // of a whole-document rewrite — concurrent edits no longer clobber).
  savedItems: Map<string, string>; // id -> canonical JSON (version stripped)
  savedItemVersions: Map<string, number>; // id -> last known version
  savedPhasesJson: string;
  activeFormItemId: string | null;
  activeFormPhaseIndex: number | null;
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
  // Tags for the form currently open. Mutated by the tags autosuggest chips;
  // read back in applyItemForm.
  formTags: string[];
  // Selected values per multi-select custom field for the form currently open,
  // keyed by field key. Mutated by the custom-field chip editors; read back in
  // applyItemForm. Scalar (text/select) fields are read straight from the DOM.
  formCustomMulti: Record<string, string[]>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  realtimeUnsub: (() => void) | null;
  presenceUnsub: (() => void) | null;
  // Source id the presence channel is currently joined to (null = none). Lets
  // setupRealtime skip a re-join on same-view re-renders (avoids badge flicker
  // and leave/join churn broadcast to other clients).
  presenceSourceId: string | null;
  // Signed-in user (from /api/me); labels our own presence avatar. Null when the
  // site isn't gated / identity is unknown.
  currentUser: PresenceUser | null;
  realtimeRefreshTimer: ReturnType<typeof setTimeout> | null;
  // Debounce for reactive form edits: coalesces rapid keystrokes into one
  // model update + live rebuild (see scheduleLiveEdit).
  liveEditTimer: ReturnType<typeof setTimeout> | null;
  currentBrand: string;
  selectedItemId: string | null;
  userWindow: { start: Date; end: Date } | null;
  pendingItem: string | null;
  pendingWindow: { start: Date; end: Date } | null;
  suppressUrlSync: boolean;
  milestonesOnly: boolean;
  viewMode: ViewMode;
  // List-view grouping dimension (see LIST_GROUP_BY_KEY).
  listGroupBy: string;
  persisting: boolean;
  persistAgain: boolean;
  lastFormPersistAt: number;
  throttlePersistTimer: ReturnType<typeof setTimeout> | null;
}

export const state: AppState = {
  timeline: null,
  allNotes: [],
  config: null,
  activeView: null,
  activeSourceId: null,
  activeSourceFile: null,
  activeSourceEditable: false,
  activeBuild: null,
  savedItems: new Map(),
  savedItemVersions: new Map(),
  savedPhasesJson: '[]',
  activeFormItemId: null,
  activeFormPhaseIndex: null,
  formRebuilding: false,
  formJiraIssues: [],
  formDependsOn: [],
  formTags: [],
  formCustomMulti: {},
  saveTimer: null,
  realtimeUnsub: null,
  presenceUnsub: null,
  presenceSourceId: null,
  currentUser: null,
  realtimeRefreshTimer: null,
  liveEditTimer: null,
  currentBrand: DEFAULT_BRAND,
  selectedItemId: null,
  userWindow: null,
  pendingItem: null,
  pendingWindow: null,
  suppressUrlSync: false,
  milestonesOnly: localStorage.getItem(MILESTONES_ONLY_KEY) === 'true',
  viewMode: localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'timeline',
  listGroupBy: localStorage.getItem(LIST_GROUP_BY_KEY) || 'group',
  persisting: false,
  persistAgain: false,
  lastFormPersistAt: 0,
  throttlePersistTimer: null,
};

export function setStatus(text: string): void {
  els.status.textContent = text;
}

// Run a layout change that resizes the timeline horizontally (opening/closing
// the detail panel shrinks/grows it) while keeping the zoom factor (px/day)
// constant. Without this, vis-timeline keeps the same time window in the new
// width, squeezing every item into a narrower/wider box — the view visibly
// "jumps". We anchor the left edge and recompute the visible range so px/day is
// unchanged: every date keeps its exact horizontal pixel position, only the
// revealed span at the right edge changes.
//
// It runs synchronously — reading clientWidth after the toggle forces a layout,
// so the corrected window is set before the browser paints. Doing it here rather
// than reacting in a ResizeObserver avoids the one-frame flash where vis would
// otherwise paint the old window at the new width first.
export function withPreservedZoom(toggle: () => void): void {
  const tl = state.timeline;
  if (!tl) {
    toggle();
    return;
  }
  // Time→pixel mapping is driven by the *center* panel — the container minus the
  // fixed left group-label column (and scrollbar/borders). We must preserve
  // px/day against that center width, not the whole container, or a few px of
  // drift remain (the label column doesn't shrink with the panel).
  //
  // But the center panel is sized by vis-timeline's own JS during its redraw, so
  // reading its clientWidth right after the toggle still reports the *old* width
  // (the redraw hasn't run yet) — a no-op that lets the later redraw rescale and
  // jump. The container, by contrast, is CSS-grid-driven and updates synchronously
  // on a forced reflow. So we read the container synchronously and derive the
  // center width from it by subtracting the label column `L`, measured before the
  // toggle where both widths are consistent (L stays constant when the side panel
  // opens/closes — only the center width absorbs the change).
  const center = els.timeline.querySelector<HTMLElement>('.vis-panel.vis-center');
  const oldContainer = els.timeline.clientWidth;
  const oldCenter = center?.clientWidth || oldContainer;
  const chrome = oldContainer - oldCenter; // label column + scrollbar/borders
  const win = tl.getWindow();
  // Snapshot the vertical scroll too. Shrinking/growing the center width makes
  // vis-timeline re-stack items on its redraw, which changes the content height
  // and lets the browser clamp the scroll container back toward the top — so on
  // the *first* click (panel goes hidden→visible) the view visibly jumps up.
  // We re-apply this offset after the redraw below, the same way renderTimeline
  // restores it on a re-render.
  const prevVScroll = els.timeline.querySelector<HTMLElement>('.vis-panel.vis-left')?.scrollTop ?? 0;
  toggle();
  const newContainer = els.timeline.clientWidth; // forces synchronous layout
  const oldWidth = oldCenter;
  const newWidth = newContainer - chrome;
  if (oldWidth > 0 && newWidth > 0 && newWidth !== oldWidth) {
    const startMs = win.start.getTime();
    const rangeMs = win.end.getTime() - startMs;
    const newEnd = new Date(startMs + (rangeMs * newWidth) / oldWidth);
    tl.setWindow(win.start, newEnd, { animation: false });
    // Keep the tracked window in sync so persistence snapshots and URL syncing
    // reflect what's actually shown (silent — no URL write here).
    if (state.userWindow) state.userWindow = { start: new Date(win.start), end: newEnd };
  }
  // Restore the vertical scroll through vis-timeline's own authoritative path
  // (`_setScrollTop` clamps to the new content range, a redraw syncs both the
  // content transform and the scrollbar container). Repeated across frames so a
  // pass that ran before layout settled gets corrected.
  if (prevVScroll > 0) {
    const restore = () => {
      const anyTl = tl as unknown as { _setScrollTop?: (v: number) => void };
      if (typeof anyTl._setScrollTop === 'function') {
        anyTl._setScrollTop(-prevVScroll);
        tl.redraw();
      }
    };
    restore();
    requestAnimationFrame(restore);
    setTimeout(restore, 0);
  }
}

export function isEditableView(): boolean {
  return !!state.activeSourceFile && !!state.activeSourceId && state.activeSourceEditable;
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
  if (state.viewMode === 'list') urlState.mode = 'list';
  if (BRAND_MODE === 'select' && state.currentBrand && state.currentBrand !== DEFAULT_BRAND) {
    urlState.brand = state.currentBrand;
  }
  writeUrlState(urlState);
}

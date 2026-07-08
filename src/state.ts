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
import { isoDateOnly } from './editor';
import { writeUrlState, type UrlState } from './urlState';

export const els = {
  timeline: document.getElementById('timeline') as HTMLDivElement,
  viewSelect: document.getElementById('view-select') as HTMLSelectElement,
  brandControl: document.getElementById('brand-control') as HTMLLabelElement,
  brandSelect: document.getElementById('brand-select') as HTMLSelectElement,
  milestonesOnly: document.getElementById('milestones-only') as HTMLInputElement,
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
  // Linked JIRA issues for the form currently open. Mutated by the autosuggest
  // chips; read back in applyItemForm.
  formJiraIssues: JiraIssue[];
  // dependsOn IDs for the form currently open. Mutated by the deps autosuggest
  // chips; read back in applyItemForm.
  formDependsOn: string[];
  // Tags for the form currently open. Mutated by the tags autosuggest chips;
  // read back in applyItemForm.
  formTags: string[];
  saveTimer: ReturnType<typeof setTimeout> | null;
  realtimeUnsub: (() => void) | null;
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
  formJiraIssues: [],
  formDependsOn: [],
  formTags: [],
  saveTimer: null,
  realtimeUnsub: null,
  realtimeRefreshTimer: null,
  liveEditTimer: null,
  currentBrand: DEFAULT_BRAND,
  selectedItemId: null,
  userWindow: null,
  pendingItem: null,
  pendingWindow: null,
  suppressUrlSync: false,
  milestonesOnly: localStorage.getItem(MILESTONES_ONLY_KEY) === 'true',
  persisting: false,
  persistAgain: false,
  lastFormPersistAt: 0,
  throttlePersistTimer: null,
};

export function setStatus(text: string): void {
  els.status.textContent = text;
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
  if (BRAND_MODE === 'select' && state.currentBrand && state.currentBrand !== DEFAULT_BRAND) {
    urlState.brand = state.currentBrand;
  }
  writeUrlState(urlState);
}

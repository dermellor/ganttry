// Timeline rendering and direct-manipulation handlers: builds the vis-timeline
// from the active view/source, keeps its DataSets in sync on live edits, and
// handles drag-move, add and remove.

import { Timeline, DataSet } from 'vis-timeline/standalone';
import {
  buildFromJson,
  buildFromNotes,
  tagPillsHtml,
  type BuildResult,
  type TimelineGroup,
  type TimelineItem,
} from './buildItems';
import { DependencyArrows } from './arrows';
import { PhaseBand } from './phaseBand';
import { iconSpanHtml } from './icons';
import {
  ensureItemIds,
  findItemIndex,
  generateNewId,
  isoDateOnly,
  loadSource,
} from './editor';
import type { TimelineFile, TimelineFileItem, View } from './types';
import {
  state,
  els,
  setStatus,
  isEditableView,
  syncUrl,
  MS_PER_DAY,
  TAG_TEXT_MIN_PX_PER_DAY,
} from './state';
import { schedulePersist, setupRealtime, snapshotSaved } from './persistence';
import { showItemForm } from './itemForm';
import { showDetailForId, hideDetail } from './detailPanel';
import { showPhaseFormByIndex, handlePhaseEdit } from './phaseForm';

// Render-internal handles. `timeline` mirrors state.timeline (kept in sync on
// every assignment) so other modules can read the current instance while this
// module keeps a non-null-narrowable local for its own setup code. arrows,
// phaseBand and the DataSets are only ever touched here.
let timeline: Timeline | null = null;
let arrows: DependencyArrows | null = null;
let phaseBand: PhaseBand | null = null;
let itemsDs: DataSet<TimelineItem> | null = null;
let groupsDs: DataSet<TimelineGroup> | null = null;

export function filterBuildForDisplay(build: BuildResult): {
  items: TimelineItem[];
  groups: TimelineGroup[];
} {
  if (!state.milestonesOnly) return { items: build.items, groups: build.groups };
  const items = build.items.filter((it) => it.type === 'point');
  const referenced = new Set<string>();
  for (const it of items) if (it.group) referenced.add(it.group);
  const keep = new Set<string>();
  const visit = (id: string): boolean => {
    if (keep.has(id)) return true;
    const g = build.groups.find((x) => x.id === id);
    if (!g) return false;
    let kept = referenced.has(id);
    if (g.nestedGroups) {
      for (const child of g.nestedGroups) {
        if (visit(child)) kept = true;
      }
    }
    if (kept) keep.add(id);
    return kept;
  };
  for (const g of build.groups) visit(g.id);
  const groups = build.groups
    .filter((g) => keep.has(g.id))
    .map((g) =>
      g.nestedGroups
        ? { ...g, nestedGroups: g.nestedGroups.filter((c) => keep.has(c)) }
        : g,
    );
  return { items, groups };
}

export function rebuildAndApply(): void {
  if (!state.activeView || !state.activeSourceFile || !timeline) return;
  const built = buildFromJson(state.activeView, state.activeSourceFile);
  state.activeBuild = built;
  applyBuildToDataSets();
  if (arrows) arrows.setDependencies(built.dependencies);
  if (phaseBand) phaseBand.setPhases(built.phases);
  setStatus(statusFor(state.activeView, built));
}

export function applyBuildToDataSets(): void {
  if (!state.activeBuild) return;
  const filtered = filterBuildForDisplay(state.activeBuild);
  // Diff the DataSets in place instead of clear()+add(). Clearing momentarily
  // empties the timeline, collapsing its content height — the browser then clamps
  // the vertical-scroll container's scrollTop to the top and vis-timeline latches
  // that, snapping the view up on every rebuild (live edits, drags, switching
  // items). update()/remove() keep the surviving rows mounted, so the height
  // never collapses and the scroll position is left untouched.
  if (itemsDs) syncDataSet(itemsDs, filtered.items);
  if (groupsDs) syncDataSet(groupsDs, filtered.groups);
}

// Reconcile a vis DataSet to `next` without ever emptying it: drop rows that are
// gone, then add/update the rest. Avoids the content-height collapse a clear()
// would cause (which resets vis-timeline's vertical scroll to the top).
function syncDataSet(ds: DataSet<any>, next: Array<{ id?: string | number }>): void {
  const nextIds = new Set(next.map((r) => String(r.id)));
  const stale = (ds.getIds() as (string | number)[]).filter((id) => !nextIds.has(String(id)));
  if (stale.length) ds.remove(stale);
  ds.update(next);
}

export function statusFor(view: View, build: BuildResult): string {
  const filtered = filterBuildForDisplay(build);
  const suffix = state.milestonesOnly ? ' · nur Meilensteine' : '';
  return `${filtered.items.length} items in „${view.name}" · ${filtered.groups.length} groups${suffix}`;
}

export async function renderTimeline(view: View) {
  if (!state.config) return;

  // A fresh vis-timeline always starts scrolled to the top. When we re-render
  // the *same* view (realtime refresh, conflict reload, live rebuild) we must
  // keep the user where they were vertically — otherwise clicking/editing an
  // item near the bottom snaps the view to the top. The horizontal window is
  // preserved separately via `pendingWindow`; this is its vertical counterpart.
  const sameView = state.activeView?.id === view.id;
  const prevVScroll = sameView
    ? els.timeline.querySelector<HTMLElement>('.vis-panel.vis-left')?.scrollTop ?? 0
    : 0;

  let built: BuildResult;
  let sourceFile: TimelineFile | null = null;
  let sourceId: string | null = null;

  let sourceEditable = false;

  if (view.source?.type === 'json') {
    try {
      const loaded = await loadSource(view.source.id);
      sourceFile = loaded.file;
      sourceEditable = loaded.editable;
    } catch (err) {
      setStatus(`Konnte Quelle ${view.source.id} nicht laden: ${err instanceof Error ? err.message : err}`);
      return;
    }
    sourceId = view.source.id;
    if (ensureItemIds(sourceFile)) {
      // assigned ids in memory only — saved on first edit
    }
    built = buildFromJson(view, sourceFile);
  } else {
    built = buildFromNotes(view, state.allNotes, state.config);
  }
  state.activeBuild = built;
  state.activeView = view;
  state.activeSourceFile = sourceFile;
  state.activeSourceId = sourceId;
  state.activeSourceEditable = sourceEditable;
  snapshotSaved();
  setupRealtime();

  const filtered = filterBuildForDisplay(built);
  itemsDs = new DataSet<TimelineItem>(filtered.items);
  groupsDs = new DataSet<TimelineGroup>(filtered.groups);

  if (arrows) {
    arrows.dispose();
    arrows = null;
  }
  if (phaseBand) {
    phaseBand.dispose();
    phaseBand = null;
  }
  if (timeline) {
    (timeline as any)._ro?.disconnect();
    timeline.destroy();
    timeline = null;
    state.timeline = null;
    els.timeline.innerHTML = '';
  }

  const useGroups = filtered.groups.length > 0;

  const now = Date.now();
  const yearMs = 365 * 24 * 3600 * 1000;
  const recent = built.items
    .map((i) => new Date(i.start).getTime())
    .filter((t) => t <= now + yearMs)
    .sort((a, b) => b - a);
  const focusMax = recent[0] ?? now;
  const focusMin = recent[Math.min(recent.length - 1, 200)] ?? focusMax - 2 * yearMs;
  const span = Math.max(focusMax - focusMin, 90 * 24 * 3600 * 1000);
  const padding = span * 0.05;

  const containerHeight = els.timeline.clientHeight || 600;

  const editable = isEditableView()
    ? { updateTime: true, updateGroup: true, add: true, remove: true, overrideItems: false }
    : false;

  els.addBtn.hidden = !isEditableView();

  const initialStart = state.pendingWindow?.start ?? new Date(focusMin - padding);
  const initialEnd = state.pendingWindow?.end ?? new Date(focusMax + padding);

  // Reserve room at the top for the phase ribbon. `margin.axis` alone doesn't
  // do it: it only offsets the first *item*, so an empty parent/nested group
  // rendered as the first row collapses to a header that sits exactly behind
  // the band. Instead we tag the container and let CSS pad the whole group set
  // (labels, items, and phase tints) down by the band height — see
  // `.timeline.has-phase-band` in styles/timeline.css.
  const axisMargin = 8;
  els.timeline.classList.toggle('has-phase-band', built.phases.length > 0);

  timeline = new Timeline(els.timeline, itemsDs, useGroups ? groupsDs : undefined, {
    stack: true,
    horizontalScroll: true,
    zoomKey: 'ctrlKey',
    // Prepend the brand-resolved icon at render time so the stored `content`
    // stays clean (used by the edit form, confirm dialogs, and Sheets).
    template: (item: TimelineItem) =>
      item ? `${tagPillsHtml(item.tags)}${iconSpanHtml(item.icon)}${item.content ?? ''}` : '',
    // vis-timeline's XSS filter strips the icon span's class/style. Our content
    // and titles are already escapeHtml'd at build time and icon keys are
    // validated, so disabling the redundant filter is safe here.
    xss: { disabled: true },
    margin: { item: 6, axis: axisMargin },
    orientation: { axis: 'top', item: 'top' },
    locale: 'de',
    tooltip: { followMouse: false, overflowMethod: 'cap' },
    zoomMin: 1000 * 60 * 60 * 6,
    zoomMax: 1000 * 60 * 60 * 24 * 365 * 30,
    snap: (date: Date) => {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      return d;
    },
    height: `${containerHeight}px`,
    verticalScroll: true,
    start: initialStart,
    end: initialEnd,
    editable,
    onMove: handleMove,
    onAdd: handleAdd,
    onRemove: handleRemove,
    onUpdate: (_item: TimelineItem, callback: (item: TimelineItem | null) => void) => {
      // suppress vis-timeline's built-in inline editor; we use our own form on select
      callback(null);
    },
  } as any);
  state.timeline = timeline;

  let lastH = containerHeight;
  const ro = new ResizeObserver(() => {
    const h = els.timeline.clientHeight;
    if (h > 0 && h !== lastH) {
      lastH = h;
      timeline?.setOptions({ height: `${h}px` });
    }
    // width may have changed too (e.g. detail panel opening) → re-evaluate
    updateTagDensity();
  });
  ro.observe(els.timeline);
  (timeline as any)._ro = ro;

  const ensureVisible = () => {
    timeline?.redraw();
    // Re-apply the pre-render vertical offset once the new timeline has laid out
    // (content height and the feasible scroll range are only known after a
    // redraw). vis-timeline's own `_setScrollTop` clamps to that range and a
    // second redraw syncs both the content transform and the scrollbar
    // containers — the authoritative path, avoiding the desync a raw DOM
    // scrollTop write races into. Repeated across frames so a first pass that
    // ran before layout settled gets corrected.
    const tl = timeline as any;
    if (prevVScroll > 0 && typeof tl?._setScrollTop === 'function') {
      tl._setScrollTop(-prevVScroll);
      timeline?.redraw();
    }
    const visEl = els.timeline.querySelector<HTMLElement>('.vis-timeline');
    if (visEl) visEl.style.visibility = 'visible';
  };
  requestAnimationFrame(ensureVisible);
  setTimeout(ensureVisible, 100);
  setTimeout(ensureVisible, 500);

  if (built.dependencies.size > 0) {
    // The .vis-panel.vis-center the overlay attaches to only exists once the
    // timeline has laid out. A single rAF sometimes fires too early, so retry
    // across a few frames/timeouts until it succeeds (mirrors ensureVisible).
    // Each tick also re-applies the dependencies: the first draw can land before
    // the item DOM has laid out (anchors resolve to null → no lines), and on a
    // static page no further 'changed' event fires to correct it. setDependencies
    // reschedules a redraw, so a later tick draws once anchors exist.
    const initArrows = () => {
      if (!timeline) return;
      try {
        if (!arrows) arrows = new DependencyArrows(timeline, els.timeline);
        arrows.setDependencies(built.dependencies);
      } catch {
        // panel not ready yet — a later attempt will pick it up
      }
    };
    requestAnimationFrame(initArrows);
    setTimeout(initArrows, 100);
    setTimeout(initArrows, 500);
  }

  if (built.phases.length > 0) {
    requestAnimationFrame(() => {
      try {
        phaseBand = new PhaseBand(timeline!, els.timeline);
        phaseBand.setPhases(built.phases);
        if (isEditableView()) phaseBand.setEditable(true, handlePhaseEdit, showPhaseFormByIndex);
      } catch (err) {
        console.warn('PhaseBand init failed:', err);
      }
    });
  }

  updateTagDensity();
  // `rangechange` fires continuously while zooming/panning; `updateTagDensity`
  // is a no-op unless the compact state actually flips, so this is cheap.
  timeline.on('rangechange', updateTagDensity);

  timeline.on('select', (props: { items: string[] }) => {
    const id = props.items[0];
    if (!id) {
      state.selectedItemId = null;
      syncUrl();
      return;
    }
    state.selectedItemId = id;
    syncUrl();
    showDetailForId(id);
  });

  timeline.on('rangechanged', (props: { start: Date; end: Date; byUser: boolean }) => {
    if (!props.byUser) return;
    state.userWindow = { start: new Date(props.start), end: new Date(props.end) };
    syncUrl();
  });

  if (state.pendingItem) {
    const id = state.pendingItem;
    state.pendingItem = null;
    setTimeout(() => {
      try {
        timeline?.setSelection([id]);
      } catch {
        /* item may not exist in this build */
      }
      state.selectedItemId = id;
      showDetailForId(id);
    }, 0);
  }
  if (state.pendingWindow) {
    state.userWindow = state.pendingWindow;
    state.pendingWindow = null;
  }

  setStatus(statusFor(view, built));
}

// Toggle the compact tag mode based on how much horizontal room a day of the
// timeline currently occupies. Recomputed on zoom/pan (`rangechange`) and on
// container resize; only mutates the DOM when the state actually flips.
export function updateTagDensity(): void {
  if (!timeline) return;
  const win = timeline.getWindow();
  const width = els.timeline.clientWidth;
  if (!width) return;
  const days = (win.end.getTime() - win.start.getTime()) / MS_PER_DAY;
  const pxPerDay = days > 0 ? width / days : Infinity;
  const compact = pxPerDay < TAG_TEXT_MIN_PX_PER_DAY;
  els.timeline.classList.toggle('is-tags-compact', compact);
}

function handleMove(item: TimelineItem, callback: (item: TimelineItem | null) => void): void {
  if (!state.activeSourceFile) {
    callback(item);
    return;
  }
  const idx = findItemIndex(state.activeSourceFile, item.id);
  if (idx === -1) {
    callback(item);
    return;
  }
  const src = state.activeSourceFile.items[idx];
  const newStart = isoDateOnly(item.start);
  const newEnd = item.end ? isoDateOnly(item.end) : undefined;

  src.start = newStart;
  if (src.type === 'point') {
    delete src.end;
    delete src.duration;
  } else if (newEnd) {
    src.end = newEnd;
    delete src.duration;
  } else {
    delete src.end;
  }
  if (item.group != null && item.group !== src.group) {
    src.group = String(item.group);
  }

  callback(item);
  rebuildAndApply();
  schedulePersist();
  if (state.activeFormItemId === item.id) {
    showItemForm(src);
  }
}

// Appends a new item to the active source at the given start/group, persists,
// and opens its edit form. Shared by the double-click handler (handleAdd) and
// the toolbar "+ Eintrag" button (addNewItem).
export function createItem(start: Date, group?: string | number | null): (TimelineFileItem & { id: string }) | null {
  if (!state.activeSourceFile) return null;
  const newId = generateNewId(state.activeSourceFile);
  const groupId = group != null
    ? String(group)
    : state.activeSourceFile.groups?.[0]?.id ?? state.activeBuild?.groups[0]?.id;

  const newItem: TimelineFileItem & { id: string } = {
    id: newId,
    start: isoDateOnly(start),
    duration: '1w',
    content: 'Neuer Eintrag',
    group: groupId,
  };
  state.activeSourceFile.items.push(newItem);
  rebuildAndApply();
  schedulePersist();
  return newItem;
}

function handleAdd(item: TimelineItem, callback: (item: TimelineItem | null) => void): void {
  const newItem = createItem(item.start, item.group);
  if (!newItem) {
    callback(null);
    return;
  }
  callback({ ...item, id: newItem.id, content: newItem.content });
  setTimeout(() => showItemForm(newItem), 50);
}

// Toolbar "+ Eintrag": adds an item at the centre of the visible window (so it
// lands on screen) and opens its form. No-op on read-only views.
export function addNewItem(): void {
  if (!isEditableView()) return;
  const win = timeline?.getWindow();
  const start = win
    ? new Date((new Date(win.start).getTime() + new Date(win.end).getTime()) / 2)
    : new Date();
  const newItem = createItem(start);
  if (!newItem) return;
  setTimeout(() => {
    try {
      timeline?.setSelection([newItem.id]);
    } catch {
      /* item may be filtered out of the current view */
    }
    showItemForm(newItem);
  }, 50);
}

function handleRemove(item: TimelineItem, callback: (item: TimelineItem | null) => void): void {
  if (!state.activeSourceFile) {
    callback(item);
    return;
  }
  const idx = findItemIndex(state.activeSourceFile, item.id);
  if (idx === -1) {
    callback(item);
    return;
  }
  const src = state.activeSourceFile.items[idx];
  if (!confirm(`„${src.content}" wirklich löschen?`)) {
    callback(null);
    return;
  }
  state.activeSourceFile.items.splice(idx, 1);
  callback(item);
  rebuildAndApply();
  schedulePersist();
  hideDetail();
}

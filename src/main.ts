import { Timeline, DataSet } from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.css';
import { marked } from 'marked';
import type { Config, NotesData, Note, TimelineFile, TimelineFileItem, View } from './types';
import {
  buildFromJson,
  buildFromNotes,
  escapeHtml,
  type BuildResult,
  type DetailNote,
  type TimelineGroup,
  type TimelineItem,
} from './buildItems';
import { DependencyArrows } from './arrows';
import { PhaseBand, type PhaseEdit } from './phaseBand';
import { TIMELINE_ICONS, iconSpanHtml } from './icons';
import { createMarkdownEditor, type MarkdownEditor } from './wysiwyg';
import {
  ensureItemIds,
  findItemIndex,
  generateNewId,
  isoDateOnly,
  loadSource,
  apiAddItem,
  apiUpdateItem,
  apiDeleteItem,
  apiPutPhases,
  ConflictError,
} from './editor';
import {
  onExternalUrlStateChange,
  readUrlState,
  writeUrlState,
  type UrlState,
} from './urlState';
import {
  isJiraKey,
  jiraLinksHtml,
  normalizeKey,
  readJiraIssues,
  searchJira,
  type JiraIssue,
} from './jira';
import { isRealtimeEnabled, subscribeTimeline } from './realtime';

const els = {
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

const MILESTONES_ONLY_KEY = 'timelines.milestonesOnly';
let milestonesOnly = localStorage.getItem(MILESTONES_ONLY_KEY) === 'true';

const BRAND_MODE = (import.meta.env.VITE_BRAND_MODE ?? 'select') as 'select' | 'fixed';
const DEFAULT_BRAND = (import.meta.env.VITE_DEFAULT_BRAND ?? 'marcel-mellor') as string;

let timeline: Timeline | null = null;
let arrows: DependencyArrows | null = null;
let phaseBand: PhaseBand | null = null;
let itemsDs: DataSet<TimelineItem> | null = null;
let groupsDs: DataSet<TimelineGroup> | null = null;
let allNotes: Note[] = [];
let config: Config | null = null;
let activeView: View | null = null;
let activeSourceId: string | null = null;
let activeSourceFile: TimelineFile | null = null;
let activeSourceEditable = false;
let activeBuild: BuildResult | null = null;
// Snapshot of the last successfully persisted state, diffed on persist() so we
// only send the items/phases that actually changed (item-level writes instead
// of a whole-document rewrite — concurrent edits no longer clobber).
let savedItems = new Map<string, string>(); // id -> canonical JSON (version stripped)
let savedItemVersions = new Map<string, number>(); // id -> last known version
let savedPhasesJson = '[]';
let activeFormItemId: string | null = null;
let activeFormPhaseIndex: number | null = null;
// Linked JIRA issues for the form currently open. Mutated by the autosuggest
// chips; read back in applyItemForm.
let formJiraIssues: JiraIssue[] = [];
// dependsOn IDs for the form currently open. Mutated by the deps autosuggest
// chips; read back in applyItemForm.
let formDependsOn: string[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let realtimeUnsub: (() => void) | null = null;
let realtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
// Debounce for reactive form edits: coalesces rapid keystrokes into one
// model update + live rebuild (see scheduleLiveEdit).
let liveEditTimer: ReturnType<typeof setTimeout> | null = null;
let currentBrand = DEFAULT_BRAND;
let selectedItemId: string | null = null;
let userWindow: { start: Date; end: Date } | null = null;
let pendingItem: string | null = null;
let pendingWindow: { start: Date; end: Date } | null = null;
let suppressUrlSync = false;

function syncUrl(): void {
  if (suppressUrlSync || !activeView) return;
  const state: UrlState = { view: activeView.id };
  if (selectedItemId) state.item = selectedItemId;
  if (userWindow) {
    state.from = isoDateOnly(userWindow.start);
    state.to = isoDateOnly(userWindow.end);
  }
  if (milestonesOnly) state.milestones = true;
  if (BRAND_MODE === 'select' && currentBrand && currentBrand !== DEFAULT_BRAND) {
    state.brand = currentBrand;
  }
  writeUrlState(state);
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

function setStatus(text: string): void {
  els.status.textContent = text;
}

function isEditableView(): boolean {
  return !!activeSourceFile && !!activeSourceId && activeSourceEditable;
}

function filterBuildForDisplay(build: NonNullable<typeof activeBuild>): {
  items: TimelineItem[];
  groups: TimelineGroup[];
} {
  if (!milestonesOnly) return { items: build.items, groups: build.groups };
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

function rebuildAndApply(): void {
  if (!activeView || !activeSourceFile || !timeline) return;
  const built = buildFromJson(activeView, activeSourceFile);
  activeBuild = built;
  applyBuildToDataSets();
  if (arrows) arrows.setDependencies(built.dependencies);
  if (phaseBand) phaseBand.setPhases(built.phases);
  setStatus(statusFor(activeView, built));
}

function applyBuildToDataSets(): void {
  if (!activeBuild) return;
  const filtered = filterBuildForDisplay(activeBuild);
  if (itemsDs) {
    itemsDs.clear();
    itemsDs.add(filtered.items);
  }
  if (groupsDs) {
    groupsDs.clear();
    groupsDs.add(filtered.groups);
  }
}

function statusFor(view: View, build: NonNullable<typeof activeBuild>): string {
  const filtered = filterBuildForDisplay(build);
  const suffix = milestonesOnly ? ' · nur Meilensteine' : '';
  return `${filtered.items.length} items in „${view.name}" · ${filtered.groups.length} groups${suffix}`;
}

function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

// Canonical JSON of an item with the server-managed `version` stripped, so
// content changes are detected but a version bump alone is not.
function canonicalItem(item: TimelineFileItem): string {
  const { version: _v, ...rest } = item;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// Rebuild the saved-state snapshot from the current in-memory file. Called
// after a load and after every successful persist.
function snapshotSaved(): void {
  savedItems = new Map();
  savedItemVersions = new Map();
  for (const it of activeSourceFile?.items ?? []) {
    if (!it.id) continue;
    savedItems.set(it.id, canonicalItem(it));
    if (it.version != null) savedItemVersions.set(it.id, it.version);
  }
  savedPhasesJson = JSON.stringify(activeSourceFile?.phases ?? []);
}

let persisting = false;
let persistAgain = false;

async function persist(): Promise<void> {
  if (!activeSourceId || !activeSourceFile) return;
  if (persisting) {
    persistAgain = true; // coalesce edits that land mid-save
    return;
  }
  persisting = true;
  const sourceId = activeSourceId;
  const file = activeSourceFile;
  try {
    const currentIds = new Set(file.items.map((it) => it.id).filter(Boolean) as string[]);

    // Additions + updates.
    for (const it of file.items) {
      if (!it.id) continue;
      const canon = canonicalItem(it);
      const prev = savedItems.get(it.id);
      if (prev === undefined) {
        setStatus('Speichere…');
        const saved = await apiAddItem(sourceId, it);
        it.version = saved.version;
        savedItems.set(it.id, canonicalItem(it));
        if (saved.version != null) savedItemVersions.set(it.id, saved.version);
      } else if (prev !== canon) {
        setStatus('Speichere…');
        const { id: _id, version: _v, ...patch } = it;
        const saved = await apiUpdateItem(sourceId, it.id, patch, savedItemVersions.get(it.id));
        it.version = saved.version;
        savedItems.set(it.id, canonicalItem(it));
        if (saved.version != null) savedItemVersions.set(it.id, saved.version);
      }
    }

    // Deletions.
    for (const oldId of [...savedItems.keys()]) {
      if (!currentIds.has(oldId)) {
        setStatus('Speichere…');
        await apiDeleteItem(sourceId, oldId);
        savedItems.delete(oldId);
        savedItemVersions.delete(oldId);
      }
    }

    // Phases (replaced as a unit — small, rarely edited).
    const phasesJson = JSON.stringify(file.phases ?? []);
    if (phasesJson !== savedPhasesJson) {
      setStatus('Speichere…');
      await apiPutPhases(sourceId, file.phases ?? []);
      savedPhasesJson = phasesJson;
    }

    setStatus(`Gespeichert · ${file.items.length} items`);
  } catch (err) {
    if (err instanceof ConflictError) {
      // Someone edited the same item concurrently — reload authoritative state.
      setStatus('Konflikt: extern geändert, lade neu…');
      persisting = false;
      persistAgain = false;
      if (activeView) await renderTimeline(activeView);
      return;
    }
    console.error(err);
    setStatus(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    persisting = false;
    if (persistAgain) {
      persistAgain = false;
      void persist();
    }
  }
}

// Reload the active source from the server and re-render, preserving the
// current viewport. Used when a remote change arrives via realtime.
function scheduleRemoteRefresh(): void {
  if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(() => {
    if (!activeView) return;
    const win = timeline?.getWindow();
    if (win) pendingWindow = { start: new Date(win.start), end: new Date(win.end) };
    void renderTimeline(activeView);
  }, 400);
}

// (Re)subscribe to realtime changes for the active editable DB source.
function setupRealtime(): void {
  if (realtimeUnsub) {
    realtimeUnsub();
    realtimeUnsub = null;
  }
  if (!isRealtimeEnabled() || !activeSourceId || !activeSourceEditable) return;
  const sourceId = activeSourceId;
  realtimeUnsub = subscribeTimeline(sourceId, (change) => {
    if (activeSourceId !== sourceId) return; // stale event after a view switch
    // Suppress our own echo: we already hold this exact version.
    if (
      change.table === 'timeline_items' &&
      change.version != null &&
      savedItemVersions.get(change.id) === change.version
    ) {
      return;
    }
    // Don't clobber a form the user is editing — just flag it.
    if (change.table === 'timeline_items' && change.id === activeFormItemId) {
      setStatus('Dieser Eintrag wurde extern geändert — beim Speichern wird neu geladen.');
      return;
    }
    scheduleRemoteRefresh();
  });
}

async function renderTimeline(view: View) {
  if (!config) return;

  // A fresh vis-timeline always starts scrolled to the top. When we re-render
  // the *same* view (realtime refresh, conflict reload, live rebuild) we must
  // keep the user where they were vertically — otherwise clicking/editing an
  // item near the bottom snaps the view to the top. The horizontal window is
  // preserved separately via `pendingWindow`; this is its vertical counterpart.
  const sameView = activeView?.id === view.id;
  const prevVScroll = sameView
    ? els.timeline.querySelector<HTMLElement>('.vis-panel.vis-left')?.scrollTop ?? 0
    : 0;

  let built: typeof activeBuild;
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
    built = buildFromNotes(view, allNotes, config);
  }
  activeBuild = built;
  activeView = view;
  activeSourceFile = sourceFile;
  activeSourceId = sourceId;
  activeSourceEditable = sourceEditable;
  snapshotSaved();
  setupRealtime();

  const filtered = filterBuildForDisplay(built!);
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
    els.timeline.innerHTML = '';
  }

  const useGroups = filtered.groups.length > 0;

  const now = Date.now();
  const yearMs = 365 * 24 * 3600 * 1000;
  const recent = built!.items
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

  const initialStart = pendingWindow?.start ?? new Date(focusMin - padding);
  const initialEnd = pendingWindow?.end ?? new Date(focusMax + padding);

  // reserve room at the top for the phase ribbon so items sit below it
  const axisMargin = built!.phases.length > 0 ? 34 : 8;

  timeline = new Timeline(els.timeline, itemsDs, useGroups ? groupsDs : undefined, {
    stack: true,
    horizontalScroll: true,
    zoomKey: 'ctrlKey',
    // Prepend the brand-resolved icon at render time so the stored `content`
    // stays clean (used by the edit form, confirm dialogs, and Sheets).
    template: (item: TimelineItem) =>
      item ? `${iconSpanHtml(item.icon)}${item.content ?? ''}` : '',
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

  // ===== TEMP SCROLL DIAGNOSTIC — nach Debugging wieder entfernen =====
  // Loggt jedes Mal, wenn vis-timeline den vertikalen Offset auf 0 (= ganz oben)
  // setzt, samt Stacktrace des Verursachers. So sehen wir im echten Browser,
  // welcher Code-Pfad den Sprung auslöst.
  {
    const tlAny = timeline as any;
    const orig = tlAny._setScrollTop?.bind(tlAny);
    if (orig) {
      tlAny._setScrollTop = (v: number) => {
        const prev = tlAny.props?.scrollTop;
        if (v === 0 && prev != null && prev < -5) {
          // eslint-disable-next-line no-console
          console.warn('[scroll-diag] Sprung nach oben: scrollTop', prev, '→ 0');
          // eslint-disable-next-line no-console
          console.trace('[scroll-diag] Verursacher');
        }
        return orig(v);
      };
    }
  }
  // ===== /TEMP SCROLL DIAGNOSTIC =====

  let lastH = containerHeight;
  const ro = new ResizeObserver(() => {
    const h = els.timeline.clientHeight;
    if (h > 0 && h !== lastH) {
      lastH = h;
      timeline?.setOptions({ height: `${h}px` });
    }
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

  if (built!.dependencies.size > 0) {
    requestAnimationFrame(() => {
      try {
        arrows = new DependencyArrows(timeline!, els.timeline);
        arrows.setDependencies(built!.dependencies);
      } catch (err) {
        console.warn('DependencyArrows init failed:', err);
      }
    });
  }

  if (built!.phases.length > 0) {
    requestAnimationFrame(() => {
      try {
        phaseBand = new PhaseBand(timeline!, els.timeline);
        phaseBand.setPhases(built!.phases);
        if (isEditableView()) phaseBand.setEditable(true, handlePhaseEdit, showPhaseFormByIndex);
      } catch (err) {
        console.warn('PhaseBand init failed:', err);
      }
    });
  }

  timeline.on('select', (props: { items: string[] }) => {
    const id = props.items[0];
    if (!id) {
      selectedItemId = null;
      syncUrl();
      return;
    }
    selectedItemId = id;
    syncUrl();
    showDetailForId(id);
  });

  timeline.on('rangechanged', (props: { start: Date; end: Date; byUser: boolean }) => {
    if (!props.byUser) return;
    userWindow = { start: new Date(props.start), end: new Date(props.end) };
    syncUrl();
  });

  if (pendingItem) {
    const id = pendingItem;
    pendingItem = null;
    setTimeout(() => {
      try {
        timeline?.setSelection([id]);
      } catch {
        /* item may not exist in this build */
      }
      selectedItemId = id;
      showDetailForId(id);
    }, 0);
  }
  if (pendingWindow) {
    userWindow = pendingWindow;
    pendingWindow = null;
  }

  setStatus(statusFor(view, built!));
}

function handleMove(item: TimelineItem, callback: (item: TimelineItem | null) => void): void {
  if (!activeSourceFile) {
    callback(item);
    return;
  }
  const idx = findItemIndex(activeSourceFile, item.id);
  if (idx === -1) {
    callback(item);
    return;
  }
  const src = activeSourceFile.items[idx];
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
  if (activeFormItemId === item.id) {
    showItemForm(src);
  }
}

function handlePhaseEdit(edit: PhaseEdit): void {
  const phase = activeSourceFile?.phases?.[edit.srcIndex];
  if (!phase) return;
  // Persist as explicit start/end and drop any `duration` so the written range
  // is unambiguous (mirrors how item moves are stored).
  phase.start = isoDateOnly(edit.start);
  phase.end = isoDateOnly(edit.end);
  delete phase.duration;
  rebuildAndApply();
  schedulePersist();
  if (activeFormPhaseIndex === edit.srcIndex) showPhaseForm(edit.srcIndex);
}

function showPhaseFormByIndex(srcIndex: number): void {
  showPhaseForm(srcIndex);
}

function showPhaseForm(srcIndex: number): void {
  const phase = activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  // Opening a phase form supersedes any open item form.
  activeFormItemId = null;
  activeFormPhaseIndex = srcIndex;
  timeline?.setSelection([]);
  selectedItemId = null;

  els.detailTitle.textContent = phase.label || '(unbenannte Phase)';
  els.detailMeta.innerHTML = '';

  const iconOptions =
    `<option value=""${!phase.icon ? ' selected' : ''}>— kein Icon —</option>` +
    TIMELINE_ICONS.map(
      ({ key, label }) => `<option value="${key}"${phase.icon === key ? ' selected' : ''}>${label}</option>`,
    ).join('');

  els.detailBody.classList.add('detail-form');
  els.detailBody.innerHTML = `
    <form class="item-form phase-form" data-index="${srcIndex}">
      <div class="field full">
        <label for="p-label">Titel</label>
        <input id="p-label" name="label" value="${escapeHtml(phase.label ?? '')}" />
      </div>
      <div class="field">
        <label for="p-start">Start</label>
        <input id="p-start" name="start" type="date" value="${isoDateOnly(phase.start)}" />
      </div>
      <div class="field">
        <label for="p-end">Ende</label>
        <input id="p-end" name="end" type="date" value="${isoDateOnly(phase.end ?? '')}" />
      </div>
      <div class="field">
        <label for="p-duration">Dauer</label>
        <input id="p-duration" name="duration" value="${escapeHtml(typeof phase.duration === 'string' ? phase.duration : phase.duration != null ? String(phase.duration) : '')}" placeholder="leer = Ende nutzen" />
      </div>
      <div class="field">
        <label for="p-icon">Icon</label>
        <select id="p-icon" name="icon">${iconOptions}</select>
      </div>
      <div class="field">
        <label for="p-color">Farbe</label>
        <input id="p-color" name="color" value="${escapeHtml(phase.color ?? '')}" placeholder="#2f0d5b" />
      </div>
      <div class="field">
        <label for="p-id">ID <small>(read-only)</small></label>
        <input id="p-id" name="id" value="${escapeHtml(phase.id ?? '')}" readonly />
      </div>
      <div class="form-actions">
        <button type="submit" class="btn-primary">Speichern</button>
        <button type="button" class="btn-danger" data-action="delete">Löschen</button>
      </div>
    </form>
  `;

  const form = els.detailBody.querySelector('form') as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    savePhaseFromForm(srcIndex, form);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    deletePhase(srcIndex);
  });

  els.detail.hidden = false;
  setTimeout(() => timeline?.redraw(), 0);
}

function savePhaseFromForm(srcIndex: number, form: HTMLFormElement): void {
  const phase = activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  phase.label = get('label') || phase.label;
  const startVal = get('start');
  if (startVal) phase.start = startVal;

  const endVal = get('end');
  const durVal = get('duration');
  // Duration wins over end (same precedence as items); at least one is needed
  // for the phase to render, so keep whatever the user supplied.
  if (durVal) {
    phase.duration = durVal;
    delete phase.end;
  } else if (endVal) {
    phase.end = endVal;
    delete phase.duration;
  } else {
    delete phase.duration;
    delete phase.end;
  }

  const iconVal = get('icon');
  if (iconVal) phase.icon = iconVal;
  else delete phase.icon;

  const colorVal = get('color');
  if (colorVal) phase.color = colorVal;
  else delete phase.color;

  rebuildAndApply();
  schedulePersist();
  setStatus(`Phase „${phase.label}" aktualisiert`);
  showPhaseForm(srcIndex);
}

function deletePhase(srcIndex: number): void {
  const phase = activeSourceFile?.phases?.[srcIndex];
  if (!phase) return;
  if (!confirm(`Phase „${phase.label}" wirklich löschen?`)) return;
  activeSourceFile!.phases!.splice(srcIndex, 1);
  activeFormPhaseIndex = null;
  rebuildAndApply();
  schedulePersist();
  hideDetail();
}

// Appends a new item to the active source at the given start/group, persists,
// and opens its edit form. Shared by the double-click handler (handleAdd) and
// the toolbar "+ Eintrag" button (addNewItem).
function createItem(start: Date, group?: string | number | null): (TimelineFileItem & { id: string }) | null {
  if (!activeSourceFile) return null;
  const newId = generateNewId(activeSourceFile);
  const groupId = group != null
    ? String(group)
    : activeSourceFile.groups?.[0]?.id ?? activeBuild?.groups[0]?.id;

  const newItem: TimelineFileItem & { id: string } = {
    id: newId,
    start: isoDateOnly(start),
    duration: '1w',
    content: 'Neuer Eintrag',
    group: groupId,
  };
  activeSourceFile.items.push(newItem);
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
function addNewItem(): void {
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
  if (!activeSourceFile) {
    callback(item);
    return;
  }
  const idx = findItemIndex(activeSourceFile, item.id);
  if (idx === -1) {
    callback(item);
    return;
  }
  const src = activeSourceFile.items[idx];
  if (!confirm(`„${src.content}" wirklich löschen?`)) {
    callback(null);
    return;
  }
  activeSourceFile.items.splice(idx, 1);
  callback(item);
  rebuildAndApply();
  schedulePersist();
  hideDetail();
}

function showDetailForId(id: string): void {
  if (isEditableView() && activeSourceFile) {
    const item = activeSourceFile.items.find((it) => it.id === id);
    if (item) {
      showItemForm(item);
      return;
    }
  }
  const note = activeBuild?.details.get(id);
  if (note) showDetail(note);
}

function showDetail(note: DetailNote) {
  els.detailTitle.textContent = note.title;

  const fm = note.frontmatter;
  const metaPairs: [string, string][] = [];
  if (note.start) metaPairs.push(['Start', `${note.start.slice(0, 10)} (${note.dateSource ?? '?'})`]);
  if (note.end) metaPairs.push(['End', note.end.slice(0, 10)]);
  if (note.folder) metaPairs.push(['Folder', note.folder]);
  if (note.filename) metaPairs.push(['File', note.filename]);
  for (const key of ['categories', 'tags', 'topics', 'status', 'distribution']) {
    const v = fm[key];
    if (v == null || v === '') continue;
    metaPairs.push([key, Array.isArray(v) ? v.map(String).join(', ') : String(v)]);
  }

  const jiraIssues = readJiraIssues(fm);

  els.detailMeta.innerHTML =
    metaPairs
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join('') +
    (jiraIssues.length
      ? `<dt>JIRA</dt><dd class="jira-refs">${jiraLinksHtml(jiraIssues, escapeHtml)}</dd>`
      : '');

  const bodyHtml = marked.parse(note.body || '', { async: false }) as string;
  els.detailBody.innerHTML = bodyHtml;
  els.detailBody.classList.remove('detail-form');

  els.detail.hidden = false;
  setTimeout(() => timeline?.redraw(), 0);
}

function showItemForm(item: TimelineFileItem & { id?: string }): void {
  if (!activeSourceFile || !item.id) return;
  const id = item.id;
  // Switching to a different item = leaving the previous form → persist it.
  if (activeFormItemId && activeFormItemId !== id) commitItemForm();
  activeFormItemId = id;
  activeFormPhaseIndex = null;
  els.detailTitle.textContent = item.content || '(unbenannt)';
  els.detailMeta.innerHTML = '';

  const groupOptions = (activeSourceFile.groups ?? activeBuild?.groups ?? []).map((g) =>
    `<option value="${escapeHtml(g.id)}"${g.id === item.group ? ' selected' : ''}>${escapeHtml(g.content)}</option>`
  ).join('');

  const metadata = (item.metadata ?? {}) as Record<string, unknown>;
  const dependsOn = Array.isArray(metadata.dependsOn) ? (metadata.dependsOn as unknown[]).map(String) : [];
  formDependsOn = [...dependsOn];
  const owner = typeof metadata.owner === 'string' ? metadata.owner : '';
  formJiraIssues = readJiraIssues(metadata);

  const otherMeta = Object.fromEntries(
    Object.entries(metadata).filter(([k]) => k !== 'dependsOn' && k !== 'owner' && k !== 'jira')
  );
  const metaJson = Object.keys(otherMeta).length ? JSON.stringify(otherMeta, null, 2) : '';

  els.detailBody.classList.add('detail-form');
  els.detailBody.innerHTML = `
    <form class="item-form" data-id="${escapeHtml(id)}">
      <div class="field full">
        <label for="f-content">Title</label>
        <input id="f-content" name="content" value="${escapeHtml(item.content ?? '')}" />
      </div>
      <div class="field">
        <label for="f-start">Start</label>
        <input id="f-start" name="start" type="date" value="${isoDateOnly(item.start)}" />
      </div>
      <div class="field">
        <label for="f-end">End</label>
        <input id="f-end" name="end" type="date" value="${isoDateOnly(item.end ?? '')}" />
      </div>
      <div class="field">
        <label for="f-duration">Duration</label>
        <input id="f-duration" name="duration" value="${escapeHtml(typeof item.duration === 'string' ? item.duration : item.duration != null ? String(item.duration) : '')}" placeholder="leer = End nutzen" />
      </div>
      <div class="field">
        <label for="f-group">Group</label>
        <select id="f-group" name="group">${groupOptions}</select>
      </div>
      <div class="field">
        <label for="f-type">Type</label>
        <select id="f-type" name="type">
          ${[
            ['', 'Automatisch'],
            ['point', 'Meilenstein'],
            ['range', 'Zeitraum'],
            ['background', 'Phase (Hintergrund)'],
            ['box', 'Markierung'],
          ].map(([t, label]) => `<option value="${t}"${(item.type ?? '') === t ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="f-icon">Icon</label>
        <select id="f-icon" name="icon">
          <option value=""${!item.icon ? ' selected' : ''}>— kein Icon —</option>
          ${TIMELINE_ICONS.map(({ key, label }) => `<option value="${key}"${item.icon === key ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="field full">
        <label>Body</label>
        <div data-role="body-editor"></div>
        <textarea id="f-body" name="body" hidden>${escapeHtml(item.body ?? '')}</textarea>
      </div>
      <div class="field full deps-field">
        <label for="f-deps">Depends on <small>(Einträge verknüpfen)</small></label>
        <div class="deps-chips" data-role="deps-chips"></div>
        <div class="deps-suggest">
          <input id="f-deps" type="text" autocomplete="off" placeholder="Eintrag suchen…" />
          <ul class="deps-suggest-list" data-role="deps-list" hidden></ul>
        </div>
      </div>
      <div class="field full jira-field">
        <label for="f-jira">JIRA <small>(Tickets verlinken)</small></label>
        <div class="jira-chips" data-role="jira-chips"></div>
        <div class="jira-suggest">
          <input id="f-jira" type="text" autocomplete="off" placeholder="Ticket suchen oder Key eingeben (z. B. PROJ-123)…" />
          <ul class="jira-suggest-list" data-role="jira-list" hidden></ul>
        </div>
      </div>
      <div class="field">
        <label for="f-owner">Owner</label>
        <input id="f-owner" name="owner" value="${escapeHtml(owner)}" />
      </div>
      <div class="field">
        <label for="f-id">ID <small>(read-only)</small></label>
        <input id="f-id" name="id" value="${escapeHtml(id)}" readonly />
      </div>
      <div class="field full meta-json">
        <label for="f-meta">Other metadata (JSON)</label>
        <textarea id="f-meta" name="metadata" rows="3" placeholder='{"key": "value"}'>${escapeHtml(metaJson)}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-danger" data-action="delete">Löschen</button>
      </div>
    </form>
  `;

  const form = els.detailBody.querySelector('form') as HTMLFormElement;
  const typeSelect = form.querySelector<HTMLSelectElement>('#f-type')!;
  const endField = form.querySelector<HTMLElement>('#f-end')!.closest('.field') as HTMLElement;
  const durField = form.querySelector<HTMLElement>('#f-duration')!.closest('.field') as HTMLElement;
  // A point (Meilenstein) has no extent. End/Duration stay editable: entering
  // one promotes the item to a range live (see applyItemForm). Just flag the
  // point state visually so the interaction reads cleanly.
  const syncTypeFields = () => {
    const isPoint = typeSelect.value === 'point';
    endField.classList.toggle('is-muted', isPoint);
    durField.classList.toggle('is-muted', isPoint);
  };
  syncTypeFields();
  typeSelect.addEventListener('change', syncTypeFields);

  // Reactive editing: every change writes straight into the model and refreshes
  // the live view. No save button — the source is persisted when the sidebar is
  // left (commitItemForm).
  form.addEventListener('input', scheduleLiveEdit);
  form.addEventListener('change', scheduleLiveEdit);
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    deleteItem(id);
  });

  wireBodyEditor(form);
  wireJiraAutosuggest(form);
  wireDepsAutosuggest(form, id);

  els.detail.hidden = false;
  // Switching items commits the previous form, whose rebuildAndApply reloads the
  // DataSet (dropping the selection) and re-selects the *old* item. Re-assert the
  // selection on the item we're actually showing so the mark follows the sidebar.
  try {
    timeline?.setSelection([id]);
  } catch {
    /* item may be filtered out of the current view */
  }
  setTimeout(() => timeline?.redraw(), 0);
}

// Mounts the Markdown WYSIWYG editor over the hidden Body textarea. The editor
// keeps the textarea's value in sync (Markdown) and dispatches a bubbling input
// event so the form's existing live-edit listener persists the change.
let bodyEditor: MarkdownEditor | null = null;
function wireBodyEditor(form: HTMLFormElement): void {
  const mount = form.querySelector<HTMLElement>('[data-role="body-editor"]');
  const textarea = form.querySelector<HTMLTextAreaElement>('#f-body');
  if (!mount || !textarea) return;
  bodyEditor = createMarkdownEditor(textarea.value, () => {
    textarea.value = bodyEditor?.getMarkdown() ?? '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  mount.appendChild(bodyEditor.el);
}

// Renders the JIRA chip list (the linked-issue pills) into the form, with a
// remove button per chip. Re-rendered whenever formJiraIssues changes.
function renderJiraChips(form: HTMLFormElement): void {
  const wrap = form.querySelector<HTMLElement>('[data-role="jira-chips"]');
  if (!wrap) return;
  wrap.innerHTML = formJiraIssues
    .map(
      (iss, i) =>
        `<span class="jira-chip" title="${escapeHtml(iss.summary || iss.key)}">` +
        `<span class="jira-chip-key">${escapeHtml(iss.key)}</span>` +
        (iss.summary ? `<span class="jira-chip-sum">${escapeHtml(iss.summary)}</span>` : '') +
        `<button type="button" class="jira-chip-x" data-remove="${i}" aria-label="Entfernen">×</button>` +
        `</span>`,
    )
    .join('');
  wrap.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.remove);
      formJiraIssues.splice(idx, 1);
      renderJiraChips(form);
      scheduleLiveEdit();
    });
  });
}

function addJiraIssue(form: HTMLFormElement, issue: JiraIssue): void {
  if (!issue.key) return;
  if (formJiraIssues.some((i) => i.key === issue.key)) return;
  formJiraIssues.push(issue);
  renderJiraChips(form);
  scheduleLiveEdit();
}

function wireJiraAutosuggest(form: HTMLFormElement): void {
  renderJiraChips(form);

  const input = form.querySelector<HTMLInputElement>('#f-jira');
  const list = form.querySelector<HTMLUListElement>('[data-role="jira-list"]');
  if (!input || !list) return;

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let activeIndex = -1;
  let current: JiraIssue[] = [];

  const closeList = () => {
    list.hidden = true;
    list.innerHTML = '';
    activeIndex = -1;
    current = [];
  };

  const renderList = (issues: JiraIssue[]) => {
    current = issues;
    activeIndex = -1;
    if (!issues.length) {
      closeList();
      return;
    }
    list.innerHTML = issues
      .map(
        (iss, i) =>
          `<li class="jira-suggest-item" data-i="${i}" role="option">` +
          `<span class="jira-suggest-key">${escapeHtml(iss.key)}</span>` +
          `<span class="jira-suggest-sum">${escapeHtml(iss.summary)}</span>` +
          `</li>`,
      )
      .join('');
    list.hidden = false;
    list.querySelectorAll<HTMLLIElement>('.jira-suggest-item').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(Number(li.dataset.i));
      });
    });
  };

  const highlight = () => {
    list.querySelectorAll<HTMLLIElement>('.jira-suggest-item').forEach((li, i) => {
      li.classList.toggle('is-active', i === activeIndex);
    });
  };

  const pick = (i: number) => {
    const issue = current[i];
    if (issue) addJiraIssue(form, issue);
    input.value = '';
    closeList();
    input.focus();
  };

  const commitRaw = () => {
    const raw = input.value.trim();
    if (!raw) return;
    if (isJiraKey(raw)) {
      addJiraIssue(form, { key: normalizeKey(raw), summary: '' });
      input.value = '';
      closeList();
    }
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (debounce) clearTimeout(debounce);
    if (q.length < 2) {
      closeList();
      return;
    }
    debounce = setTimeout(async () => {
      const issues = await searchJira(q);
      // Ignore stale results if the field changed meanwhile.
      if (input.value.trim() === q) renderList(issues);
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRaw();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, current.length - 1);
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) pick(activeIndex);
      else commitRaw();
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  input.addEventListener('blur', () => {
    // Let a mousedown on a suggestion fire first, then close.
    setTimeout(closeList, 120);
  });
}

// Resolves a dependsOn id to a readable label (the item's title, falling back
// to the raw id if the target isn't in the current source, e.g. a stale ref).
function depLabel(depId: string): string {
  const it = activeSourceFile?.items.find((i) => i.id === depId);
  return it?.content?.trim() || depId;
}

// Renders the dependsOn chip list (linked-item pills) into the form, each with
// a remove button. Re-rendered whenever formDependsOn changes.
function renderDepChips(form: HTMLFormElement): void {
  const wrap = form.querySelector<HTMLElement>('[data-role="deps-chips"]');
  if (!wrap) return;
  wrap.innerHTML = formDependsOn
    .map(
      (depId, i) =>
        `<span class="deps-chip" title="${escapeHtml(depId)}">` +
        `<span class="deps-chip-label">${escapeHtml(depLabel(depId))}</span>` +
        `<button type="button" class="deps-chip-x" data-remove="${i}" aria-label="Entfernen">×</button>` +
        `</span>`,
    )
    .join('');
  wrap.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.remove);
      formDependsOn.splice(idx, 1);
      renderDepChips(form);
      scheduleLiveEdit();
    });
  });
}

function addDep(form: HTMLFormElement, depId: string): void {
  if (!depId || formDependsOn.includes(depId)) return;
  formDependsOn.push(depId);
  renderDepChips(form);
  scheduleLiveEdit();
}

// Autosuggest over the current timeline's items: type to match item titles
// (or ids), pick to link a dependency. The current item and already-linked
// items are excluded from the suggestions.
function wireDepsAutosuggest(form: HTMLFormElement, selfId: string): void {
  renderDepChips(form);

  const input = form.querySelector<HTMLInputElement>('#f-deps');
  const list = form.querySelector<HTMLUListElement>('[data-role="deps-list"]');
  if (!input || !list) return;

  let activeIndex = -1;
  let current: TimelineFileItem[] = [];

  const closeList = () => {
    list.hidden = true;
    list.innerHTML = '';
    activeIndex = -1;
    current = [];
  };

  const search = (q: string): TimelineFileItem[] => {
    const items = (activeSourceFile?.items ?? []).filter(
      (it) => it.id && it.id !== selfId && !formDependsOn.includes(it.id),
    );
    const needle = q.toLowerCase();
    const scored = items.filter(
      (it) =>
        !needle ||
        (it.content ?? '').toLowerCase().includes(needle) ||
        (it.id ?? '').toLowerCase().includes(needle),
    );
    return scored.slice(0, 8);
  };

  const highlight = () => {
    list.querySelectorAll<HTMLLIElement>('.deps-suggest-item').forEach((li, i) => {
      li.classList.toggle('is-active', i === activeIndex);
    });
  };

  const pick = (i: number) => {
    const it = current[i];
    if (it?.id) addDep(form, it.id);
    input.value = '';
    closeList();
    input.focus();
  };

  const renderList = (items: TimelineFileItem[]) => {
    current = items;
    activeIndex = -1;
    if (!items.length) {
      closeList();
      return;
    }
    list.innerHTML = items
      .map(
        (it, i) =>
          `<li class="deps-suggest-item" data-i="${i}" role="option">` +
          `<span class="deps-suggest-label">${escapeHtml(it.content?.trim() || it.id || '')}</span>` +
          `<span class="deps-suggest-id">${escapeHtml(it.id ?? '')}</span>` +
          `</li>`,
      )
      .join('');
    list.hidden = false;
    list.querySelectorAll<HTMLLIElement>('.deps-suggest-item').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(Number(li.dataset.i));
      });
    });
  };

  input.addEventListener('input', () => {
    renderList(search(input.value.trim()));
  });

  input.addEventListener('focus', () => {
    renderList(search(input.value.trim()));
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        renderList(search(input.value.trim()));
      } else if (e.key === 'Enter') {
        // Don't let a stray Enter submit/reload the form.
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, current.length - 1);
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) pick(activeIndex);
      else if (current.length) pick(0);
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  input.addEventListener('blur', () => {
    // Let a mousedown on a suggestion fire first, then close.
    setTimeout(closeList, 120);
  });
}

// Reads the open item form and writes its values into the in-memory model,
// then refreshes the live view. Reactive: called on every field change, so the
// timeline reflects edits as you type. Persistence is deferred until the
// sidebar is left (see commitItemForm).
function applyItemForm(id: string, form: HTMLFormElement): void {
  if (!activeSourceFile) return;
  const idx = findItemIndex(activeSourceFile, id);
  if (idx === -1) return;

  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  const item = activeSourceFile.items[idx];
  item.content = get('content') || item.content;
  const startVal = get('start');
  if (startVal) item.start = startVal;
  const endVal = get('end');
  const durVal = get('duration');

  const typeVal = get('type');
  if (typeVal) {
    item.type = typeVal as TimelineFileItem['type'];
  } else {
    delete item.type;
  }

  if (durVal) {
    item.duration = durVal;
    delete item.end;
  } else if (endVal) {
    item.end = endVal;
    delete item.duration;
  } else {
    delete item.duration;
    delete item.end;
  }

  // A point has no extent — but if the user gave it one, honour that and
  // promote it to a range instead of silently dropping the value.
  if (item.type === 'point' && (item.end || item.duration)) {
    delete item.type;
  }

  const grp = get('group');
  if (grp) item.group = grp;

  const iconVal = get('icon');
  if (iconVal) item.icon = iconVal;
  else delete item.icon;

  const body = String(fd.get('body') ?? '');
  if (body) item.body = body;
  else delete item.body;

  const meta = (item.metadata ??= {}) as Record<string, unknown>;
  if (formDependsOn.length) meta.dependsOn = [...formDependsOn];
  else delete meta.dependsOn;

  const owner = get('owner');
  if (owner) meta.owner = owner;
  else delete meta.owner;

  if (formJiraIssues.length) meta.jira = formJiraIssues.map((i) => ({ key: i.key, summary: i.summary }));
  else delete meta.jira;

  // Invalid metadata JSON: keep the last valid extras and just flag it in the
  // status line — no blocking alert on every keystroke while typing.
  const metaJsonRaw = get('metadata');
  let metaError = false;
  if (metaJsonRaw) {
    try {
      const extra = JSON.parse(metaJsonRaw);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [k, v] of Object.entries(extra)) {
          if (k === 'dependsOn' || k === 'owner' || k === 'jira') continue;
          meta[k] = v;
        }
      }
    } catch {
      metaError = true;
    }
  } else {
    for (const k of Object.keys(meta)) {
      if (k === 'dependsOn' || k === 'owner' || k === 'jira') continue;
      delete meta[k];
    }
  }
  if (Object.keys(meta).length === 0) delete (item as any).metadata;

  rebuildAndApply();
  // Keep the sidebar header and the timeline selection in sync with the live
  // content (rebuildAndApply reloads the DataSet, which drops the selection).
  els.detailTitle.textContent = item.content || '(unbenannt)';
  try {
    timeline?.setSelection([id]);
  } catch {
    /* item may be filtered out of the current view */
  }
  if (metaError) setStatus('Metadata JSON ungültig — Änderung nicht übernommen');
}

// Debounced reactive apply: coalesces rapid keystrokes into one model update.
function scheduleLiveEdit(): void {
  if (liveEditTimer) clearTimeout(liveEditTimer);
  liveEditTimer = setTimeout(() => {
    liveEditTimer = null;
    if (!activeFormItemId) return;
    const form = els.detailBody.querySelector<HTMLFormElement>('form.item-form');
    if (form) applyItemForm(activeFormItemId, form);
  }, 100);
}

// Flushes any pending live edit and persists the source. Called whenever the
// item sidebar is left (closed, another item opened, view switched, unload).
function commitItemForm(): void {
  if (liveEditTimer) {
    clearTimeout(liveEditTimer);
    liveEditTimer = null;
  }
  if (!activeFormItemId) return;
  const form = els.detailBody.querySelector<HTMLFormElement>('form.item-form');
  if (form) applyItemForm(activeFormItemId, form);
  void persist();
}

function deleteItem(id: string): void {
  if (!activeSourceFile) return;
  const idx = findItemIndex(activeSourceFile, id);
  if (idx === -1) return;
  const item = activeSourceFile.items[idx];
  if (!confirm(`„${item.content}" wirklich löschen?`)) return;
  activeSourceFile.items.splice(idx, 1);
  rebuildAndApply();
  schedulePersist();
  hideDetail();
}

function hideDetail() {
  if (liveEditTimer) {
    clearTimeout(liveEditTimer);
    liveEditTimer = null;
  }
  els.detail.hidden = true;
  els.detailBody.classList.remove('detail-form');
  activeFormItemId = null;
  activeFormPhaseIndex = null;
  setTimeout(() => timeline?.redraw(), 0);
}

function applyBrand(brand: string) {
  document.body.dataset.brand = brand;
  currentBrand = brand;
  if (BRAND_MODE === 'select') {
    localStorage.setItem('timelines.brand', brand);
  }
  els.brandSelect.value = brand;
  syncUrl();
}

async function applyView(viewId: string) {
  if (!config) return;
  const view = config.views.find((v) => v.id === viewId);
  if (!view) return;
  // Switching views leaves any open item form → persist it first.
  commitItemForm();
  localStorage.setItem('timelines.view', viewId);
  els.viewSelect.value = viewId;
  hideDetail();
  await renderTimeline(view);
  syncUrl();
}

async function handleExport() {
  if (!activeView || !activeBuild) return;
  const brand = document.body.dataset.brand || 'marcel-mellor';
  const original = els.exportBtn.textContent;
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = 'Exportiere…';
  try {
    const { exportTimelineHtml } = await import('./export');
    const filtered = filterBuildForDisplay(activeBuild);
    await exportTimelineHtml({
      view: activeView,
      build: { ...activeBuild, items: filtered.items, groups: filtered.groups },
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

  const [cfg, notesData] = await Promise.all([loadConfig(), loadNotes()]);
  config = cfg;
  allNotes = notesData.notes;

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
    milestonesOnly = !!urlState.milestones;
    localStorage.setItem(MILESTONES_ONLY_KEY, String(milestonesOnly));
  }

  pendingItem = urlState.item ?? null;
  if (urlState.from && urlState.to) {
    const startD = new Date(urlState.from);
    const endD = new Date(urlState.to);
    if (!Number.isNaN(startD.getTime()) && !Number.isNaN(endD.getTime())) {
      pendingWindow = { start: startD, end: endD };
    }
  }

  suppressUrlSync = true;
  applyBrand(brand);
  await applyView(initialView);
  suppressUrlSync = false;
  syncUrl();

  // Safety net: flush + persist an open item form if the tab closes mid-edit.
  window.addEventListener('beforeunload', () => commitItemForm());

  els.milestonesOnly.checked = milestonesOnly;
  els.milestonesOnly.addEventListener('change', () => {
    milestonesOnly = els.milestonesOnly.checked;
    localStorage.setItem(MILESTONES_ONLY_KEY, String(milestonesOnly));
    if (activeView && activeBuild) {
      applyBuildToDataSets();
      setStatus(statusFor(activeView, activeBuild));
      timeline?.redraw();
    }
    syncUrl();
  });

  els.viewSelect.addEventListener('change', () => {
    selectedItemId = null;
    userWindow = null;
    pendingItem = null;
    pendingWindow = null;
    applyView(els.viewSelect.value);
  });
  els.brandSelect.addEventListener('change', () => applyBrand(els.brandSelect.value));
  els.detailClose.addEventListener('click', () => {
    commitItemForm();
    selectedItemId = null;
    timeline?.setSelection([]);
    hideDetail();
    syncUrl();
  });
  els.addBtn.addEventListener('click', addNewItem);
  els.exportBtn.addEventListener('click', handleExport);

  onExternalUrlStateChange((state) => applyExternalState(state));
}

async function applyExternalState(state: UrlState): Promise<void> {
  if (!config) return;
  suppressUrlSync = true;
  try {
    if (BRAND_MODE === 'select') {
      const brand = state.brand ?? DEFAULT_BRAND;
      if (brand !== currentBrand) applyBrand(brand);
    }

    const wantMilestones = !!state.milestones;
    if (wantMilestones !== milestonesOnly) {
      milestonesOnly = wantMilestones;
      els.milestonesOnly.checked = wantMilestones;
      localStorage.setItem(MILESTONES_ONLY_KEY, String(wantMilestones));
      if (activeView && activeBuild) {
        applyBuildToDataSets();
        setStatus(statusFor(activeView, activeBuild));
        timeline?.redraw();
      }
    }

    const targetViewId = state.view ?? config.defaultView;
    const targetWindow = state.from && state.to
      ? (() => {
          const s = new Date(state.from!);
          const e = new Date(state.to!);
          return !Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())
            ? { start: s, end: e }
            : null;
        })()
      : null;

    if (activeView?.id !== targetViewId) {
      pendingItem = state.item ?? null;
      pendingWindow = targetWindow;
      await applyView(targetViewId);
    } else {
      if (state.item && state.item !== selectedItemId) {
        selectedItemId = state.item;
        try {
          timeline?.setSelection([state.item]);
        } catch {
          /* ignore */
        }
        showDetailForId(state.item);
      } else if (!state.item && selectedItemId) {
        timeline?.setSelection([]);
        selectedItemId = null;
        hideDetail();
      }
      if (targetWindow && timeline) {
        timeline.setWindow(targetWindow.start, targetWindow.end, { animation: false });
        userWindow = targetWindow;
      }
    }
  } finally {
    suppressUrlSync = false;
  }
}

bootstrap().catch((err) => {
  console.error(err);
  setStatus(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
});

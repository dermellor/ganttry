import { Timeline, DataSet } from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.css';
import { marked } from 'marked';
import type { Config, NotesData, Note, TimelineFile, TimelineFileItem, View } from './types';
import {
  buildFromJson,
  buildFromNotes,
  escapeHtml,
  type DetailNote,
  type TimelineGroup,
  type TimelineItem,
} from './buildItems';
import { DependencyArrows } from './arrows';
import {
  ensureItemIds,
  findItemIndex,
  generateNewId,
  isoDateOnly,
  loadSource,
  parseDependsOn,
  saveSourceToApi,
} from './editor';

const els = {
  timeline: document.getElementById('timeline') as HTMLDivElement,
  viewSelect: document.getElementById('view-select') as HTMLSelectElement,
  brandControl: document.getElementById('brand-control') as HTMLLabelElement,
  brandSelect: document.getElementById('brand-select') as HTMLSelectElement,
  exportBtn: document.getElementById('export-btn') as HTMLButtonElement,
  status: document.getElementById('status') as HTMLSpanElement,
  detail: document.getElementById('detail') as HTMLElement,
  detailTitle: document.getElementById('detail-title') as HTMLHeadingElement,
  detailMeta: document.getElementById('detail-meta') as HTMLDListElement,
  detailBody: document.getElementById('detail-body') as HTMLElement,
  detailClose: document.getElementById('detail-close') as HTMLButtonElement,
};

const BRAND_MODE = (import.meta.env.VITE_BRAND_MODE ?? 'select') as 'select' | 'fixed';
const DEFAULT_BRAND = (import.meta.env.VITE_DEFAULT_BRAND ?? 'marcel-mellor') as string;

let timeline: Timeline | null = null;
let arrows: DependencyArrows | null = null;
let itemsDs: DataSet<TimelineItem> | null = null;
let groupsDs: DataSet<TimelineGroup> | null = null;
let allNotes: Note[] = [];
let config: Config | null = null;
let activeView: View | null = null;
let activeSourceId: string | null = null;
let activeSourceFile: TimelineFile | null = null;
let activeSourceEditable = false;
let activeBuild: {
  items: TimelineItem[];
  groups: TimelineGroup[];
  details: Map<string, DetailNote>;
  dependencies: Map<string, string[]>;
} | null = null;
let activeFormItemId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

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

function rebuildAndApply(): void {
  if (!activeView || !activeSourceFile || !timeline) return;
  const built = buildFromJson(activeView, activeSourceFile);
  activeBuild = built;
  if (itemsDs) {
    itemsDs.clear();
    itemsDs.add(built.items);
  }
  if (groupsDs) {
    groupsDs.clear();
    groupsDs.add(built.groups);
  }
  if (arrows) arrows.setDependencies(built.dependencies);
  setStatus(`${built.items.length} items in „${activeView.name}" · ${built.groups.length} groups`);
}

function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

async function persist(): Promise<void> {
  if (!activeSourceId || !activeSourceFile) return;
  try {
    setStatus('Speichere…');
    await saveSourceToApi(activeSourceId, activeSourceFile);
    setStatus(`Gespeichert · ${activeSourceFile.items.length} items`);
  } catch (err) {
    console.error(err);
    setStatus(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function renderTimeline(view: View) {
  if (!config) return;

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

  itemsDs = new DataSet<TimelineItem>(built!.items);
  groupsDs = new DataSet<TimelineGroup>(built!.groups);

  if (arrows) {
    arrows.dispose();
    arrows = null;
  }
  if (timeline) {
    (timeline as any)._ro?.disconnect();
    timeline.destroy();
    timeline = null;
    els.timeline.innerHTML = '';
  }

  const useGroups = built!.groups.length > 0;

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

  timeline = new Timeline(els.timeline, itemsDs, useGroups ? groupsDs : undefined, {
    stack: true,
    horizontalScroll: true,
    zoomKey: 'ctrlKey',
    margin: { item: 6, axis: 8 },
    orientation: { axis: 'top', item: 'top' },
    locale: 'de',
    tooltip: { followMouse: false, overflowMethod: 'cap' },
    zoomMin: 1000 * 60 * 60 * 6,
    zoomMax: 1000 * 60 * 60 * 24 * 365 * 30,
    height: `${containerHeight}px`,
    verticalScroll: true,
    start: new Date(focusMin - padding),
    end: new Date(focusMax + padding),
    editable,
    onMove: handleMove,
    onAdd: handleAdd,
    onRemove: handleRemove,
    onUpdate: (_item: TimelineItem, callback: (item: TimelineItem | null) => void) => {
      // suppress vis-timeline's built-in inline editor; we use our own form on select
      callback(null);
    },
  } as any);

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

  timeline.on('select', (props: { items: string[] }) => {
    const id = props.items[0];
    if (!id) return;
    if (isEditableView() && activeSourceFile) {
      const item = activeSourceFile.items.find((it) => it.id === id);
      if (item) {
        showItemForm(item);
        return;
      }
    }
    const note = built!.details.get(id);
    if (note) showDetail(note);
  });

  setStatus(`${built!.items.length} items in „${view.name}"${useGroups ? ` · ${built!.groups.length} groups` : ''}`);
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

function handleAdd(item: TimelineItem, callback: (item: TimelineItem | null) => void): void {
  if (!activeSourceFile) {
    callback(null);
    return;
  }
  const newId = generateNewId(activeSourceFile);
  const groupId = item.group != null
    ? String(item.group)
    : activeSourceFile.groups?.[0]?.id ?? activeBuild?.groups[0]?.id;

  const newItem: TimelineFileItem & { id: string } = {
    id: newId,
    start: isoDateOnly(item.start),
    duration: '1w',
    content: 'Neuer Eintrag',
    group: groupId,
  };
  activeSourceFile.items.push(newItem);

  callback({ ...item, id: newId, content: newItem.content });
  rebuildAndApply();
  schedulePersist();
  setTimeout(() => showItemForm(newItem), 50);
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

  els.detailMeta.innerHTML = metaPairs
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');

  const bodyHtml = marked.parse(note.body || '', { async: false }) as string;
  els.detailBody.innerHTML = bodyHtml;
  els.detailBody.classList.remove('detail-form');

  els.detail.hidden = false;
  setTimeout(() => timeline?.redraw(), 0);
}

function showItemForm(item: TimelineFileItem & { id?: string }): void {
  if (!activeSourceFile || !item.id) return;
  const id = item.id;
  activeFormItemId = id;
  els.detailTitle.textContent = item.content || '(unbenannt)';
  els.detailMeta.innerHTML = '';

  const groupOptions = (activeSourceFile.groups ?? activeBuild?.groups ?? []).map((g) =>
    `<option value="${escapeHtml(g.id)}"${g.id === item.group ? ' selected' : ''}>${escapeHtml(g.content)}</option>`
  ).join('');

  const metadata = (item.metadata ?? {}) as Record<string, unknown>;
  const dependsOn = Array.isArray(metadata.dependsOn) ? (metadata.dependsOn as unknown[]).map(String) : [];
  const owner = typeof metadata.owner === 'string' ? metadata.owner : '';

  const otherMeta = Object.fromEntries(
    Object.entries(metadata).filter(([k]) => k !== 'dependsOn' && k !== 'owner')
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
        <label for="f-duration">Duration <small>(z. B. 7d, 2w, 90m — überschreibt End)</small></label>
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
      <div class="field full">
        <label for="f-body">Body (Markdown)</label>
        <textarea id="f-body" name="body" rows="6">${escapeHtml(item.body ?? '')}</textarea>
      </div>
      <div class="field full">
        <label for="f-deps">Depends on <small>(IDs, komma-getrennt)</small></label>
        <input id="f-deps" name="dependsOn" value="${escapeHtml(dependsOn.join(', '))}" placeholder="z. B. S-1, D-2" />
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
        <button type="submit" class="btn-primary">Speichern</button>
        <button type="button" class="btn-danger" data-action="delete">Löschen</button>
      </div>
    </form>
  `;

  const form = els.detailBody.querySelector('form') as HTMLFormElement;
  const typeSelect = form.querySelector<HTMLSelectElement>('#f-type')!;
  const endField = form.querySelector<HTMLElement>('#f-end')!.closest('.field') as HTMLElement;
  const durField = form.querySelector<HTMLElement>('#f-duration')!.closest('.field') as HTMLElement;
  const syncTypeFields = () => {
    const isPoint = typeSelect.value === 'point';
    endField.hidden = isPoint;
    durField.hidden = isPoint;
  };
  syncTypeFields();
  typeSelect.addEventListener('change', syncTypeFields);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveItemFromForm(id, form);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    deleteItem(id);
  });

  els.detail.hidden = false;
  setTimeout(() => timeline?.redraw(), 0);
}

function saveItemFromForm(id: string, form: HTMLFormElement): void {
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

  if (item.type === 'point') {
    delete item.duration;
    delete item.end;
  } else if (durVal) {
    item.duration = durVal;
    delete item.end;
  } else {
    delete item.duration;
    if (endVal) item.end = endVal;
    else delete item.end;
  }

  const grp = get('group');
  if (grp) item.group = grp;

  const body = String(fd.get('body') ?? '');
  if (body) item.body = body;
  else delete item.body;

  const meta = (item.metadata ??= {}) as Record<string, unknown>;
  const deps = parseDependsOn(get('dependsOn'));
  if (deps.length) meta.dependsOn = deps;
  else delete meta.dependsOn;

  const owner = get('owner');
  if (owner) meta.owner = owner;
  else delete meta.owner;

  const metaJsonRaw = get('metadata');
  if (metaJsonRaw) {
    try {
      const extra = JSON.parse(metaJsonRaw);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [k, v] of Object.entries(extra)) {
          if (k === 'dependsOn' || k === 'owner') continue;
          meta[k] = v;
        }
      }
    } catch (err) {
      alert(`Metadata JSON ungültig: ${err instanceof Error ? err.message : err}`);
      return;
    }
  } else {
    for (const k of Object.keys(meta)) {
      if (k === 'dependsOn' || k === 'owner') continue;
      delete meta[k];
    }
  }
  if (Object.keys(meta).length === 0) delete (item as any).metadata;

  rebuildAndApply();
  schedulePersist();
  setStatus(`Item „${item.content}" aktualisiert`);
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
  els.detail.hidden = true;
  els.detailBody.classList.remove('detail-form');
  activeFormItemId = null;
  setTimeout(() => timeline?.redraw(), 0);
}

function applyBrand(brand: string) {
  document.body.dataset.brand = brand;
  if (BRAND_MODE === 'select') {
    localStorage.setItem('timelines.brand', brand);
  }
  els.brandSelect.value = brand;
}

async function applyView(viewId: string) {
  if (!config) return;
  const view = config.views.find((v) => v.id === viewId);
  if (!view) return;
  localStorage.setItem('timelines.view', viewId);
  els.viewSelect.value = viewId;
  hideDetail();
  await renderTimeline(view);
}

async function handleExport() {
  if (!activeView || !activeBuild) return;
  const brand = document.body.dataset.brand || 'marcel-mellor';
  const original = els.exportBtn.textContent;
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = 'Exportiere…';
  try {
    const { exportTimelineHtml } = await import('./export');
    await exportTimelineHtml({ view: activeView, build: activeBuild, brand });
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

  const savedView = localStorage.getItem('timelines.view') ?? cfg.defaultView;
  const brand =
    BRAND_MODE === 'fixed'
      ? DEFAULT_BRAND
      : localStorage.getItem('timelines.brand') ?? DEFAULT_BRAND;

  if (BRAND_MODE === 'fixed') {
    els.brandControl.hidden = true;
  }

  applyBrand(brand);
  applyView(cfg.views.some((v) => v.id === savedView) ? savedView : cfg.defaultView);

  els.viewSelect.addEventListener('change', () => applyView(els.viewSelect.value));
  els.brandSelect.addEventListener('change', () => applyBrand(els.brandSelect.value));
  els.detailClose.addEventListener('click', hideDetail);
  els.exportBtn.addEventListener('click', handleExport);
}

bootstrap().catch((err) => {
  console.error(err);
  setStatus(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
});

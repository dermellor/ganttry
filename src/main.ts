import { Timeline, DataSet } from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.css';
import { marked } from 'marked';
import type { Config, NotesData, Note, TimelineFile, View } from './types';
import {
  buildFromJson,
  buildFromNotes,
  escapeHtml,
  type DetailNote,
  type TimelineGroup,
  type TimelineItem,
} from './buildItems';
import { DependencyArrows } from './arrows';

const els = {
  timeline: document.getElementById('timeline') as HTMLDivElement,
  viewSelect: document.getElementById('view-select') as HTMLSelectElement,
  brandSelect: document.getElementById('brand-select') as HTMLSelectElement,
  exportBtn: document.getElementById('export-btn') as HTMLButtonElement,
  status: document.getElementById('status') as HTMLSpanElement,
  detail: document.getElementById('detail') as HTMLElement,
  detailTitle: document.getElementById('detail-title') as HTMLHeadingElement,
  detailMeta: document.getElementById('detail-meta') as HTMLDListElement,
  detailBody: document.getElementById('detail-body') as HTMLElement,
  detailClose: document.getElementById('detail-close') as HTMLButtonElement,
};

let timeline: Timeline | null = null;
let arrows: DependencyArrows | null = null;
let allNotes: Note[] = [];
let config: Config | null = null;
let activeView: View | null = null;
let activeBuild: {
  items: TimelineItem[];
  groups: TimelineGroup[];
  details: Map<string, DetailNote>;
  dependencies: Map<string, string[]>;
} | null = null;

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

async function renderTimeline(view: View) {
  if (!config) return;

  let built: {
    items: TimelineItem[];
    groups: TimelineGroup[];
    details: Map<string, DetailNote>;
    dependencies: Map<string, string[]>;
  };

  if (view.source?.type === 'json') {
    const res = await fetch(`/data/sources/${view.source.id}.json`);
    if (!res.ok) {
      els.status.textContent = `Konnte Quelle ${view.source.id} nicht laden (${res.status})`;
      return;
    }
    const file: TimelineFile = await res.json();
    built = buildFromJson(view, file);
  } else {
    built = buildFromNotes(view, allNotes, config);
  }
  activeBuild = built;
  activeView = view;

  const itemsDs = new DataSet<TimelineItem>(built.items);
  const groupsDs = new DataSet<TimelineGroup>(built.groups);

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

  const useGroups = built.groups.length > 0;

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
  });

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

  if (built.dependencies.size > 0) {
    requestAnimationFrame(() => {
      try {
        arrows = new DependencyArrows(timeline!, els.timeline);
        arrows.setDependencies(built.dependencies);
      } catch (err) {
        console.warn('DependencyArrows init failed:', err);
      }
    });
  }

  timeline.on('select', (props: { items: string[] }) => {
    const id = props.items[0];
    if (!id) return;
    const note = built.details.get(id);
    if (note) showDetail(note);
  });

  els.status.textContent = `${built.items.length} items in „${view.name}"${useGroups ? ` · ${built.groups.length} groups` : ''}`;
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

  els.detail.hidden = false;
  setTimeout(() => timeline?.redraw(), 0);
}

function hideDetail() {
  els.detail.hidden = true;
  setTimeout(() => timeline?.redraw(), 0);
}

function applyBrand(brand: string) {
  document.body.dataset.brand = brand;
  localStorage.setItem('timelines.brand', brand);
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
  els.status.textContent = 'Lade Konfiguration & Notizen…';

  const [cfg, notesData] = await Promise.all([loadConfig(), loadNotes()]);
  config = cfg;
  allNotes = notesData.notes;

  els.viewSelect.innerHTML = cfg.views
    .map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`)
    .join('');

  const savedView = localStorage.getItem('timelines.view') ?? cfg.defaultView;
  const savedBrand = localStorage.getItem('timelines.brand') ?? 'marcel-mellor';

  applyBrand(savedBrand);
  applyView(cfg.views.some((v) => v.id === savedView) ? savedView : cfg.defaultView);

  els.viewSelect.addEventListener('change', () => applyView(els.viewSelect.value));
  els.brandSelect.addEventListener('change', () => applyBrand(els.brandSelect.value));
  els.detailClose.addEventListener('click', hideDetail);
  els.exportBtn.addEventListener('click', handleExport);
}

bootstrap().catch((err) => {
  console.error(err);
  els.status.textContent = `Fehler: ${err instanceof Error ? err.message : String(err)}`;
});

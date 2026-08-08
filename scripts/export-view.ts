import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuiltConfig, TimelineFile, TimelineFileItem, View } from '../src/types';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = join(ROOT, 'public', 'data');
const STYLES_DIR = join(ROOT, 'src', 'styles');
const NM = join(ROOT, 'node_modules');
const OUT_DIR = join(ROOT, 'export');

const UNGROUPED = '_ungrouped';

type Args = { viewId: string; outPath: string | null };

function parseArgs(argv: string[]): Args {
  let outPath: string | null = null;
  let viewId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outPath = argv[++i];
    else if (!a.startsWith('--')) viewId = a;
  }
  if (!viewId) {
    console.error('Usage: tsx scripts/export-view.ts <viewId> [--out path.html]');
    console.error('       npm run export -- <viewId> [--out …]');
    process.exit(1);
  }
  return { viewId, outPath };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;

function durationToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const m = s.match(DURATION_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const map: Record<string, number> = {
    ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000,
    d: 86400000, day: 86400000, w: 604800000, wk: 604800000,
    mo: 2592000000, month: 2592000000, y: 31536000000, year: 31536000000,
  };
  return n * (map[unit] ?? 0) || null;
}

type ExportItem = {
  id: string;
  group?: string;
  start: string;
  end?: string;
  content: string;
  // Only the notes path derives a tooltip (title + date); JSON items carry none.
  title?: string;
  type: 'point' | 'range' | 'background' | 'box';
};

type ExportGroup = { id: string; content: string };

type ExportNote = {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  dateSource: string | null;
  folder: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

function detailFromJsonItem(view: View, raw: TimelineFileItem & { id: string }): ExportNote {
  return {
    id: raw.id,
    title: raw.content,
    start: raw.start ?? null,
    end: raw.end ?? null,
    dateSource: 'json',
    folder: '',
    filename: '',
    frontmatter: (raw.metadata ?? {}) as Record<string, unknown>,
    body: raw.body ?? '',
  };
}

function buildFromJson(view: View, file: TimelineFile): { items: ExportItem[]; groups: ExportGroup[]; details: Record<string, ExportNote> } {
  const items: ExportItem[] = [];
  const groupSet = new Map<string, ExportGroup>();
  const details: Record<string, ExportNote> = {};

  for (const declared of file.groups ?? []) {
    groupSet.set(declared.id, { id: declared.id, content: escapeHtml(declared.content) });
  }

  let auto = 0;
  for (const raw of file.items) {
    if (!raw.start || !raw.content) continue;
    const id = raw.id || `__auto_${auto++}`;

    let endIso: string | undefined = raw.end;
    if (!endIso) {
      const ms = durationToMs(raw.duration);
      if (ms && ms > 0) {
        const startMs = new Date(raw.start).getTime();
        if (!Number.isNaN(startMs)) endIso = new Date(startMs + ms).toISOString();
      }
    }

    const groupId = raw.group ?? UNGROUPED;
    if (!groupSet.has(groupId)) {
      groupSet.set(groupId, { id: groupId, content: groupId === UNGROUPED ? '—' : escapeHtml(groupId) });
    }

    items.push({
      id,
      group: groupId,
      start: raw.start,
      end: endIso,
      content: escapeHtml(raw.content),
      type: raw.type ?? (endIso ? 'range' : 'point'),
    });
    details[id] = detailFromJsonItem(view, { ...raw, id });
  }

  const hasGroupBy = view.groupBy || file.items.some((i) => i.group);
  const groups = hasGroupBy
    ? [...groupSet.values()].sort((a, b) => {
        if (a.id === UNGROUPED) return 1;
        if (b.id === UNGROUPED) return -1;
        return a.id.localeCompare(b.id, 'de');
      })
    : [];

  return { items, groups, details };
}


function safeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'view';
}

async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

function clientScript(): string {
  // Inline runtime, runs in the browser. Reads window.__TIMELINE_PAYLOAD__.
  return `
(function () {
  var payload = window.__TIMELINE_PAYLOAD__;
  if (!payload) return;
  var items = payload.items;
  var groups = payload.groups;
  var details = payload.details;

  var elTimeline = document.getElementById('timeline');
  var elDetail = document.getElementById('detail');
  var elDetailTitle = document.getElementById('detail-title');
  var elDetailMeta = document.getElementById('detail-meta');
  var elDetailBody = document.getElementById('detail-body');
  var elDetailClose = document.getElementById('detail-close');
  var elStatus = document.getElementById('status');

  var itemsDs = new vis.DataSet(items);
  var groupsDs = new vis.DataSet(groups);
  var useGroups = groups.length > 0;

  var now = Date.now();
  var yearMs = 365 * 24 * 3600 * 1000;
  var recent = items
    .map(function (i) { return new Date(i.start).getTime(); })
    .filter(function (t) { return t <= now + yearMs; })
    .sort(function (a, b) { return b - a; });
  var focusMax = recent[0] || now;
  var focusMin = recent[Math.min(recent.length - 1, 200)] || (focusMax - 2 * yearMs);
  var span = Math.max(focusMax - focusMin, 90 * 24 * 3600 * 1000);
  var padding = span * 0.05;
  var height = elTimeline.clientHeight || 600;

  var timeline = new vis.Timeline(elTimeline, itemsDs, useGroups ? groupsDs : undefined, {
    stack: true,
    horizontalScroll: true,
    zoomKey: 'ctrlKey',
    margin: { item: 6, axis: 8 },
    orientation: { axis: 'top', item: 'top' },
    locale: 'de',
    tooltip: { followMouse: false, overflowMethod: 'cap' },
    zoomMin: 1000 * 60 * 60 * 6,
    zoomMax: 1000 * 60 * 60 * 24 * 365 * 30,
    height: height + 'px',
    verticalScroll: true,
    start: new Date(focusMin - padding),
    end: new Date(focusMax + padding)
  });

  var lastH = height;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () {
      var h = elTimeline.clientHeight;
      if (h > 0 && h !== lastH) {
        lastH = h;
        timeline.setOptions({ height: h + 'px' });
      }
    }).observe(elTimeline);
  }

  var ensureVisible = function () {
    timeline.redraw();
    var v = elTimeline.querySelector('.vis-timeline');
    if (v) v.style.visibility = 'visible';
  };
  requestAnimationFrame(ensureVisible);
  setTimeout(ensureVisible, 100);
  setTimeout(ensureVisible, 500);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function showDetail(note) {
    elDetailTitle.textContent = note.title;
    var fm = note.frontmatter || {};
    var pairs = [];
    if (note.start) pairs.push(['Start', note.start.slice(0, 10) + ' (' + (note.dateSource || '?') + ')']);
    if (note.end) pairs.push(['End', note.end.slice(0, 10)]);
    if (note.folder) pairs.push(['Folder', note.folder]);
    if (note.filename) pairs.push(['File', note.filename]);
    ['categories', 'tags', 'topics', 'status', 'distribution'].forEach(function (k) {
      var v = fm[k];
      if (v == null || v === '') return;
      pairs.push([k, Array.isArray(v) ? v.map(String).join(', ') : String(v)]);
    });
    elDetailMeta.innerHTML = pairs.map(function (p) {
      return '<dt>' + escapeHtml(p[0]) + '</dt><dd>' + escapeHtml(p[1]) + '</dd>';
    }).join('');
    var bodyHtml = (window.marked && note.body) ? window.marked.parse(note.body) : escapeHtml(note.body || '');
    elDetailBody.innerHTML = bodyHtml;
    elDetail.hidden = false;
    setTimeout(function () { timeline.redraw(); }, 0);
  }

  function hideDetail() {
    elDetail.hidden = true;
    setTimeout(function () { timeline.redraw(); }, 0);
  }

  timeline.on('select', function (props) {
    var id = props.items[0];
    if (!id) return;
    var note = details[id];
    if (note) showDetail(note);
  });

  elDetailClose.addEventListener('click', hideDetail);

  elStatus.textContent = items.length + ' items' + (useGroups ? ' · ' + groups.length + ' groups' : '');
})();
`.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const configPath = join(DATA_DIR, 'config.json');
  if (!existsSync(configPath)) {
    console.error(`[export] Missing ${configPath}.`);
    console.error(`[export] Run 'npm run build:data' first (or use 'npm run export -- ${args.viewId}').`);
    process.exit(1);
  }

  const config: BuiltConfig = JSON.parse(await readTextFile(configPath));

  const view = config.views.find((v) => v.id === args.viewId);
  if (!view) {
    console.error(`[export] View '${args.viewId}' not found. Available:`);
    for (const v of config.views) console.error(`  - ${v.id}  (${v.name})`);
    process.exit(1);
  }

  // Every view is source-backed since the notes pipeline was retired, so the
  // export reads the one materialized file and has no second build path.
  const srcPath = join(DATA_DIR, 'sources', `${view.source.id}.json`);
  if (!existsSync(srcPath)) {
    console.error(`[export] Source file not found: ${srcPath}`);
    process.exit(1);
  }
  const file: TimelineFile = JSON.parse(await readTextFile(srcPath));
  const built = buildFromJson(view, file);

  const [baseCss, themeCss, timelineCss, visCss, visJs, markedJs] = await Promise.all([
    readTextFile(join(STYLES_DIR, 'base.css')),
    readTextFile(join(STYLES_DIR, 'theme.css')),
    readTextFile(join(STYLES_DIR, 'timeline.css')),
    readTextFile(join(NM, 'vis-timeline', 'styles', 'vis-timeline-graph2d.min.css')),
    readTextFile(join(NM, 'vis-timeline', 'standalone', 'umd', 'vis-timeline-graph2d.min.js')),
    readTextFile(join(NM, 'marked', 'marked.min.js')),
  ]);

  const payload = JSON.stringify({
    items: built.items,
    groups: built.groups,
    details: built.details,
  });

  const title = `${view.name} — Timeline`;
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>${visCss}</style>
<style>${baseCss}</style>
<style>${themeCss}</style>
<style>${timelineCss}</style>
</head>
<body>
<header class="app-header">
  <div class="app-title">
    <span class="app-title-mark"></span>
    <h1>${escapeHtml(view.name)}</h1>
  </div>
</header>
<main class="app-main">
  <section id="timeline" class="timeline" aria-label="Timeline"></section>
  <aside id="detail" class="detail" hidden>
    <button id="detail-close" class="detail-close" aria-label="Schließen">×</button>
    <h2 id="detail-title"></h2>
    <dl id="detail-meta" class="detail-meta"></dl>
    <article id="detail-body" class="detail-body"></article>
  </aside>
</main>
<footer class="app-footer"><span id="status" class="status">…</span></footer>
<script>${visJs}</script>
<script>${markedJs}</script>
<script>window.__TIMELINE_PAYLOAD__ = ${payload};</script>
<script>${clientScript()}</script>
</body>
</html>
`;

  const outPath = args.outPath ?? join(OUT_DIR, `${safeFilename(view.id)}.html`);
  await mkdir(join(outPath, '..'), { recursive: true });
  await writeFile(outPath, html);
  const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
  console.log(`[export] Wrote ${outPath} (${sizeKb} KB, ${built.items.length} items, ${built.groups.length} groups)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

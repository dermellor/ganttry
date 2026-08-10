import type { View } from './types';
import { exportShellHtml } from './appShell';
import {
  escapeHtml,
  withStatusMarks,
  type DetailNote,
  type TimelineGroup,
  type TimelineItem,
} from './buildItems';
import { JIRA_BASE_URL } from './jira';

import visJsRaw from 'vis-timeline/standalone/umd/vis-timeline-graph2d.min.js?raw';
import visCssRaw from 'vis-timeline/styles/vis-timeline-graph2d.min.css?raw';
import markedJsRaw from 'marked/marked.min.js?raw';
import timelineCssRaw from './styles/timeline.css?raw';
import appCssRaw from './styles/app.css?raw';

// The exported file is one self-contained document, so every stylesheet it needs
// has to be inlined as text. The design system's are collected by glob rather
// than listed: a component added to the layer brought its stylesheet with it and
// was then invisible in exports until somebody remembered to add a line here —
// which is exactly the kind of omission nobody notices, because the app itself
// looks right.
const dsCss = Object.entries(
  import.meta.glob<string>('./design-system/**/*.css', { query: '?raw', import: 'default', eager: true }),
)
  // Tokens first: a component stylesheet that reads `var(--space-md)` before the
  // custom property is defined resolves to nothing at all.
  .sort(([a], [b]) => Number(b.includes('/tokens/')) - Number(a.includes('/tokens/')))
  .map(([, css]) => css)
  .join('\n');

type ExportArgs = {
  view: View;
  build: { items: TimelineItem[]; groups: TimelineGroup[]; details: Map<string, DetailNote> };
};

function safeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'view';
}

function clientScript(): string {
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

  // The Icon component's markup, hand-written because this script runs inside the
  // exported file with no module loader — the class and the custom property are
  // the contract it has to match (see src/design-system/components/Marks.ts).
  function iconSpan(icon) {
    if (!icon || !/^[a-z]+$/.test(icon)) return '';
    return '<span class="ds-Icon" aria-hidden="true" style="--ds-icon:var(--icon-' + icon + ')"></span>';
  }

  var timeline = new vis.Timeline(elTimeline, itemsDs, useGroups ? groupsDs : undefined, {
    stack: false,
    horizontalScroll: true,
    zoomKey: 'ctrlKey',
    // Gentler zoom per wheel/trackpad-pinch step (vis default is 5); mirrors the
    // live viewer (see src/render.ts).
    zoomFriction: 15,
    template: function (item) {
      return item ? iconSpan(item.icon) + (item.content || '') : '';
    },
    xss: { disabled: true },
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
    var metaHtml = pairs.map(function (p) {
      return '<dt>' + escapeHtml(p[0]) + '</dt><dd>' + escapeHtml(p[1]) + '</dd>';
    }).join('');
    var jira = Array.isArray(fm.jira) ? fm.jira : [];
    if (jira.length) {
      var base = (payload.jiraBaseUrl || '').replace(/\\/+$/, '');
      var refs = jira.map(function (entry) {
        var key = typeof entry === 'string' ? entry : (entry && entry.key) || '';
        var sum = (entry && entry.summary) || '';
        if (!key) return '';
        var label = sum ? key + ' – ' + sum : key;
        // The Link component's markup — same reason as iconSpan above.
        return base
          ? '<a class="ds-Link" data-tabular href="' + escapeHtml(base + '/browse/' + key) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>'
          : '<span class="ds-Link" data-tabular data-static>' + escapeHtml(label) + '</span>';
      }).join('');
      metaHtml += '<dt>JIRA</dt><dd><span class="ds-DescriptionList-stack">' + refs + '</span></dd>';
    }
    elDetailMeta.innerHTML = metaHtml;
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

function buildHtml(args: ExportArgs): string {
  const { view, build } = args;
  const detailsObj: Record<string, DetailNote> = {};
  build.details.forEach((v, k) => {
    detailsObj[k] = v;
  });
  const payload = JSON.stringify({
    // Same status marks the live timeline draws (the rail's check / warning): the
    // export inlines timeline.css, so all it was missing was the class. Start-less
    // items are dropped here too — vis can't place them, and the export has no
    // list view to show them in.
    items: withStatusMarks(
      build.items.filter((it) => !!it.start),
      Date.now(),
    ),
    groups: build.groups,
    details: detailsObj,
    jiraBaseUrl: JIRA_BASE_URL,
  });
  const title = `${view.name} — Timeline`;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>${visCssRaw}</style>
<style>${dsCss}</style>
<style>${timelineCssRaw}</style>
<style>${appCssRaw}</style>
</head>
<body>
${exportShellHtml(view.name)}
<script>${visJsRaw}</script>
<script>${markedJsRaw}</script>
<script>window.__TIMELINE_PAYLOAD__ = ${payload};</script>
<script>${clientScript()}</script>
</body>
</html>
`;
}

export async function exportTimelineHtml(args: ExportArgs): Promise<void> {
  const html = buildHtml(args);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename(args.view.id)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

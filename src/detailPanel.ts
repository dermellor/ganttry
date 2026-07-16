// Detail side panel in its read-only mode: renders a note's metadata and
// Markdown body. Editable sources open the item form (itemForm.ts) instead.

import { marked } from 'marked';
import { escapeHtml, type DetailNote } from './buildItems';
import { jiraLinksHtml, readJiraIssues } from './jira';
import { state, els, isEditableView, withPreservedZoom } from './state';
import { cancelThrottledPersist } from './persistence';
import { showItemForm } from './itemForm';

export function showDetailForId(id: string): void {
  if (isEditableView() && state.activeSourceFile) {
    const item = state.activeSourceFile.items.find((it) => it.id === id);
    if (item) {
      showItemForm(item);
      return;
    }
  }
  const note = state.activeBuild?.details.get(id);
  if (note) showDetail(note);
}

export function showDetail(note: DetailNote) {
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

  withPreservedZoom(() => {
    els.detail.hidden = false;
  });
  setTimeout(() => state.timeline?.redraw(), 0);
}

export function hideDetail() {
  if (state.liveEditTimer) {
    clearTimeout(state.liveEditTimer);
    state.liveEditTimer = null;
  }
  cancelThrottledPersist();
  withPreservedZoom(() => {
    els.detail.hidden = true;
  });
  els.detailBody.classList.remove('detail-form');
  state.activeFormItemId = null;
  state.activeFormPhaseIndex = null;
  state.activeFormFeatureId = null;
  setTimeout(() => state.timeline?.redraw(), 0);
}

// Detail side panel in its read-only mode: renders a note's metadata and
// Markdown body. Editable sources open the item form (itemForm.ts) instead.

import { marked } from 'marked';
import { escapeHtml, type DetailNote } from './buildItems';
import { jiraLinksHtml, readJiraIssues } from './jira';
import { state, els, isEditableView, revealBesidePanel } from './state';
import { cancelThrottledPersist, publishSelfPresence } from './persistence';
import { showItemForm } from './itemForm';

// Single entry point for the panel headline. For an editable item the headline
// *is* the title editor (`editable: true` turns it into a contenteditable
// textbox, wired in itemForm.ts): the form used to repeat the same string in a
// labelled input right below the heading, which cost a row and left two places
// showing one value. Every other consumer (read-only note, phase form, feature
// form) calls this plain, which also clears the editable state a previous item
// left behind.
export function setDetailTitle(text: string, editable = false): void {
  const h = els.detailTitle;
  h.textContent = text;
  // The header tools row (the item form's icon/type/status pickers) belongs to
  // one specific item form, so switching what the panel shows clears it;
  // showItemForm refills it right after. Without this, a phase form or a
  // read-only note would inherit the pickers of the item shown before.
  //
  // This is why the function is for *switching panels only* — call
  // setDetailTitleText to keep the caption in sync with an ongoing edit. Doing
  // that through here wiped the pickers on every keystroke, and with their
  // form-associated hidden inputs gone from the DOM, FormData lost icon / type /
  // status: the next edit reset the status to its default and dropped the rest.
  els.detailTools.innerHTML = '';
  els.detailTools.hidden = true;
  els.detail.querySelector('.detail-header')?.classList.remove('has-tools');
  if (editable) {
    // plaintext-only keeps pasted rich text (and stray <br>) out of a value that
    // round-trips to the DB as a plain string.
    h.setAttribute('contenteditable', 'plaintext-only');
    h.setAttribute('role', 'textbox');
    h.setAttribute('aria-label', 'Titel');
    h.setAttribute('spellcheck', 'false');
  } else {
    h.removeAttribute('contenteditable');
    h.removeAttribute('role');
    h.removeAttribute('aria-label');
    h.removeAttribute('spellcheck');
  }
}

// Keeps the headline text in sync with an edit already in progress: text only,
// no editable-state or tools churn (see the note in setDetailTitle). A no-op
// while the headline has focus — it is the input being typed into, and setting
// textContent under the caret would send it back to the start of the line.
export function setDetailTitleText(text: string): void {
  if (document.activeElement === els.detailTitle) return;
  els.detailTitle.textContent = text;
}

// Puts the caret in the headline with the current text selected — used when a
// freshly created item opens so typing replaces the placeholder title.
export function focusDetailTitle(): void {
  const h = els.detailTitle;
  h.focus();
  const range = document.createRange();
  range.selectNodeContents(h);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

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
  setDetailTitle(note.title);

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
  if (note.start) {
    revealBesidePanel(Date.parse(note.start), note.end ? Date.parse(note.end) : undefined);
  }
}

export function hideDetail() {
  if (state.liveEditTimer) {
    clearTimeout(state.liveEditTimer);
    state.liveEditTimer = null;
  }
  cancelThrottledPersist();
  els.detail.hidden = true;
  els.detailBody.classList.remove('detail-form');
  state.activeFormItemId = null;
  state.activeFormPhaseIndex = null;
  state.activeFormFeatureId = null;
  // Panel closed → release the item mark we held for the others.
  publishSelfPresence();
}

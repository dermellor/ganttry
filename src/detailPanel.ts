// Detail side panel in its read-only mode: renders a note's metadata and
// Markdown body. Editable sources open the item form (itemForm.ts) instead.

import { marked } from 'marked';
import { type DetailNote } from './buildItems';
import { el, Prose, setDescriptionList, type DescriptionListEntry } from './design-system';
import { jiraLinks, readJiraIssues } from './jira';
import { state, els, isEditableView, revealBesidePanel, clearFormSlots } from './state';
import { cancelThrottledPersist, publishSelfPresence } from './persistence';
import { showItemForm } from './itemForm';
import { t } from './i18n';

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
  els.detailTools.replaceChildren();
  els.detailTools.hidden = true;
  els.detail.querySelector('.ds-Panel-header')?.removeAttribute('data-has-tools');
  if (editable) {
    // plaintext-only keeps pasted rich text (and stray <br>) out of a value that
    // round-trips to the DB as a plain string.
    h.setAttribute('contenteditable', 'plaintext-only');
    h.setAttribute('role', 'textbox');
    h.setAttribute('aria-label', t('form.title'));
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
  const entries: DescriptionListEntry[] = metaPairs.map(([term, value]) => ({ term, value }));
  if (jiraIssues.length) {
    entries.push({
      term: 'JIRA',
      // Several links under one term, stacked rather than run together: an issue
      // key plus its summary is long enough that two on one line stop reading as
      // two links.
      value: el('span', { class: 'ds-DescriptionList-stack' }, jiraLinks(jiraIssues)),
    });
  }
  setDescriptionList(els.detailMeta, entries);

  // Into a `Prose` wrapper rather than onto the panel body: the body also holds
  // the edit form, and prose styling applied to it reaches the form's own
  // markup too.
  const prose = Prose();
  prose.innerHTML = marked.parse(note.body || '', { async: false }) as string;
  els.detailBody.replaceChildren(prose);

  els.detail.hidden = false;
  if (note.start) {
    revealBesidePanel(Date.parse(note.start), note.end ? Date.parse(note.end) : undefined);
  }
}

/**
 * The drawer as a plugin uses it (`HostApi.panel`), implemented against the same
 * elements the app's own forms use.
 *
 * Registered into `pluginHost/panel.ts` by `main.ts` rather than imported from
 * there, because `hostBackend.ts` reaching this module closes a cycle through the
 * item form.
 *
 * `close` and `showItem` are guarded by which plugin owns the drawer: a plugin
 * closing a panel it did not open is either a bug in that plugin or a way to shut
 * another one's editor, and neither should be possible through the contract.
 */
export const pluginPanelBackend = {
  open(pluginId: string, form: { title: string; render(container: HTMLElement): void }): void {
    // Same order the app's own forms use: claim the slot, then paint. Claiming it
    // first is what stops background persistence from writing between the two.
    clearFormSlots();
    state.activePluginForm = pluginId;
    setDetailTitle(form.title);
    // The meta list belongs to a note's frontmatter; a plugin form has none, and
    // leaving the previous one standing shows one row's metadata above another's
    // editor.
    els.detailMeta.replaceChildren();
    const container = el('div', { class: 'plugin-panel-form' });
    form.render(container);
    els.detailBody.replaceChildren(container);
    els.detail.hidden = false;
  },
  close(pluginId: string): void {
    if (state.activePluginForm !== pluginId) return;
    hideDetail();
  },
  showItem(itemId: string): void {
    showDetailForId(itemId);
  },
};

export function hideDetail() {
  if (state.liveEditTimer) {
    clearTimeout(state.liveEditTimer);
    state.liveEditTimer = null;
  }
  cancelThrottledPersist();
  els.detail.hidden = true;
  clearFormSlots();
  // Panel closed → release the item mark we held for the others.
  publishSelfPresence();
}

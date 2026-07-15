// The editable item form shown in the detail panel: field layout, the Markdown
// body editor, the JIRA / dependencies / tags chip editors with autosuggest,
// and the reactive apply/delete logic. Persistence is deferred to
// persistence.ts (commitItemForm / scheduleLiveEdit).

import { escapeHtml, readTags, tagColor } from './buildItems';
import {
  applyCustomFields,
  initCustomFieldState,
  isManagedMetaKey,
  renderCustomFieldsHtml,
  wireCustomFields,
} from './customFields';
import { TIMELINE_ICONS } from './icons';
import { ITEM_STATUSES, statusOrDefault } from './status';
import { findItemIndex, isoDateOnly } from './editor';
import { createMarkdownEditor, type MarkdownEditor } from './wysiwyg';
import {
  isJiraKey,
  normalizeKey,
  readJiraIssues,
  searchJira,
  type JiraIssue,
} from './jira';
import type { TimelineFileItem } from './types';
import { state, els, setStatus, withPreservedZoom } from './state';
import { commitItemForm, scheduleLiveEdit, schedulePersist } from './persistence';
import { rebuildAndApply } from './render';
import { hideDetail } from './detailPanel';

export function showItemForm(
  item: TimelineFileItem & { id?: string },
  opts?: { focusTitle?: boolean },
): void {
  if (!state.activeSourceFile || !item.id) return;
  const id = item.id;
  // Switching to a different item = leaving the previous form → persist it.
  if (state.activeFormItemId && state.activeFormItemId !== id) commitItemForm();
  state.activeFormItemId = id;
  state.activeFormPhaseIndex = null;
  els.detailTitle.textContent = item.content || '(unbenannt)';
  els.detailMeta.innerHTML = '';

  const groupOptions = (state.activeSourceFile.groups ?? state.activeBuild?.groups ?? []).map((g) =>
    `<option value="${escapeHtml(g.id)}"${g.id === item.group ? ' selected' : ''}>${escapeHtml(g.content)}</option>`
  ).join('');

  const metadata = (item.metadata ?? {}) as Record<string, unknown>;
  const dependsOn = Array.isArray(metadata.dependsOn) ? (metadata.dependsOn as unknown[]).map(String) : [];
  state.formDependsOn = [...dependsOn];
  const owner = typeof metadata.owner === 'string' ? metadata.owner : '';
  state.formJiraIssues = readJiraIssues(metadata);
  state.formTags = readTags(metadata);
  initCustomFieldState(metadata);

  const otherMeta = Object.fromEntries(
    Object.entries(metadata).filter(([k]) => !isManagedMetaKey(k)),
  );
  const metaJson = Object.keys(otherMeta).length ? JSON.stringify(otherMeta, null, 2) : '';

  els.detailBody.classList.add('detail-form');
  // Swapping the form removes the previously-focused input, which fires a
  // focusout → commit. Guard it: the outgoing form's values must not be
  // flushed onto this (already switched-to) item.
  state.formRebuilding = true;
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
        <input id="f-duration" name="duration" value="${escapeHtml(typeof item.duration === 'string' ? item.duration : item.duration != null ? String(item.duration) : '')}" placeholder="nur ohne End-Datum" />
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
      <div class="field">
        <label for="f-status">Status</label>
        <select id="f-status" name="status">
          ${ITEM_STATUSES.map(({ key, label }) => `<option value="${key}"${statusOrDefault(item.status) === key ? ' selected' : ''}>${label}</option>`).join('')}
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
      <div class="field full tags-field">
        <label for="f-tags">Tags <small>(farbige Marker)</small></label>
        <div class="tags-chips" data-role="tags-chips"></div>
        <div class="tags-suggest">
          <input id="f-tags" type="text" autocomplete="off" placeholder="Tag suchen oder neu eingeben…" />
          <ul class="tags-suggest-list" data-role="tags-list" hidden></ul>
        </div>
      </div>
      ${renderCustomFieldsHtml(metadata)}
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
      ${auditBlockHtml(item)}
    </form>
  `;
  state.formRebuilding = false;

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
  // Leaving a field guarantees its edit is written even mid-session, without
  // waiting for the throttle window or the sidebar to close.
  form.addEventListener('focusout', () => commitItemForm());
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener('click', () => {
    deleteItem(id);
  });

  wireBodyEditor(form);
  wireJiraAutosuggest(form);
  wireDepsAutosuggest(form, id);
  wireTagsAutosuggest(form);
  wireCustomFields(form);

  withPreservedZoom(() => {
    els.detail.hidden = false;
  });
  // Switching items commits the previous form, whose rebuildAndApply reloads the
  // DataSet (dropping the selection) and re-selects the *old* item. Re-assert the
  // selection on the item we're actually showing so the mark follows the sidebar.
  try {
    state.timeline?.setSelection([id]);
  } catch {
    /* item may be filtered out of the current view */
  }
  setTimeout(() => state.timeline?.redraw(), 0);

  // Freshly-created items open with the placeholder title pre-selected, so the
  // user can just start typing to replace "Neuer Eintrag".
  if (opts?.focusTitle) {
    const contentInput = form.querySelector<HTMLInputElement>('#f-content');
    contentInput?.focus();
    contentInput?.select();
  }
}

// ---- audit footer (localhost only) ----------------------------------------
// Read-only "created / updated by whom, when" block at the bottom of the form.
// Server-managed fields (see timeline-repo ITEM_SELECT). Gated to dev because
// the deployed site has no need for edit-attribution noise and local edits are
// the only ones stamped `local`.

const auditDateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

function formatAuditDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : auditDateFmt.format(d);
}

function auditRowHtml(label: string, by?: string, iso?: string, version?: number): string {
  const when = formatAuditDate(iso);
  if (!when && !by) return '';
  const parts: string[] = [];
  if (by) parts.push(`von <strong>${escapeHtml(by)}</strong>`);
  if (when) parts.push(escapeHtml(when));
  if (version != null) parts.push(`v${version}`);
  return `<dt>${escapeHtml(label)}</dt><dd>${parts.join(' · ')}</dd>`;
}

function auditBlockHtml(item: TimelineFileItem): string {
  if (!import.meta.env.DEV) return '';
  const rows =
    auditRowHtml('Erstellt', item.createdBy, item.createdAt) +
    auditRowHtml('Aktualisiert', item.updatedBy, item.updatedAt, item.version);
  // Nothing known yet (e.g. a freshly added item before its first save round-trip).
  const body = rows || '<dt>Metadaten</dt><dd>noch nicht gespeichert</dd>';
  return `<div class="item-audit" data-role="audit"><dl>${body}</dl></div>`;
}

// Re-render the audit block in place after a save writes fresh server values
// back onto the item (called from persistence.adoptAudit).
export function refreshItemAudit(item: TimelineFileItem): void {
  const wrap = els.detailBody.querySelector<HTMLElement>('.item-audit[data-role="audit"]');
  if (!wrap) return;
  const html = auditBlockHtml(item);
  // auditBlockHtml wraps in .item-audit; swap just the inner <dl>.
  const inner = html.replace(/^<div[^>]*>|<\/div>$/g, '');
  wrap.innerHTML = inner;
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
// remove button per chip. Re-rendered whenever state.formJiraIssues changes.
function renderJiraChips(form: HTMLFormElement): void {
  const wrap = form.querySelector<HTMLElement>('[data-role="jira-chips"]');
  if (!wrap) return;
  wrap.innerHTML = state.formJiraIssues
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
      state.formJiraIssues.splice(idx, 1);
      renderJiraChips(form);
      scheduleLiveEdit();
    });
  });
}

function addJiraIssue(form: HTMLFormElement, issue: JiraIssue): void {
  if (!issue.key) return;
  if (state.formJiraIssues.some((i) => i.key === issue.key)) return;
  state.formJiraIssues.push(issue);
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
  const it = state.activeSourceFile?.items.find((i) => i.id === depId);
  return it?.content?.trim() || depId;
}

// Renders the dependsOn chip list (linked-item pills) into the form, each with
// a remove button. Re-rendered whenever state.formDependsOn changes.
function renderDepChips(form: HTMLFormElement): void {
  const wrap = form.querySelector<HTMLElement>('[data-role="deps-chips"]');
  if (!wrap) return;
  wrap.innerHTML = state.formDependsOn
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
      state.formDependsOn.splice(idx, 1);
      renderDepChips(form);
      scheduleLiveEdit();
    });
  });
}

function addDep(form: HTMLFormElement, depId: string): void {
  if (!depId || state.formDependsOn.includes(depId)) return;
  state.formDependsOn.push(depId);
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
    const items = (state.activeSourceFile?.items ?? []).filter(
      (it) => it.id && it.id !== selfId && !state.formDependsOn.includes(it.id),
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

// Distinct tags already in use across the current source, for autosuggest.
function collectTimelineTags(): string[] {
  const out: string[] = [];
  for (const it of state.activeSourceFile?.items ?? []) {
    for (const t of readTags(it.metadata)) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'de'));
}

// Renders the tag chip list into the form, each coloured by its resolved tag
// colour and carrying a remove button. Re-rendered whenever state.formTags changes.
function renderTagChips(form: HTMLFormElement): void {
  const wrap = form.querySelector<HTMLElement>('[data-role="tags-chips"]');
  if (!wrap) return;
  wrap.innerHTML = state.formTags
    .map(
      (tag, i) =>
        `<span class="tag-chip" style="--tag-color:${tagColor(tag)}">` +
        `<span class="tag-chip-dot"></span>` +
        `<span class="tag-chip-label">${escapeHtml(tag)}</span>` +
        `<button type="button" class="tag-chip-x" data-remove="${i}" aria-label="Entfernen">×</button>` +
        `</span>`,
    )
    .join('');
  wrap.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.remove);
      state.formTags.splice(idx, 1);
      renderTagChips(form);
      scheduleLiveEdit();
    });
  });
}

function addTag(form: HTMLFormElement, tag: string): void {
  const t = tag.trim();
  if (!t || state.formTags.includes(t)) return;
  state.formTags.push(t);
  renderTagChips(form);
  scheduleLiveEdit();
}

// Autosuggest over the tags already used in the timeline; free-form entry is
// allowed too (Enter adds whatever is typed, so new tags can be created).
function wireTagsAutosuggest(form: HTMLFormElement): void {
  renderTagChips(form);

  const input = form.querySelector<HTMLInputElement>('#f-tags');
  const list = form.querySelector<HTMLUListElement>('[data-role="tags-list"]');
  if (!input || !list) return;

  let activeIndex = -1;
  let current: string[] = [];

  const closeList = () => {
    list.hidden = true;
    list.innerHTML = '';
    activeIndex = -1;
    current = [];
  };

  const search = (q: string): string[] => {
    const needle = q.trim().toLowerCase();
    return collectTimelineTags()
      .filter((t) => !state.formTags.includes(t) && (!needle || t.toLowerCase().includes(needle)))
      .slice(0, 8);
  };

  const highlight = () => {
    list.querySelectorAll<HTMLLIElement>('.tags-suggest-item').forEach((li, i) => {
      li.classList.toggle('is-active', i === activeIndex);
    });
  };

  const pick = (i: number) => {
    const tag = current[i];
    if (tag) addTag(form, tag);
    input.value = '';
    closeList();
    input.focus();
  };

  const renderList = (tags: string[]) => {
    current = tags;
    activeIndex = -1;
    if (!tags.length) {
      closeList();
      return;
    }
    list.innerHTML = tags
      .map(
        (tag, i) =>
          `<li class="tags-suggest-item" data-i="${i}" role="option">` +
          `<span class="tags-suggest-dot" style="background-color:${tagColor(tag)}"></span>` +
          `<span class="tags-suggest-label">${escapeHtml(tag)}</span>` +
          `</li>`,
      )
      .join('');
    list.querySelectorAll<HTMLLIElement>('.tags-suggest-item').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(Number(li.dataset.i));
      });
    });
    list.hidden = false;
  };

  input.addEventListener('input', () => renderList(search(input.value)));
  input.addEventListener('focus', () => renderList(search(input.value)));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) renderList(search(input.value));
      activeIndex = Math.min(activeIndex + 1, current.length - 1);
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // A highlighted suggestion wins; otherwise commit the free-form input as
      // a new tag.
      if (activeIndex >= 0) pick(activeIndex);
      else if (input.value.trim()) {
        addTag(form, input.value);
        input.value = '';
        closeList();
      }
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
export function applyItemForm(id: string, form: HTMLFormElement): void {
  if (!state.activeSourceFile) return;
  const idx = findItemIndex(state.activeSourceFile, id);
  if (idx === -1) return;

  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) ?? '').trim();

  const item = state.activeSourceFile.items[idx];
  item.content = get('content') || item.content;
  const startVal = get('start');
  // Start is optional: clearing the field removes the date (the item then shows
  // only in the list view, hidden from the timeline).
  if (startVal) item.start = startVal;
  else delete item.start;
  const endVal = get('end');
  const durVal = get('duration');

  const typeVal = get('type');
  if (typeVal) {
    item.type = typeVal as TimelineFileItem['type'];
  } else {
    delete item.type;
  }

  // Extent precedence must match the render path (buildItems: `end` wins, with
  // `duration` only a fallback). Committing with the opposite precedence is what
  // collapsed items carrying *both* fields — a long `end`-based bar silently
  // shrank to its stale `duration` on the next commit. Prefer `end` here and
  // drop the other so the two never coexist going forward.
  if (endVal) {
    item.end = endVal;
    delete item.duration;
  } else if (durVal) {
    item.duration = durVal;
    delete item.end;
  } else {
    delete item.duration;
    delete item.end;
  }

  // A point has no extent — but if the user gave it one, honour that and
  // promote it to a range instead of silently dropping the value.
  if (item.type === 'point' && (item.end || item.duration)) {
    delete item.type;
  }

  // The reverse: promoting a point to a range/box without giving it an extent
  // would produce a range item with no `end` — vis-timeline drops those, so the
  // item silently vanishes from the timeline. Seed a default duration (matching
  // the double-click "new item" default) so it renders as a visible bar the
  // user can then resize.
  if ((item.type === 'range' || item.type === 'background') && !item.end && !item.duration) {
    item.duration = '1w';
  }

  const grp = get('group');
  if (grp) item.group = grp;

  const iconVal = get('icon');
  if (iconVal) item.icon = iconVal;
  else delete item.icon;

  // status is mandatory (NOT NULL, default Open) — always store a canonical value.
  item.status = statusOrDefault(get('status'));

  const body = String(fd.get('body') ?? '');
  if (body) item.body = body;
  else delete item.body;

  const meta = (item.metadata ??= {}) as Record<string, unknown>;
  if (state.formDependsOn.length) meta.dependsOn = [...state.formDependsOn];
  else delete meta.dependsOn;

  const owner = get('owner');
  if (owner) meta.owner = owner;
  else delete meta.owner;

  if (state.formJiraIssues.length) meta.jira = state.formJiraIssues.map((i) => ({ key: i.key, summary: i.summary }));
  else delete meta.jira;

  if (state.formTags.length) meta.tags = [...state.formTags];
  else delete meta.tags;
  // The tags chip editor supersedes the legacy singular `tag`; drop it so both
  // don't linger (readTags already folds it into formTags on load).
  delete meta.tag;

  // Custom fields (managed by their own controls, so kept out of the JSON box).
  applyCustomFields(form, meta);

  // Invalid metadata JSON: keep the last valid extras and just flag it in the
  // status line — no blocking alert on every keystroke while typing.
  const metaJsonRaw = get('metadata');
  let metaError = false;
  if (metaJsonRaw) {
    try {
      const extra = JSON.parse(metaJsonRaw);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [k, v] of Object.entries(extra)) {
          if (isManagedMetaKey(k)) continue;
          meta[k] = v;
        }
      }
    } catch {
      metaError = true;
    }
  } else {
    for (const k of Object.keys(meta)) {
      if (isManagedMetaKey(k)) continue;
      delete meta[k];
    }
  }
  if (Object.keys(meta).length === 0) delete (item as any).metadata;

  rebuildAndApply();
  // Keep the sidebar header and the timeline selection in sync with the live
  // content (rebuildAndApply reloads the DataSet, which drops the selection).
  els.detailTitle.textContent = item.content || '(unbenannt)';
  try {
    state.timeline?.setSelection([id]);
  } catch {
    /* item may be filtered out of the current view */
  }
  if (metaError) setStatus('Metadata JSON ungültig — Änderung nicht übernommen');
}

export function deleteItem(id: string): void {
  if (!state.activeSourceFile) return;
  const idx = findItemIndex(state.activeSourceFile, id);
  if (idx === -1) return;
  const item = state.activeSourceFile.items[idx];
  if (!confirm(`„${item.content}" wirklich löschen?`)) return;
  state.activeSourceFile.items.splice(idx, 1);
  rebuildAndApply();
  schedulePersist();
  hideDetail();
}

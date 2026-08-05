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
import { assignableLeaves, parentGroupIds } from './groupHierarchy';
import { state, els, setStatus, revealBesidePanel } from './state';
import { parseLocalDay, durationToMs } from './date';
import {
  commitItemForm,
  publishSelfPresence,
  scheduleLiveEdit,
  schedulePersist,
} from './persistence';
import { rebuildAndApply } from './render';
import { focusDetailTitle, hideDetail, setDetailTitle, setDetailTitleText } from './detailPanel';

// Build the group <select> options. Parent groups (those with nestedGroups) are
// containers only, so they render as a non-selectable <optgroup> heading and
// only their leaf children appear as options — an item can never be assigned to
// a parent. Groups with no children render as plain top-level options.
type GroupOption = { id: string; content: string; nestedGroups?: string[] };
function buildGroupOptions(
  groups: GroupOption[],
  selected: string | number | null | undefined,
): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parents = parentGroupIds(groups);
  const childIds = new Set<string>();
  for (const g of groups) for (const c of g.nestedGroups ?? []) childIds.add(c);
  const sel = selected == null ? null : String(selected);
  const optHtml = (id: string): string => {
    const g = byId.get(id);
    if (!g) return '';
    return `<option value="${escapeHtml(g.id)}"${g.id === sel ? ' selected' : ''}>${escapeHtml(g.content)}</option>`;
  };

  const out: string[] = [];
  for (const g of groups) {
    if (childIds.has(g.id)) continue; // rendered under its parent's optgroup
    if (parents.has(g.id)) {
      const children = assignableLeaves(g.id, groups).map(optHtml).join('');
      out.push(`<optgroup label="${escapeHtml(g.content)}">${children}</optgroup>`);
    } else {
      out.push(optHtml(g.id));
    }
  }
  return out.join('');
}

// ---- form tabs -------------------------------------------------------------
// The item form grew past what one flat column reads well as, so its fields are
// split into three tabs. All panels stay in the DOM (just `hidden`), so FormData
// keeps seeing every field and applyItemForm needs no knowledge of the tabs.
// The pinned Title sits above the tabstrip; the delete action + audit footer
// below it, so both stay reachable from any tab.
// Tab glyphs: inline SVG in the same style as the header's mode toggle
// (24-unit viewBox, currentColor stroke), so they inherit the tab's active /
// muted colour. Decorative — the label carries the meaning, hence aria-hidden.
const TAB_ICONS = {
  // calendar
  time:
    '<rect x="3" y="5" width="18" height="16" rx="2" /><line x1="3" y1="10" x2="21" y2="10" />' +
    '<line x1="8" y1="3" x2="8" y2="7" /><line x1="16" y1="3" x2="16" y2="7" />',
  // sliders
  props:
    '<line x1="3" y1="8" x2="21" y2="8" /><line x1="3" y1="16" x2="21" y2="16" />' +
    '<circle cx="9" cy="8" r="2.4" /><circle cx="15" cy="16" r="2.4" />',
  // chain link
  rel:
    '<path d="M15 7h2a5 5 0 0 1 0 10h-2" /><path d="M9 17H7A5 5 0 0 1 7 7h2" />' +
    '<line x1="8.5" y1="12" x2="15.5" y2="12" />',
} as const;

const FORM_TABS = [
  { id: 'time', label: 'Date & Time' },
  { id: 'props', label: 'Properties' },
  { id: 'rel', label: 'Relationships' },
] as const;
type FormTabId = (typeof FORM_TABS)[number]['id'];

function tabIconHtml(id: FormTabId): string {
  return (
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${TAB_ICONS[id]}</svg>`
  );
}

// Remembered across form rebuilds so clicking through items keeps the tab the
// user is working in.
let activeFormTab: FormTabId = 'time';

// The item form's id. Needed as a real id because the header pickers live
// outside the form and associate with it via their `form` attribute.
const FORM_ID = 'item-form';

// Extent a range/background item gets when it has none: vis-timeline drops a
// range without an end, so the item would silently vanish from the timeline.
// Shared by applyItemForm (the model) and the type picker (the form field), so
// the two cannot drift apart. Matches the double-click "new item" default.
const DEFAULT_EXTENT = '1w';

// ---- title = the panel headline --------------------------------------------
// The item title is edited directly in the panel's <h2> (contenteditable, see
// setDetailTitle). The form keeps a hidden input under the field's own name, so
// `applyItemForm` and the persist diff still read `content` out of FormData;
// typing in the headline writes into that input and dispatches a bubbling
// `input`, which the form's live-edit listener picks up.
//
// The listeners are attached once for the app's lifetime and resolve the open
// form on each event — the headline outlives any single form, so re-binding per
// item would stack a listener per opened item.
let titleWired = false;

function contentInput(): HTMLInputElement | null {
  return els.detailBody.querySelector<HTMLInputElement>('.item-form input[name="content"]');
}

function wireTitleHeadline(): void {
  if (titleWired) return;
  titleWired = true;
  const h = els.detailTitle;
  h.addEventListener('input', () => {
    const input = contentInput();
    if (!input || state.formRebuilding) return;
    input.value = h.textContent ?? '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  h.addEventListener('keydown', (e) => {
    // A title is one line: Enter commits instead of inserting a break.
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      h.blur();
    }
  });
  // The headline sits outside the form, so leaving it never triggers the form's
  // own focusout → commit. Do it here.
  h.addEventListener('blur', () => {
    if (state.activeFormItemId) commitItemForm();
  });
}

// ---- mark pickers (icon / type / status) -----------------------------------
// Icon, type and status are all "pick one value from a small fixed set", and all
// three used to be a labelled <select> costing a full field row each. They share
// ONE control here: a 30px trigger button showing the current value's *mark* —
// the icon glyph, the temporal shape, the status colour dot — that opens a
// popover with the choices. No labels; the tooltip and the popover rows name
// them.
//
// The trio lives in the panel header (`els.detailTools`), on the same line as
// the close button and above the headline, so it costs the form no row at all,
// sits outside the tabs, and stays put while the body scrolls (sticky header).
//
// That places it OUTSIDE the <form>, so two things are deliberate: each hidden
// input carries `form="item-form"` (a form-attribute-associated control is still
// part of FormData, so `applyItemForm` keeps reading these fields as before),
// and picking calls `scheduleLiveEdit()` directly — a change event dispatched
// here bubbles up the header, never reaching the form's own listener.

type PickOption = {
  value: string;
  label: string; // full name: tooltip, accessible name, and popover row text
  mark: string; // HTML for the visual shown in the trigger and the popover
};

type PickerSpec = {
  name: string; // form field name (also the hidden input's name)
  title: string; // field name shown in the tooltip, e.g. "Icon"
  options: PickOption[];
  // `grid` for a mark-only matrix (the 19 icons), `list` for mark + label rows.
  layout: 'grid' | 'list';
};

// A mark rendered as an inline SVG, in the same style as the tab glyphs.
function svgMark(body: string): string {
  return (
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"' +
    ` stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

const ICON_SPEC: PickerSpec = {
  name: 'icon',
  title: 'Icon',
  layout: 'grid',
  options: [
    { value: '', label: 'kein Icon', mark: '<span class="pick-none">—</span>' },
    ...TIMELINE_ICONS.map(({ key, label }) => ({
      value: key,
      label,
      mark: `<span class="item-icon" style="--item-icon:var(--icon-${key})"></span>`,
    })),
  ],
};

// The mark *is* the temporal shape the option produces: a diamond for a
// milestone, a bar for a range, a dashed band for a background phase.
const TYPE_SPEC: PickerSpec = {
  name: 'type',
  title: 'Type',
  layout: 'list',
  options: [
    { value: '', label: 'Automatisch', mark: svgMark('<path d="M6 3.5v5M3.5 6h5M16 13v7M12.5 16.5h7" />') },
    { value: 'point', label: 'Meilenstein', mark: svgMark('<path d="M12 4l8 8-8 8-8-8z" />') },
    { value: 'range', label: 'Zeitraum', mark: svgMark('<rect x="3" y="9" width="18" height="6" rx="2" />') },
    {
      value: 'background',
      label: 'Phase (Hintergrund)',
      mark: svgMark('<rect x="2.5" y="5" width="19" height="14" rx="1.5" stroke-dasharray="3 2.5" />'),
    },
    { value: 'box', label: 'Markierung', mark: svgMark('<rect x="7" y="7" width="10" height="10" rx="1.5" />') },
  ],
};

// Derived from ITEM_STATUSES so src/status.ts stays the single source of truth;
// the dot takes its colour per value from CSS (`--status-<key>`).
const STATUS_SPEC: PickerSpec = {
  name: 'status',
  title: 'Status',
  layout: 'list',
  options: ITEM_STATUSES.map(({ key, label }) => ({
    value: key,
    label,
    mark: `<span class="status-dot" data-status="${key}"></span>`,
  })),
};

const PICKERS: PickerSpec[] = [ICON_SPEC, TYPE_SPEC, STATUS_SPEC];

function pickOption(spec: PickerSpec, value: string): PickOption {
  return spec.options.find((o) => o.value === value) ?? spec.options[0];
}

function pickerTitle(spec: PickerSpec, value: string): string {
  return `${spec.title}: ${pickOption(spec, value).label}`;
}

function pickerHtml(spec: PickerSpec, current: string): string {
  const cells = spec.options
    .map(
      (o) =>
        `<button type="button" class="pick-cell" role="option" data-value="${escapeHtml(o.value)}"` +
        ` aria-selected="${o.value === current}" title="${escapeHtml(o.label)}"` +
        ` aria-label="${escapeHtml(o.label)}">${o.mark}` +
        (spec.layout === 'list' ? `<span class="pick-cell-label">${escapeHtml(o.label)}</span>` : '') +
        `</button>`,
    )
    .join('');
  return (
    `<div class="pick" data-pick="${spec.name}">` +
    `<button type="button" class="pick-trigger" data-role="pick-trigger" aria-haspopup="listbox"` +
    ` aria-expanded="false" title="${escapeHtml(pickerTitle(spec, current))}"` +
    ` aria-label="${escapeHtml(pickerTitle(spec, current))}">${pickOption(spec, current).mark}</button>` +
    `<input type="hidden" form="${FORM_ID}" name="${spec.name}" value="${escapeHtml(current)}" />` +
    `<div class="pick-menu pick-${spec.layout}" role="listbox" aria-label="${escapeHtml(spec.title)}"` +
    ` data-role="pick-menu" hidden>${cells}</div>` +
    `</div>`
  );
}

// Renders all three pickers into the panel header row. Called by showItemForm
// after setDetailTitle (which clears the row for the non-editable cases).
function renderPickerTools(item: TimelineFileItem): void {
  const current: Record<string, string> = {
    icon: item.icon ?? '',
    type: item.type ?? '',
    status: statusOrDefault(item.status),
  };
  els.detailTools.innerHTML = PICKERS.map((spec) => pickerHtml(spec, current[spec.name])).join('');
  els.detailTools.hidden = false;
  els.detail.querySelector('.detail-header')?.classList.add('has-tools');
}

function wirePicker(spec: PickerSpec, onPick?: (value: string) => void): void {
  const host = els.detailTools;
  const root = host.querySelector<HTMLElement>(`[data-pick="${spec.name}"]`);
  const trigger = root?.querySelector<HTMLButtonElement>('[data-role="pick-trigger"]');
  const menu = root?.querySelector<HTMLElement>('[data-role="pick-menu"]');
  const hidden = root?.querySelector<HTMLInputElement>('input[type="hidden"]');
  if (!root || !trigger || !menu || !hidden) return;

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  // Only one picker open at a time — they sit shoulder to shoulder, so a second
  // open menu would cover its neighbour's trigger.
  const open = () => {
    closePickMenus(menu);
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  };

  trigger.addEventListener('click', () => (menu.hidden ? open() : close()));

  menu.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick-cell');
    if (!cell || cell.dataset.value == null) return;
    const value = cell.dataset.value;
    close();
    trigger.focus();
    if (hidden.value === value) return;
    hidden.value = value;
    trigger.innerHTML = pickOption(spec, value).mark;
    const title = pickerTitle(spec, value);
    trigger.title = title;
    trigger.setAttribute('aria-label', title);
    for (const c of menu.querySelectorAll<HTMLButtonElement>('.pick-cell')) {
      c.setAttribute('aria-selected', String(c === cell));
    }
    onPick?.(value);
    // The pickers sit outside the <form>, so a dispatched change event never
    // reaches its listener — drive the live edit directly.
    scheduleLiveEdit();
  });
}

// Closes every open picker popover except `keep`. They sit shoulder to shoulder,
// so a second open menu would cover its neighbour's trigger.
function closePickMenus(keep?: HTMLElement): void {
  for (const menu of els.detailTools.querySelectorAll<HTMLElement>('[data-role="pick-menu"]')) {
    if (menu !== keep) menu.hidden = true;
  }
  for (const t of els.detailTools.querySelectorAll<HTMLElement>('[data-role="pick-trigger"]')) {
    const own = t.parentElement?.querySelector('[data-role="pick-menu"]');
    t.setAttribute('aria-expanded', String(own === keep && keep?.hidden === false));
  }
}

// Outside-click / Escape dismissal. Bound once on the document for the app's
// lifetime: the pickers are re-rendered per item, so per-instance document
// listeners would stack one set per opened item.
let pickGlobalWired = false;
function wirePickDismiss(): void {
  if (pickGlobalWired) return;
  pickGlobalWired = true;
  document.addEventListener('mousedown', (e) => {
    if (!els.detailTools.contains(e.target as Node)) closePickMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePickMenus();
  });
}

function tabStripHtml(): string {
  const tabs = FORM_TABS.map(
    ({ id, label }) =>
      `<button type="button" role="tab" class="form-tab" data-tab="${id}"` +
      ` id="f-tab-${id}" aria-controls="f-panel-${id}"` +
      ` aria-selected="${id === activeFormTab}"${id === activeFormTab ? '' : ' tabindex="-1"'}>` +
      `${tabIconHtml(id)}<span>${escapeHtml(label)}</span></button>`,
  ).join('');
  return `<div class="form-tabs" role="tablist" aria-label="Felder">${tabs}</div>`;
}

function panelHtml(id: FormTabId, fields: string): string {
  return (
    `<div class="form-panel" role="tabpanel" id="f-panel-${id}" data-tab="${id}"` +
    ` aria-labelledby="f-tab-${id}"${id === activeFormTab ? '' : ' hidden'}>${fields}</div>`
  );
}

function wireFormTabs(form: HTMLFormElement): void {
  const tabs = [...form.querySelectorAll<HTMLButtonElement>('.form-tab')];
  const select = (id: FormTabId) => {
    activeFormTab = id;
    for (const tab of tabs) {
      const on = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(on));
      if (on) tab.removeAttribute('tabindex');
      else tab.tabIndex = -1;
    }
    for (const panel of form.querySelectorAll<HTMLElement>('.form-panel')) {
      panel.hidden = panel.dataset.tab !== id;
    }
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.tab as FormTabId));
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const i = tabs.indexOf(tab);
      const next = tabs[(i + step + tabs.length) % tabs.length];
      select(next.dataset.tab as FormTabId);
      next.focus();
    });
  }
}

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
  state.activeFormFeatureId = null;
  // Tell the others which item we now occupy (see publishSelfPresence).
  publishSelfPresence();
  // The headline is this form's title editor, not just a caption; the pickers
  // live in the header row above it (setDetailTitle cleared whatever the last
  // panel put there).
  setDetailTitle(item.content ?? '', true);
  wireTitleHeadline();
  renderPickerTools(item);
  els.detailMeta.innerHTML = '';

  const groupOptions = buildGroupOptions(
    state.activeSourceFile.groups ?? state.activeBuild?.groups ?? [],
    item.group,
  );

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
    <form class="item-form" id="${FORM_ID}" data-id="${escapeHtml(id)}">
      <input id="f-content" name="content" type="hidden" value="${escapeHtml(item.content ?? '')}" />
      ${tabStripHtml()}
      ${panelHtml(
        'time',
        `
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
      </div>`,
      )}
      ${panelHtml(
        'props',
        `
      <div class="field">
        <label for="f-group">Group</label>
        <select id="f-group" name="group">${groupOptions}</select>
      </div>
      <div class="field">
        <label for="f-owner">Owner</label>
        <input id="f-owner" name="owner" value="${escapeHtml(owner)}" />
      </div>
      <div class="field full">
        <label>Body</label>
        <div data-role="body-editor"></div>
        <textarea id="f-body" name="body" hidden>${escapeHtml(item.body ?? '')}</textarea>
      </div>
      <div class="field tags-field">
        <label for="f-tags">Tags <small>(farbige Marker)</small></label>
        <div class="chip-box">
          <div class="tags-chips" data-role="tags-chips"></div>
          <div class="tags-suggest">
            <input id="f-tags" type="text" autocomplete="off" placeholder="hinzufügen…" />
            <ul class="tags-suggest-list" data-role="tags-list" hidden></ul>
          </div>
        </div>
      </div>
      ${renderCustomFieldsHtml(metadata)}
      <details class="adv-block"${metaJson ? ' open' : ''}>
        <summary>Erweitert</summary>
        <div class="field meta-json">
          <label for="f-meta">Other metadata (JSON)</label>
          <textarea id="f-meta" name="metadata" rows="3" placeholder='{"key": "value"}'>${escapeHtml(metaJson)}</textarea>
        </div>
      </details>`,
      )}
      ${panelHtml(
        'rel',
        `
      <div class="field full deps-field">
        <label for="f-deps">Depends on <small>(Einträge verknüpfen)</small></label>
        <div class="chip-box">
          <div class="deps-chips" data-role="deps-chips"></div>
          <div class="deps-suggest">
            <input id="f-deps" type="text" autocomplete="off" placeholder="Eintrag suchen…" />
            <ul class="deps-suggest-list" data-role="deps-list" hidden></ul>
          </div>
        </div>
      </div>
      <div class="field full jira-field">
        <label for="f-jira">JIRA <small>(Tickets verlinken)</small></label>
        <div class="chip-box">
          <div class="jira-chips" data-role="jira-chips"></div>
          <div class="jira-suggest">
            <input id="f-jira" type="text" autocomplete="off" placeholder="Ticket suchen oder Key eingeben (z. B. PROJ-123)…" />
            <ul class="jira-suggest-list" data-role="jira-list" hidden></ul>
          </div>
        </div>
      </div>`,
      )}
      <div class="form-actions centered">
        <button type="button" class="btn-danger" data-action="delete">Löschen</button>
      </div>
      ${auditBlockHtml(item)}
    </form>
  `;
  state.formRebuilding = false;

  const form = els.detailBody.querySelector('form') as HTMLFormElement;
  const endInput = form.querySelector<HTMLInputElement>('#f-end')!;
  const durInput = form.querySelector<HTMLInputElement>('#f-duration')!;
  const endField = endInput.closest('.field') as HTMLElement;
  const durField = durInput.closest('.field') as HTMLElement;
  // A point (Meilenstein) has no extent. End/Duration stay editable: entering
  // one promotes the item to a range live (see applyItemForm). Just flag the
  // point state visually so the interaction reads cleanly.
  const syncTypeFields = (value: string) => {
    const isPoint = value === 'point';
    endField.classList.toggle('is-muted', isPoint);
    durField.classList.toggle('is-muted', isPoint);
  };
  syncTypeFields(item.type ?? '');

  // Picking Meilenstein has to clear the extent, because applyItemForm resolves
  // the "a point has no extent" conflict in favour of the *extent* (so that a
  // typed end date is never silently swallowed). For an item that had an end or a
  // duration, the pick was therefore reverted in the same tick: the type never
  // stuck and, since nothing changed, nothing was even saved. Clearing the two
  // fields makes the pick the newer intent. The reverse still works — picking
  // Zeitraum seeds a default duration, and typing an extent promotes a point
  // back to a range.
  const onTypePick = (value: string) => {
    if (value === 'point') {
      endInput.value = '';
      durInput.value = '';
    } else if ((value === 'range' || value === 'background') && !endInput.value && !durInput.value) {
      // applyItemForm seeds this extent on the model anyway; writing it into the
      // field too keeps the form from showing an empty Duration for a bar that
      // does have one.
      durInput.value = DEFAULT_EXTENT;
    }
    syncTypeFields(value);
  };

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

  wireFormTabs(form);
  wirePicker(ICON_SPEC);
  wirePicker(TYPE_SPEC, onTypePick);
  wirePicker(STATUS_SPEC);
  wirePickDismiss();
  wireBodyEditor(form);
  wireJiraAutosuggest(form);
  wireDepsAutosuggest(form, id);
  wireTagsAutosuggest(form);
  wireCustomFields(form);

  els.detail.hidden = false;
  // Switching items commits the previous form, whose rebuildAndApply reloads the
  // DataSet (dropping the selection) and re-selects the *old* item. Re-assert the
  // selection on the item we're actually showing so the mark follows the sidebar.
  try {
    state.timeline?.setSelection([id]);
  } catch {
    /* item may be filtered out of the current view */
  }
  // The overlay panel can cover a right-edge item; pan it clear if needed.
  if (item.start) {
    const startMs = parseLocalDay(item.start).getTime();
    let endMs: number | undefined;
    if (item.end) endMs = parseLocalDay(item.end).getTime();
    else if (item.duration != null) {
      const d = durationToMs(item.duration);
      if (d) endMs = startMs + d;
    }
    revealBesidePanel(startMs, endMs);
  }

  // Freshly-created items open with the placeholder title pre-selected, so the
  // user can just start typing to replace "Neuer Eintrag".
  if (opts?.focusTitle) focusDetailTitle();
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
  // The read-only id lives here instead of as its own form field: it is metadata
  // of the same category as the audit rows, and as an 11px dt/dd pair it costs a
  // fraction of the vertical space a labelled input took in the field grid.
  // Unlike the audit rows it renders everywhere, not just on localhost.
  const idRow = item.id ? `<dt>ID</dt><dd><code>${escapeHtml(item.id)}</code></dd>` : '';
  const wrap = (body: string) =>
    body ? `<div class="item-audit" data-role="audit"><dl>${body}</dl></div>` : '';
  if (!import.meta.env.DEV) return wrap(idRow);
  const rows =
    auditRowHtml('Erstellt', item.createdBy, item.createdAt) +
    auditRowHtml('Aktualisiert', item.updatedBy, item.updatedAt, item.version);
  // Nothing known yet (e.g. a freshly added item before its first save round-trip).
  return wrap(idRow + (rows || '<dt>Metadaten</dt><dd>noch nicht gespeichert</dd>'));
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

  // Icon, type and status live in header controls *outside* the form (associated
  // via their `form` attribute, see the picker section). A missing key therefore
  // means "the control is not in the DOM right now", not "the user cleared the
  // field" — so leave the model value alone rather than clobbering it. Without
  // this guard a torn-down picker row silently reset the status to its default
  // and dropped icon and type.
  if (fd.has('type')) {
    const typeVal = get('type');
    if (typeVal) item.type = typeVal as TimelineFileItem['type'];
    else delete item.type;
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
    item.duration = DEFAULT_EXTENT;
  }

  const grp = get('group');
  if (grp) item.group = grp;

  if (fd.has('icon')) {
    const iconVal = get('icon');
    if (iconVal) item.icon = iconVal;
    else delete item.icon;
  }

  // status is mandatory (NOT NULL, default Open) — always store a canonical
  // value, but only when its control is actually present (see above).
  if (fd.has('status')) item.status = statusOrDefault(get('status'));

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
  // Keep the caption and the timeline selection in sync with the live content
  // (rebuildAndApply reloads the DataSet, which drops the selection). Text only:
  // setDetailTitle would tear down the header's picker row mid-edit.
  setDetailTitleText(item.content || '(unbenannt)');
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

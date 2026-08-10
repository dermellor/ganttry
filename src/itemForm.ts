// The editable item form shown in the detail panel: field layout, the Markdown
// body editor, the JIRA / dependencies / tags chip editors and the owner picker
// with autosuggest, and the reactive apply/delete logic. Persistence is deferred
// to persistence.ts (commitItemForm / scheduleLiveEdit).

import { readTags, tagColor } from './buildItems';
import {
  applyCustomFields,
  initCustomFieldState,
  isManagedMetaKey,
  readFieldValues,
  renderCustomFields,
  wireCustomFields,
} from './customFields';
import {
  Button,
  Chip,
  ChipBox,
  ChipBoxSlot,
  DescriptionList,
  Disclosure,
  Dot,
  el,
  Field,
  FieldError,
  FieldNote,
  FormActions,
  fromHtml,
  highlightSuggestion,
  Icon,
  IconButton,
  MenuItem,
  PickerGrid,
  PickerList,
  Popover,
  Select,
  StatusDot,
  SuggestEmpty,
  SuggestItem,
  SuggestList,
  Tab,
  TabPanel,
  Tabs,
  TextArea,
  TextInput,
  ToolbarAnchor,
  type Child,
  type DescriptionListEntry,
  type SelectOption,
  type SelectOptionGroup,
} from './design-system';
import { TIMELINE_ICONS } from './icons';
import { ITEM_STATUSES, statusOrDefault, statusToStore, type StatusKey } from './status';
import { ITEM_TYPES, type ItemTypeKey } from './itemType';
import { findItemIndex, isoDateOnly } from './editor';
import { applyFieldPick, writeListMeta } from './fieldValue';
import { createMarkdownEditor, type MarkdownEditor } from './wysiwyg';
import {
  isJiraKey,
  normalizeKey,
  readJiraIssues,
  searchJira,
  type JiraIssue,
} from './jira';
import type { DirectoryUser, TimelineFileItem } from './types';
import { directoryState, displayName, resolveOwner, searchUsers, userAvatar } from './users';
import { assignableLeaves, parentGroupIds } from './groupHierarchy';
import {
  PARENT_META_KEY,
  extentOverflow,
  readParentId,
  regroupSubtree,
  wouldCreateCycle,
} from './itemHierarchy';
import { state, els, setStatus, revealBesidePanel, clearFormSlots } from './state';
import { parseLocalDay, durationToMs, shiftDays } from './date';
import { describeReversedExtent, isReversedExtent } from './itemExtent';
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
): (SelectOption | SelectOptionGroup)[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parents = parentGroupIds(groups);
  const childIds = new Set<string>();
  for (const g of groups) for (const c of g.nestedGroups ?? []) childIds.add(c);
  const sel = selected == null ? null : String(selected);
  let matched = false;
  const option = (id: string): SelectOption | null => {
    const g = byId.get(id);
    if (!g) return null;
    const isSel = g.id === sel;
    if (isSel) matched = true;
    return { value: g.id, label: g.content, selected: isSel };
  };

  const out: (SelectOption | SelectOptionGroup)[] = [];
  for (const g of groups) {
    if (childIds.has(g.id)) continue; // rendered under its parent's optgroup
    if (parents.has(g.id)) {
      const children = assignableLeaves(g.id, groups)
        .map(option)
        .filter((o): o is SelectOption => o != null);
      out.push({ label: g.content, options: children });
    } else {
      const leaf = option(g.id);
      if (leaf) out.push(leaf);
    }
  }
  // Nothing matched — the item has no group, or one that no longer exists. A
  // `<select>` with no selected option shows its *first* one, so committing the
  // form wrote that first group onto the item: opening the form silently moved a
  // group-less item into whatever track happened to sort first. The placeholder
  // carries the empty value, which applyItemForm leaves alone, so the read stays
  // a read and a dangling group id survives instead of being reassigned.
  if (!matched) out.unshift({ value: '', label: '— —', selected: true });
  return out;
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
  { id: 'props', label: 'Properties' },
  { id: 'time', label: 'Date & Time' },
  { id: 'rel', label: 'Relationships' },
] as const;
type FormTabId = (typeof FORM_TABS)[number]['id'];

function tabIcon(id: FormTabId): Element {
  return fromHtml(
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      `${TAB_ICONS[id]}</svg>`,
  );
}

// Remembered across form rebuilds so clicking through items keeps the tab the
// user is working in.
let activeFormTab: FormTabId = 'props';

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
  // The visual shown in the trigger and in the popover row. A factory rather
  // than one node, because the same option is drawn in both places at once and
  // an element cannot be in two parents.
  mark: () => Element;
};

type PickerSpec = {
  name: string; // form field name (also the hidden input's name)
  title: string; // field name shown in the tooltip, e.g. "Icon"
  options: PickOption[];
  // `grid` for a mark-only matrix (the 19 icons), `list` for mark + label rows.
  layout: 'grid' | 'list';
};

// A mark rendered as an inline SVG, in the same style as the tab glyphs.
function svgMark(body: string): () => Element {
  return () =>
    fromHtml(
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"' +
        ` stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`,
    );
}

const ICON_SPEC: PickerSpec = {
  name: 'icon',
  title: 'Icon',
  layout: 'grid',
  options: [
    { value: '', label: 'kein Icon', mark: () => el('span', {}, '—') },
    ...TIMELINE_ICONS.map(({ key, label }) => ({
      value: key,
      label,
      mark: () => Icon({ name: key, standalone: true }),
    })),
  ],
};

// The mark *is* the temporal shape the option produces: a diamond for a
// milestone, a bar for a range, a dashed band for a background phase.
// The marks are the form's own: the value set is shared
// ([`src/itemType.ts`](./itemType.ts)), a glyph for it is not. „Automatisch" is a
// stored type of nothing, resolved at build time from whether the item has an
// extent, so it is an editor affordance rather than a member of the value set.
// Background says what it *looks* like here, because the form is where that choice
// is made.
const TYPE_MARKS: Record<ItemTypeKey, string> = {
  point: '<path d="M12 4l8 8-8 8-8-8z" />',
  range: '<rect x="3" y="9" width="18" height="6" rx="2" />',
  background: '<rect x="2.5" y="5" width="19" height="14" rx="1.5" stroke-dasharray="3 2.5" />',
  box: '<rect x="7" y="7" width="10" height="10" rx="1.5" />',
};

const TYPE_SPEC: PickerSpec = {
  name: 'type',
  title: 'Type',
  layout: 'list',
  options: [
    { value: '', label: 'Automatisch', mark: svgMark('<path d="M6 3.5v5M3.5 6h5M16 13v7M12.5 16.5h7" />') },
    ...ITEM_TYPES.map(({ key, label }) => ({
      value: key,
      label: key === 'background' ? `${label} (Hintergrund)` : label,
      mark: svgMark(TYPE_MARKS[key]),
    })),
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
    mark: () => StatusDot({ status: key }),
  })),
};

const PICKERS: PickerSpec[] = [ICON_SPEC, TYPE_SPEC, STATUS_SPEC];

function pickOption(spec: PickerSpec, value: string): PickOption {
  return spec.options.find((o) => o.value === value) ?? spec.options[0];
}

function pickerTitle(spec: PickerSpec, value: string): string {
  return `${spec.title}: ${pickOption(spec, value).label}`;
}

function pickerNode(spec: PickerSpec, current: string): HTMLElement {
  const cells = spec.options.map((option) =>
    MenuItem({
      cell: spec.layout === 'grid',
      label: option.label,
      mark: option.mark(),
      selected: option.value === current,
      // `option` inside the listbox below, rather than the component's default
      // menu semantics: this is a value picker, not a set of commands.
      attrs: { role: 'option', 'data-value': option.value, 'aria-label': option.label },
    }),
  );

  const title = pickerTitle(spec, current);
  const trigger = IconButton({
    icon: pickOption(spec, current).mark(),
    ariaLabel: title,
    variant: 'outline',
    attrs: { 'data-role': 'pick-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
  });

  const menu = Popover({
    hidden: true,
    role: 'listbox',
    ariaLabel: spec.title,
    attrs: { 'data-role': 'pick-menu' },
    children: spec.layout === 'grid' ? PickerGrid({ children: cells }) : PickerList({ children: cells }),
  });

  return ToolbarAnchor({
    attrs: { 'data-pick': spec.name },
    children: [
      trigger,
      // Outside the <form> element but bound to it by `form`, which is what lets
      // the pickers sit in the panel header and still be submitted with it.
      el('input', { type: 'hidden', form: FORM_ID, name: spec.name, value: current }),
      menu,
    ],
  });
}

// Renders all three pickers into the panel header row. Called by showItemForm
// after setDetailTitle (which clears the row for the non-editable cases).
function renderPickerTools(item: TimelineFileItem): void {
  const current: Record<string, string> = {
    icon: item.icon ?? '',
    type: item.type ?? '',
    status: statusOrDefault(item.status),
  };
  els.detailTools.replaceChildren(...PICKERS.map((spec) => pickerNode(spec, current[spec.name])));
  els.detailTools.hidden = false;
  els.detail.querySelector('.ds-Panel-header')?.setAttribute('data-has-tools', '');
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
    const cell = (e.target as HTMLElement).closest<HTMLButtonElement>('.ds-MenuItem');
    if (!cell || cell.dataset.value == null) return;
    const value = cell.dataset.value;
    close();
    trigger.focus();
    if (hidden.value === value) return;
    hidden.value = value;
    trigger.querySelector('.ds-Button-icon')?.replaceChildren(pickOption(spec, value).mark());
    const title = pickerTitle(spec, value);
    trigger.title = title;
    trigger.setAttribute('aria-label', title);
    for (const c of menu.querySelectorAll<HTMLButtonElement>('.ds-MenuItem')) {
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

function tabStrip(): HTMLElement {
  return Tabs({
    ariaLabel: 'Felder',
    children: FORM_TABS.map(({ id, label }) =>
      Tab({
        label,
        icon: tabIcon(id),
        selected: id === activeFormTab,
        controls: `f-panel-${id}`,
        attrs: { id: `f-tab-${id}`, 'data-tab': id },
      }),
    ),
  });
}

function panel(id: FormTabId, fields: Child): HTMLElement {
  return TabPanel({
    id: `f-panel-${id}`,
    hidden: id !== activeFormTab,
    attrs: { 'data-tab': id, 'aria-labelledby': `f-tab-${id}` },
    children: fields,
  });
}

/**
 * The four token fields — owner, tags, dependencies, JIRA — differ in their
 * label, their placeholder and which slots the wiring re-renders into. They were
 * four near-identical blocks of markup; what is left of the difference is the
 * arguments below.
 */
function chipField(spec: {
  label: string;
  hint?: string;
  inputId: string;
  placeholder: string;
  chipRole: string;
  listRole: string;
  full?: boolean;
  /** The owner list is wider than its half-width field and opens leftwards. */
  alignEnd?: boolean;
  /** Trailing content inside the field — the owner's hidden value input. */
  extra?: Child;
}): HTMLElement {
  return Field({
    label: spec.label,
    hint: spec.hint,
    htmlFor: spec.inputId,
    full: spec.full,
    control: [
      ChipBox({
        children: [
          ChipBoxSlot({ attrs: { 'data-role': spec.chipRole } }),
          ChipBoxSlot({
            children: [
              TextInput({ id: spec.inputId, bare: true, placeholder: spec.placeholder, attrs: { autocomplete: 'off' } }),
              SuggestList({ hidden: true, alignEnd: spec.alignEnd, attrs: { 'data-role': spec.listRole } }),
            ],
          }),
        ],
      }),
      spec.extra,
    ],
  });
}

function wireFormTabs(form: HTMLFormElement): void {
  const tabs = [...form.querySelectorAll<HTMLButtonElement>('.ds-Tab')];
  const select = (id: FormTabId) => {
    activeFormTab = id;
    for (const tab of tabs) {
      const on = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(on));
      if (on) tab.removeAttribute('tabindex');
      else tab.tabIndex = -1;
    }
    for (const panel of form.querySelectorAll<HTMLElement>('.ds-TabPanel')) {
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
  clearFormSlots();
  state.activeFormItemId = id;
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
  state.formParent = readParentId(metadata) ?? '';
  const owner = typeof metadata.owner === 'string' ? metadata.owner : '';
  state.formJiraIssues = readJiraIssues(metadata);
  state.formTags = readTags(metadata);
  initCustomFieldState(metadata);

  const otherMeta = Object.fromEntries(
    Object.entries(metadata).filter(([k]) => !isManagedMetaKey(k)),
  );
  const metaJson = Object.keys(otherMeta).length ? JSON.stringify(otherMeta, null, 2) : '';

  // Swapping the form removes the previously-focused input, which fires a
  // focusout → commit. Guard it: the outgoing form's values must not be
  // flushed onto this (already switched-to) item.
  state.formRebuilding = true;

  const durationValue =
    typeof item.duration === 'string' ? item.duration : item.duration != null ? String(item.duration) : '';

  const formEl = el('form', { class: 'ds-FormGrid item-form', id: FORM_ID, 'data-id': id }, [
    el('input', { id: 'f-content', name: 'content', type: 'hidden', value: item.content ?? '' }),
    tabStrip(),

    panel('props', [
      Field({
        label: 'Group',
        htmlFor: 'f-group',
        control: Select({ id: 'f-group', name: 'group', options: groupOptions }),
      }),
      chipField({
        label: 'Owner',
        inputId: 'f-owner-search',
        placeholder: 'Person suchen…',
        chipRole: 'owner-chip',
        listRole: 'owner-list',
        alignEnd: true,
        extra: el('input', { id: 'f-owner', name: 'owner', type: 'hidden', value: owner }),
      }),
      Field({
        label: 'Body',
        full: true,
        control: [
          el('div', { 'data-role': 'body-editor' }),
          TextArea({ id: 'f-body', name: 'body', value: item.body ?? '', attrs: { hidden: true } }),
        ],
      }),
      chipField({
        label: 'Tags',
        hint: '(farbige Marker)',
        inputId: 'f-tags',
        placeholder: 'hinzufügen…',
        chipRole: 'tags-chips',
        listRole: 'tags-list',
        full: true,
      }),
      renderCustomFields(metadata),
      Disclosure({
        summary: 'Erweitert',
        open: !!metaJson,
        children: Field({
          label: 'Other metadata (JSON)',
          htmlFor: 'f-meta',
          className: 'meta-json',
          control: TextArea({
            id: 'f-meta',
            name: 'metadata',
            rows: 3,
            value: metaJson,
            placeholder: '{"key": "value"}',
          }),
        }),
      }),
    ]),

    panel('time', [
      Field({
        label: 'Start',
        htmlFor: 'f-start',
        control: TextInput({ id: 'f-start', name: 'start', type: 'date', value: isoDateOnly(item.start) }),
      }),
      Field({
        label: 'End',
        htmlFor: 'f-end',
        control: TextInput({ id: 'f-end', name: 'end', type: 'date', value: isoDateOnly(item.end ?? '') }),
      }),
      Field({
        label: 'Duration',
        htmlFor: 'f-duration',
        control: TextInput({
          id: 'f-duration',
          name: 'duration',
          value: durationValue,
          placeholder: 'nur ohne End-Datum',
        }),
      }),
      FieldError({ hidden: true, attrs: { 'data-role': 'extent-error' } }),
    ]),

    panel('rel', [
      chipField({
        label: 'Übergeordnet',
        hint: '(Teil von)',
        inputId: 'f-parent',
        placeholder: 'Eintrag suchen…',
        chipRole: 'parent-chip',
        listRole: 'parent-list',
        full: true,
      }),
      // Read-only: a child is linked from its own form, so this field shows the
      // subtree rather than editing it. Hidden until there is one.
      Field({
        label: 'Untereinträge',
        full: true,
        hidden: true,
        attrs: { 'data-role': 'children-field' },
        control: [
          ChipBoxSlot({ className: 'ds-ChipRow', attrs: { 'data-role': 'children-chips' } }),
          FieldNote({ hidden: true, attrs: { 'data-role': 'children-overflow' } }),
        ],
      }),
      chipField({
        label: 'Depends on',
        hint: '(Einträge verknüpfen)',
        inputId: 'f-deps',
        placeholder: 'Eintrag suchen…',
        chipRole: 'deps-chips',
        listRole: 'deps-list',
        full: true,
      }),
      chipField({
        label: 'JIRA',
        hint: '(Tickets verlinken)',
        inputId: 'f-jira',
        placeholder: 'Ticket suchen oder Key eingeben (z. B. PROJ-123)…',
        chipRole: 'jira-chips',
        listRole: 'jira-list',
        full: true,
      }),
    ]),

    FormActions({
      centered: true,
      children: Button({ label: 'Löschen', variant: 'danger', attrs: { 'data-action': 'delete' } }),
    }),
    auditBlock(item),
  ]);

  els.detailBody.replaceChildren(formEl);
  state.formRebuilding = false;

  const form = els.detailBody.querySelector('form') as HTMLFormElement;
  const startInput = form.querySelector<HTMLInputElement>('#f-start')!;
  const endInput = form.querySelector<HTMLInputElement>('#f-end')!;
  const durInput = form.querySelector<HTMLInputElement>('#f-duration')!;
  const endField = endInput.closest('.ds-Field') as HTMLElement;
  const durField = durInput.closest('.ds-Field') as HTMLElement;

  // Native bounds so the two date pickers can't offer a reversed extent in the
  // first place: the end starts the day *after* the start (the rule is strict —
  // see src/itemExtent.ts), and the start ends the day before the end. This is
  // the proactive half of the guard, the counterpart to the phase ribbon clamping
  // to its neighbour's edge; it is an affordance, not the enforcement — a typed
  // (rather than picked) date still lands in the field, so applyItemForm rejects
  // it as well. Re-synced on every edit because either date may have just moved.
  //
  // Never while one of the two has focus, and never a write that changes
  // nothing. Assigning `min`/`max` makes the control re-parse its value, which
  // throws away the half-finished entry in its segment editor — the date the
  // user was in the middle of typing is gone on the first keystroke. And this
  // ran at exactly the wrong moment: Chrome fires `change` as soon as a complete
  // date becomes incomplete, i.e. on that very first digit, not (as assumed)
  // only on a settled value. Traced in the running app:
  //   keydown "0" → value 2027-09-01
  //   input       → value ""        badInput true
  //   change      → value ""        badInput true   ← bounds were rewritten here
  // The bounds are an affordance for the picker, so deferring them until the
  // field is left costs nothing: the enforcement is applyItemForm plus the
  // server, and both still run.
  const syncExtentBounds = () => {
    if (document.activeElement === startInput || document.activeElement === endInput) return;
    const nextEndMin = startInput.value ? shiftDays(startInput.value, 1) : '';
    const nextStartMax = endInput.value ? shiftDays(endInput.value, -1) : '';
    if (endInput.min !== nextEndMin) endInput.min = nextEndMin;
    if (startInput.max !== nextStartMax) startInput.max = nextStartMax;
  };
  syncExtentBounds();
  // An item stored with a reversed extent (from before this rule existed) opens
  // with the reason already showing, not only after the first keystroke — it is
  // what explains the hairline bar on the timeline.
  showExtentError(
    form,
    isReversedExtent(item.start, item.end) ? describeReversedExtent(item.start, item.end) : null,
  );
  form.addEventListener('change', syncExtentBounds);
  // A point (Meilenstein) has no extent. End/Duration stay editable: entering
  // one promotes the item to a range live (see applyItemForm). Just flag the
  // point state visually so the interaction reads cleanly.
  const syncTypeFields = (value: string) => {
    const isPoint = value === 'point';
    // `data-muted` is the Field component's own prop, expressed as the attribute
    // it renders — a `is-muted` class would style nothing.
    endField.toggleAttribute('data-muted', isPoint);
    durField.toggleAttribute('data-muted', isPoint);
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
  //
  // Dates are not exempted here even though their intermediate states must not
  // reach the model: `change` fires on the first keystroke too (traced — see
  // syncExtentBounds), so skipping `input` for them would buy nothing. What
  // keeps a half-typed date out of the model is `isTransient` in applyItemForm.
  form.addEventListener('input', scheduleLiveEdit);
  form.addEventListener('change', scheduleLiveEdit);
  // Leaving a field guarantees its edit is written even mid-session, without
  // waiting for the throttle window or the sidebar to close. The bounds are
  // re-synced here rather than on `change`, because that is the first moment
  // writing them cannot disturb an entry in progress; deferred a tick so focus
  // has actually moved.
  form.addEventListener('focusout', () => {
    commitItemForm();
    setTimeout(syncExtentBounds, 0);
  });
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
  wireParentPicker(form, id);
  wireDepsAutosuggest(form, id);
  wireTagsAutosuggest(form);
  wireOwnerPicker(form);
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

function auditRow(term: string, by?: string, iso?: string, version?: number): DescriptionListEntry | null {
  const when = formatAuditDate(iso);
  if (!when && !by) return null;
  const parts: Child[] = [];
  if (by) parts.push('von ', el('strong', {}, by));
  if (when) parts.push(parts.length ? ' · ' : '', when);
  if (version != null) parts.push(' · ', `v${version}`);
  return { term, value: parts };
}

function auditEntries(item: TimelineFileItem): DescriptionListEntry[] {
  // The read-only id lives here instead of as its own form field: it is metadata
  // of the same category as the audit rows, and as a dt/dd pair in the compact
  // voice it costs a fraction of the vertical space a labelled input took in the
  // field grid. Unlike the audit rows it renders everywhere, not just on
  // localhost.
  const entries: DescriptionListEntry[] = item.id
    ? [{ term: 'ID', value: el('code', {}, item.id), breakAll: true }]
    : [];
  if (!import.meta.env.DEV) return entries;
  const rows = [
    auditRow('Erstellt', item.createdBy, item.createdAt),
    auditRow('Aktualisiert', item.updatedBy, item.updatedAt, item.version),
  ].filter((row): row is DescriptionListEntry => row != null);
  // Nothing known yet (e.g. a freshly added item before its first save round-trip).
  return [...entries, ...(rows.length ? rows : [{ term: 'Metadaten', value: 'noch nicht gespeichert' }])];
}

function auditBlock(item: TimelineFileItem): HTMLElement | null {
  const entries = auditEntries(item);
  if (!entries.length) return null;
  return DescriptionList({
    compact: true,
    entries,
    className: 'item-audit',
    attrs: { 'data-role': 'audit' },
  });
}

// Re-render the audit block in place after a save writes fresh server values
// back onto the item (called from persistence.adoptAudit).
export function refreshItemAudit(item: TimelineFileItem): void {
  const current = els.detailBody.querySelector<HTMLElement>('.item-audit[data-role="audit"]');
  const next = auditBlock(item);
  if (!current || !next) return;
  current.replaceWith(next);
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
  wrap.replaceChildren(
    ...state.formJiraIssues.map((iss, i) =>
      Chip({
        code: iss.key,
        label: iss.summary || undefined,
        title: iss.summary || iss.key,
        removable: true,
        onRemove: () => {
          state.formJiraIssues.splice(i, 1);
          renderJiraChips(form);
          scheduleLiveEdit();
        },
      }),
    ),
  );
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
    list.replaceChildren(
      ...issues.map((iss, i) =>
        SuggestItem({
          layout: 'stacked',
          code: iss.key,
          description: iss.summary,
          attrs: { 'data-i': i },
          on: {
            mousedown: (e) => {
              e.preventDefault();
              pick(i);
            },
          },
        }),
      ),
    );
    list.hidden = false;
  };

  const highlight = () => highlightSuggestion(list, activeIndex);

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

/**
 * The „Übergeordnet" picker plus the read-only „Untereinträge" list under it —
 * the two sides of one relationship, so they are rendered by one function and
 * cannot end up describing different links.
 *
 * The suggestions leave out every item that would close a cycle (the item
 * itself, and anything already below it). Offering those and having
 * `resolveParents` drop the link afterwards looks exactly like a pick that did
 * not register.
 */
function wireParentPicker(form: HTMLFormElement, selfId: string): void {
  const chip = form.querySelector<HTMLElement>('[data-role="parent-chip"]');
  const input = form.querySelector<HTMLInputElement>('#f-parent');
  const list = form.querySelector<HTMLUListElement>('[data-role="parent-list"]');
  if (!chip || !input || !list) return;

  const renderChip = (): void => {
    chip.replaceChildren(
      ...(state.formParent
        ? [
            Chip({
              label: depLabel(state.formParent),
              title: state.formParent,
              removable: true,
              attrs: { 'data-clear-parent': '' },
            }),
          ]
        : []),
    );
    chip.querySelector<HTMLButtonElement>('[data-clear-parent] .ds-Chip-remove')?.addEventListener('click', () => {
      state.formParent = '';
      renderChip();
      // A single-valued picker hides its input once filled; clearing brings it
      // back, so the next parent can be typed without reopening the form.
      input.hidden = false;
      scheduleLiveEdit();
    });
    input.hidden = !!state.formParent;
  };

  const closeList = () => {
    list.hidden = true;
    list.innerHTML = '';
  };

  const candidates = (q: string): TimelineFileItem[] => {
    // Read the *live* hierarchy, not the one this form was opened with: the
    // user may have re-parented another item since.
    const parents = state.activeBuild?.parents ?? new Map<string, string>();
    const needle = q.toLowerCase();
    return (state.activeSourceFile?.items ?? [])
      .filter((it) => it.id && !wouldCreateCycle(parents, selfId, it.id))
      .filter(
        (it) =>
          !needle ||
          (it.content ?? '').toLowerCase().includes(needle) ||
          (it.id ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 8);
  };

  const renderList = (items: TimelineFileItem[]): void => {
    if (!items.length) {
      closeList();
      return;
    }
    list.replaceChildren(
      ...items.map((it) =>
        SuggestItem({
          layout: 'stacked',
          label: it.content?.trim() || it.id || '',
          description: it.id ?? '',
          attrs: { 'data-id': it.id ?? '' },
        }),
      ),
    );
    list.hidden = false;
    list.querySelectorAll<HTMLLIElement>('.ds-SuggestItem').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        state.formParent = li.dataset.id ?? '';
        input.value = '';
        closeList();
        renderChip();
        scheduleLiveEdit();
      });
    });
  };

  input.addEventListener('input', () => renderList(candidates(input.value.trim())));
  input.addEventListener('focus', () => renderList(candidates(input.value.trim())));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeList();
  });
  // Let a mousedown on a suggestion fire first, then close.
  input.addEventListener('blur', () => setTimeout(closeList, 120));

  renderChip();
  renderChildren(form, selfId);
}

/**
 * The children an item has, as read-only chips, plus the one place the rollup is
 * stated: where the children run outside the parent's own dates.
 *
 * The parent's dates stay authoritative — they are maintained by hand and a
 * rollup that overwrote them would silently replace a decision with a
 * calculation. So this reports the discrepancy and changes nothing.
 */
function renderChildren(form: HTMLFormElement, selfId: string): void {
  const field = form.querySelector<HTMLElement>('[data-role="children-field"]');
  const chips = form.querySelector<HTMLElement>('[data-role="children-chips"]');
  const note = form.querySelector<HTMLElement>('[data-role="children-overflow"]');
  if (!field || !chips || !note) return;

  const parents = state.activeBuild?.parents ?? new Map<string, string>();
  const childIds = [...parents.entries()].filter(([, p]) => p === selfId).map(([c]) => c);
  field.hidden = childIds.length === 0;
  if (!childIds.length) return;

  // No remove button: a child is linked from its own form, so this row shows the
  // subtree rather than editing it.
  chips.replaceChildren(...childIds.map((cid) => Chip({ label: depLabel(cid), title: cid })));

  const byId = new Map((state.activeSourceFile?.items ?? []).map((it) => [it.id, it]));
  const self = byId.get(selfId);
  const { before, after } = extentOverflow(
    { start: self?.start, end: self?.end },
    childIds.map((cid) => ({ start: byId.get(cid)?.start, end: byId.get(cid)?.end })),
  );
  const parts: string[] = [];
  if (before) parts.push(`beginnen am ${formatDay(before)}`);
  if (after) parts.push(`laufen bis ${formatDay(after)}`);
  note.hidden = parts.length === 0;
  note.textContent = parts.length ? `Untereinträge ${parts.join(' und ')}.` : '';
}

// "2026-07-16" → "16.07.2026". Same reading as the list view's dates; anything
// unparseable falls back to the raw day so an odd value still shows something.
function formatDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
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
  wrap.replaceChildren(
    ...state.formDependsOn.map((depId, i) =>
      Chip({
        label: depLabel(depId),
        title: depId,
        removable: true,
        onRemove: () => {
          state.formDependsOn.splice(i, 1);
          renderDepChips(form);
          scheduleLiveEdit();
        },
      }),
    ),
  );
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
    highlightSuggestion(list, activeIndex);
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
    list.replaceChildren(
      ...items.map((it, i) =>
        SuggestItem({
          layout: 'stacked',
          label: it.content?.trim() || it.id || '',
          description: it.id ?? '',
          attrs: { 'data-i': i },
          on: {
            mousedown: (e) => {
              e.preventDefault();
              pick(i);
            },
          },
        }),
      ),
    );
    list.hidden = false;
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

// ---------------------------------------------------------------------------
// Owner picker
// ---------------------------------------------------------------------------
// Owner links a **user** rather than holding free text: the value stored in
// `metadata.owner` is an e-mail, resolved for display against the directory
// (src/users.ts). One owner per item, so this is a single-value combobox, not a
// chip list — but it borrows the `.chip-box` shell the multi-value fields use, so
// a filled owner reads as the same kind of control as a filled Tags field.
//
// The picked value lives in a **hidden `owner` input**, which is what keeps the
// rest of the form oblivious: `FormData` still carries `owner`, and
// `applyItemForm`'s `get('owner')` is unchanged from when this was a text input.
// The visible input is a search box only and is deliberately unnamed, or it would
// submit a half-typed name as the owner.
//
// Two states, never both: an empty owner shows the search box; a set owner shows
// its chip and hides the search box (a second person cannot be added, so leaving
// the box there would invite a pick that silently replaces the first).
function wireOwnerPicker(form: HTMLFormElement): void {
  const hidden = form.querySelector<HTMLInputElement>('#f-owner');
  const slot = form.querySelector<HTMLElement>('[data-role="owner-chip"]');
  const input = form.querySelector<HTMLInputElement>('#f-owner-search');
  const list = form.querySelector<HTMLUListElement>('[data-role="owner-list"]');
  if (!hidden || !slot || !input || !list) return;

  let activeIndex = -1;
  let current: DirectoryUser[] = [];

  const closeList = () => {
    list.hidden = true;
    list.innerHTML = '';
    activeIndex = -1;
    current = [];
  };

  const renderChip = () => {
    const owner = resolveOwner(hidden.value);
    slot.replaceChildren();
    input.hidden = !!owner;
    if (!owner) return;

    // An unresolvable value is a legacy free-text owner (or a file source's).
    // Marked as such rather than dropped, and shown without an avatar: inventing
    // a monogram and a colour for "Strategy Team" would present a string as a
    // person the directory never knew.
    slot.appendChild(
      Chip({
        mark: owner.known && owner.user ? userAvatar(owner.user, 'sm') : undefined,
        label: owner.label,
        unlinked: !owner.known,
        title: owner.known ? owner.raw : `${owner.raw} — nicht mit einem Benutzer verknüpft`,
        removable: true,
        removeLabel: 'Owner entfernen',
        onRemove: () => setOwner(''),
      }),
    );
  };

  const setOwner = (email: string) => {
    hidden.value = email;
    input.value = '';
    closeList();
    renderChip();
    scheduleLiveEdit();
    if (!email) input.focus();
  };

  const highlight = () => highlightSuggestion(list, activeIndex);

  const pick = (i: number) => {
    const user = current[i];
    if (user) setOwner(user.email);
  };

  const renderList = (users: DirectoryUser[]) => {
    current = users;
    activeIndex = -1;
    if (!users.length) {
      // Say why instead of just not opening. Nothing happening at all is
      // indistinguishable from a broken field — and on a fresh install the
      // directory legitimately *is* empty until someone signs in, which is a
      // different problem from the endpoint being unreachable (e.g. migration
      // 0015 not applied). `current` stays empty, so the row is inert: arrow
      // keys and Enter have nothing to pick.
      const { status } = directoryState();
      const msg =
        status === 'unavailable'
          ? 'Benutzerverzeichnis nicht erreichbar'
          : status === 'empty'
            ? 'Noch keine Benutzer erfasst'
            : 'Kein Treffer';
      list.replaceChildren(SuggestEmpty({ text: msg }));
      list.hidden = false;
      return;
    }
    list.replaceChildren(
      ...users.map((u, i) =>
        SuggestItem({
          mark: userAvatar(u, 'sm'),
          label: displayName(u),
          // The address is shown next to the name, not only in a tooltip: two
          // colleagues can share a display name, and the address is the value
          // actually stored.
          detail: u.email,
          attrs: { 'data-i': i },
          on: {
            mousedown: (e) => {
              e.preventDefault();
              pick(i);
            },
          },
        }),
      ),
    );
    list.hidden = false;
  };

  input.addEventListener('input', () => renderList(searchUsers(input.value)));
  input.addEventListener('focus', () => renderList(searchUsers(input.value)));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) renderList(searchUsers(input.value));
      activeIndex = Math.min(activeIndex + 1, current.length - 1);
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlight();
    } else if (e.key === 'Enter') {
      // No free-form fallback here (unlike Tags): the field links an existing
      // user, so typed text that matches nobody must not become the value.
      e.preventDefault();
      if (activeIndex >= 0) pick(activeIndex);
      else if (current.length === 1) pick(0);
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  input.addEventListener('blur', () => {
    // Let a mousedown on a suggestion fire first, then close.
    setTimeout(closeList, 120);
  });

  renderChip();
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
  wrap.replaceChildren(
    ...state.formTags.map((tag, i) =>
      Chip({
        mark: Dot({ color: tagColor(tag) }),
        label: tag,
        removable: true,
        onRemove: () => {
          state.formTags.splice(i, 1);
          renderTagChips(form);
          scheduleLiveEdit();
        },
      }),
    ),
  );
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

  const highlight = () => highlightSuggestion(list, activeIndex);

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
    list.replaceChildren(
      ...tags.map((tag, i) =>
        SuggestItem({
          mark: Dot({ color: tagColor(tag) }),
          label: tag,
          attrs: { 'data-i': i },
          on: {
            mousedown: (e) => {
              e.preventDefault();
              pick(i);
            },
          },
        }),
      ),
    );
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

// Show (or clear) the reason an extent was refused, in the Date & Time panel
// under the three date fields.
//
// Deliberately NOT the status line, which is where the sibling "metadata JSON
// ungültig" notice goes: leaving a field's edit out of the model schedules a
// commit anyway, and the persist that follows reports „Gespeichert" milliseconds
// later — so a status-line message flashed and vanished, leaving the user looking
// at „Gespeichert" while their typed date had in fact been refused. That reads as
// a successful save of bad data, which is worse than saying nothing. An error
// anchored in the form outlives every status write and sits where the problem is.
function showExtentError(form: HTMLFormElement, message: string | null): void {
  const box = form.querySelector<HTMLElement>('[data-role="extent-error"]');
  if (!box) return;
  box.textContent = message ?? '';
  box.hidden = !message;
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

  /**
   * Is this date control being typed into right now?
   *
   * A half-typed `type=date` reports `value === ''`, exactly like a field the
   * user cleared, and FormData cannot tell the two apart. It matters because
   * this function runs on every keystroke: the FIRST digit typed makes the date
   * incomplete, the extent block below read that as "cleared", deleted the date
   * and persisted the deletion (`"start": null`). The field then lost its
   * remaining segments under the caret, which is why entering a date was
   * impossible — „ich gebe 01. ein, daraus wird 12.".
   *
   * Focus is the signal, deliberately not `validity.badInput`: after the first
   * digit Chrome reports `value === ''` with `badInput === false`, so the
   * platform's own "is this a partial entry" flag does not cover the case that
   * breaks. Measured, not assumed.
   *
   * The year needs the same treatment for the opposite reason. Typing `2026`
   * passes through the years 2, 20 and 202, and each of those is a *complete,
   * valid* date — so an empty-value check alone does not catch it. The app took
   * `0002-12-01` as the user's answer, flashed „das End-Datum muss nach dem
   * Start liegen" on the first digit of the year, and reset the whole field on
   * the next one. A year below 1000 while the control still has focus is
   * therefore an intermediate state, not an input.
   *
   * Everything here is scoped to a focused control. Whatever stands in the field
   * when the user leaves it counts, so a genuinely cleared date still reaches the
   * model on blur (`focusout` already commits the form), and a deliberate
   * year-999 date is applied then too.
   */
  const isTransient = (name: string, value: string): boolean => {
    const el = form.querySelector(`[name="${name}"]`);
    if (!(el instanceof HTMLInputElement) || el !== document.activeElement) return false;
    if (!value) return true; // segments still empty
    const year = Number(value.slice(0, 4));
    return !Number.isFinite(year) || year < 1000; // year still being typed
  };

  const item = state.activeSourceFile.items[idx];
  // Captured before the form overwrites either: the extent seeding further down
  // has to tell "the user just emptied this" from "it was stored this way".
  const hadExtent = item.end != null || item.duration != null;
  const prevType = item.type;
  item.content = get('content') || item.content;
  const durVal = get('duration');
  // A transient value counts as "no answer yet" everywhere below — including the
  // reversed-extent check, so no error is shown for a date the user is still
  // halfway through typing.
  const startTyping = isTransient('start', get('start'));
  const endTyping = isTransient('end', get('end'));
  const startVal = startTyping ? '' : get('start');
  const endVal = endTyping ? '' : get('end');

  // An `end` before (or on) its `start` renders as a hairline stripe and the
  // server rejects it outright (see src/itemExtent.ts), so it must never reach
  // the model. The form is reactive, so there is no save button to block: keep
  // the last valid dates instead and name the problem under the fields (see
  // showExtentError). Only settled values reach this — a date still being typed
  // is blanked above, so no keystroke on the way to a valid one trips the error.
  //
  // Rejects the extent as a whole rather than guessing which of the two dates the
  // user meant to move. To shift an item past its own end, change the end first.
  const extentReversed = isReversedExtent(startVal, endVal);
  if (!extentReversed) {
    // Start is optional: clearing the field removes the date (the item then shows
    // only in the list view, hidden from the timeline). Half-typed is not
    // cleared, though — see `isTransient`.
    if (startVal) item.start = startVal;
    else if (!startTyping) delete item.start;

    // Extent precedence must match the render path (buildItems: `end` wins, with
    // `duration` only a fallback). Committing with the opposite precedence is what
    // collapsed items carrying *both* fields — a long `end`-based bar silently
    // shrank to its stale `duration` on the next commit. Prefer `end` here and
    // drop the other so the two never coexist going forward.
    if (endVal) {
      item.end = endVal;
      delete item.duration;
    } else if (endTyping) {
      // Mid-entry: leave the extent exactly as it is. Falling through would read
      // the half-typed end as "no end" and either promote a stale `duration` or
      // clear both, i.e. rewrite the item on every keystroke.
    } else if (durVal) {
      item.duration = durVal;
      delete item.end;
    } else {
      delete item.duration;
      delete item.end;
    }
  }

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
  // Not while a date is being typed: the extent is momentarily unreadable, and
  // seeding a default there would write a duration the user never asked for and
  // then have to take it back once the date completes.
  //
  // And only when this pass is what left the item extentless — either the type
  // just changed, or an extent it arrived with was emptied. An item *stored*
  // without one keeps it that way, because opening its form is a read: seeding
  // unconditionally wrote `duration: '1w'` into the source on a mere click, the
  // same defect as the status default. Such an item is invisible on the timeline
  // either way; the form now shows an empty Duration, which says so.
  if (
    (item.type === 'range' || item.type === 'background') &&
    !item.end &&
    !item.duration &&
    (hadExtent || item.type !== prevType) &&
    !startTyping &&
    !endTyping
  ) {
    item.duration = DEFAULT_EXTENT;
  }

  // The Group control moves the item's whole subtree, exactly like a drag onto
  // another track does — the same rule, from the same place, so picking a track
  // in the form and dropping the bar on it cannot end up meaning two things.
  const grp = get('group');
  if (grp) regroupSubtree(state.activeSourceFile.items, id, grp);

  if (fd.has('icon')) {
    const iconVal = get('icon');
    if (iconVal) item.icon = iconVal;
    else delete item.icon;
  }

  // Only when the control is actually present (see above), and only when the
  // value is the user's rather than the picker's seeded default — statusToStore
  // owns that distinction, because getting it wrong made opening a form a write.
  if (fd.has('status')) {
    const status = statusToStore(item.status, get('status'));
    if (status !== undefined) item.status = status;
  }

  const body = String(fd.get('body') ?? '');
  if (body) item.body = body;
  else delete item.body;

  // An item that arrived with an empty `metadata` object keeps it: the cleanup at
  // the end of this function would otherwise drop the key on a mere read, the
  // same churn writeListMeta exists to prevent one level down.
  const arrivedWithEmptyMeta =
    item.metadata != null && Object.keys(item.metadata as object).length === 0;
  const meta = (item.metadata ??= {}) as Record<string, unknown>;
  writeListMeta(meta, 'dependsOn', state.formDependsOn);

  if (state.formParent) meta[PARENT_META_KEY] = state.formParent;
  else delete meta[PARENT_META_KEY];

  const owner = get('owner');
  if (owner) meta.owner = owner;
  else delete meta.owner;

  writeListMeta(meta, 'jira', state.formJiraIssues.map((i) => ({ key: i.key, summary: i.summary })));

  writeListMeta(meta, 'tags', state.formTags);
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
  if (Object.keys(meta).length === 0 && !arrivedWithEmptyMeta) delete (item as any).metadata;

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
  showExtentError(form, extentReversed ? describeReversedExtent(startVal, endVal) : null);
  if (metaError) setStatus('Metadata JSON ungültig — Änderung nicht übernommen');
}

/**
 * Set an item's status without going through the form — the context menu's
 * status rows (see contextMenu.ts). Lives here next to `deleteItem` because it
 * is the same kind of thing: a mutation of an existing item that has to keep an
 * open form in step.
 *
 * That last part is a correctness requirement, not a cosmetic one. The status
 * picker holds its value in a hidden input, so a form still open on this item
 * would keep the *old* status in its FormData and the next `commitItemForm`
 * would write it straight back over this change. Re-rendering the form syncs the
 * picker, exactly as `handleMove` does after a drag.
 *
 * Deliberately no `markSelfEditing()`: presence attributes activity to the item
 * the form/selection points at, and a right-click doesn't select — so on an
 * unselected item it would flag the wrong one as being edited.
 */
export function setItemStatus(id: string, status: StatusKey): void {
  if (!state.activeSourceFile) return;
  const idx = findItemIndex(state.activeSourceFile, id);
  if (idx === -1) return;
  const item = state.activeSourceFile.items[idx];
  if (statusOrDefault(item.status) === status) return;
  item.status = status;
  rebuildAndApply();
  if (state.activeFormItemId === id) showItemForm(item);
  schedulePersist();
}

/**
 * Set (or, for a multi-select, toggle) one custom-field value on an item from the
 * context menu — the counterpart to `setItemStatus` for the fields that opted in
 * via `def.contextMenu`. An empty `value` on a single-select clears the field.
 *
 * Values live in `metadata[key]`, so the same emptiness rule as `applyItemForm`
 * applies: a field with no values loses its key, and an item with no keys left
 * loses `metadata` entirely — which the persist diff sends as an explicit `null`
 * (see `buildItemPatch`), or the old value would come back on reload.
 *
 * Returns the values the item carries afterwards, so the menu can re-mark its
 * rows without reaching into the model itself.
 */
export function setItemFieldValue(
  id: string,
  key: string,
  value: string,
  multi: boolean,
): string[] {
  if (!state.activeSourceFile) return [];
  const idx = findItemIndex(state.activeSourceFile, id);
  if (idx === -1) return [];
  const item = state.activeSourceFile.items[idx];
  const meta = ((item.metadata ??= {}) as Record<string, unknown>);
  // Toggle-vs-replace and the stored shape are resolved in fieldValue.ts, where
  // they are unit-testable.
  const { values, stored } = applyFieldPick(readFieldValues(meta, key), value, multi);
  if (stored === undefined) delete meta[key];
  else meta[key] = stored;
  if (Object.keys(meta).length === 0) delete (item as any).metadata;

  rebuildAndApply();
  if (state.activeFormItemId === id) showItemForm(item);
  schedulePersist();
  return values;
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

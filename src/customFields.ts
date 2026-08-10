// Per-timeline custom fields in the item form. Definitions come from two places:
// the timeline itself (state.activeSourceFile.customFields, seeded backend-side)
// and the enabled plugins, which derive fields from the timeline's own data
// (kinds/registry.ts `pluginFieldDefs`). Values live per item in metadata[key].
// This module renders a form control per field, wires the multi-select chip
// editors, and reads the values back into metadata.
//
// Mirrors the tags chip editor (itemForm.ts) but with a *fixed* option set:
// multi-select suggestions are the field's declared options, not free-form.

import {
  Chip,
  ChipBox,
  ChipBoxSlot,
  Dot,
  Field,
  Fieldset,
  highlightSuggestion,
  Select,
  SuggestItem,
  SuggestList,
  TextInput,
} from './design-system';
import { writeListMeta } from './fieldValue';
import { state } from './state';
import { scheduleLiveEdit } from './persistence';
import { mergeFieldDefs, pluginFieldDefs } from './pluginHost/registry';
import { type CustomFieldDef, type CustomFieldOption } from './types';

// metadata keys managed by their own dedicated form control (the reserved
// built-ins handled directly in itemForm) — used to keep them out of the
// free-form "Other metadata" JSON box. Custom-field keys are added on top.
const RESERVED_META_KEYS = new Set(['dependsOn', 'parent', 'owner', 'jira', 'tags', 'tag']);

const FALLBACK_COLOR = '#64748B';

// Every field definition the active timeline offers: its own stored ones first,
// then whatever the enabled plugins contribute (already stamped with the
// plugin's label as their `group`), one definition per key — a contributed field
// supersedes a stored one on the same key (see mergeFieldDefs). This module
// deliberately knows nothing about which plugins exist — the registry is the only
// place plugin ids live.
export function getCustomFields(): CustomFieldDef[] {
  const cfs = state.activeSourceFile?.customFields;
  const stored = Array.isArray(cfs) ? cfs.filter((f) => f && f.key && f.type) : [];
  return mergeFieldDefs(stored, pluginFieldDefs(state.activeSourceFile));
}

// True when a metadata key is surfaced by a dedicated control (reserved built-in
// or a custom field), so it must not also appear in the raw metadata JSON box.
export function isManagedMetaKey(key: string): boolean {
  if (RESERVED_META_KEYS.has(key)) return true;
  return getCustomFields().some((f) => f.key === key);
}

function optionOf(def: CustomFieldDef, value: string): CustomFieldOption | undefined {
  return def.options?.find((o) => o.value === value);
}

function optionLabel(def: CustomFieldDef, value: string): string {
  return optionOf(def, value)?.label ?? value;
}

function optionColor(def: CustomFieldDef, value: string): string {
  return optionOf(def, value)?.color ?? FALLBACK_COLOR;
}

// An option's pill colour, for consumers outside this module (the context menu's
// value rows). Exported rather than re-derived there so the fallback colour has
// one definition.
export function fieldOptionColor(def: CustomFieldDef, value: string): string {
  return optionColor(def, value);
}

/**
 * The fields that opted into being editable from an item's right-click menu
 * (`def.contextMenu`), in definition order.
 *
 * A `text` field is filtered out no matter what it declares: a menu can only
 * offer a fixed set of rows, and free text needs a keyboard. Keeping that rule
 * here — beside the rest of the per-type field semantics — means contextMenu.ts
 * never has to reason about field types.
 */
export function contextMenuFields(): CustomFieldDef[] {
  return getCustomFields().filter((f) => f.contextMenu && f.type !== 'text');
}

// Read a stored value as string[] regardless of scalar/array shape, so a
// multi-select tolerates a legacy scalar and a select tolerates a stray array.
export function readFieldValues(meta: Record<string, unknown>, key: string): string[] {
  const v = meta[key];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  return [];
}

// Seed the per-field multi-select state from the item's metadata. Called by
// showItemForm before the form HTML is built.
export function initCustomFieldState(meta: Record<string, unknown>): void {
  const next: Record<string, string[]> = {};
  for (const def of getCustomFields()) {
    if (def.type !== 'multi-select') continue;
    next[def.key] = readFieldValues(meta, def.key);
  }
  state.formCustomMulti = next;
}

// The custom-fields part of the item form (nothing when the timeline declares
// none). Appended to the form's first panel by showItemForm.
//
// Fields that declare a `group` (every plugin-contributed one does, carrying its
// plugin's label) are collected into a titled section per group, in first-seen
// order, after the ungrouped fields. Without that, a plugin's fields sat flat
// among the timeline's own and nothing said they belonged together — or where
// they came from. The sections are ordinary nodes inside the same <form>, so
// FormData, applyCustomFields and isManagedMetaKey are untouched by the grouping.
export function renderCustomFields(meta: Record<string, unknown>): Element[] {
  const defs = getCustomFields();
  if (!defs.length) return [];

  const sections = new Map<string, CustomFieldDef[]>();
  for (const def of defs) {
    if (!def.group) continue;
    (sections.get(def.group) ?? sections.set(def.group, []).get(def.group)!).push(def);
  }

  return [
    ...defs.filter((d) => !d.group).map((def) => fieldNode(def, meta)),
    ...[...sections].map(([legend, fields]) =>
      Fieldset({ legend, children: fields.map((def) => fieldNode(def, meta)) }),
    ),
  ];
}

// One field's control, identical whether it ends up flat or in a section.
// `def.width: 'full'` maps onto the Field component's own `full` prop, so a
// definition — a plugin's or the timeline's — controls its width the same way
// the built-in fields do.
function fieldNode(def: CustomFieldDef, meta: Record<string, unknown>): HTMLElement {
  const shared = {
    label: def.label || def.key,
    full: def.width === 'full',
    className: 'cf-field',
    attrs: { 'data-cf-key': def.key },
  };

  if (def.type === 'multi-select') {
    return Field({
      ...shared,
      control: ChipBox({
        children: [
          ChipBoxSlot({ attrs: { 'data-cf-chips': def.key } }),
          ChipBoxSlot({
            children: [
              TextInput({
                bare: true,
                placeholder: 'Auswählen…',
                attrs: { autocomplete: 'off', 'data-cf-input': def.key },
              }),
              SuggestList({ hidden: true, attrs: { 'data-cf-list': def.key } }),
            ],
          }),
        ],
      }),
    });
  }

  const current = readFieldValues(meta, def.key)[0] ?? '';

  if (def.type === 'select') {
    return Field({
      ...shared,
      control: Select({
        attrs: { 'data-cf-control': def.key },
        options: [
          { value: '', label: '— —', selected: !current },
          ...(def.options ?? []).map((o) => ({
            value: o.value,
            label: o.label ?? o.value,
            selected: o.value === current,
          })),
        ],
      }),
    });
  }

  return Field({
    ...shared,
    control: TextInput({ value: current, attrs: { 'data-cf-control': def.key } }),
  });
}

// ---- multi-select chip editor (one per multi-select field) -----------------

function renderCfChips(form: HTMLFormElement, def: CustomFieldDef): void {
  const wrap = form.querySelector<HTMLElement>(`[data-cf-chips="${def.key}"]`);
  if (!wrap) return;
  const values = state.formCustomMulti[def.key] ?? [];
  wrap.replaceChildren(
    ...values.map((val, i) =>
      Chip({
        mark: Dot({ color: optionColor(def, val) }),
        label: optionLabel(def, val),
        removable: true,
        onRemove: () => {
          (state.formCustomMulti[def.key] ??= []).splice(i, 1);
          renderCfChips(form, def);
          scheduleLiveEdit();
        },
      }),
    ),
  );
}

function addCfValue(form: HTMLFormElement, def: CustomFieldDef, value: string): void {
  const arr = (state.formCustomMulti[def.key] ??= []);
  if (!value || arr.includes(value)) return;
  arr.push(value);
  renderCfChips(form, def);
  scheduleLiveEdit();
}

function wireCfMultiSelect(form: HTMLFormElement, def: CustomFieldDef): void {
  renderCfChips(form, def);

  const input = form.querySelector<HTMLInputElement>(`[data-cf-input="${def.key}"]`);
  const list = form.querySelector<HTMLUListElement>(`[data-cf-list="${def.key}"]`);
  if (!input || !list) return;

  let activeIndex = -1;
  let current: string[] = [];

  const closeList = () => {
    list.hidden = true;
    list.innerHTML = '';
    activeIndex = -1;
    current = [];
  };

  // Remaining options: declared choices not already picked, filtered by the
  // typed needle (matched against value and label).
  const available = (q: string): string[] => {
    const chosen = state.formCustomMulti[def.key] ?? [];
    const needle = q.trim().toLowerCase();
    return (def.options ?? [])
      .map((o) => o.value)
      .filter(
        (v) =>
          !chosen.includes(v) &&
          (!needle ||
            v.toLowerCase().includes(needle) ||
            optionLabel(def, v).toLowerCase().includes(needle)),
      );
  };

  const highlight = () => highlightSuggestion(list, activeIndex);

  const pick = (i: number) => {
    const v = current[i];
    if (v) addCfValue(form, def, v);
    input.value = '';
    closeList();
    input.focus();
  };

  const renderList = (vals: string[]) => {
    current = vals;
    activeIndex = -1;
    if (!vals.length) {
      closeList();
      return;
    }
    list.replaceChildren(
      ...vals.map((v, i) =>
        SuggestItem({
          mark: Dot({ color: optionColor(def, v) }),
          label: optionLabel(def, v),
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

  input.addEventListener('input', () => renderList(available(input.value)));
  input.addEventListener('focus', () => renderList(available(input.value)));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) renderList(available(input.value));
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

  input.addEventListener('blur', () => setTimeout(closeList, 120));
}

// Wire every custom field's interactive control. Scalar fields (text/select)
// need no wiring — they're plain form controls read in applyCustomFields.
export function wireCustomFields(form: HTMLFormElement): void {
  for (const def of getCustomFields()) {
    if (def.type === 'multi-select') wireCfMultiSelect(form, def);
  }
}

// Write every custom field's current value into the item's metadata object,
// deleting the key when empty (so a cleared field doesn't linger).
export function applyCustomFields(form: HTMLFormElement, meta: Record<string, unknown>): void {
  for (const def of getCustomFields()) {
    const key = def.key;
    if (def.type === 'multi-select') {
      // Via writeListMeta so a stored empty array survives a read — see there.
      writeListMeta(meta, key, (state.formCustomMulti[key] ?? []).filter(Boolean));
    } else {
      const control = form.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[data-cf-control="${key}"]`,
      );
      const val = (control?.value ?? '').trim();
      if (val) meta[key] = val;
      else delete meta[key];
    }
  }
}

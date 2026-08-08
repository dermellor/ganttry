// Per-timeline custom fields in the item form. Definitions come from two places:
// the timeline itself (state.activeSourceFile.customFields, seeded backend-side)
// and the enabled plugins, which derive fields from the timeline's own data
// (kinds/registry.ts `pluginFieldDefs`). Values live per item in metadata[key].
// This module renders a form control per field, wires the multi-select chip
// editors, and reads the values back into metadata.
//
// Mirrors the tags chip editor (itemForm.ts) but with a *fixed* option set:
// multi-select suggestions are the field's declared options, not free-form.

import { escapeHtml } from './buildItems';
import { state } from './state';
import { scheduleLiveEdit } from './persistence';
import { mergeFieldDefs, pluginFieldDefs } from './pluginHost/registry';
import { type CustomFieldDef, type CustomFieldOption } from './types';

// metadata keys managed by their own dedicated form control (the reserved
// built-ins handled directly in itemForm) — used to keep them out of the
// free-form "Other metadata" JSON box. Custom-field keys are added on top.
const RESERVED_META_KEYS = new Set(['dependsOn', 'owner', 'jira', 'tags', 'tag']);

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

// HTML for the custom-fields section of the item form (empty string when the
// timeline declares none). Inserted into the form template by showItemForm.
//
// Fields that declare a `group` (every plugin-contributed one does, carrying its
// plugin's label) are collected into a titled section per group, in first-seen
// order, after the ungrouped fields. Without that, a plugin's fields sat flat
// among the timeline's own and nothing said they belonged together — or where
// they came from. The sections are plain markup inside the same <form>, so
// FormData, applyCustomFields and isManagedMetaKey are untouched by the grouping.
export function renderCustomFieldsHtml(meta: Record<string, unknown>): string {
  const defs = getCustomFields();
  if (!defs.length) return '';

  const ungrouped = defs.filter((d) => !d.group);
  const sections = new Map<string, CustomFieldDef[]>();
  for (const def of defs) {
    if (!def.group) continue;
    (sections.get(def.group) ?? sections.set(def.group, []).get(def.group)!).push(def);
  }

  const groupHtml = [...sections].map(
    ([title, fields]) =>
      // The fields live in their own grid inside the fieldset: a `display: grid`
      // fieldset renders its legend inconsistently across engines, so the legend
      // stays a normal flow child and the two-column layout moves one level in.
      `<fieldset class="cf-group">` +
      `<legend>${escapeHtml(title)}</legend>` +
      `<div class="cf-group-fields">${fields.map((def) => fieldHtml(def, meta)).join('')}</div>` +
      `</fieldset>`,
  );

  return ungrouped.map((def) => fieldHtml(def, meta)).join('') + groupHtml.join('');
}

// One field's control markup, identical whether it ends up flat or in a section.
// `def.width: 'full'` reuses the form's existing `.field.full` rule (span both
// grid columns), so a definition — a plugin's or the timeline's — controls its own
// width the same way the built-in fields do.
function fieldHtml(def: CustomFieldDef, meta: Record<string, unknown>): string {
  const key = escapeHtml(def.key);
  const label = escapeHtml(def.label || def.key);
  const wide = def.width === 'full' ? ' full' : '';
  if (def.type === 'multi-select') {
    return `
      <div class="field cf-field${wide}" data-cf-key="${key}">
        <label>${label}</label>
        <div class="chip-box">
          <div class="cf-chips" data-cf-chips="${key}"></div>
          <div class="cf-suggest">
            <input class="cf-input" data-cf-input="${key}" type="text" autocomplete="off" placeholder="Auswählen…" />
            <ul class="cf-suggest-list" data-cf-list="${key}" hidden></ul>
          </div>
        </div>
      </div>`;
  }
  if (def.type === 'select') {
    const cur = readFieldValues(meta, def.key)[0] ?? '';
    const opts = [`<option value=""${cur ? '' : ' selected'}>— —</option>`].concat(
      (def.options ?? []).map((o) => {
        const v = escapeHtml(o.value);
        const l = escapeHtml(o.label ?? o.value);
        return `<option value="${v}"${o.value === cur ? ' selected' : ''}>${l}</option>`;
      }),
    );
    return `
      <div class="field cf-field${wide}" data-cf-key="${key}">
        <label>${label}</label>
        <select data-cf-control="${key}">${opts.join('')}</select>
      </div>`;
  }
  // text
  const cur = escapeHtml(readFieldValues(meta, def.key)[0] ?? '');
  return `
      <div class="field cf-field${wide}" data-cf-key="${key}">
        <label>${label}</label>
        <input data-cf-control="${key}" type="text" value="${cur}" />
      </div>`;
}

// ---- multi-select chip editor (one per multi-select field) -----------------

function renderCfChips(form: HTMLFormElement, def: CustomFieldDef): void {
  const wrap = form.querySelector<HTMLElement>(`[data-cf-chips="${def.key}"]`);
  if (!wrap) return;
  const values = state.formCustomMulti[def.key] ?? [];
  wrap.innerHTML = values
    .map(
      (val, i) =>
        `<span class="cf-chip" style="--cf-color:${optionColor(def, val)}">` +
        `<span class="cf-chip-dot"></span>` +
        `<span class="cf-chip-label">${escapeHtml(optionLabel(def, val))}</span>` +
        `<button type="button" class="cf-chip-x" data-remove="${i}" aria-label="Entfernen">×</button>` +
        `</span>`,
    )
    .join('');
  wrap.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.remove);
      (state.formCustomMulti[def.key] ??= []).splice(idx, 1);
      renderCfChips(form, def);
      scheduleLiveEdit();
    });
  });
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

  const highlight = () => {
    list.querySelectorAll<HTMLLIElement>('.cf-suggest-item').forEach((li, i) => {
      li.classList.toggle('is-active', i === activeIndex);
    });
  };

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
    list.innerHTML = vals
      .map(
        (v, i) =>
          `<li class="cf-suggest-item" data-i="${i}" role="option">` +
          `<span class="cf-suggest-dot" style="background-color:${optionColor(def, v)}"></span>` +
          `<span class="cf-suggest-label">${escapeHtml(optionLabel(def, v))}</span>` +
          `</li>`,
      )
      .join('');
    list.querySelectorAll<HTMLLIElement>('.cf-suggest-item').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(Number(li.dataset.i));
      });
    });
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
      const arr = (state.formCustomMulti[key] ?? []).filter(Boolean);
      if (arr.length) meta[key] = [...arr];
      else delete meta[key];
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

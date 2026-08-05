// Per-timeline custom fields in the item form. Definitions come from the
// timeline (state.activeSourceFile.customFields, seeded backend-side); values
// live per item in metadata[key]. This module renders a form control per field,
// wires the multi-select chip editors, and reads the values back into metadata.
//
// Mirrors the tags chip editor (itemForm.ts) but with a *fixed* option set:
// multi-select suggestions are the field's declared options, not free-form.

import { escapeHtml } from './buildItems';
import { state } from './state';
import { scheduleLiveEdit } from './persistence';
import { PRODUCT_ROADMAP_PLUGIN, hasPlugin } from './plugins';
import {
  PRICING_FEATURE_META_KEY,
  PRICING_ITEM_VERSION_META_KEY,
  type CustomFieldDef,
  type CustomFieldOption,
} from './types';

// metadata keys managed by their own dedicated form control (the reserved
// built-ins handled directly in itemForm) — used to keep them out of the
// free-form "Other metadata" JSON box. Custom-field keys are added on top.
const RESERVED_META_KEYS = new Set(['dependsOn', 'owner', 'jira', 'tags', 'tag']);

const FALLBACK_COLOR = '#64748B';

// A product timeline exposes its pricing features as a synthetic multi-select
// field (key = metadata.featureIds). Routing it through the custom-field
// machinery gives the item form a feature picker, keeps the key out of the raw
// metadata box, and offers grouping-by-feature in the list view — all for free,
// without a parallel code path. It is NOT part of the stored `customFields` array
// (it's derived from `pricing`), so it never gets persisted back as a definition.
function pricingFieldDefs(): CustomFieldDef[] {
  const file = state.activeSourceFile;
  if (!file || !hasPlugin(file, PRODUCT_ROADMAP_PLUGIN)) return [];
  const defs: CustomFieldDef[] = [];
  const features = file.pricing?.features ?? [];
  if (features.length) {
    defs.push({
      key: PRICING_FEATURE_META_KEY,
      label: 'Features',
      type: 'multi-select',
      options: features.map((f) => ({ value: f.id, label: f.name })),
    });
  }
  // Which pricing version this item's work targets (drives the matrix's
  // version-dependent work indicator). Single-select from the declared versions.
  const versions = file.pricing?.versions ?? [];
  if (versions.length) {
    defs.push({
      key: PRICING_ITEM_VERSION_META_KEY,
      label: 'Version',
      type: 'select',
      options: versions.map((v) => ({ value: v })),
    });
  }
  return defs;
}

export function getCustomFields(): CustomFieldDef[] {
  const cfs = state.activeSourceFile?.customFields;
  const stored = Array.isArray(cfs) ? cfs.filter((f) => f && f.key && f.type) : [];
  return [...stored, ...pricingFieldDefs()];
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

// Read a stored value as string[] regardless of scalar/array shape, so a
// multi-select tolerates a legacy scalar and a select tolerates a stray array.
function readValues(meta: Record<string, unknown>, key: string): string[] {
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
    next[def.key] = readValues(meta, def.key);
  }
  state.formCustomMulti = next;
}

// HTML for the custom-fields section of the item form (empty string when the
// timeline declares none). Inserted into the form template by showItemForm.
export function renderCustomFieldsHtml(meta: Record<string, unknown>): string {
  const defs = getCustomFields();
  if (!defs.length) return '';
  return defs
    .map((def) => {
      const key = escapeHtml(def.key);
      const label = escapeHtml(def.label || def.key);
      if (def.type === 'multi-select') {
        return `
      <div class="field cf-field" data-cf-key="${key}">
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
        const cur = readValues(meta, def.key)[0] ?? '';
        const opts = [`<option value=""${cur ? '' : ' selected'}>— —</option>`].concat(
          (def.options ?? []).map((o) => {
            const v = escapeHtml(o.value);
            const l = escapeHtml(o.label ?? o.value);
            return `<option value="${v}"${o.value === cur ? ' selected' : ''}>${l}</option>`;
          }),
        );
        return `
      <div class="field cf-field" data-cf-key="${key}">
        <label>${label}</label>
        <select data-cf-control="${key}">${opts.join('')}</select>
      </div>`;
      }
      // text
      const cur = escapeHtml(readValues(meta, def.key)[0] ?? '');
      return `
      <div class="field cf-field" data-cf-key="${key}">
        <label>${label}</label>
        <input data-cf-control="${key}" type="text" value="${cur}" />
      </div>`;
    })
    .join('');
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

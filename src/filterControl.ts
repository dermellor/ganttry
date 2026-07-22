// The toolbar "Filter" control, sitting next to "Gruppieren" and sharing its
// vocabulary: an independent dimension dropdown (same categories as grouping —
// Gruppe / Tag / custom fields) plus a popover checklist of that dimension's
// values. Selected values narrow both the timeline and the list to items
// carrying one of them; an empty selection means "no restriction". The actual
// filtering lives in filterBuildForDisplay (render.ts) via passesFilter, so every
// consumer (timeline, list, export, status line) honours it from one place.

import { escapeHtml, type TimelineItem } from './buildItems';
import { state, els, FILTER_DIM_KEY, FILTER_VALUES_KEY } from './state';
import { filterDimensions, filterValueOptions } from './grouping';
import { applyFilter } from './render';

// Value options are drawn from the *unfiltered* build so narrowing the selection
// never shrinks the list of choices.
function currentEntries(): TimelineItem[] {
  return (state.activeBuild?.items ?? []).filter((it) => it.type !== 'background');
}

function persist(): void {
  localStorage.setItem(FILTER_DIM_KEY, state.filterDim);
  localStorage.setItem(FILTER_VALUES_KEY, JSON.stringify(state.filterValues));
}

function updateToggleLabel(total: number): void {
  const n = state.filterValues.length;
  els.filterToggle.textContent = n === 0 ? 'Alle Werte' : `${n} von ${total}`;
}

function closeMenu(): void {
  els.filterMenu.hidden = true;
  els.filterToggle.setAttribute('aria-expanded', 'false');
}

// Reflect the current build + persisted selection into the dropdown and popover.
// Rebuilds the value checklist only when the available values actually change
// (keyed by a signature), so an open menu and its checkbox state survive the
// per-edit refreshes that call this.
export function syncFilterControl(): void {
  const dimSel = els.filterDim;
  if (!dimSel) return;
  const entries = currentEntries();
  const dims = filterDimensions(entries);

  const dimHtml =
    `<option value="">Aus</option>` +
    dims.map((d) => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.label)}</option>`).join('');
  if (dimSel.dataset.built !== dimHtml) {
    dimSel.innerHTML = dimHtml;
    dimSel.dataset.built = dimHtml;
  }

  // A persisted dimension that no longer exists (build changed) turns the filter
  // off rather than silently filtering on a phantom dimension.
  if (state.filterDim && !dims.some((d) => d.key === state.filterDim)) {
    state.filterDim = '';
    state.filterValues = [];
    persist();
  }
  dimSel.value = state.filterDim;

  const groups = state.activeBuild?.groups ?? [];
  const values = state.filterDim ? filterValueOptions(entries, state.filterDim, groups) : [];

  // Drop selected values that are no longer present.
  const present = new Set(values.map((v) => v.value));
  const pruned = state.filterValues.filter((v) => present.has(v));
  if (pruned.length !== state.filterValues.length) {
    state.filterValues = pruned;
    persist();
  }

  const active = !!state.filterDim;
  els.filterToggle.hidden = !active;
  if (!active) {
    closeMenu();
    els.filterMenu.innerHTML = '';
    els.filterMenu.dataset.sig = '';
    return;
  }

  const sig = values.map((v) => `${v.value}␟${v.label}`).join('|');
  if (els.filterMenu.dataset.sig !== sig) {
    els.filterMenu.innerHTML = values
      .map((v) => {
        const checked = state.filterValues.includes(v.value) ? ' checked' : '';
        return `<label class="filter-opt"><input type="checkbox" value="${escapeHtml(v.value)}"${checked} /><span>${escapeHtml(v.label)}</span></label>`;
      })
      .join('');
    els.filterMenu.dataset.sig = sig;
  }
  updateToggleLabel(values.length);
}

let wired = false;

export function setupFilterControl(): void {
  if (wired) return;
  wired = true;

  // Pick the dimension to filter on. Switching dimensions clears the value
  // selection (values are dimension-specific).
  els.filterDim.addEventListener('change', () => {
    state.filterDim = els.filterDim.value;
    state.filterValues = [];
    persist();
    closeMenu();
    applyFilter(); // refresh → syncFilterControl rebuilds the value list
  });

  els.filterToggle.addEventListener('click', () => {
    const open = els.filterMenu.hidden;
    els.filterMenu.hidden = !open;
    els.filterToggle.setAttribute('aria-expanded', String(open));
  });

  // Toggle a value: recompute the selection from the checked boxes.
  els.filterMenu.addEventListener('change', (e) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    state.filterValues = [...els.filterMenu.querySelectorAll<HTMLInputElement>('input:checked')].map(
      (cb) => cb.value,
    );
    persist();
    updateToggleLabel(els.filterMenu.querySelectorAll('input').length);
    applyFilter();
  });

  // Close the popover on an outside click.
  document.addEventListener('click', (e) => {
    if (els.filterMenu.hidden) return;
    if (!els.filterControl.contains(e.target as Node)) closeMenu();
  });
}

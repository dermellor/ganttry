// The toolbar "Filter" control: one popover holding every dimension the active
// timeline offers (Gruppe / Tag / Status / custom fields), each with its values as
// checkboxes. Selected values narrow both the timeline and the list; a dimension
// with nothing selected restricts nothing.
//
// It used to be a dimension dropdown plus the values of that ONE dimension, which
// could not express „status Open and tier Free" — and „nur Meilensteine" existed as
// a separate checkbox in the header precisely because a second narrowing had
// nowhere to go. The dropdown is gone with that limit: choosing which dimension to
// edit is no longer a step, since all of them are in the panel.
//
// The rule itself lives in filterRule.ts (DOM-free, unit-tested) and the filtering
// runs in filterBuildForDisplay (render.ts), so every consumer (timeline, list,
// export, status line) honours it from one place.

import { type TimelineItem } from './buildItems';
import { Checkbox, MenuSection } from './design-system';
import { state, els, saveViewPrefs } from './state';
import { filterDimensions, filterValueOptions } from './grouping';
import { applyFilter } from './render';
import { filterValueCount, pruneFilters, withFilterValues } from './filterRule';

import { t } from './i18n';
// Value options are drawn from the *unfiltered* build so narrowing the selection
// never shrinks the list of choices.
function currentEntries(): TimelineItem[] {
  return (state.activeBuild?.items ?? []).filter((it) => it.type !== 'background');
}

// The selection belongs to the timeline it was made on, so it is written with the
// rest of that timeline's display state (see viewPrefs.ts).
function persist(): void {
  saveViewPrefs();
}

function updateToggleLabel(): void {
  const values = filterValueCount(state.filters);
  // The count of selected values, not „n von m" as before: with several dimensions
  // in the panel there is no single total to be „of". How the values are spread
  // across dimensions is what the panel itself shows.
  els.filterToggle.textContent =
    values === 0 ? t('filter.all') : t('filter.count', { count: values });
  // A narrowed filter is worth seeing without opening the panel, since it explains
  // a count in the status line that would otherwise look like missing data.
  els.filterToggle.dataset.active = values > 0 ? 'true' : 'false';
}

function closeMenu(): void {
  els.filterMenu.hidden = true;
  els.filterToggle.setAttribute('aria-expanded', 'false');
}

/**
 * Reflect the current build and the stored selection into the panel. Runs on every
 * repaint, so the panel's DOM is rebuilt only when the available dimensions or
 * values actually change (keyed by a signature): replacing it unconditionally
 * would close the panel under the pointer of anyone using it.
 */
export function syncFilterControl(): void {
  if (!els.filterMenu) return;
  const entries = currentEntries();
  const dims = filterDimensions(entries);
  const groups = state.activeBuild?.groups ?? [];
  const valuesByDim = new Map(
    dims.map((d) => [d.key, filterValueOptions(entries, d.key, groups)] as const),
  );

  // Drop what this timeline no longer has, per dimension: a custom field that was
  // removed takes its own selection with it and leaves the others in force.
  const pruned = pruneFilters(
    state.filters,
    dims.map((d) => d.key),
    (dim) => (valuesByDim.get(dim) ?? []).map((v) => v.value),
  );
  if (pruned !== state.filters) {
    state.filters = pruned;
    persist();
  }

  const sig = dims
    .map((d) => `${d.key}␟${d.label}␟${(valuesByDim.get(d.key) ?? []).map((v) => `${v.value}·${v.label}`).join('|')}`)
    .join('§');
  if (els.filterMenu.dataset.sig !== sig) {
    els.filterMenu.replaceChildren(
      ...dims.map((d) =>
        MenuSection({
          label: d.label,
          attrs: { 'data-dim': d.key },
          children: (valuesByDim.get(d.key) ?? []).map((v) =>
            Checkbox({
              value: v.value,
              label: v.label,
              checked: state.filters[d.key]?.includes(v.value) ?? false,
              className: 'ds-MenuItem',
            }),
          ),
        }),
      ),
    );
    els.filterMenu.dataset.sig = sig;
  } else {
    // Same options, possibly a different selection (a stored one just loaded, a
    // pruned value): re-check the boxes without touching the DOM structure.
    for (const box of els.filterMenu.querySelectorAll<HTMLInputElement>('input')) {
      const dim = box.closest<HTMLElement>('[data-dim]')?.dataset.dim;
      box.checked = !!dim && (state.filters[dim]?.includes(box.value) ?? false);
    }
  }

  // No dimension at all (a source without groups, tags, status or fields) leaves
  // nothing to filter on, so the control says so by disappearing rather than
  // opening an empty panel.
  const offerable = dims.length > 0;
  els.filterToggle.hidden = !offerable;
  if (!offerable) closeMenu();
  updateToggleLabel();
}

let wired = false;

export function setupFilterControl(): void {
  if (wired) return;
  wired = true;

  els.filterToggle.addEventListener('click', () => {
    const open = els.filterMenu.hidden;
    els.filterMenu.hidden = !open;
    els.filterToggle.setAttribute('aria-expanded', String(open));
  });

  // Toggle a value: recompute that dimension's selection from its own checked
  // boxes. Per dimension rather than over the whole panel, so one dimension's
  // values can never end up in another's list.
  els.filterMenu.addEventListener('change', (e) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    const section = e.target.closest<HTMLElement>('[data-dim]');
    const dim = section?.dataset.dim;
    if (!section || !dim) return;
    const checked = [...section.querySelectorAll<HTMLInputElement>('input:checked')].map(
      (cb) => cb.value,
    );
    state.filters = withFilterValues(state.filters, dim, checked);
    persist();
    updateToggleLabel();
    applyFilter();
  });

  // Close the popover on an outside click.
  document.addEventListener('click', (e) => {
    if (els.filterMenu.hidden) return;
    if (!els.filterControl.contains(e.target as Node)) closeMenu();
  });
}

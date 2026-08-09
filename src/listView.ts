// Alternative "Liste/Tabelle" rendering of the active build. Same data as the
// vis-timeline (state.activeBuild, respecting the milestones-only filter), but
// laid out as a grouped table instead of a horizontal timeline. Rows are
// clickable and route through the same detail/edit panel as the timeline
// (showDetailForId), so editing works identically in either mode.
//
// The grouping dimension is selectable (state.groupBy, shared with the timeline
// view via the toolbar dropdown): the item's own group (default), its tags, or
// any custom field the timeline defines (e.g. "Tier"). Multi-valued dimensions
// (tags, multi-select fields) let an
// item appear under every value it carries; items without a value fall into an
// "Ohne …" bucket. The sectioning itself is a pure, DOM-free function
// (computeSections in listGrouping.ts) so it can be unit-tested.

import { escapeHtml, tagPillsHtml, type TimelineItem } from './buildItems';
import { iconSpanHtml } from './icons';
import { addNewItem, filterBuildForDisplay, displayIdsFor, toggleItemChildren } from './render';
import { showDetailForId } from './detailPanel';
import { state, els, syncUrl, isEditableView } from './state';
import { computeSections, GROUP_DIM } from './listGrouping';
import { metaOf, resolveGrouping, sectionContext, syncGroupByControl } from './grouping';
import { syncFilterControl } from './filterControl';
import { parentGroupIds } from './groupHierarchy';
import { treeOrder } from './itemHierarchy';
import { ownerCellHtml } from './users';

const TYPE_LABELS: Record<TimelineItem['type'], string> = {
  point: 'Meilenstein',
  range: 'Zeitraum',
  box: 'Box',
  background: 'Hintergrund',
};

// "2026-01-15" / ISO → "15.01.2026". Falls back to the raw slice if it can't
// be parsed, so odd inputs still show something rather than "Invalid Date".
function formatDate(value?: string | null): string {
  if (!value) return '—';
  const iso = value.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function ownerOf(id: string): string {
  const owner = metaOf(id)?.owner;
  return typeof owner === 'string' ? owner : '';
}

// The fold slot in front of an entry, present on every row of a table that has a
// tree in it so the labels line up whether or not a row has children. The caret
// is a real `<button>`: the row itself is activatable too, and only a nested
// control keeps „open this entry" and „fold its children" apart for the keyboard.
function treeSlotHtml(item: TimelineItem, hasChildren: boolean): string {
  if (!hasChildren) return '<span class="list-tree"></span>';
  const collapsed = state.collapsedItems.has(item.id);
  const label = collapsed ? 'Untereinträge einblenden' : 'Untereinträge ausblenden';
  return (
    `<span class="list-tree"><button type="button" class="list-collapse${collapsed ? ' is-collapsed' : ''}"` +
    ` data-collapse="${escapeHtml(item.id)}" aria-expanded="${!collapsed}"` +
    ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></button></span>`
  );
}

function rowHtml(
  item: TimelineItem,
  selected: boolean,
  depth: number,
  hasChildren: boolean,
  hasTree: boolean,
): string {
  const label = `${tagPillsHtml(item.tags)}${iconSpanHtml(item.icon)}${item.content ?? ''}`;
  const owner = ownerOf(item.id);
  const indent = hasTree ? ` style="--depth:${depth}"` : '';
  const slot = hasTree ? treeSlotHtml(item, hasChildren) : '';
  return `<tr class="list-row${selected ? ' is-selected' : ''}${hasChildren ? ' is-summary' : ''}" data-id="${escapeHtml(item.id)}" tabindex="0" role="button">
    <td class="list-entry"${indent}>${slot}${label || '<span class="list-empty">—</span>'}</td>
    <td class="list-date">${formatDate(item.start)}</td>
    <td class="list-date">${item.type === 'point' ? '—' : formatDate(item.end)}</td>
    <td class="list-type">${TYPE_LABELS[item.type] ?? escapeHtml(item.type)}</td>
    <td class="list-status">${item.status ? escapeHtml(item.status) : '<span class="list-empty">—</span>'}</td>
    <td class="list-owner">${ownerCellHtml(owner)}</td>
  </tr>`;
}

// Real (non-background) items grouped by the active dimension, each section's
// items sorted by start ascending. Phase-tint background items are omitted.
export function renderListView(): void {
  const build = state.activeBuild;
  if (!build) {
    els.listBody.innerHTML = '';
    return;
  }
  const { items, groups } = filterBuildForDisplay(build);
  const entries = items
    .filter((it) => it.type !== 'background')
    // Sort by start ascending; date-less items (no start yet) sink to the end.
    .sort((a, b) => {
      if (!a.start && !b.start) return 0;
      if (!a.start) return 1;
      if (!b.start) return -1;
      return a.start.localeCompare(b.start);
    });

  const { dim, options } = resolveGrouping(entries);
  state.groupBy = dim;
  syncGroupByControl(options, dim);
  syncFilterControl();

  const { sections, grouped } = computeSections(entries, dim, options, sectionContext(groups));

  const sel = state.selectedItemId;
  // The per-section "+ Eintrag" button only makes sense in the group dimension:
  // it pins the new item to that group. Tag/custom-field sections aren't a
  // group, so they get no add button (the global toolbar "+ Eintrag" stays).
  const editable = isEditableView();
  const showAdd = editable && dim === GROUP_DIM;
  // Parent groups (with nestedGroups) are containers only — no "+ Eintrag" that
  // would pin a new item to a parent.
  const parents = parentGroupIds(groups);

  // Parent/child inside a section: children follow their parent, one indent step
  // per level. A section can hold a child whose parent fell outside it (a tag
  // section, say) — treeOrder leaves that one at the top level rather than
  // dropping it, so nothing disappears from a view it belongs in.
  const itemParents = state.activeBuild?.parents ?? new Map<string, string>();
  const hasChildren = new Set(itemParents.values());

  const body = sections
    .map((s) => {
      const ordered = treeOrder(s.items, itemParents);
      const hasTree = ordered.some((e) => e.depth > 0 || hasChildren.has(e.item.id));
      const rows = ordered
        .map((e) => rowHtml(e.item, e.item.id === sel, e.depth, hasChildren.has(e.item.id), hasTree))
        .join('');
      const addBtn =
        showAdd && !s.empty && !parents.has(s.id)
          ? `<button type="button" class="list-add-item" data-add-group="${escapeHtml(s.id)}">+ Eintrag</button>`
          : '';
      const header = grouped
        ? `<tr class="list-group-row"><th colspan="6" scope="colgroup"><span class="list-group-title">${escapeHtml(s.label)}</span>${addBtn}</th></tr>`
        : '';
      return header + rows;
    })
    .join('');

  els.listBody.innerHTML = entries.length
    ? `<table class="list-table">
        <thead>
          <tr>
            <th scope="col">Eintrag</th>
            <th scope="col">Start</th>
            <th scope="col">Ende</th>
            <th scope="col">Typ</th>
            <th scope="col">Status</th>
            <th scope="col">Owner</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`
    : '<p class="list-empty-msg">Keine Einträge in dieser View.</p>';
}

let wired = false;

// Delegated click/keyboard handling: rows are re-rendered on every data change,
// so we bind once to the stable container and read the id off the target row.
export function setupListView(): void {
  if (wired) return;
  wired = true;
  const activate = (target: EventTarget | null) => {
    // Per-group "+ Eintrag" button: add an item pinned to that group, then let
    // addNewItem select it and open its form. Handled before row activation.
    const addBtn = (target as HTMLElement | null)?.closest<HTMLElement>('.list-add-item');
    if (addBtn) {
      addNewItem(addBtn.dataset.addGroup ?? null);
      return;
    }
    // The fold caret sits inside a row, so it has to be handled before the row
    // activation below — otherwise folding would also open the entry's form.
    const caret = (target as HTMLElement | null)?.closest<HTMLElement>('.list-collapse');
    if (caret?.dataset.collapse) {
      toggleItemChildren(caret.dataset.collapse);
      return;
    }
    const row = (target as HTMLElement | null)?.closest<HTMLElement>('.list-row');
    const id = row?.dataset.id;
    if (!id) return;
    // Mirror the timeline's select behaviour: track the selection (so the URL
    // and the row highlight follow) and keep the hidden timeline in sync, then
    // open the same detail/edit panel.
    state.selectedItemId = id;
    try {
      state.timeline?.setSelection(displayIdsFor(id));
    } catch {
      /* item may be filtered out of the current view */
    }
    renderListView();
    syncUrl();
    showDetailForId(id);
  };
  els.list.addEventListener('click', (e) => activate(e.target));
  els.list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(e.target);
    }
  });
}

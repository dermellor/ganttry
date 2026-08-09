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

import { tagColor, type TimelineItem } from './buildItems';
import {
  Button,
  el,
  Icon,
  Table,
  TableCell,
  TableGroupRow,
  TableHead,
  TableRow,
  Tag,
  Text,
} from './design-system';
import { addNewItem, filterBuildForDisplay, displayIdsFor } from './render';
import { showDetailForId } from './detailPanel';
import { state, els, syncUrl, isEditableView } from './state';
import { computeSections, GROUP_DIM } from './listGrouping';
import { metaOf, resolveGrouping, sectionContext, syncGroupByControl } from './grouping';
import { syncFilterControl } from './filterControl';
import { parentGroupIds } from './groupHierarchy';
import { ownerCell } from './users';

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

const EMPTY = () => Text({ text: '—', tone: 'muted' });

function row(item: TimelineItem, selected: boolean): HTMLElement {
  const marks = [
    ...(item.tags ?? []).map((tag) => Tag({ label: tag, color: tagColor(tag) })),
    item.icon ? Icon({ name: String(item.icon) }) : null,
  ].filter(Boolean) as Element[];
  // `label`, not `content`: the latter is escaped markup for vis-timeline, and
  // setting it as a text node shows the entities.
  const content = item.label ?? '';

  return TableRow({
    interactive: true,
    selected,
    attrs: { 'data-id': item.id, role: 'button' },
    children: [
      TableCell({ primary: true, children: marks.length || content ? [marks, content] : EMPTY() }),
      TableCell({ nowrap: true, muted: true, children: formatDate(item.start) }),
      TableCell({ nowrap: true, muted: true, children: item.type === 'point' ? '—' : formatDate(item.end) }),
      TableCell({ nowrap: true, muted: true, children: TYPE_LABELS[item.type] ?? item.type }),
      TableCell({ nowrap: true, muted: true, children: item.status ? item.status : EMPTY() }),
      TableCell({ nowrap: true, muted: true, children: ownerCell(ownerOf(item.id)) }),
    ],
  });
}

const COLUMNS = ['Eintrag', 'Start', 'Ende', 'Typ', 'Status', 'Owner'];

// Real (non-background) items grouped by the active dimension, each section's
// items sorted by start ascending. Phase-tint background items are omitted.
export function renderListView(): void {
  const build = state.activeBuild;
  if (!build) {
    els.listBody.replaceChildren();
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

  if (!entries.length) {
    els.listBody.replaceChildren(
      Text({ as: 'p', text: 'Keine Einträge in dieser View.', tone: 'muted' }),
    );
    return;
  }

  const body = sections.flatMap((s) => [
    grouped
      ? TableGroupRow({
          title: s.label,
          colspan: COLUMNS.length,
          action:
            showAdd && !s.empty && !parents.has(s.id)
              ? Button({
                  label: '+ Eintrag',
                  variant: 'outline',
                  size: 'sm',
                  reveal: true,
                  className: 'list-add-item',
                  attrs: { 'data-add-group': s.id },
                })
              : undefined,
        })
      : null,
    ...s.items.map((it) => row(it, it.id === sel)),
  ]);

  els.listBody.replaceChildren(
    Table({ children: [TableHead({ columns: COLUMNS }), el('tbody', {}, body)] }),
  );
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
    const row = (target as HTMLElement | null)?.closest<HTMLElement>('.ds-TableRow');
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

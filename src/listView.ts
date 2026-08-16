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
  TreeToggle,
} from './design-system';
import { addNewItem, filterBuildForDisplay, displayIdsFor, toggleItemChildren } from './render';
import { showDetailForId } from './detailPanel';
import { state, els, syncUrl, isEditableView } from './state';
import { computeSections, GROUP_DIM } from './listGrouping';
import { metaOf, resolveGrouping, sectionContext, syncGroupByControl } from './grouping';
import { syncFilterControl } from './filterControl';
import { syncEdgeControl } from './edgeControl';
import { syncSavedViewsControl } from './savedViewsControl';
import { parentGroupIds } from './groupHierarchy';
import { treeOrder } from './itemHierarchy';
import { ownerCell } from './users';
import { itemTypeLabel } from './itemType';
import { t } from './i18n';


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

function row(
  item: TimelineItem,
  selected: boolean,
  depth: number,
  hasChildren: boolean,
  hasTree: boolean,
): HTMLElement {
  const marks = [
    ...(item.tags ?? []).map((tag) => Tag({ label: tag, color: tagColor(tag) })),
    item.icon ? Icon({ name: String(item.icon) }) : null,
  ].filter(Boolean) as Element[];
  // `label`, not `content`: the latter is escaped markup for vis-timeline, and
  // setting it as a text node shows the entities.
  const content = item.label ?? '';
  const collapsed = state.collapsedItems.has(item.id);

  return TableRow({
    interactive: true,
    selected,
    summary: hasChildren,
    attrs: { 'data-id': item.id, role: 'button' },
    children: [
      TableCell({
        primary: true,
        depth: hasTree ? depth : undefined,
        children: [
          // The slot sits on every row of a table that has a tree in it, so the
          // labels line up whether or not a row has children.
          hasTree
            ? TreeToggle({
                expanded: hasChildren ? !collapsed : undefined,
                label: collapsed ? t('item.children.show') : t('item.children.hide'),
                attrs: hasChildren ? { 'data-collapse': item.id } : undefined,
              })
            : null,
          marks.length || content ? [marks, content] : EMPTY(),
        ],
      }),
      TableCell({ nowrap: true, muted: true, children: formatDate(item.start) }),
      TableCell({ nowrap: true, muted: true, children: item.type === 'point' ? '—' : formatDate(item.end) }),
      TableCell({ nowrap: true, muted: true, children: itemTypeLabel(item.type) }),
      TableCell({ nowrap: true, muted: true, children: item.status ? item.status : EMPTY() }),
      TableCell({ nowrap: true, muted: true, children: ownerCell(ownerOf(item.id)) }),
    ],
  });
}

// A function, not a constant: a `const` here is filled on import, before the
// reader's language is resolved, and the header row would stay in whichever
// language the page booted in — see „Never call `t()` at module scope"
// (src/i18n/index.ts).
function columns(): string[] {
  return [
    t('list.column.entry'),
    t('list.column.start'),
    t('list.column.end'),
    t('list.column.type'),
    t('list.column.status'),
    t('list.column.owner'),
  ];
}

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

  // The resolved dimension is deliberately NOT written back to state.groupBy:
  // that field is the user's choice, and it is now stored per timeline. A
  // dimension that is momentarily unavailable (the active filter left no tagged
  // item) would otherwise be flattened to 'group' and saved, so clearing the
  // filter would not bring the grouping back. resolveGrouping derives the
  // fallback on every render, which is where it belongs.
  const { dim, options } = resolveGrouping(entries);
  syncGroupByControl(options, dim);
  syncFilterControl();
  syncEdgeControl();
  // Every repaint, so the trigger's asterisk follows a grouping or filter change
  // made in the two controls beside it. Cheap: the panel is a list of commands
  // rebuilt from state, not something anybody is mid-way through ticking.
  syncSavedViewsControl();

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
      Text({ as: 'p', text: t('view.empty'), tone: 'muted' }),
    );
    return;
  }

  // Parent/child inside a section: children follow their parent, one indent step
  // per level. A section can hold a child whose parent fell outside it (a tag
  // section, say) — treeOrder leaves that one at the top level rather than
  // dropping it, so nothing disappears from a view it belongs in.
  const itemParents = state.activeBuild?.parents ?? new Map<string, string>();
  const hasChildren = new Set(itemParents.values());

  const cols = columns();
  const body = sections.flatMap((s) => {
    const ordered = treeOrder(s.items, itemParents);
    const hasTree = ordered.some((e) => e.depth > 0 || hasChildren.has(e.item.id));
    return [
      grouped
        ? TableGroupRow({
            title: s.label,
            colspan: cols.length,
            action:
              showAdd && !s.empty && !parents.has(s.id)
                ? Button({
                    label: t('item.create'),
                    variant: 'outline',
                    size: 'sm',
                    reveal: true,
                    className: 'list-add-item',
                    attrs: { 'data-add-group': s.id },
                  })
                : undefined,
          })
        : null,
      ...ordered.map((e) =>
        row(e.item, e.item.id === sel, e.depth, hasChildren.has(e.item.id), hasTree),
      ),
    ];
  });

  els.listBody.replaceChildren(
    Table({ children: [TableHead({ columns: cols }), el('tbody', {}, body)] }),
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
    // The fold caret sits inside a row, so it has to be handled before the row
    // activation below — otherwise folding would also open the entry's form.
    const caret = (target as HTMLElement | null)?.closest<HTMLElement>('.ds-TreeToggle');
    if (caret?.dataset.collapse) {
      toggleItemChildren(caret.dataset.collapse);
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

// Alternative "Liste/Tabelle" rendering of the active build. Same data as the
// vis-timeline (state.activeBuild, respecting the milestones-only filter), but
// laid out as a grouped table instead of a horizontal timeline. Rows are
// clickable and route through the same detail/edit panel as the timeline
// (showDetailForId), so editing works identically in either mode.

import { escapeHtml, tagPillsHtml, type TimelineItem } from './buildItems';
import { iconSpanHtml } from './icons';
import { filterBuildForDisplay } from './render';
import { showDetailForId } from './detailPanel';
import { state, els, syncUrl } from './state';

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
  const fm = state.activeBuild?.details.get(id)?.frontmatter as
    | Record<string, unknown>
    | undefined;
  const owner = fm?.owner;
  return typeof owner === 'string' ? owner : '';
}

function rowHtml(item: TimelineItem, selected: boolean): string {
  const label = `${tagPillsHtml(item.tags)}${iconSpanHtml(item.icon)}${item.content ?? ''}`;
  const owner = ownerOf(item.id);
  return `<tr class="list-row${selected ? ' is-selected' : ''}" data-id="${escapeHtml(item.id)}" tabindex="0" role="button">
    <td class="list-entry">${label || '<span class="list-empty">—</span>'}</td>
    <td class="list-date">${formatDate(item.start)}</td>
    <td class="list-date">${item.type === 'point' ? '—' : formatDate(item.end)}</td>
    <td class="list-type">${TYPE_LABELS[item.type] ?? escapeHtml(item.type)}</td>
    <td class="list-owner">${owner ? escapeHtml(owner) : '<span class="list-empty">—</span>'}</td>
  </tr>`;
}

// Real (non-background) items grouped by their group id, in group order, each
// group's items sorted by start ascending. Phase-tint background items and
// items in unknown groups are handled explicitly.
export function renderListView(): void {
  const build = state.activeBuild;
  if (!build) {
    els.list.innerHTML = '';
    return;
  }
  const { items, groups } = filterBuildForDisplay(build);
  const entries = items.filter((it) => it.type !== 'background');

  const byGroup = new Map<string, TimelineItem[]>();
  const NO_GROUP = ' __nogroup';
  for (const it of entries) {
    const key = it.group && groups.some((g) => g.id === it.group) ? it.group : NO_GROUP;
    (byGroup.get(key) ?? byGroup.set(key, []).get(key)!).push(it);
  }

  const order: { id: string; label: string }[] = groups.map((g) => ({
    id: g.id,
    label: g.content || g.id,
  }));
  if (byGroup.has(NO_GROUP)) order.push({ id: NO_GROUP, label: 'Ohne Gruppe' });

  const sel = state.selectedItemId;
  const grouped = order.length > 1 || (order.length === 1 && order[0].id !== NO_GROUP);

  const sections = order
    .filter((g) => byGroup.has(g.id))
    .map((g) => {
      const rows = byGroup
        .get(g.id)!
        .slice()
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((it) => rowHtml(it, it.id === sel))
        .join('');
      const header = grouped
        ? `<tr class="list-group-row"><th colspan="5" scope="colgroup">${escapeHtml(g.label)}</th></tr>`
        : '';
      return header + rows;
    })
    .join('');

  els.list.innerHTML = entries.length
    ? `<table class="list-table">
        <thead>
          <tr>
            <th scope="col">Eintrag</th>
            <th scope="col">Start</th>
            <th scope="col">Ende</th>
            <th scope="col">Typ</th>
            <th scope="col">Owner</th>
          </tr>
        </thead>
        <tbody>${sections}</tbody>
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
    const row = (target as HTMLElement | null)?.closest<HTMLElement>('.list-row');
    const id = row?.dataset.id;
    if (!id) return;
    // Mirror the timeline's select behaviour: track the selection (so the URL
    // and the row highlight follow) and keep the hidden timeline in sync, then
    // open the same detail/edit panel.
    state.selectedItemId = id;
    try {
      state.timeline?.setSelection([id]);
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

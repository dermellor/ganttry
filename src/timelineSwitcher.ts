// The timeline switcher: which timeline is open, and how to get to another one.
//
// It replaces a flat `<select>` over every discovered source — database timelines,
// JSON files and note directories in one unsorted list, with no origin and no
// search. A `<select>` cannot be searched or grouped, so on an instance with a few
// dozen timelines it was the first thing to break.
//
// The trigger carries the open timeline's name, which is also what makes this level
// visible at all (see „Where every control belongs" in
// docs/information-architecture.md): the header now says which document you are in
// rather than offering a control to change it.
//
// Matching, grouping and keyboard movement live in
// [`src/switcherRows.ts`](./switcherRows.ts), DOM-free and unit-tested. This module
// is the popover around them.

import {
  Button,
  SuggestItem,
  SuggestList,
  Text,
  TextInput,
  el,
} from './design-system';
import { els } from './state';
import {
  flattenRows,
  nextRowIndex,
  switcherGroups,
  type SwitcherRow,
} from './switcherRows';
import type { View } from './types';

let views: readonly View[] = [];
let activeId: string | null = null;
let onPick: (viewId: string) => void = () => {};
let cursor = -1;
let rows: SwitcherRow[] = [];

function isOpen(): boolean {
  return !els.switcherList.hidden;
}

function label(view: View | undefined): string {
  return view?.name || activeId || 'Timeline';
}

/** Reflect the current selection on the trigger. */
function renderTrigger(): void {
  const view = views.find((v) => v.id === activeId);
  els.switcherBtn.textContent = label(view);
  // The trigger used to have „TIMELINE" written beside it, which was the only place
  // the interface said what kind of thing this name is. That caption is gone (a
  // document name needs no label in front of it), so the word moves into the
  // accessible name — set here, where the visible name is set, because two writers
  // on one attribute is how the two drift apart.
  els.switcherBtn.setAttribute('aria-label', `Timeline: ${label(view)}`);
  // The id in the tooltip, because two timelines may carry the same name and the id
  // is what a link and the API speak.
  els.switcherBtn.title = view ? `${view.name} · ${view.id}` : '';
}

function renderList(): void {
  const groups = switcherGroups(views, els.switcherSearch.value, activeId);
  rows = flattenRows(groups);
  if (cursor >= rows.length) cursor = rows.length - 1;

  els.switcherList.replaceChildren(
    ...groups.flatMap((group) => [
      // A group heading is not an option: `role="presentation"` keeps it out of the
      // listbox's own children, or a screen reader counts it as a timeline.
      el('li', { class: 'switcher-group', role: 'presentation' }, group.label),
      ...group.rows.map((row) => {
        const index = rows.indexOf(row);
        return SuggestItem({
          label: row.view.name,
          detail: row.active ? 'geöffnet' : undefined,
          active: index === cursor,
          attrs: { 'data-view-id': row.view.id, id: `switcher-row-${index}` },
          on: { click: () => pick(row.view.id) },
        });
      }),
    ]),
    ...(rows.length
      ? []
      : [
          el('li', { class: 'switcher-empty', role: 'presentation' }, [
            Text({ text: 'Keine Timeline passt dazu.', tone: 'muted', size: 'xs' }),
          ]),
        ]),
  );
  els.switcherSearch.setAttribute(
    'aria-activedescendant',
    cursor >= 0 && rows[cursor] ? `switcher-row-${cursor}` : '',
  );
}

function open(): void {
  els.switcherList.hidden = false;
  els.switcherSearchWrap.hidden = false;
  els.switcherBtn.setAttribute('aria-expanded', 'true');
  els.switcherSearch.value = '';
  // The open timeline starts under the cursor, so Enter without typing is a no-op
  // rather than a jump to whatever happens to be first.
  renderList();
  cursor = rows.findIndex((r) => r.active);
  renderList();
  els.switcherSearch.focus();
}

function close(): void {
  els.switcherList.hidden = true;
  els.switcherSearchWrap.hidden = true;
  els.switcherBtn.setAttribute('aria-expanded', 'false');
  cursor = -1;
}

function pick(viewId: string): void {
  close();
  els.switcherBtn.focus();
  if (viewId === activeId) return;
  onPick(viewId);
}

/** The timelines to offer. Called once the built config is in. */
export function setSwitcherViews(next: readonly View[]): void {
  views = next;
  renderTrigger();
}

/** Which one is open, and under which name (the live one, see timelineMeta.ts). */
export function setSwitcherActive(viewId: string, name?: string): void {
  activeId = viewId;
  if (name) {
    // The open timeline's own source may carry a newer name than the build did, so
    // the caller can hand it over rather than this module reading two sources.
    views = views.map((v) => (v.id === viewId ? { ...v, name } : v));
  }
  renderTrigger();
}

export function wireTimelineSwitcher(pickView: (viewId: string) => void): void {
  onPick = pickView;

  els.switcherBtn.addEventListener('click', () => (isOpen() ? close() : open()));
  els.switcherSearch.addEventListener('input', () => {
    cursor = 0;
    renderList();
  });

  els.switcherSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = nextRowIndex(rows.length, cursor, e.key === 'ArrowDown' ? 1 : -1);
      renderList();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row) pick(row.view.id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      els.switcherBtn.focus();
    }
  });

  // Dismissal on an outside pointerdown, like every other popover here.
  document.addEventListener('pointerdown', (e) => {
    if (!isOpen()) return;
    if (!els.switcherControl.contains(e.target as Node)) close();
  });
}

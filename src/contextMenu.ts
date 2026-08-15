// Right-click menu on a timeline item: the quick actions worth having without
// opening the detail form — set the status, set the fields that opted in,
// duplicate the item, delete it.
//
// The trigger is vis-timeline's own `contextmenu` event, which hands us
// `getEventProperties()`: the display id under the cursor plus the raw event. So
// this needs no DOM walking of its own — unlike itemRail.ts, which delegates a
// click listener because a *mark* is not a vis concept and vis can't resolve it.
// An item is one, including a right-click that lands on the rail's own mark.
// vis does not suppress the browser menu itself (its `oncontextmenu` only
// emits), so we preventDefault — but only once we know the click has an item we
// can act on. A right-click on empty space, an axis, or a read-only view keeps
// the browser's own menu rather than replacing it with nothing.
//
// **Value pickers are submenus, not flat rows.** Status alone was three rows; add
// one opted-in field and the root menu becomes a wall of values in which
// „Löschen" is just another line. A submenu per field keeps the root a list of
// *nouns* (Status, Tier, …) plus the two verbs, so it stays the same size however
// many fields opt in.
//
// The menu is built per open, not once and reused: which rows carry
// `aria-checked` is a property of the item that was right-clicked.

import { contextMenuFields, fieldOptionColor, readFieldValues } from './customFields';
import { Dot, el, fromHtml, Menu, MenuItem, MenuSection, Popover, StatusDot } from './design-system';
import { findItemIndex } from './editor';
import { realIdOf } from './grouping';
import { menuPosition, submenuPosition } from './menuPosition';
import { state, isEditableView } from './state';
import { ITEM_STATUSES, statusOrDefault, type StatusKey } from './status';
import type { TimelineFileItem } from './types';
import { t } from './i18n';

// What the menu can do. Passed in from render.ts rather than imported here, the
// same way the rail takes its `deleteItem` — the mutations live next to their
// peers (`setItemStatus` / `setItemFieldValue` / `deleteItem` in itemForm.ts,
// `duplicateItem` beside `createItem` in render.ts), and this module stays about
// menu mechanics.
export type ItemMenuActions = {
  setStatus: (id: string, status: StatusKey) => void;
  // Returns the values the item carries afterwards, so a multi-select row can
  // re-mark itself without this module reading the model.
  setField: (id: string, key: string, value: string, multi: boolean) => string[];
  duplicate: (id: string) => void;
  remove: (id: string) => void;
};

// Distance kept from the viewport edge when a panel is flipped/clamped.
const EDGE_PAD = 8;
// How far a submenu covers its parent, so the two read as one connected surface.
const SUB_OVERLAP = 4;
// The panel's own top padding — subtracted so a submenu's first row lines up with
// the parent row it belongs to, rather than sitting a few pixels below it.
const PANEL_PAD = 5;

const ITEM_SELECTOR = '.ds-MenuItem';
// Root-level rows only: submenu rows are the same component, and keyboard
// navigation has to treat the two levels separately.
const ROOT_ITEM_SELECTOR = ':scope > .ds-MenuSection > .ds-MenuItem';

// Glyphs in the same style as the form's pickers (stroke, currentColor) so a menu
// row and a picker row read as the same family.
function glyph(body: string): () => Element {
  return () =>
    fromHtml(
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"' +
        ` stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`,
    );
}

const GLYPH_DUPLICATE = glyph(
  '<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />',
);
const GLYPH_DELETE = glyph(
  '<path d="M4 7h16M9 7V4.5h6V7M6 7l.9 12.1A1.5 1.5 0 0 0 8.4 20.5h7.2a1.5 1.5 0 0 0 1.5-1.4L18 7M10.5 11v5.5M13.5 11v5.5" />',
);

// A mark is a factory rather than a node: the current value's mark appears on the
// root row and again in the panel, and one element cannot have two parents.
type Mark = () => Element;

type ValueRow = { value: string; label: string; mark: Mark; checked: boolean };
type Submenu = {
  id: string; // ties the root row to its panel
  label: string;
  mark?: Mark; // the root row's mark: the current value, when there is exactly one
  multi: boolean; // toggle semantics, and the panel stays open between picks
  action: 'status' | 'field';
  key?: string; // metadata key, for action === 'field'
  rows: ValueRow[];
};

let handlers: ItemMenuActions | null = null;
// The open menu, the item it acts on, and what had focus before it opened.
let menuEl: HTMLElement | null = null;
let menuItemId: string | null = null;
let restoreFocus: HTMLElement | null = null;
// The currently expanded submenu, if any.
let openSub: { row: HTMLElement; panel: HTMLElement } | null = null;

/**
 * Hook a freshly created timeline instance up to the context menu. Called per
 * render (each render builds a new Timeline), so only instance-scoped listeners
 * are registered here — the document-level ones live for as long as the menu is
 * open and are removed with it.
 */
export function attachItemContextMenu(
  timeline: { on: (event: string, cb: (props: any) => void) => void },
  actions: ItemMenuActions,
): void {
  handlers = actions;
  timeline.on('contextmenu', handleContextMenu);
  // Panning or zooming moves the bar out from under a menu anchored to viewport
  // coordinates, so the menu would end up pointing at a different item.
  timeline.on('rangechange', closeMenu);
}

function handleContextMenu(props: { event: MouseEvent; item: string | number | null }): void {
  closeMenu();
  if (props.item == null || !isEditableView()) return;
  const file = state.activeSourceFile;
  if (!file) return;
  // A clone in a regrouped view maps back to the real item; a build-only item
  // (a phase tint has no row in the source file) is not ours to act on.
  const id = realIdOf(String(props.item));
  if (findItemIndex(file, id) === -1) return;
  props.event.preventDefault();
  openMenu(props.event.clientX, props.event.clientY, id);
}

// Status first — it is universal and always present — then every field that opted
// in, in definition order.
function submenusFor(item: TimelineFileItem): Submenu[] {
  const status = statusOrDefault(item.status);
  const out: Submenu[] = [
    {
      id: 'status',
      label: 'Status',
      mark: () => StatusDot({ status }),
      multi: false,
      action: 'status',
      rows: ITEM_STATUSES.map(({ key, label }) => ({
        value: key,
        label,
        mark: () => StatusDot({ status: key }),
        checked: key === status,
      })),
    },
  ];

  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  for (const def of contextMenuFields()) {
    const current = readFieldValues(meta, def.key);
    const multi = def.type === 'multi-select';
    const rows: ValueRow[] = (def.options ?? []).map((o) => ({
      value: o.value,
      label: o.label ?? o.value,
      mark: () => Dot({ color: fieldOptionColor(def, o.value), size: 'sm' }),
      checked: current.includes(o.value),
    }));
    // A single-select needs a way back to "unset" — the same empty choice its
    // <select> carries in the form. A multi-select clears by untoggling.
    if (!multi) {
      rows.unshift({
        value: '',
        label: t('form.noValue'),
        mark: () => el('span', {}, '—'),
        checked: current.length === 0,
      });
    }
    const rootValue = !multi ? current[0] : undefined;
    out.push({
      id: `f:${def.key}`,
      label: def.label || def.key,
      // Only a single-valued field can show "the" current value on its root row.
      mark: rootValue ? () => Dot({ color: fieldOptionColor(def, rootValue), size: 'sm' }) : undefined,
      multi,
      action: 'field',
      key: def.key,
      rows,
    });
  }
  return out;
}

function rootRow(sub: Submenu): HTMLElement {
  return MenuItem({
    label: sub.label,
    mark: sub.mark?.(),
    parent: true,
    attrs: { role: 'menuitem', 'data-sub': sub.id },
  });
}

function panel(sub: Submenu): HTMLElement {
  // menuitemradio for a single choice, menuitemcheckbox for a toggle — the role
  // is what tells a screen reader whether picking replaces or adds.
  const role = sub.multi ? 'menuitemcheckbox' : 'menuitemradio';
  return Popover({
    placement: 'fixed',
    layer: 'menu',
    hidden: true,
    role: 'menu',
    ariaLabel: sub.label,
    minWidth: 150,
    attrs: { 'data-sub-panel': sub.id },
    children: sub.rows.map((r) =>
      MenuItem({
        label: r.label,
        mark: r.mark(),
        none: r.value === '',
        attrs: {
          role,
          'aria-checked': String(r.checked),
          'data-action': sub.action,
          ...(sub.key ? { 'data-key': sub.key } : {}),
          'data-multi': String(sub.multi),
          'data-value': r.value,
        },
      }),
    ),
  });
}

function menuChildren(subs: Submenu[]): Element[] {
  return [
    MenuSection({ children: subs.map(rootRow) }),
    MenuSection({
      children: [
        MenuItem({
          label: 'Duplizieren',
          mark: GLYPH_DUPLICATE(),
          attrs: { role: 'menuitem', 'data-action': 'duplicate' },
        }),
        MenuItem({
          label: t('form.delete'),
          mark: GLYPH_DELETE(),
          danger: true,
          attrs: { role: 'menuitem', 'data-action': 'delete' },
        }),
      ],
    }),
    // Panels come after the sections and are positioned as fixed overlays, so
    // they take no part in the root menu's flow.
    ...subs.map(panel),
  ];
}

function openMenu(clientX: number, clientY: number, id: string): void {
  const file = state.activeSourceFile;
  if (!file) return;
  const item = file.items[findItemIndex(file, id)];
  if (!item) return;

  const menu = Menu({
    placement: 'fixed',
    layer: 'menu',
    ariaLabel: `Aktionen: ${item.content ?? 'Eintrag'}`,
    minWidth: 170,
    children: menuChildren(submenusFor(item)),
  });
  document.body.appendChild(menu);

  menuEl = menu;
  menuItemId = id;
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Measured after mounting (the size depends on the rendered labels), then
  // clamped/flipped by menuPosition — see there for the edge cases.
  const { width, height } = menu.getBoundingClientRect();
  const { x, y } = menuPosition(
    { x: clientX, y: clientY },
    { width, height },
    { width: window.innerWidth, height: window.innerHeight },
    EDGE_PAD,
  );
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  menu.addEventListener('click', handleMenuClick);
  menu.addEventListener('keydown', handleMenuKeydown);
  // Hovering a row is the expected way to open its submenu, and to dismiss a
  // sibling's — delegated, so it covers rows in both levels.
  menu.addEventListener('mouseover', handleMenuHover);
  // On the document so a dismissal is caught wherever the pointer lands, and in
  // the capture phase so the click that dismisses doesn't also act on whatever
  // is underneath. Escape is document-level too, in case focus escaped the menu.
  document.addEventListener('pointerdown', handleDocPointerDown, true);
  document.addEventListener('keydown', handleDocKeydown, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('wheel', closeMenu, { passive: true });

  focusItem(rootItems(), 0);
}

export function closeMenu(): void {
  if (!menuEl) return;
  openSub = null;
  menuEl.remove();
  menuEl = null;
  menuItemId = null;
  document.removeEventListener('pointerdown', handleDocPointerDown, true);
  document.removeEventListener('keydown', handleDocKeydown, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('wheel', closeMenu);
  // Hand focus back where it came from, so dismissing with Escape doesn't strand
  // a keyboard user on <body>.
  if (restoreFocus?.isConnected) restoreFocus.focus();
  restoreFocus = null;
}

// ---- submenus --------------------------------------------------------------

function openSubmenu(row: HTMLElement, focusFirst = false): void {
  if (openSub?.row === row) {
    if (focusFirst) focusItem(panelItems(openSub.panel), 0);
    return;
  }
  closeSubmenu();
  const id = row.dataset.sub;
  const panel = menuEl?.querySelector<HTMLElement>(`[data-sub-panel="${CSS.escape(id ?? '')}"]`);
  if (!panel || !menuEl) return;
  // Un-hide before measuring: a hidden panel has no box.
  panel.hidden = false;
  row.setAttribute('aria-expanded', 'true');

  const parent = menuEl.getBoundingClientRect();
  const anchor = row.getBoundingClientRect();
  const size = panel.getBoundingClientRect();
  const { x, y } = submenuPosition(
    { left: parent.left, right: parent.right },
    anchor.top - PANEL_PAD,
    { width: size.width, height: size.height },
    { width: window.innerWidth, height: window.innerHeight },
    EDGE_PAD,
    SUB_OVERLAP,
  );
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;

  openSub = { row, panel };
  if (focusFirst) focusItem(panelItems(panel), 0);
}

function closeSubmenu(focusParent = false): void {
  if (!openSub) return;
  const { row, panel } = openSub;
  panel.hidden = true;
  row.setAttribute('aria-expanded', 'false');
  openSub = null;
  if (focusParent) row.focus();
}

function handleMenuHover(event: Event): void {
  const row = rowFrom(event);
  if (!row) return;
  // Only root rows own submenus; hovering a value row inside the open panel must
  // not collapse the panel it lives in.
  if (row.dataset.sub) openSubmenu(row);
  else if (!openSub?.panel.contains(row)) closeSubmenu();
}

// ---- rows / focus ----------------------------------------------------------

function rootItems(): HTMLElement[] {
  return menuEl ? Array.from(menuEl.querySelectorAll<HTMLElement>(ROOT_ITEM_SELECTOR)) : [];
}

function panelItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

// The level the arrow keys should move within: the open panel when focus is
// inside it, the root otherwise.
function activeItems(): HTMLElement[] {
  if (openSub && document.activeElement instanceof Node && openSub.panel.contains(document.activeElement)) {
    return panelItems(openSub.panel);
  }
  return rootItems();
}

function focusItem(items: HTMLElement[], index: number): void {
  if (items.length === 0) return;
  items[(index + items.length) % items.length].focus();
}

function rowFrom(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(ITEM_SELECTOR);
  return row && menuEl?.contains(row) ? row : null;
}

function handleMenuClick(event: MouseEvent): void {
  const row = rowFrom(event);
  if (!row) return;
  // A root row owns a submenu rather than an action.
  if (row.dataset.sub) {
    if (openSub?.row === row) closeSubmenu(true);
    else openSubmenu(row, true);
    return;
  }

  const id = menuItemId;
  const action = row.dataset.action;
  const value = row.dataset.value ?? '';
  const multi = row.dataset.multi === 'true';

  // A multi-select is the one case worth staying open for: picking three tiers
  // shouldn't mean reopening the menu three times. Everything else closes first —
  // delete raises a confirm() the menu must not sit over, and neither should it
  // outlive the item it acts on.
  if (action === 'field' && multi && id && row.dataset.key && handlers) {
    const after = handlers.setField(id, row.dataset.key, value, true);
    row.setAttribute('aria-checked', String(after.includes(value)));
    return;
  }

  closeMenu();
  if (!id || !handlers) return;
  if (action === 'status' && value) handlers.setStatus(id, value as StatusKey);
  else if (action === 'field' && row.dataset.key) handlers.setField(id, row.dataset.key, value, false);
  else if (action === 'duplicate') handlers.duplicate(id);
  else if (action === 'delete') handlers.remove(id);
}

function handleMenuKeydown(event: KeyboardEvent): void {
  const items = activeItems();
  const current = items.findIndex((el) => el === document.activeElement);
  const row = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusItem(items, current + 1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      focusItem(items, current - 1);
      break;
    case 'ArrowRight':
      if (row?.dataset.sub) {
        event.preventDefault();
        openSubmenu(row, true);
      }
      break;
    case 'ArrowLeft':
      if (openSub && row && openSub.panel.contains(row)) {
        event.preventDefault();
        closeSubmenu(true);
      }
      break;
    case 'Home':
      event.preventDefault();
      focusItem(items, 0);
      break;
    case 'End':
      event.preventDefault();
      focusItem(items, items.length - 1);
      break;
    case 'Tab':
      // Let focus move on rather than trapping it in a transient menu.
      closeMenu();
      break;
    default:
      break;
  }
}

function handleDocKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  // This listener captures, so it runs before the menu's own keydown — hence the
  // level check lives here rather than there: Escape inside a submenu backs out
  // one level, and only then does it dismiss the whole menu.
  if (openSub) closeSubmenu(true);
  else closeMenu();
}

function handleDocPointerDown(event: Event): void {
  if (event.target instanceof Node && menuEl?.contains(event.target)) return;
  closeMenu();
}

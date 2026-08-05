// The item rail's delete mark — the „×" at a bar's inner right edge.
//
// vis-timeline ships its own delete affordance (`editable.remove` → a
// `.vis-delete` div), but it exists only while an item is *selected*: hovering a
// bar showed nothing, so the only way to find out a bar is deletable was to
// click it, which also opens its edit form. This mark is ours instead, which
// keeps hover and selection one affordance with one implementation rather than
// vis's button for the one state and a copy of it for the other.
//
// Rendering follows itemPresence: a child of `.vis-item` moves, scrolls and
// zooms with its item for free, so nothing needs repositioning per frame — what
// it does need is re-applying whenever vis mounts item DOM ('changed' hook).
// *When* the mark shows is left entirely to CSS (`:hover`, `.vis-selected`);
// tracking hover in JS would duplicate what the selector already knows, and the
// mark is in the DOM either way.

import { realIdOf } from './grouping';
import { state, isEditableView } from './state';

const MARK_CLASS = 'rail-delete';

// Events vis recognises a tap or a drag from. They are swallowed on the mark so
// deleting doesn't also select the item and open its form. Handled in the
// *capture* phase on the container: vis binds its own listeners further down the
// tree, so a bubbling listener would run after them, too late to stop anything.
const GESTURE_EVENTS = ['mousedown', 'pointerdown', 'touchstart'] as const;

let paintTimer: ReturnType<typeof setTimeout> | null = null;
let onDelete: ((realId: string) => void) | null = null;
// The container the delegated listeners are on. It outlives the timeline
// instances rendered into it, so they are wired once instead of per render.
let wiredContainer: HTMLElement | null = null;

/**
 * Hook a freshly created timeline instance up to the rail. `deleteItem` is
 * called with the *real* item id (a regrouped build renders an item once per
 * lane, see render.ts displayIdsFor).
 */
export function attachItemRail(
  timeline: { on: (event: string, cb: () => void) => void },
  container: HTMLElement,
  deleteItem: (realId: string) => void,
): void {
  onDelete = deleteItem;
  timeline.on('changed', schedulePaint);
  if (wiredContainer !== container) {
    container.addEventListener('click', handleClick, true);
    for (const type of GESTURE_EVENTS) {
      container.addEventListener(type, swallowOnMark, true);
    }
    wiredContainer = container;
  }
  schedulePaint();
}

// Coalesce repaints through a timer, not requestAnimationFrame — see the same
// note in itemPresence.ts: a hidden tab stops firing rAF, which would leave the
// "already scheduled" guard set forever and drop every later repaint.
function schedulePaint(): void {
  if (paintTimer != null) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paint();
  }, 0);
}

// vis-timeline's mounted items, keyed by display id.
function mountedItems(): Record<string, any> | null {
  return (state.timeline as any)?.itemSet?.items ?? null;
}

function itemBox(item: any): HTMLElement | null {
  return item?.dom?.box ?? item?.dom?.point ?? item?.dom?.dot ?? null;
}

function paint(): void {
  const items = mountedItems();
  if (!items) return;
  const editable = isEditableView();

  for (const displayId of Object.keys(items)) {
    const box = itemBox(items[displayId]);
    if (!box) continue;
    // Phase tints are full-height chrome, not deletable items.
    const wanted = editable && !box.classList.contains('vis-background');
    const mark = box.querySelector<HTMLElement>(`:scope > .${MARK_CLASS}`);
    if (wanted && !mark) {
      box.appendChild(makeMark(displayId));
    } else if (wanted && mark) {
      mark.dataset.itemId = displayId;
    } else if (mark) {
      mark.remove();
    }
  }
}

function makeMark(displayId: string): HTMLElement {
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = MARK_CLASS;
  mark.dataset.itemId = displayId;
  mark.title = 'Eintrag löschen';
  mark.setAttribute('aria-label', 'Eintrag löschen');
  return mark;
}

function markFrom(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(`.${MARK_CLASS}`);
}

function swallowOnMark(event: Event): void {
  if (!markFrom(event)) return;
  event.stopPropagation();
}

function handleClick(event: Event): void {
  const mark = markFrom(event);
  if (!mark) return;
  event.preventDefault();
  event.stopPropagation();
  const displayId = mark.dataset.itemId;
  if (displayId) onDelete?.(realIdOf(displayId));
}

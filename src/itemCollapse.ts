// The fold caret on a summary bar — the „▾" at the inner LEFT edge of an item
// that has children.
//
// A sibling of itemRail.ts and built the same way, for the reasons given there:
// a child of `.vis-item` moves, scrolls and zooms with its bar for free, and
// what it needs is re-applying whenever vis mounts item DOM ('changed'). The two
// stay separate modules because they answer to different rules — the delete mark
// is an editing affordance and disappears on a read-only source, while folding is
// a way of *reading* a timeline and therefore works everywhere.
//
// Which bars get one is not passed in: the caret goes on every `.vis-item` that
// carries `item-summary`, the class `withHierarchyMarks` stamps on the way into
// the DataSet (buildItems.ts). One statement of „this item has children", not
// two that drift.

import { realIdOf } from './grouping';
import { state } from './state';
import { t } from './i18n';

const MARK_CLASS = 'rail-collapse';
const SUMMARY_CLASS = 'item-summary';

// Swallowed on the caret so folding doesn't also select the item and open its
// form. Capture phase, because vis binds further down the tree — see itemRail.ts.
const GESTURE_EVENTS = ['mousedown', 'pointerdown', 'touchstart'] as const;

let paintTimer: ReturnType<typeof setTimeout> | null = null;
let onToggle: ((realId: string) => void) | null = null;
let wiredContainer: HTMLElement | null = null;

/**
 * Hook a freshly created timeline instance up to the fold carets. `toggle` is
 * called with the *real* item id (a regrouped build renders an item once per
 * lane, see render.ts displayIdsFor).
 */
export function attachItemCollapse(
  timeline: { on: (event: string, cb: () => void) => void },
  container: HTMLElement,
  toggle: (realId: string) => void,
): void {
  onToggle = toggle;
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

// A timer rather than requestAnimationFrame: a hidden tab stops firing rAF,
// which would leave the "already scheduled" guard set forever (see itemRail.ts).
function schedulePaint(): void {
  if (paintTimer != null) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paint();
  }, 0);
}

function mountedItems(): Record<string, any> | null {
  return (state.timeline as any)?.itemSet?.items ?? null;
}

function itemBox(item: any): HTMLElement | null {
  return item?.dom?.box ?? item?.dom?.point ?? item?.dom?.dot ?? null;
}

function paint(): void {
  const items = mountedItems();
  if (!items) return;

  for (const displayId of Object.keys(items)) {
    const box = itemBox(items[displayId]);
    if (!box) continue;
    const wanted = box.classList.contains(SUMMARY_CLASS);
    const mark = box.querySelector<HTMLElement>(`:scope > .${MARK_CLASS}`);
    if (wanted && !mark) {
      box.appendChild(makeMark(displayId, box));
    } else if (wanted && mark) {
      mark.dataset.itemId = displayId;
      applyLabels(mark, box);
    } else if (mark) {
      mark.remove();
    }
  }
}

function makeMark(displayId: string, box: HTMLElement): HTMLElement {
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = MARK_CLASS;
  mark.dataset.itemId = displayId;
  applyLabels(mark, box);
  return mark;
}

// The caret says what a click will do, so the label follows the folded state —
// which `is-collapsed` on the bar already carries (see withHierarchyMarks).
function applyLabels(mark: HTMLElement, box: HTMLElement): void {
  const collapsed = box.classList.contains('is-collapsed');
  const label = collapsed ? t('item.children.show') : t('item.children.hide');
  mark.title = label;
  mark.setAttribute('aria-label', label);
  mark.setAttribute('aria-expanded', String(!collapsed));
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
  if (displayId) onToggle?.(realIdOf(displayId));
}

// Stored background items are real timeline entries, even though vis-timeline
// renders every `type: background` item as non-interactive chrome. Phases use
// the same third-party item type for their generated tint, so this bridge marks
// only stored backgrounds and leaves `.phase-bg` alone.

import { realIdOf } from './cloneId';
import { t } from './i18n';

const ITEM_ATTR = 'data-background-item-id';
const INTERACTIVE_CLASS = 'interactive-background';
const CLICK_SLOP_PX = 4;

let paintTimer: ReturnType<typeof setTimeout> | null = null;
let onSelect: ((realId: string) => void) | null = null;
let wiredContainer: HTMLElement | null = null;
let activeTimeline: TimelineLike | null = null;
let press: { displayId: string; x: number; y: number } | null = null;

type TimelineLike = { on: (event: string, cb: () => void) => void };

/** Generated phase tints share the vis background class but are not entries. */
export function isStoredBackground(box: Pick<HTMLElement, 'classList'>): boolean {
  return box.classList.contains('vis-background') && !box.classList.contains('phase-bg');
}

/** Resolve an activation inside a marked background without depending on vis. */
export function backgroundIdFromTarget(target: EventTarget | null): string | null {
  const closest = (target as Element | null)?.closest;
  if (typeof closest !== 'function') return null;
  const box = closest.call(target, `[${ITEM_ATTR}]`) as HTMLElement | null;
  return box?.dataset.backgroundItemId ?? null;
}

/**
 * Make stored background items open the normal item detail/editor.
 *
 * vis-timeline deliberately omits its private item reference from background
 * DOM, so its own selection event can never identify one. Reaching into that
 * private reference would also opt the item into gestures the BackgroundItem
 * implementation does not support. A small delegated activation is the stable
 * seam: the DOM follows vis, while selection stays on our existing item path.
 */
export function attachBackgroundItemSelection(
  timeline: TimelineLike,
  container: HTMLElement,
  select: (realId: string) => void,
): void {
  onSelect = select;
  activeTimeline = timeline;
  timeline.on('changed', schedulePaint);
  if (wiredContainer !== container) {
    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeydown);
    wiredContainer = container;
  }
  schedulePaint();
}

function schedulePaint(): void {
  if (paintTimer != null) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paint();
  }, 0);
}

function mountedItems(): Record<string, any> | null {
  return (activeTimeline as any)?.itemSet?.items ?? null;
}

function paint(): void {
  const items = mountedItems();
  if (!items) return;

  for (const [displayId, item] of Object.entries(items)) {
    const box = (item as any)?.dom?.box as HTMLElement | null;
    if (!box) continue;
    if (isStoredBackground(box)) {
      box.dataset.backgroundItemId = displayId;
      box.classList.add(INTERACTIVE_CLASS);
      box.tabIndex = 0;
      box.setAttribute('role', 'button');
      const label = String((item as any)?.data?.label ?? (item as any)?.data?.content ?? '').trim();
      box.setAttribute(
        'aria-label',
        label ? t('item.background.editNamed', { label }) : t('item.background.edit'),
      );
    } else if (box.hasAttribute(ITEM_ATTR)) {
      box.removeAttribute(ITEM_ATTR);
      box.classList.remove(INTERACTIVE_CLASS);
      box.removeAttribute('tabindex');
      box.removeAttribute('role');
      box.removeAttribute('aria-label');
    }
  }
}

function activate(displayId: string | null): boolean {
  if (!displayId) return false;
  onSelect?.(realIdOf(displayId));
  return true;
}

function handlePointerDown(event: PointerEvent): void {
  const displayId = backgroundIdFromTarget(event.target);
  press = displayId ? { displayId, x: event.clientX, y: event.clientY } : null;
}

function handleClick(event: MouseEvent): void {
  const displayId = backgroundIdFromTarget(event.target);
  if (
    press?.displayId === displayId &&
    (Math.abs(event.clientX - press.x) > CLICK_SLOP_PX || Math.abs(event.clientY - press.y) > CLICK_SLOP_PX)
  ) {
    press = null;
    return; // the background was where a timeline pan started, not a click
  }
  press = null;
  if (!activate(displayId)) return;
  event.preventDefault();
  event.stopPropagation();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!activate(backgroundIdFromTarget(event.target))) return;
  event.preventDefault();
  event.stopPropagation();
}

// Full-width, pale folder bodies behind expanded item subtrees.
//
// The item bars themselves carry dates, so stretching a parent bar around its
// children would lie about duration. This overlay uses only the vertical axis:
// the parent remains the dated "tab", while a background body spans from its
// lower edge through the last visible descendant across the timeline viewport.

import type { Timeline } from 'vis-timeline/standalone';
import type { TimelineItem } from './buildItems';
import { childrenByParent, hierarchyDepth } from './itemHierarchy';

export type HierarchyFolderTree = {
  parentId: string;
  descendantIds: string[];
  depth: number;
};

/** The expanded, same-track subtrees that earn a folder body. */
export function hierarchyFolderTrees(
  items: readonly Pick<TimelineItem, 'id' | 'group'>[],
  parents: Map<string, string>,
): HierarchyFolderTree[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const localParents = new Map<string, string>();
  for (const item of items) {
    const parentId = parents.get(item.id);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && parent.group === item.group) localParents.set(item.id, parentId!);
  }

  const children = childrenByParent(localParents);
  const depths = hierarchyDepth(localParents);
  const out: HierarchyFolderTree[] = [];
  for (const item of items) {
    if (!children.has(item.id)) continue;
    const descendantIds: string[] = [];
    const visit = (id: string): void => {
      for (const childId of children.get(id) ?? []) {
        descendantIds.push(childId);
        visit(childId);
      }
    };
    visit(item.id);
    out.push({ parentId: item.id, descendantIds, depth: depths.get(item.id) ?? 0 });
  }
  return out;
}

type ItemPosition = { left: number; right: number; top: number; bottom: number };

const REDRAW_EVENTS = ['changed', 'rangechange', 'rangechanged'] as const;
const FOLDER_INLINE_INSET = 8;

export class HierarchyFolders {
  private timeline: Timeline;
  private itemSet: HTMLElement;
  private layer: HTMLElement;
  private items: TimelineItem[] = [];
  private parents = new Map<string, string>();
  private resizeObserver: ResizeObserver;
  private rafToken = 0;
  private settleTimers: ReturnType<typeof setTimeout>[] = [];
  private onChanged = () => this.scheduleRedraw();

  constructor(timeline: Timeline, container: HTMLElement) {
    this.timeline = timeline;
    const itemSet = container.querySelector<HTMLElement>('.vis-itemset');
    const foreground = itemSet?.querySelector<HTMLElement>(':scope > .vis-foreground');
    if (!itemSet || !foreground) throw new Error('HierarchyFolders: item set not ready');
    this.itemSet = itemSet;

    this.layer = document.createElement('div');
    this.layer.className = 'hierarchy-folders';
    // Between vis's background and foreground layers: above phase tint/grid
    // furniture, below every real item and interaction target.
    this.itemSet.insertBefore(this.layer, foreground);

    for (const event of REDRAW_EVENTS) timeline.on(event, this.onChanged);
    this.resizeObserver = new ResizeObserver(this.onChanged);
    this.resizeObserver.observe(this.itemSet);
  }

  setHierarchy(items: TimelineItem[], parents: Map<string, string>): void {
    this.items = items.filter((it) => it.type !== 'background' && !!it.start);
    this.parents = parents;
    // DataSet updates make vis reposition its item DOM asynchronously. Remove
    // the old body immediately and wait for vis's `changed` event (with timed
    // fallbacks) before measuring again. Drawing in the same frame used the new
    // hierarchy with the old item positions, briefly enclosing unrelated bars.
    this.layer.replaceChildren();
    this.redrawWhenSettled();
  }

  dispose(): void {
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
    for (const timer of this.settleTimers) clearTimeout(timer);
    this.resizeObserver.disconnect();
    for (const event of REDRAW_EVENTS) this.timeline.off(event, this.onChanged);
    this.layer.remove();
  }

  private redrawWhenSettled(): void {
    for (const timer of this.settleTimers) clearTimeout(timer);
    this.settleTimers = [];
    for (const ms of [80, 240]) {
      this.settleTimers.push(setTimeout(() => this.scheduleRedraw(), ms));
    }
  }

  private scheduleRedraw(): void {
    if (this.rafToken) return;
    this.rafToken = requestAnimationFrame(() => {
      this.rafToken = 0;
      this.redraw();
    });
  }

  private itemPosition(id: string): ItemPosition | null {
    const item = (this.timeline as any).itemSet?.items?.[id];
    const label: HTMLElement | undefined = item?.parent?.dom?.label;
    const box: HTMLElement | undefined = item?.dom?.box ?? item?.dom?.point ?? item?.dom?.dot;
    if (!item || !label || !Number.isFinite(item.top) || !Number.isFinite(item.height)) return null;
    if (!box?.getBoundingClientRect) return null;
    const itemSetRect = this.itemSet.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const top = label.getBoundingClientRect().top + item.top - itemSetRect.top;
    const left = Math.max(0, boxRect.left - itemSetRect.left);
    const right = Math.min(itemSetRect.width, boxRect.right - itemSetRect.left);
    return { left, right, top, bottom: top + item.height };
  }

  private redraw(): void {
    this.layer.replaceChildren();
    const trees = hierarchyFolderTrees(this.items, this.parents);
    const byId = new Map(this.items.map((it) => [it.id, it]));

    for (const tree of trees) {
      const parent = this.itemPosition(tree.parentId);
      const descendants = tree.descendantIds.flatMap((id) => {
        const pos = this.itemPosition(id);
        return pos ? [pos] : [];
      });
      if (!parent || descendants.length === 0) continue;

      const top = parent.bottom - 1;
      const bottom = Math.max(...descendants.map((pos) => pos.bottom)) + 6;
      const left = parent.left + FOLDER_INLINE_INSET;
      const right = parent.right - FOLDER_INLINE_INSET;
      if (bottom <= top || right <= left) continue;

      const folder = document.createElement('div');
      const lane = byId.get(tree.parentId)?.className?.match(/(?:^|\s)(lane-\d)(?:\s|$)/)?.[1];
      folder.className = ['hierarchy-folder', lane].filter(Boolean).join(' ');
      folder.style.left = `${left}px`;
      folder.style.width = `${right - left}px`;
      folder.style.top = `${top}px`;
      folder.style.height = `${bottom - top}px`;
      folder.dataset.parentId = tree.parentId;
      this.layer.appendChild(folder);
    }
  }
}

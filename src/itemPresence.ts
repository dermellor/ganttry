// Per-item presence marks on the timeline: shows which item another user
// currently has selected, and who is actually editing one right now.
//
// The header badge (presence.ts) answers "who is here"; this answers "who is on
// what", so two people notice they're about to touch the same item *before* the
// 409/"extern geändert" hint. The data rides the existing presence channel
// (realtime.ts, `PresenceActivity`) — no extra channel, no table, no migration.
//
// Rendering deliberately hangs the mark off vis-timeline's own item element
// instead of an absolutely-positioned overlay (as arrows.ts / phaseBand.ts do):
// a child of `.vis-item` moves, scrolls and zooms with its item for free, so
// there is no per-frame repositioning to keep in sync. What it does need is a
// re-apply after vis mounts item DOM (rebuild, scrolling an item into view),
// hence the 'changed' hook in attachItemPresence.

import {
  groupPresenceByItem,
  hueFor,
  initials,
  labelFor,
  type PresenceEntry,
} from './presenceModel';
import { Avatar } from './design-system';
import { realIdOf } from './grouping';
import { state } from './state';

// Real item id → the other users currently on it (never ourselves).
let marks = new Map<string, PresenceEntry[]>();
// Display ids we last painted a mark onto, so a cleared roster can be undone
// without walking every mounted item.
let painted = new Set<string>();
let paintTimer: ReturnType<typeof setTimeout> | null = null;

const MARK_CLASS = 'item-presence';
// At most this many avatars per item; the rest collapse into a "+N" chip.
const MAX_MARKS = 3;

/**
 * Replace the item-presence roster. `entries` is the full presence roster;
 * `selfEmail` is dropped from it (our own selection is already the vis
 * selection). Repaints on the next frame.
 */
export function setItemPresence(entries: PresenceEntry[], selfEmail: string | null): void {
  marks = groupPresenceByItem(entries, selfEmail);
  schedulePaint();
}

/** Drop all marks (view switch, presence channel left). */
export function clearItemPresence(): void {
  if (marks.size === 0 && painted.size === 0) return;
  marks = new Map();
  schedulePaint();
}

/**
 * Hook a freshly created timeline instance up to the marks. vis-timeline mounts
 * and unmounts item DOM as items enter the viewport or the DataSets change, so
 * the marks are re-applied after every redraw ('changed'). The listener dies
 * with the instance (renderTimeline destroys it), while the roster itself is
 * module state and survives re-renders.
 */
export function attachItemPresence(timeline: { on: (e: string, cb: () => void) => void }): void {
  timeline.on('changed', schedulePaint);
  schedulePaint();
}

// Coalesce repaints (a roster sync and vis's 'changed' often land together)
// through a timer, NOT requestAnimationFrame. A hidden tab — backgrounded,
// minimized, on another desktop — stops firing rAF, so a pending frame callback
// never runs; the "already scheduled" guard would then stay set forever and
// every later sync would silently drop its repaint, freezing the marks at the
// last state the tab saw while it was in front. Timers keep running (merely
// throttled) in a hidden tab, and the marks are a handful of DOM writes, so
// there is nothing to gain from frame alignment here.
function schedulePaint(): void {
  if (paintTimer != null) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paint();
  }, 0);
}

// vis-timeline's mounted items, keyed by *display* id (a regrouped build renders
// an item once per lane — see render.ts displayIdsFor).
function mountedItems(): Record<string, any> | null {
  return (state.timeline as any)?.itemSet?.items ?? null;
}

function itemBox(item: any): HTMLElement | null {
  return item?.dom?.box ?? item?.dom?.point ?? item?.dom?.dot ?? null;
}

function paint(): void {
  if (marks.size === 0 && painted.size === 0) return; // nothing to draw or undo
  const items = mountedItems();
  if (!items) return;

  const stillPainted = new Set<string>();
  for (const displayId of Object.keys(items)) {
    const box = itemBox(items[displayId]);
    if (!box) continue;
    const users = marks.get(realIdOf(displayId));
    if (users?.length) {
      applyMark(box, users);
      stillPainted.add(displayId);
    } else if (painted.has(displayId)) {
      removeMark(box);
    }
  }
  painted = stillPainted;
}

function applyMark(box: HTMLElement, users: PresenceEntry[]): void {
  const editing = users.some((u) => u.editing);
  box.classList.add('has-remote-presence');
  box.classList.toggle('is-remote-editing', editing);
  // The ring picks up the colour of the first (topmost) user's avatar.
  box.style.setProperty('--presence-hue', String(hueFor(users[0].email)));

  const signature = `${users.map((u) => `${u.email}:${u.editing ? 1 : 0}`).join(',')}`;
  let mark = box.querySelector<HTMLElement>(`:scope > .${MARK_CLASS}`);
  if (mark && mark.dataset.signature === signature) return; // unchanged
  if (!mark) {
    mark = document.createElement('span');
    mark.className = MARK_CLASS;
    box.appendChild(mark);
  }
  mark.dataset.signature = signature;
  mark.replaceChildren(...avatars(users));
}

function removeMark(box: HTMLElement): void {
  box.classList.remove('has-remote-presence', 'is-remote-editing');
  box.style.removeProperty('--presence-hue');
  box.querySelector<HTMLElement>(`:scope > .${MARK_CLASS}`)?.remove();
}

function avatars(users: PresenceEntry[]): HTMLElement[] {
  const shown = users.slice(0, MAX_MARKS);
  const out = shown.map((u) =>
    Avatar({
      initials: initials(u),
      hue: hueFor(u.email),
      size: 'sm',
      stacked: true,
      className: 'presence-mark',
      // „ausgewählt" rather than „offen": the mark follows the timeline
      // selection, which outlives closing the detail panel.
      title: `${labelFor(u)} — ${u.editing ? 'editiert gerade' : 'hat diesen Eintrag ausgewählt'}`,
      attrs: u.editing ? { 'data-editing': '' } : undefined,
    }),
  );
  const overflow = users.length - shown.length;
  if (overflow > 0) {
    out.push(
      Avatar({
        initials: `+${overflow}`,
        hue: 0,
        size: 'sm',
        stacked: true,
        overflow: true,
        className: 'presence-mark',
        title: users.slice(MAX_MARKS).map(labelFor).join('\n'),
      }),
    );
  }
  return out;
}

// A one-line rail of milestone marks sitting *on* the timeline's axis line. It
// answers a question the lanes cannot: *which* milestones does this plan have,
// and when? A point item lives in its track's lane, so reading the full set means
// scanning vertically across every track — and with enough tracks that means
// scrolling, at which point a milestone near the bottom is simply missed. The
// rail collects them onto one row, at the same x as the item itself.
//
// Each mark carries its item's lane colour, so a mark and the point it stands for
// read as the same thing, and clicking one selects that item — the same path a
// click on the point in its lane takes.
//
// The marks straddle the rule under the date labels, which is the top border of
// `.vis-panel.vis-center`. That is why the rail mounts into `.vis-panel.vis-top`
// (the axis panel) rather than into the center panel it annotates: the center
// panel clips to its own box (`overflow: hidden`), so a mark centred on its top
// edge would lose its upper half. The axis panel does not clip, and it comes
// *after* the center panel in vis's DOM, so a mark hanging out of its bottom edge
// paints over the content below the line. Both panels share the same left edge
// and width, so the x from vis's own conversion carries over unchanged.

import type { Timeline } from 'vis-timeline/standalone';
import { decodeEntities, laneClassOf, type TimelineItem } from './buildItems';
import { realIdOf } from './cloneId';
import { centerWidth, timeToX } from './visGeometry';

// Timeline events the rail redraws on: a re-layout plus the window-motion pair
// (continuous during pan/zoom, and on settle after the initial load). Same set
// the phase ribbon listens to, for the same reason.
const RAIL_EVENTS = ['changed', 'rangechange', 'rangechanged'] as const;


// A mark is a 10px (border-box) square turned 45°, so on screen it is as wide as
// that square's diagonal.
const MARK_BOX_PX = 10;
const MARK_WIDTH_PX = MARK_BOX_PX * Math.SQRT2; // ≈14.1

// Horizontal room one mark needs to clear its neighbour: its own width plus a
// hair, so two fanned marks touch at the corner rather than intersect. See
// `spreadCoincident`.
const MARK_PITCH_PX = Math.ceil(MARK_WIDTH_PX) + 1;

// A mark closer than half its width to either edge is dropped rather than drawn:
// the rail no longer sits in a clipping box (see the note at the top), so a
// half-visible mark would hang over the group labels instead of being cut off.
const MARK_HALF_PX = Math.ceil(MARK_WIDTH_PX / 2);

/** One milestone as the rail draws it. `id` is the real item id, never a clone. */
export type RailMark = {
  id: string;
  label: string;
  start: string;
  laneClass: string | null;
};

/**
 * The milestones of a display item set, in date order.
 *
 * Takes the *display* items (post-filter, post-regroup) rather than the raw
 * build, so the rail shows exactly what the timeline shows. When grouping by tag
 * or a custom field, a multi-valued item is cloned into one lane per value; the
 * clones are collapsed back to their real item here, because two marks at one
 * date for one milestone is noise, and selection works on real ids anyway.
 */
export function railMarks(items: TimelineItem[]): RailMark[] {
  const seen = new Set<string>();
  const out: RailMark[] = [];
  for (const it of items) {
    if (it.type !== 'point' || !it.start) continue;
    const id = realIdOf(it.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      // `content` is HTML-escaped at build time; a `title` attribute is set as a
      // DOM property and would show the entities verbatim ("R&amp;D").
      label: decodeEntities(it.content ?? ''),
      start: it.start,
      laneClass: laneClassOf(it.className) ?? null,
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Push apart marks that would otherwise cover each other, so a run of N
 * near-coincident milestones reads as N marks rather than as one.
 *
 * Two milestones on the same day land on the same x, and one diamond then hides
 * the other completely — the rail would claim a milestone does not exist, which
 * is the one thing it is there to prevent. Drawing at the exact x was tried
 * first and rejected for that reason.
 *
 * A run is spread symmetrically **around its own centre** rather than by pushing
 * each colliding mark to the right. Pushing right accumulates: a dense cluster
 * walks steadily away from its dates and the drift grows with every member,
 * while a symmetric spread keeps the run centred on where it actually sits and
 * bounds the error at half the run's width. The exact date stays available in
 * the tooltip either way, and zooming in separates the marks for real.
 *
 * `xs` must be in date order (as `railMarks` returns them).
 */
export function spreadCoincident(xs: number[], pitch = MARK_PITCH_PX): number[] {
  const out = xs.slice();
  let i = 0;
  while (i < xs.length) {
    // Grow the run while the next mark would still touch the previous one.
    let j = i + 1;
    while (j < xs.length && xs[j] - xs[j - 1] < pitch) j++;
    const n = j - i;
    if (n > 1) {
      const mid = (xs[i] + xs[j - 1]) / 2;
      const first = mid - ((n - 1) * pitch) / 2;
      for (let k = 0; k < n; k++) out[i + k] = first + k * pitch;
    }
    i = j;
  }
  return out;
}

/**
 * Renders the rail into `.vis-panel.vis-top` and keeps it aligned while the
 * window pans and zooms. Construct once per timeline instance (the panel only
 * exists after vis has laid out, so the caller retries), then push new data with
 * `setItems` on every rebuild.
 */
export class MilestoneRail {
  private rail: HTMLElement;
  private host: HTMLElement;
  // The panel whose top border *is* the line the marks sit on. Kept so every
  // redraw can measure where that line currently is (see `alignToLine`).
  private center: HTMLElement;
  private container: HTMLElement;
  private timeline: Timeline;
  private marks: RailMark[] = [];
  private resizeObserver: ResizeObserver;
  private rafToken = 0;
  private drawTimers: ReturnType<typeof setTimeout>[] = [];
  private disposed = false;
  private onSelect: ((id: string) => void) | null = null;
  private onChanged = () => this.scheduleRedraw();

  constructor(timeline: Timeline, container: HTMLElement) {
    this.timeline = timeline;
    this.container = container;
    const axis = container.querySelector('.vis-panel.vis-top') as HTMLElement | null;
    if (!axis) throw new Error('MilestoneRail: .vis-panel.vis-top not found');
    const center = container.querySelector('.vis-panel.vis-center') as HTMLElement | null;
    if (!center) throw new Error('MilestoneRail: .vis-panel.vis-center not found');
    this.host = axis;
    this.center = center;
    // Only make the host a containing block if it is not one already, and decide
    // that from the *computed* position rather than the inline one: vis styles
    // this panel `absolute` from its stylesheet, so an inline-only check reads
    // "unset" and overwrites it with `relative` — which drops the axis out of its
    // absolute placement and parks it below the whole timeline.
    if (getComputedStyle(this.host).position === 'static') this.host.style.position = 'relative';

    this.rail = document.createElement('div');
    this.rail.className = 'milestone-rail';
    this.host.appendChild(this.rail);

    for (const evt of RAIL_EVENTS) timeline.on(evt, this.onChanged);
    this.resizeObserver = new ResizeObserver(this.onChanged);
    this.resizeObserver.observe(this.host);
  }

  /** What a click on a mark should do — select the item it stands for. */
  setOnSelect(onSelect: (id: string) => void): void {
    this.onSelect = onSelect;
  }

  /**
   * Feed the rail the current display items; it picks the milestones out itself.
   *
   * Toggling the container class lives here rather than at the call site because
   * the milestone count changes with the active filter, not just with the build:
   * filtering every point away has to give the vertical room back, and that is
   * the same event as the data changing.
   */
  setItems(items: TimelineItem[]): void {
    this.marks = railMarks(items);
    const any = this.marks.length > 0;
    this.rail.style.display = any ? '' : 'none';
    this.container.classList.toggle('has-milestone-rail', any);
    this.redrawSoon();
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
    this.drawTimers.forEach(clearTimeout);
    this.drawTimers = [];
    this.resizeObserver.disconnect();
    for (const evt of RAIL_EVENTS) this.timeline.off(evt, this.onChanged);
    this.rail.remove();
    this.container.classList.remove('has-milestone-rail');
  }

  private scheduleRedraw(): void {
    if (this.rafToken) return;
    this.rafToken = requestAnimationFrame(() => {
      this.rafToken = 0;
      this.redraw();
    });
  }

  // Positioning needs vis to have laid out (its `toScreen` conversion and the
  // content width are only valid after the timeline's first — throttled — redraw).
  // A single rAF right after the rail is built can land before that, drawing
  // nothing, with no later `changed` event to correct it on a static page. Mirror
  // the phase ribbon: attempt a few times across frames until the width is real.
  // `redraw` no-ops while the width is 0, so the extra attempts are cheap.
  private redrawSoon(): void {
    this.drawTimers.forEach(clearTimeout);
    this.drawTimers = [];
    this.scheduleRedraw();
    for (const delay of [100, 500]) {
      this.drawTimers.push(setTimeout(() => this.redraw(), delay));
    }
  }

  /**
   * Put the rail's zero-height box exactly on the line the marks sit on: the top
   * border of the center panel, expressed in the axis panel's own coordinates.
   *
   * Measured rather than assumed. The axis panel normally ends where the center
   * panel begins, so `bottom: 0` would do — but vis positions the center panel
   * from its *own* measurement of the axis, and anything that nudges that
   * measurement (a stylesheet touching the label boxes, say) moves the line off
   * the panel edge and leaves the marks floating beside it.
   */
  private alignToLine(): void {
    const line = this.center.getBoundingClientRect().top;
    const origin = this.host.getBoundingClientRect().top;
    this.rail.style.top = `${line - origin}px`;
  }

  private redraw(): void {
    // A pending retry timer may fire after the rail was torn down.
    if (this.disposed) return;
    if (!this.marks.length) {
      this.rail.innerHTML = '';
      return;
    }

    // Until vis has laid out — width still 0, e.g. the rail was built before the
    // first layout, or the timeline is hidden in list mode — keep the current
    // marks rather than clearing to an empty rail; the ResizeObserver / 'changed'
    // handler redraws once the width is real.
    const width = centerWidth(this.timeline);
    if (!(width > 0)) return;

    this.alignToLine();
    this.rail.innerHTML = '';
    // Spread before clipping, so a run straddling the edge is laid out from the
    // whole run rather than from the part that happens to be on screen — the
    // visible members would otherwise shift as the window pans.
    const xs = spreadCoincident(this.marks.map((m) => timeToX(this.timeline, m.start)));
    this.marks.forEach((m, i) => {
      const x = xs[i];
      // Drop a mark that would not fit whole, rather than let it hang past the
      // panel — nothing clips it here (see MARK_HALF_PX).
      if (x < MARK_HALF_PX || x > width - MARK_HALF_PX) return;

      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = `milestone-mark${m.laneClass ? ` ${m.laneClass}` : ''}`;
      mark.style.left = `${x}px`;
      mark.title = `${m.label}\n${m.start.slice(0, 10)}`;
      // The mark is a 10px diamond, so the accessible name has to come from the
      // label — there is no text node to read.
      mark.setAttribute('aria-label', m.label);
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect?.(m.id);
      });
      this.rail.appendChild(mark);
    });
  }
}

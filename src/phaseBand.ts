import type { Timeline } from 'vis-timeline/standalone';
import { phaseCssId, type ResolvedPhase } from './buildItems';
import { parseLocalDay } from './date';
import { iconSpanHtml } from './icons';

// Pointer travel (px) below which a press-release counts as a click, not a drag.
const CLICK_SLOP_PX = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

// vis-timeline positions its items (including the phase background tints) with an
// internal time→pixel conversion, `body.util.toScreen`, applied over
// `body.domProps.center.width` — the panel's *content* width, which already
// subtracts a reserved vertical scrollbar (`verticalScroll`). Re-deriving the
// mapping ourselves from `getWindow()` + `getBoundingClientRect().width` (the
// border box, which still includes the scrollbar gutter) makes the ribbon drift
// right of the tints, growing toward the right edge. We therefore reuse vis's own
// conversion so the ribbon segment and the tint share one coordinate system.
// These internals aren't part of vis-timeline's public typings.
type VisInternals = {
  body: {
    util: { toScreen(time: Date): number };
    domProps: { center: { width: number } };
  };
};

// Timeline events the band redraws on: a re-layout plus the window-motion pair
// (continuous during pan/zoom, and on settle after the initial load).
const PHASE_BAND_EVENTS = ['changed', 'rangechange', 'rangechanged'] as const;

/** A drag/resize result, reported to the host so it can persist the change. */
export type PhaseEdit = { srcIndex: number; start: Date; end: Date };

type DragMode = 'move' | 'resize-l' | 'resize-r';

type DragState = {
  phase: ResolvedPhase;
  mode: DragMode;
  originX: number;
  msPerPx: number;
  width: number;
  startMs: number;
  endMs: number;
  seg: HTMLElement;
  newStart: number;
  newEnd: number;
  moved: boolean;
};

/**
 * Renders a labeled phase ribbon pinned to the top of the timeline's center
 * panel. Segments are positioned by mapping each phase's date range onto the
 * currently visible window, so the band stays aligned while zooming/panning.
 * It lives inside `.vis-panel.vis-center`, above the items — pair it with a
 * larger `margin.axis` so items start below the band.
 *
 * When editable, each segment can be dragged (moves start+end together) or
 * resized from either edge, mirroring how vis-timeline items behave. The
 * pixel→date mapping is inverted on drop and reported via the edit callback.
 */
export class PhaseBand {
  private band: HTMLElement;
  private host: HTMLElement;
  private styleEl: HTMLStyleElement;
  private timeline: Timeline;
  private phases: ResolvedPhase[] = [];
  private resizeObserver: ResizeObserver;
  private rafToken = 0;
  private drawTimers: ReturnType<typeof setTimeout>[] = [];
  private disposed = false;
  private editable = false;
  private onEdit: ((edit: PhaseEdit) => void) | null = null;
  private onSelect: ((srcIndex: number) => void) | null = null;
  private drag: DragState | null = null;
  private onChanged = () => this.scheduleRedraw();
  private onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);

  constructor(timeline: Timeline, container: HTMLElement) {
    this.timeline = timeline;
    const center = container.querySelector('.vis-panel.vis-center') as HTMLElement | null;
    if (!center) throw new Error('PhaseBand: .vis-panel.vis-center not found');
    this.host = center;
    if (!this.host.style.position) this.host.style.position = 'relative';

    this.band = document.createElement('div');
    this.band.className = 'phase-band';
    this.host.appendChild(this.band);

    // Per-phase colour for the full-height background items. A class selector
    // with !important beats the generic `.vis-item { ...!important }` rule,
    // which an inline item style does not.
    this.styleEl = document.createElement('style');
    document.head.appendChild(this.styleEl);

    // Redraw whenever the timeline re-lays-out (`changed`) or the visible window
    // moves. `rangechange` fires continuously during pan/zoom and `rangechanged`
    // on settle — including the post-load window adjustment vis makes after the
    // initial `start`/`end`, which `changed` alone can miss, leaving the ribbon
    // stale relative to the tints. `scheduleRedraw` coalesces to one draw/frame.
    for (const evt of PHASE_BAND_EVENTS) timeline.on(evt, this.onChanged);
    this.resizeObserver = new ResizeObserver(this.onChanged);
    this.resizeObserver.observe(this.host);
  }

  setPhases(phases: ResolvedPhase[]): void {
    this.phases = phases;
    this.band.style.display = phases.length ? '' : 'none';
    this.styleEl.textContent = phases
      .filter((p) => p.color)
      .map((p) => {
        const tint = /^#[0-9a-fA-F]{6}$/.test(p.color!) ? `${p.color}16` : p.color!;
        return `.vis-item.vis-background.phase-bg-${phaseCssId(p.id)}{background-color:${tint} !important;}`;
      })
      .join('\n');
    this.redrawSoon();
  }

  /**
   * Enable drag-to-move / edge-resize and click-to-open. `onEdit` persists a
   * drag/resize; `onSelect` fires when a segment is clicked without dragging.
   */
  setEditable(
    editable: boolean,
    onEdit: (edit: PhaseEdit) => void,
    onSelect?: (srcIndex: number) => void,
  ): void {
    this.editable = editable;
    this.onEdit = onEdit;
    this.onSelect = onSelect ?? null;
    this.band.classList.toggle('is-editable', editable);
    this.scheduleRedraw();
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
    this.drawTimers.forEach(clearTimeout);
    this.drawTimers = [];
    this.endDragListeners();
    this.resizeObserver.disconnect();
    for (const evt of PHASE_BAND_EVENTS) this.timeline.off(evt, this.onChanged);
    this.band.remove();
    this.styleEl.remove();
  }

  // vis's own time→pixel conversion (see `VisInternals`), so ribbon segments
  // land on the exact same x as the phase tints.
  private get vis(): VisInternals {
    return this.timeline as unknown as VisInternals;
  }
  private contentWidth(): number {
    return this.vis.body.domProps.center.width;
  }
  private toX(time: number | string | Date): number {
    // Parse day strings as *local* midnight (as vis does) — a UTC `new Date(iso)`
    // would offset the segment from its tint by the timezone offset. See date.ts.
    return this.vis.body.util.toScreen(parseLocalDay(time));
  }

  private scheduleRedraw(): void {
    if (this.rafToken) return;
    this.rafToken = requestAnimationFrame(() => {
      this.rafToken = 0;
      this.redraw();
    });
  }

  // Positioning needs vis to have laid out (its `toScreen` conversion and the
  // content width are only valid after the timeline's first — throttled —
  // redraw). A single rAF right after the band is built can therefore land
  // before that, drawing nothing, with no later `changed` event to correct it on
  // a static page. Mirror the arrows overlay: attempt a few times across frames
  // until the width is real. `redraw` is idempotent (it no-ops while the width is
  // 0), so the extra attempts are cheap once a draw has landed.
  private redrawSoon(): void {
    this.drawTimers.forEach(clearTimeout);
    this.drawTimers = [];
    this.scheduleRedraw();
    for (const delay of [100, 500]) {
      this.drawTimers.push(setTimeout(() => this.redraw(), delay));
    }
  }

  private redraw(): void {
    // A pending retry timer may fire after the band was torn down.
    if (this.disposed) return;
    // Don't rip out the segment the user is actively dragging.
    if (this.drag) return;
    if (!this.phases.length) {
      this.band.innerHTML = '';
      return;
    }

    // Map dates through vis's own conversion over the content width, so segments
    // sit on the same x-grid as the tints (no scrollbar-gutter drift). Until vis
    // has laid out — width still 0, e.g. the band was built before the first
    // layout, or the timeline is hidden in list mode — keep the current segments
    // rather than clearing to an empty band; the ResizeObserver / 'changed'
    // handler redraws once the width is real.
    const width = this.contentWidth();
    if (!(width > 0)) return;

    this.band.innerHTML = '';
    this.phases.forEach((p, i) => {
      const left = this.toX(p.start);
      const right = this.toX(p.end);
      if (right <= 0 || left >= width) return; // fully outside the window

      const clippedLeft = Math.max(left, 0);
      const clippedRight = Math.min(right, width);
      const seg = document.createElement('div');
      seg.className = `phase-seg phase-${i % 6}`;
      seg.style.left = `${clippedLeft}px`;
      seg.style.width = `${Math.max(0, clippedRight - clippedLeft)}px`;
      seg.title = p.label;
      if (p.color) seg.style.background = p.color;

      const label = document.createElement('span');
      label.className = 'phase-seg-label';
      // p.label is already escaped in resolvePhases; the icon span is trusted.
      label.innerHTML = `${iconSpanHtml(p.icon)}${p.label}`;
      seg.appendChild(label);

      if (this.editable) {
        seg.addEventListener('pointerdown', (e) => this.beginDrag(e, seg, p, 'move'));
        const handleL = document.createElement('div');
        handleL.className = 'phase-seg-handle left';
        handleL.addEventListener('pointerdown', (e) => this.beginDrag(e, seg, p, 'resize-l'));
        const handleR = document.createElement('div');
        handleR.className = 'phase-seg-handle right';
        handleR.addEventListener('pointerdown', (e) => this.beginDrag(e, seg, p, 'resize-r'));
        seg.append(handleL, handleR);
      }

      this.band.appendChild(seg);
    });
  }

  private beginDrag(e: PointerEvent, seg: HTMLElement, phase: ResolvedPhase, mode: DragMode): void {
    if (!this.editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const width = this.contentWidth();
    const win = this.timeline.getWindow();
    const span = win.end.getTime() - win.start.getTime();
    if (!(span > 0) || !(width > 0)) return;

    const startMs = parseLocalDay(phase.start).getTime();
    const endMs = parseLocalDay(phase.end).getTime();
    this.drag = {
      phase,
      mode,
      originX: e.clientX,
      msPerPx: span / width,
      width,
      startMs,
      endMs,
      seg,
      newStart: startMs,
      newEnd: endMs,
      moved: false,
    };
    seg.classList.add('is-dragging');
    document.body.classList.add('phase-dragging');
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  private handlePointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    // Ignore sub-slop jitter so a plain click doesn't register as a drag.
    if (!d.moved && Math.abs(e.clientX - d.originX) < CLICK_SLOP_PX) return;
    d.moved = true;
    const dMs = (e.clientX - d.originX) * d.msPerPx;

    let start = d.startMs;
    let end = d.endMs;
    if (d.mode === 'move') {
      start += dMs;
      end += dMs;
    } else if (d.mode === 'resize-l') {
      start += dMs;
    } else {
      end += dMs;
    }

    start = snapToDay(start);
    end = snapToDay(end);
    // Keep at least one day of extent so a phase can't collapse or invert.
    if (d.mode === 'resize-l') start = Math.min(start, end - DAY_MS);
    else if (d.mode === 'resize-r') end = Math.max(end, start + DAY_MS);
    else if (end - start < DAY_MS) end = start + DAY_MS;

    d.newStart = start;
    d.newEnd = end;

    const left = this.toX(start);
    const right = this.toX(end);
    const clippedLeft = Math.max(left, 0);
    const clippedRight = Math.min(right, d.width);
    d.seg.style.left = `${clippedLeft}px`;
    d.seg.style.width = `${Math.max(0, clippedRight - clippedLeft)}px`;
  }

  private handlePointerUp(_e: PointerEvent): void {
    const d = this.drag;
    this.endDragListeners();
    if (!d) return;
    d.seg.classList.remove('is-dragging');
    document.body.classList.remove('phase-dragging');
    this.drag = null;

    if (!d.moved) {
      // A click, not a drag → open the phase in the side panel.
      this.scheduleRedraw();
      this.onSelect?.(d.phase.srcIndex);
      return;
    }

    const changed = d.newStart !== d.startMs || d.newEnd !== d.endMs;
    if (changed && this.onEdit) {
      this.onEdit({ srcIndex: d.phase.srcIndex, start: new Date(d.newStart), end: new Date(d.newEnd) });
    } else {
      // No net change — snap the segment back to its data-driven position.
      this.scheduleRedraw();
    }
  }

  private endDragListeners(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }
}

function snapToDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

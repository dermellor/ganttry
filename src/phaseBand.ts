import type { Timeline } from 'vis-timeline/standalone';
import { phaseCssId, type ResolvedPhase } from './buildItems';
import { iconSpanHtml } from './icons';

// Pointer travel (px) below which a press-release counts as a click, not a drag.
const CLICK_SLOP_PX = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A drag/resize result, reported to the host so it can persist the change. */
export type PhaseEdit = { srcIndex: number; start: Date; end: Date };

type DragMode = 'move' | 'resize-l' | 'resize-r';

type DragState = {
  phase: ResolvedPhase;
  mode: DragMode;
  originX: number;
  msPerPx: number;
  t0: number;
  span: number;
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

    timeline.on('changed', this.onChanged);
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
    this.scheduleRedraw();
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
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
    this.endDragListeners();
    this.resizeObserver.disconnect();
    this.timeline.off('changed', this.onChanged);
    this.band.remove();
    this.styleEl.remove();
  }

  private scheduleRedraw(): void {
    if (this.rafToken) return;
    this.rafToken = requestAnimationFrame(() => {
      this.rafToken = 0;
      this.redraw();
    });
  }

  private redraw(): void {
    // Don't rip out the segment the user is actively dragging.
    if (this.drag) return;
    this.band.innerHTML = '';
    if (!this.phases.length) return;

    const width = this.host.getBoundingClientRect().width;
    if (width <= 0) return;

    const win = this.timeline.getWindow();
    const t0 = win.start.getTime();
    const span = win.end.getTime() - t0;
    if (!(span > 0)) return;

    const xOf = (iso: string) => ((new Date(iso).getTime() - t0) / span) * width;

    this.phases.forEach((p, i) => {
      const left = xOf(p.start);
      const right = xOf(p.end);
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
      // keep the label visible when a phase starts off-screen to the left
      if (left < 0) label.style.marginLeft = `${Math.min(-left, clippedRight - clippedLeft - 4)}px`;
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

    const width = this.host.getBoundingClientRect().width;
    const win = this.timeline.getWindow();
    const t0 = win.start.getTime();
    const span = win.end.getTime() - t0;
    if (!(span > 0) || width <= 0) return;

    const startMs = new Date(phase.start).getTime();
    const endMs = new Date(phase.end).getTime();
    this.drag = {
      phase,
      mode,
      originX: e.clientX,
      msPerPx: span / width,
      t0,
      span,
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

    const left = ((start - d.t0) / d.span) * d.width;
    const right = ((end - d.t0) / d.span) * d.width;
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

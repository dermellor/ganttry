import type { Timeline } from 'vis-timeline/standalone';
import { phaseCssId, type ResolvedPhase } from './buildItems';

/**
 * Renders a labeled phase ribbon pinned to the top of the timeline's center
 * panel. Segments are positioned by mapping each phase's date range onto the
 * currently visible window, so the band stays aligned while zooming/panning.
 * It lives inside `.vis-panel.vis-center`, above the items — pair it with a
 * larger `margin.axis` so items start below the band.
 */
export class PhaseBand {
  private band: HTMLElement;
  private host: HTMLElement;
  private styleEl: HTMLStyleElement;
  private timeline: Timeline;
  private phases: ResolvedPhase[] = [];
  private resizeObserver: ResizeObserver;
  private rafToken = 0;
  private onChanged = () => this.scheduleRedraw();

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

  dispose(): void {
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
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
      label.textContent = p.label;
      seg.appendChild(label);
      this.band.appendChild(seg);
    });
  }
}

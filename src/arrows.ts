import type { Timeline } from 'vis-timeline/standalone';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Anchor = { left: number; right: number; top: number; bottom: number; midY: number };

export class DependencyArrows {
  private svg: SVGSVGElement;
  private host: HTMLElement;
  private deps: Map<string, string[]> = new Map();
  private timeline: Timeline;
  private resizeObserver: ResizeObserver;
  private rafToken = 0;
  private onChanged = () => this.scheduleRedraw();

  constructor(timeline: Timeline, container: HTMLElement) {
    this.timeline = timeline;
    const center = container.querySelector('.vis-panel.vis-center') as HTMLElement | null;
    if (!center) throw new Error('DependencyArrows: .vis-panel.vis-center not found');
    this.host = center;
    if (!this.host.style.position) this.host.style.position = 'relative';

    this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.svg.classList.add('timeline-arrows');
    Object.assign(this.svg.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '5',
    });
    this.host.appendChild(this.svg);

    timeline.on('changed', this.onChanged);
    this.resizeObserver = new ResizeObserver(this.onChanged);
    this.resizeObserver.observe(this.host);
  }

  setDependencies(deps: Map<string, string[]>): void {
    this.deps = deps;
    this.scheduleRedraw();
  }

  dispose(): void {
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
    this.resizeObserver.disconnect();
    this.timeline.off('changed', this.onChanged);
    this.svg.remove();
  }

  private scheduleRedraw(): void {
    if (this.rafToken) return;
    this.rafToken = requestAnimationFrame(() => {
      this.rafToken = 0;
      this.redraw();
    });
  }

  private getAnchor(id: string): Anchor | null {
    const internal = (this.timeline as any).itemSet?.items;
    if (!internal) return null;
    const item = internal[id];
    if (!item || item.displayed === false) return null;
    const dom: HTMLElement | undefined = item.dom?.box ?? item.dom?.point ?? item.dom?.dot;
    if (!dom || !dom.getBoundingClientRect) return null;
    const r = dom.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      midY: r.top + r.height / 2,
    };
  }

  private redraw(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    if (this.deps.size === 0) return;

    const hostRect = this.host.getBoundingClientRect();

    const defs = document.createElementNS(SVG_NS, 'defs');
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', 'tl-arrow-head');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto');
    const arrowPath = document.createElementNS(SVG_NS, 'path');
    arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    arrowPath.setAttribute('fill', 'currentColor');
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    this.svg.appendChild(defs);

    for (const [targetId, sources] of this.deps) {
      const target = this.getAnchor(targetId);
      if (!target) continue;
      for (const sourceId of sources) {
        const source = this.getAnchor(sourceId);
        if (!source) continue;

        const x1 = source.right - hostRect.left;
        const y1 = source.midY - hostRect.top;
        const x2 = target.left - hostRect.left;
        const y2 = target.midY - hostRect.top;

        // Skip if completely off-canvas in the host's coord system
        const w = hostRect.width;
        const h = hostRect.height;
        if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > w) continue;
        if (Math.max(y1, y2) < 0 || Math.min(y1, y2) > h) continue;

        // Draw forward (downstream) arrows only — skip if source is to the right of target
        if (x1 > x2 + 4) continue;

        const dx = Math.max(24, Math.abs(x2 - x1) / 2);
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute(
          'd',
          `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 3} ${y2}`,
        );
        path.setAttribute('marker-end', 'url(#tl-arrow-head)');
        path.classList.add('dep-arrow');
        this.svg.appendChild(path);
      }
    }
  }
}

import type { Timeline } from 'vis-timeline/standalone';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Anchor = { left: number; right: number; top: number; bottom: number; midY: number };
type Pt = { x: number; y: number };

const STUB = 12; // horizontal lead-out/lead-in at each item edge
const CORRIDOR = 22; // vertical detour below same-row items in the backward case
const CORNER = 6; // corner rounding radius

// Right-angle connector from a predecessor's finish edge (x1,y1) to a
// successor's start edge (x2,y2). When the successor starts well to the right
// there's one vertical step; when it starts before the predecessor finishes
// (overlap / same row) the path drops into a corridor, runs back left, and
// re-enters from the correct side so it never doubles back through an item.
function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
  let pts: Pt[];
  if (x2 >= x1 + 2 * STUB) {
    const midX = (x1 + x2) / 2;
    pts = [
      { x: x1, y: y1 },
      { x: midX, y: y1 },
      { x: midX, y: y2 },
      { x: x2, y: y2 },
    ];
  } else {
    const corridorY =
      Math.abs(y2 - y1) > 2 * CORRIDOR ? (y1 + y2) / 2 : Math.max(y1, y2) + CORRIDOR;
    pts = [
      { x: x1, y: y1 },
      { x: x1 + STUB, y: y1 },
      { x: x1 + STUB, y: corridorY },
      { x: x2 - STUB, y: corridorY },
      { x: x2 - STUB, y: y2 },
      { x: x2, y: y2 },
    ];
  }
  return roundedPath(pts);
}

// Renders a polyline through `pts` with rounded corners (quadratic arcs).
function roundedPath(pts: Pt[]): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const len1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const len2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len1 === 0 || len2 === 0) {
      d += ` L ${p1.x} ${p1.y}`;
      continue;
    }
    const r = Math.min(CORNER, len1 / 2, len2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / len1) * r, y: p1.y - ((p1.y - p0.y) / len1) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / len2) * r, y: p1.y + ((p2.y - p1.y) / len2) * r };
    d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

export class DependencyArrows {
  private svg: SVGSVGElement;
  private host: HTMLElement;
  private deps: Map<string, string[]> = new Map();
  private timeline: Timeline;
  private resizeObserver: ResizeObserver;
  private rafToken = 0;
  private settleTimers: ReturnType<typeof setTimeout>[] = [];
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
    // The first redraw can run before vis-timeline has positioned the items, so
    // getAnchor() returns null and nothing is drawn. On a static page no further
    // 'changed' event fires to correct it, so self-heal with a few delayed
    // redraws until the item DOM has settled.
    this.clearSettleTimers();
    if (deps.size > 0) {
      for (const ms of [80, 240, 600]) {
        this.settleTimers.push(setTimeout(() => this.scheduleRedraw(), ms));
      }
    }
  }

  private clearSettleTimers(): void {
    for (const t of this.settleTimers) clearTimeout(t);
    this.settleTimers = [];
  }

  dispose(): void {
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
    this.clearSettleTimers();
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

        // Orthogonal "Gantt" elbow: leave the predecessor's finish edge, run
        // through a vertical corridor, and enter the successor's start edge
        // horizontally (so the arrowhead points cleanly into it).
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', elbowPath(x1, y1, x2, y2));
        path.setAttribute('marker-end', 'url(#tl-arrow-head)');
        path.classList.add('dep-arrow');
        this.svg.appendChild(path);
      }
    }
  }
}

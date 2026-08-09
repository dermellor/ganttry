import type { Timeline } from 'vis-timeline/standalone';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Anchor = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  midY: number;
  // Where the item's finish actually sits on the time axis. For a range that is
  // the right edge; for a milestone it is the dot, because the box around it is
  // only as wide as its caption (see `point`).
  finishX: number;
  // Where an incoming arrow's head has to stop. A range takes it on the left
  // edge, a milestone a few pixels clear of its mark: the mark overhangs the
  // box to the left, so aiming at `left` buries the head inside the diamond
  // instead of pointing at it.
  startX: number;
  // A milestone. Its box width is a typographic accident, not a duration, so
  // every rule that reads `right` as "the finish" is wrong for it.
  point: boolean;
};
type Pt = { x: number; y: number };

const STUB = 12; // horizontal lead-out/lead-in at each item edge
const CORNER = 6; // corner rounding radius
const INSET = 14; // how far in from the box corner the tight-case connector attaches
const ENTRY_GAP = 12; // vertical spacing between multiple arrows entering one target
const MARK_GAP = 4; // clearance between an arrowhead and a milestone's mark

// Right-angle connector from a predecessor (finish) to a successor (start),
// given both items' boxes in host coordinates.
//
//  • Roomy — the successor starts well to the right of the predecessor's finish:
//    the classic Gantt elbow, leaving the finish edge (right, mid-height) and
//    entering the start edge (left, mid-height) so the arrow points cleanly in.
//
//  • Tight / overlapping — the successor starts at or before the predecessor's
//    finish (back-to-back rows). A right→left elbow would have to double back
//    through the cramped gap. Instead the line leaves the predecessor's *bottom*
//    edge near its right end (its finish) and drops down into the successor's
//    *left* edge at mid-height (arrow pointing right, into the start). It still
//    reads "A must finish before B starts" without backtracking through the gap.
//    Mirrored (leaves the top edge) when the successor sits above.
//
//  • Milestone predecessor — always takes the vertical lead-out, anchored on the
//    dot rather than on the box's right edge. A milestone has no duration: its
//    box is as wide as its caption, so leaving at the right edge starts the arrow
//    at a moment the milestone never occupied, and a long caption drags the
//    departure days into the future. The horizontal elbow is unusable here for a
//    second reason — from the dot it would have to cross the caption to get out.
//
//  • Milestone successor — the head stops short of the mark (`startX`) instead of
//    on the box's left edge, which sits *inside* the mark and hides the head in it.
export function connector(s: Anchor, t: Anchor): string {
  if (!s.point && t.startX >= s.right + 2 * STUB) {
    const x1 = s.finishX;
    const x2 = t.startX;
    const midX = (x1 + x2) / 2;
    return roundedPath([
      { x: x1, y: s.midY },
      { x: midX, y: s.midY },
      { x: midX, y: t.midY },
      { x: x2, y: t.midY },
    ]);
  }

  const down = t.midY >= s.midY;
  const sy = down ? s.bottom : s.top; // leave the bottom (or top) edge…
  // …under the finish: the dot for a milestone, near the right end for a range.
  const sx = s.point ? s.finishX : Math.max(s.left + STUB, s.right - INSET);

  if (sx <= t.startX) {
    // A's finish sits left of B's start: drop straight down (up), then run into
    // B's left edge — a clean L, arrow pointing right.
    return roundedPath([
      { x: sx, y: sy },
      { x: sx, y: t.midY },
      { x: t.startX, y: t.midY },
    ]);
  }

  // Genuine overlap: A's finish is right of B's start. Drop into a corridor,
  // slide left to just before B's start, then come into B's left edge from the
  // left so the arrow still points right.
  const leadX = t.startX - STUB;
  const cy = (sy + t.midY) / 2;
  return roundedPath([
    { x: sx, y: sy },
    { x: sx, y: cy },
    { x: leadX, y: cy },
    { x: leadX, y: t.midY },
    { x: t.startX, y: t.midY },
  ]);
}

// Shift an anchor (viewport coords) into the SVG host's coordinate system.
function translate(a: Anchor, host: DOMRect): Anchor {
  return {
    left: a.left - host.left,
    right: a.right - host.left,
    top: a.top - host.top,
    bottom: a.bottom - host.top,
    midY: a.midY - host.top,
    finishX: a.finishX - host.left,
    startX: a.startX - host.left,
    point: a.point,
  };
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

    // A point item renders as dot + caption to its right, and vis-timeline sizes
    // the element to the caption while placing the *dot* on the date. Measuring
    // the dot is what ties the arrow to the moment rather than to the caption's
    // length; deriving it from the box would make a renamed milestone move its
    // arrows.
    const dotRect =
      item.dom?.point && item.dom?.dot?.getBoundingClientRect
        ? (item.dom.dot as HTMLElement).getBoundingClientRect()
        : null;
    const point = !!dotRect && dotRect.width > 0;

    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      midY: r.top + r.height / 2,
      finishX: point ? dotRect!.left + dotRect!.width / 2 : r.right,
      // The mark hangs over the box's left edge, so `left` is already inside it.
      startX: point ? dotRect!.left - MARK_GAP : r.left,
      point,
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

    const w = hostRect.width;
    const h = hostRect.height;

    const addArrow = (d: string, head: boolean): void => {
      if (!d) return;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      if (head) path.setAttribute('marker-end', 'url(#tl-arrow-head)');
      path.classList.add('dep-arrow');
      this.svg.appendChild(path);
    };

    for (const [targetId, sources] of this.deps) {
      const target = this.getAnchor(targetId);
      if (!target) continue;
      const t = translate(target, hostRect);

      // Resolve + translate on-canvas source boxes.
      const ss: Anchor[] = [];
      for (const sourceId of sources) {
        const source = this.getAnchor(sourceId);
        if (!source) continue;
        const s = translate(source, hostRect);
        if (Math.max(s.finishX, t.startX) < 0 || Math.min(s.finishX, t.startX) > w) continue;
        if (Math.max(s.midY, t.midY) < 0 || Math.min(s.midY, t.midY) > h) continue;
        ss.push(s);
      }

      if (ss.length === 1) {
        addArrow(connector(ss[0], t), true);
      } else if (ss.length >= 2) {
        // Several predecessors on one target: give each its own arrow but stagger
        // the entry points along the target's left edge so they don't stack into
        // a single-looking arrow. Order top→bottom so the vertical order of the
        // entries matches the vertical order of the sources (no crossing).
        const sorted = [...ss].sort((a, b) => a.midY - b.midY);
        const n = sorted.length;
        const span = Math.min(t.bottom - t.top - 8, (n - 1) * ENTRY_GAP);
        sorted.forEach((s, i) => {
          const dy = span * (i / (n - 1) - 0.5);
          addArrow(connector(s, { ...t, midY: t.midY + dy }), true);
        });
      }
    }
  }
}

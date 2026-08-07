// Shared placement for the pricing view's floating layers: the feature-description
// tooltip (pricingMatrix.ts) and the matrix cell editor (cellEditor.ts).
//
// Both live on <body> and are position:fixed rather than being nested in the
// table. The table wrap carries `overflow-x` for horizontal scrolling, and
// overflow-x also clips overflow-y — so a layer positioned inside it would be cut
// off at the row's top/bottom edge. Fixed-on-body escapes that clip and still
// lets the layer sit right next to its anchor.

/** Create (once) and return a fixed layer on <body>, identified by `id`. */
export function ensureLayer(id: string, className: string, role: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = className;
    el.setAttribute('role', role);
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Place `layer` just below `anchor`, flipping above it when it would overflow the
 * bottom and clamping the left edge into the viewport. Guarding each adjustment on
 * a known viewport metric avoids a spurious flip/clamp when they are unavailable
 * (e.g. a not-yet-painted tab reports 0).
 */
export function positionLayer(layer: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const gap = 8;
  const lw = layer.offsetWidth;
  const lh = layer.offsetHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  let left = r.left;
  let top = r.bottom + gap;
  if (vh > 0 && top + lh > vh - gap) top = r.top - gap - lh;
  if (vw > 0) left = Math.max(gap, Math.min(left, vw - gap - lw));
  top = Math.max(gap, top);
  layer.style.left = `${left}px`;
  layer.style.top = `${top}px`;
}

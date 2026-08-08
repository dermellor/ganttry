// The product-roadmap plugin's lazily-loaded module surface: the pricing matrix,
// the cards and the editors behind them. The registry reaches this file through a
// dynamic import, so Rollup emits everything below as its own chunk and a generic
// build downloads none of it.
//
// The stylesheet is imported *here* rather than linked from index.html, which is
// what puts it in the chunk too: a deploy without this plugin now ships neither its
// code nor its CSS.
import './pricing.css';

import { renderPricingView } from './pricingMatrix';

/** Render a view of this plugin into the host section the app created for it. */
export function renderView(container: HTMLElement, viewId: string): void {
  if (viewId !== 'pricing') return;
  // The host gives every plugin view the same neutral `.plugin-view` box; the
  // layout this view needs (flex column, pinned header, scrolling body) comes from
  // the plugin's own stylesheet, so it claims its class on the container it got.
  container.classList.add('pricing-view');
  renderPricingView(container);
}

// The product-roadmap plugin's lazily-loaded module surface: the pricing matrix,
// the cards and the editors behind them. The registry reaches this file through a
// dynamic import, so Rollup emits everything below as its own chunk and a generic
// build downloads none of it.
//
// The stylesheet is imported *here* rather than linked from index.html, which is
// what puts it in the chunk too: a deploy without this plugin now ships neither its
// code nor its CSS.
import './pricing.css';

import type { HostApi } from '../../pluginHost/api';
import { beginRender } from './host';
import { renderPricingView } from './pricingMatrix';

/**
 * Render a view of this plugin into the host section the app created for it.
 *
 * The `host` argument is where everything this plugin knows about the app comes
 * from now. It used to read `state.activeSourceFile` directly — the privilege #117
 * removed, and the reason the plugin could not find a single gap in the contract it
 * was supposed to be proving.
 *
 * Async because the snapshot is: `beginRender` awaits the timeline and the
 * writability once, and the render tree below reads both synchronously from
 * `./host.ts`. The host already handles an async `renderView` — it renders into a
 * detached element and swaps it in when the call settles, so two repaints cannot
 * interleave.
 */
export async function renderView(container: HTMLElement, viewId: string, host: HostApi): Promise<void> {
  if (viewId !== 'pricing') return;
  await beginRender(host);
  // The host gives every plugin view the same neutral `.plugin-view` box; the
  // layout this view needs (flex column, pinned header, scrolling body) comes from
  // the plugin's own stylesheet, so it claims its class on the container it got.
  container.classList.add('pricing-view');
  renderPricingView(container);
}

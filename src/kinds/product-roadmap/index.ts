// Product-roadmap kind module surface (the pricing matrix/cards + feature form).
// Loaded lazily by the registry (dynamic import) so the generic bundle carries
// no pricing code. Step 1 re-exports the still-in-place pricing modules; a later
// step moves the cluster under this folder.

import { renderPricingView } from './pricingMatrix';

/** Render the pricing view into its host section (#pricing). */
export function renderView(): void {
  renderPricingView();
}

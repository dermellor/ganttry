// Card view for product pricing: one card per tier (website-style), each listing
// the curated highlight tiles the tier includes. Highlights (pricing.highlights)
// bundle raw features into simplified tiles; per-tier presence/value is derived
// from the tiers' existing `values` via resolveHighlight. Read-only.

import { escapeHtml } from './buildItems';
import { resolveHighlight } from './pricing';
import type { TimelineFile } from './types';

/** HTML for the tier cards, or an empty-state note when no highlights are defined. */
export function renderCardsHtml(
  file: TimelineFile,
  versions: string[],
  selected: string | null,
): string {
  const p = file.pricing!;
  const highlights = p.highlights ?? [];
  if (!highlights.length) {
    return '<p class="pricing-empty">Keine Highlight-Kacheln definiert. In der Matrix-Ansicht sind alle Features sichtbar; für die Kacheln müssen Highlights im Preismodell hinterlegt werden (pricing.highlights).</p>';
  }

  const cards = p.tiers
    .map((tier) => {
      const tiles = highlights
        .map((h) => {
          const r = resolveHighlight(h, tier, p.features, versions, selected);
          if (!r.included) return '';
          const val = r.parts.join(', ');
          return (
            `<li class="pc-tile">` +
            `<span class="pc-tile-label">${escapeHtml(h.label)}</span>` +
            (val ? `<span class="pc-tile-val">${escapeHtml(val)}</span>` : '') +
            `</li>`
          );
        })
        .filter(Boolean)
        .join('');
      return (
        `<article class="pc-card">` +
        `<header class="pc-card-head">` +
        `<h3 class="pc-card-name">${escapeHtml(tier.name)}</h3>` +
        `<div class="pc-card-price">${escapeHtml(tier.price)}</div>` +
        `</header>` +
        (tiles
          ? `<ul class="pc-tiles">${tiles}</ul>`
          : '<p class="pc-card-empty">—</p>') +
        `</article>`
      );
    })
    .join('');

  return `<div class="pc-cards">${cards}</div>`;
}

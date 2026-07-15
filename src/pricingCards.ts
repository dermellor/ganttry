// Card view for product pricing — mirrors the /render pricing-card look:
// centered name + tagline + big split price, a divider, then sections with a
// green circle-check per included feature, value features shown as "Label: value",
// and higher tiers collapsing carried-over features into a single
// "← Alles aus <prev>" row (arrow + pill). Read-only; highlights are the curated
// layer (pricing.highlights). Class names + SVGs match the rendered original.

import { escapeHtml } from './buildItems';
import { resolveHighlight, itemsForFeatures, type ResolvedHighlight } from './pricing';
import { workDotHtml } from './pricingWork';
import type { PricingHighlight, PricingTier, TimelineFile, TimelineFileItem } from './types';

const DEFAULT_SECTION = 'Weitere';

// Green circle-check (included) and grey left arrow (inheritance) — same glyphs
// as the /render output; the arrow points left toward the tier it inherits from.
const CHECK_SVG =
  '<svg class="pc-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<path d="m15.698 8.237-5.165 5.614L8.83 11.77l-1.16.95 1.885 2.304a1.25 1.25 0 0 0 1.887.055l5.36-5.826-1.104-1.016Z" fill="currentColor"/>' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2ZM3.5 12a8.5 8.5 0 1 1 17 0 8.5 8.5 0 0 1-17 0Z" fill="currentColor"/></svg>';
const ARROW_SVG =
  '<svg class="pc-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

function sectionsOf(highlights: PricingHighlight[]): { section: string; items: PricingHighlight[] }[] {
  const order: string[] = [];
  const by = new Map<string, PricingHighlight[]>();
  for (const h of highlights) {
    const s = h.section?.trim() || DEFAULT_SECTION;
    if (!by.has(s)) {
      by.set(s, []);
      order.push(s);
    }
    by.get(s)!.push(h);
  }
  return order.map((section) => ({ section, items: by.get(section)! }));
}

function checkRow(inner: string, dot: string): string {
  return (
    `<li class="pc-feat pc-yes">${CHECK_SVG}<span>${inner}</span>` +
    (dot ? `<span class="pc-feat-work">${dot}</span>` : '') +
    `</li>`
  );
}

function bulletHtml(h: PricingHighlight, r: ResolvedHighlight, dot: string): string {
  if (r.value) {
    return checkRow(
      `<span class="pc-label">${escapeHtml(h.label)}:</span> <span class="pc-value">${escapeHtml(r.value)}</span>`,
      dot,
    );
  }
  return checkRow(escapeHtml(h.label), dot);
}

// Split a price string ("ab 449 €/Monat") into the big number + currency and a
// per-month suffix, matching the /render price typography.
function priceHtml(price: string): string {
  const m = price.match(/^\s*(ab\s+)?([\d.]+)(?:,(\d+))?\s*(€)?\s*(.*)$/);
  if (!m) return `<div class="pc-price"><span class="pc-price-whole">${escapeHtml(price)}</span></div>`;
  const [, prefix, whole, frac, cur, rest] = m;
  const side =
    (frac ? `<span class="pc-price-frac">,${escapeHtml(frac)}</span>` : '') +
    (cur ? `<span class="pc-price-cur">${escapeHtml(cur)}</span>` : '');
  return (
    `<div class="pc-price">` +
    (prefix ? `<span class="pc-price-prefix">${escapeHtml(prefix.trim())}</span>` : '') +
    `<span class="pc-price-whole">${escapeHtml(whole)}</span>` +
    (side ? `<span class="pc-price-side">${side}</span>` : '') +
    `</div>` +
    (rest.trim() ? `<div class="pc-permonth">${escapeHtml(rest.trim())}</div>` : '')
  );
}

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
  const sections = sectionsOf(highlights);
  const allItems: TimelineFileItem[] = file.items ?? [];

  const cards = p.tiers
    .map((tier, i) => {
      const prev: PricingTier | undefined = p.tiers[i - 1];
      const body = sections
        .map(({ section, items }) => {
          const rows = items.map((h) => ({
            h,
            cur: resolveHighlight(h, tier, p.features, versions, selected),
            prev: prev
              ? resolveHighlight(h, prev, p.features, versions, selected)
              : { included: false, value: '' },
          }));
          const included = rows.filter((r) => r.cur.included);
          if (!included.length) return '';
          const changed = included.filter((r) => !(r.prev.included && r.prev.value === r.cur.value));
          const inheritedCount = included.length - changed.length;

          const lines: string[] = [];
          if (inheritedCount > 0 && prev) {
            lines.push(
              `<li class="pc-feat pc-arrow">${ARROW_SVG}<span>Alles aus <span class="pc-pill">${escapeHtml(prev.name)}</span></span></li>`,
            );
          }
          for (const r of changed) {
            const dot = workDotHtml(itemsForFeatures(r.h.featureIds, allItems, selected));
            lines.push(bulletHtml(r.h, r.cur, dot));
          }
          return `<p class="pc-section-label">${escapeHtml(section)}</p><ul class="pc-features">${lines.join('')}</ul>`;
        })
        .join('');

      return (
        `<article class="pc-card">` +
        `<div class="pc-name">${escapeHtml(tier.name)}</div>` +
        `<div class="pc-suit">${tier.tagline ? escapeHtml(tier.tagline) : ''}</div>` +
        priceHtml(tier.price) +
        `<hr class="pc-divider" />` +
        `<div class="pc-body">${body || '<p class="pc-card-empty">—</p>'}</div>` +
        `</article>`
      );
    })
    .join('');

  return `<div class="pc-cards">${cards}</div>`;
}

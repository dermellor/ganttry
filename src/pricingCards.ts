// Card view for product pricing — website-style tier cards. Each card shows the
// tier's tagline + price and, per section, the included highlight bullets:
// value highlights render "Label: value", boolean highlights render as a check.
// Higher tiers collapse features carried over from the tier to their left into a
// single "Alles aus <prev>" line and list only the delta — mirroring the real
// pricing cards. Read-only; highlights (pricing.highlights) are the curated layer.

import { escapeHtml } from './buildItems';
import { resolveHighlight, type ResolvedHighlight } from './pricing';
import type { PricingHighlight, PricingTier, TimelineFile } from './types';

const DEFAULT_SECTION = 'Weitere';

// Sections in first-seen order, each with its highlights (order preserved).
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

function bulletHtml(h: PricingHighlight, r: ResolvedHighlight): string {
  if (r.value) {
    return (
      `<li class="pc-row pc-row-value">` +
      `<span class="pc-row-label">${escapeHtml(h.label)}</span>` +
      `<span class="pc-row-value-text">${escapeHtml(r.value)}</span>` +
      `</li>`
    );
  }
  return (
    `<li class="pc-row"><span class="pc-check" aria-hidden="true">✓</span>` +
    `<span class="pc-row-label">${escapeHtml(h.label)}</span></li>`
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

  const cards = p.tiers
    .map((tier, i) => {
      const prev: PricingTier | undefined = p.tiers[i - 1];
      const sectionHtml = sections
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
          // Inherited = present in the previous tier with the same value.
          const inherited = included.filter((r) => r.prev.included && r.prev.value === r.cur.value);
          const changed = included.filter((r) => !(r.prev.included && r.prev.value === r.cur.value));

          const lines: string[] = [];
          if (inherited.length && prev) {
            lines.push(
              `<li class="pc-row pc-inherit"><span class="pc-check" aria-hidden="true">✓</span>` +
                `<span class="pc-row-label">Alles aus ${escapeHtml(prev.name)}</span></li>`,
            );
          }
          for (const r of changed) lines.push(bulletHtml(r.h, r.cur));
          return (
            `<div class="pc-section">` +
            `<div class="pc-section-head">${escapeHtml(section)}</div>` +
            `<ul class="pc-rows">${lines.join('')}</ul>` +
            `</div>`
          );
        })
        .join('');

      return (
        `<article class="pc-card">` +
        `<header class="pc-card-head">` +
        `<h3 class="pc-card-name">${escapeHtml(tier.name)}</h3>` +
        (tier.tagline ? `<div class="pc-card-tagline">${escapeHtml(tier.tagline)}</div>` : '') +
        `<div class="pc-card-price">${escapeHtml(tier.price)}</div>` +
        `</header>` +
        `<div class="pc-card-body">${sectionHtml || '<p class="pc-card-empty">—</p>'}</div>` +
        `</article>`
      );
    })
    .join('');

  return `<div class="pc-cards">${cards}</div>`;
}

// Read-only pricing matrix for product timelines. Renders the timeline's
// `pricing` model (tiers × features) into the #pricing section, plus a per-feature
// count of roadmap items assigned to it (metadata.featureIds), tying the two
// entities together. A version switcher filters the feature rows cumulatively
// (features available up to the chosen version). Edits happen via MCP
// `set_pricing` / the item form, not here.

import { escapeHtml } from './buildItems';
import { groupFeatures, featureVisibleForVersion } from './pricing';
import { state, els } from './state';
import { PRICING_FEATURE_META_KEY, type TimelineFile } from './types';

const PRICING_VERSION_KEY = 'timelines.pricingVersion';

// Selected version for the switcher. null = "Alle" (no filter). Persisted so the
// choice survives re-renders (realtime, edits) and reloads.
let selectedVersion: string | null = localStorage.getItem(PRICING_VERSION_KEY) || null;

function readItemFeatureIds(meta: unknown): string[] {
  const v = (meta as Record<string, unknown> | undefined)?.[PRICING_FEATURE_META_KEY];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

// Count roadmap items assigned to each feature id, for the "Roadmap" column.
function itemCountsByFeature(file: TimelineFile): Map<string, number> {
  const counts = new Map<string, number>();
  for (const it of file.items) {
    for (const fid of readItemFeatureIds(it.metadata)) {
      counts.set(fid, (counts.get(fid) ?? 0) + 1);
    }
  }
  return counts;
}

/** True when the active timeline is a product timeline with a populated pricing model. */
export function hasPricing(file: TimelineFile | null | undefined): file is TimelineFile {
  return (
    !!file &&
    file.type === 'product' &&
    !!file.pricing &&
    (file.pricing.tiers.length > 0 || file.pricing.features.length > 0)
  );
}

export function renderPricingMatrix(): void {
  const file = state.activeSourceFile;
  const host = els.pricing;
  if (!host) return;
  if (!hasPricing(file)) {
    host.innerHTML = '<p class="pricing-empty">Kein Preismodell hinterlegt.</p>';
    return;
  }

  const { tiers, features } = file.pricing!;
  const versions = file.pricing!.versions ?? [];
  // Reset a stale selection that isn't part of the current version list.
  if (selectedVersion && !versions.includes(selectedVersion)) selectedVersion = null;

  const counts = itemCountsByFeature(file);
  const anyCounts = [...counts.values()].some((n) => n > 0);
  const totalCols = tiers.length + 1 + (anyCounts ? 1 : 0);

  const head =
    `<tr><th class="pm-feature">Feature</th>` +
    tiers.map((t) => `<th class="pm-tier">${escapeHtml(t.name)}</th>`).join('') +
    (anyCounts ? `<th class="pm-count" title="Zugeordnete Roadmap-Items">Roadmap</th>` : '') +
    `</tr>`;

  const priceRow =
    `<tr class="pm-price-row"><th class="pm-feature">Preis</th>` +
    tiers.map((t) => `<td class="pm-tier">${escapeHtml(t.price)}</td>`).join('') +
    (anyCounts ? `<td class="pm-count"></td>` : '') +
    `</tr>`;

  const bodyRows: string[] = [];
  for (const { group, features: fs } of groupFeatures(features)) {
    const visible = fs.filter((f) => featureVisibleForVersion(f, versions, selectedVersion));
    if (!visible.length) continue; // skip a group with no visible features
    if (group) {
      bodyRows.push(
        `<tr class="pm-group-row"><th class="pm-feature" colspan="${totalCols}">${escapeHtml(group)}</th></tr>`,
      );
    }
    for (const f of visible) {
      const cells = tiers
        .map((t) => {
          const v = t.values?.[f.id];
          if (v === true) {
            return `<td class="pm-cell is-on"><span class="pm-check" aria-label="enthalten">✓</span></td>`;
          }
          if (v === false || v == null || v === '') {
            return `<td class="pm-cell is-off"><span class="pm-dash" aria-hidden="true">–</span></td>`;
          }
          return `<td class="pm-cell is-value">${escapeHtml(String(v))}</td>`;
        })
        .join('');
      const count = counts.get(f.id) ?? 0;
      const countCell = anyCounts
        ? `<td class="pm-count">${count > 0 ? `<span class="pm-count-badge">${count}</span>` : ''}</td>`
        : '';
      const versionAttr = f.version ? ` title="ab Version ${escapeHtml(f.version)}"` : '';
      bodyRows.push(
        `<tr${versionAttr}><th class="pm-feature" scope="row">${escapeHtml(f.name)}</th>${cells}${countCell}</tr>`,
      );
    }
  }

  const switcher = versions.length
    ? `<label class="pm-version-switch">Version` +
      `<select class="pm-version-select">` +
      `<option value="">Alle</option>` +
      versions
        .map(
          (v) =>
            `<option value="${escapeHtml(v)}"${v === selectedVersion ? ' selected' : ''}>${escapeHtml(v)}</option>`,
        )
        .join('') +
      `</select></label>`
    : '';

  host.innerHTML =
    `<div class="pricing-inner">` +
    `<div class="pricing-header">` +
    `<h2 class="pricing-title">${escapeHtml(file.name ?? 'Preismodell')} — Preise</h2>` +
    switcher +
    `</div>` +
    `<div class="pricing-table-wrap"><table class="pricing-table"><thead>${head}${priceRow}</thead><tbody>${bodyRows.join('')}</tbody></table></div>` +
    `</div>`;

  const select = host.querySelector<HTMLSelectElement>('.pm-version-select');
  select?.addEventListener('change', () => {
    selectedVersion = select.value || null;
    if (selectedVersion) localStorage.setItem(PRICING_VERSION_KEY, selectedVersion);
    else localStorage.removeItem(PRICING_VERSION_KEY);
    renderPricingMatrix();
  });
}

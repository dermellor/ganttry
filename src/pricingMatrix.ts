// Pricing matrix for product timelines. Renders the timeline's `pricing`
// model (tiers × features). Each feature row carries a work indicator: an
// aggregate status dot (derived from the built-in item status of the roadmap
// items linked to that feature) plus a popover listing those items — each
// click opens the item in the detail drawer. A version switcher filters both
// the feature rows (cumulative) and the work items (exact selected version).
// On editable (DB-backed) timelines, clicking a feature row itself opens its
// Stammdaten in the same drawer (featureForm.ts). Tier/highlight editing still
// happens via the item form / MCP, not here.

import { escapeHtml } from './buildItems';
import {
  groupFeatures,
  featureVisibleForVersion,
  isNewFeature,
  isModifiedFeature,
  itemsForFeature,
  needsWorkWarning,
  readItemFeatureIds,
  resolveFeatureName,
} from './pricing';
import { state, els, isEditableView } from './state';
import { showDetailForId } from './detailPanel';
import { showFeatureForm } from './featureForm';
import { renderCardsHtml } from './pricingCards';
import { workDotHtml } from './pricingWork';
import { type TimelineFile } from './types';

const PRICING_VERSION_KEY = 'timelines.pricingVersion';
const PRICING_SUBVIEW_KEY = 'timelines.pricingSubview';

type SubView = 'matrix' | 'cards';

// Selected version for the switcher. null = "Alle" (no filter). Persisted so the
// choice survives re-renders (realtime, edits) and reloads.
let selectedVersion: string | null = localStorage.getItem(PRICING_VERSION_KEY) || null;
// Matrix (full grid) vs cards (curated highlight tiles). Persisted.
let subView: SubView = localStorage.getItem(PRICING_SUBVIEW_KEY) === 'cards' ? 'cards' : 'matrix';

/** True when the active timeline is a product timeline with a populated pricing model. */
export function hasPricing(file: TimelineFile | null | undefined): file is TimelineFile {
  return (
    !!file &&
    file.type === 'product' &&
    !!file.pricing &&
    (file.pricing.tiers.length > 0 || file.pricing.features.length > 0)
  );
}

// Build the full matrix table HTML (tiers × features + work column).
function matrixHtml(file: TimelineFile, versions: string[], editable: boolean): string {
  const { tiers, features } = file.pricing!;
  const items = file.items ?? [];
  // Show the work column when any item is linked to any feature at all (regardless
  // of the current version filter — otherwise the column would flicker in/out), or
  // when a feature needs a "new but unworked" warning there (see needsWorkWarning).
  const anyLinked = items.some((it) => readItemFeatureIds(it.metadata).length > 0);
  const anyWarning = features.some((f) => needsWorkWarning(f, items, versions, selectedVersion));
  const showWorkCol = anyLinked || anyWarning;
  const totalCols = tiers.length + 1 + (showWorkCol ? 1 : 0);

  const head =
    `<tr><th class="pm-feature">Feature</th>` +
    tiers.map((t) => `<th class="pm-tier">${escapeHtml(t.name)}</th>`).join('') +
    (showWorkCol ? `<th class="pm-work-col" title="Roadmap-Arbeit an diesem Feature">Arbeit</th>` : '') +
    `</tr>`;

  const priceRow =
    `<tr class="pm-price-row"><th class="pm-feature">Preis</th>` +
    tiers.map((t) => `<td class="pm-tier">${escapeHtml(t.price)}</td>`).join('') +
    (showWorkCol ? `<td class="pm-work-col"></td>` : '') +
    `</tr>`;

  const bodyRows: string[] = [];
  for (const { group, features: fs } of groupFeatures(features)) {
    const visible = fs.filter((f) => featureVisibleForVersion(f, versions, selectedVersion));
    if (!visible.length) continue;
    if (group) {
      bodyRows.push(
        `<tr class="pm-group-row"><th class="pm-feature" colspan="${totalCols}">${escapeHtml(group)}</th></tr>`,
      );
    }
    for (const f of visible) {
      const cells = tiers
        .map((t) => {
          const v = t.values?.[f.id];
          if (v === true) return `<td class="pm-cell is-on"><span class="pm-check" aria-label="enthalten">✓</span></td>`;
          if (v === false || v == null || v === '')
            return `<td class="pm-cell is-off"><span class="pm-dash" aria-hidden="true">–</span></td>`;
          return `<td class="pm-cell is-value">${escapeHtml(String(v))}</td>`;
        })
        .join('');

      const workItems = itemsForFeature(f.id, items, selectedVersion);
      const workCell = showWorkCol
        ? `<td class="pm-work-col">${
            workItems.length
              ? workDotHtml(workItems)
              : needsWorkWarning(f, items, versions, selectedVersion)
                ? '<span class="pm-work-warn" title="Neu in dieser Version, aber noch keine Roadmap-Arbeit verknüpft" aria-label="Warnung: keine Roadmap-Arbeit verknüpft">⚠</span>'
                : ''
          }</td>`
        : '';

      const versionAttr = f.version ? ` title="ab Version ${escapeHtml(f.version)}"` : '';
      const badge = isNewFeature(f, versions, selectedVersion)
        ? '<span class="pricing-badge-new">Neu</span>'
        : isModifiedFeature(f, items, versions, selectedVersion)
          ? '<span class="pricing-badge-modified">Modified</span>'
          : '';
      const name = escapeHtml(resolveFeatureName(f, versions, selectedVersion));
      const featureThClass = editable ? 'pm-feature pm-feature-editable' : 'pm-feature';
      const featureThAttr = editable ? ` data-feature-id="${escapeHtml(f.id)}"` : '';
      bodyRows.push(
        `<tr${versionAttr}><th class="${featureThClass}" scope="row"${featureThAttr}>${name}${badge}</th>${cells}${workCell}</tr>`,
      );
    }
  }

  return `<div class="pricing-table-wrap"><table class="pricing-table"><thead>${head}${priceRow}</thead><tbody>${bodyRows.join('')}</tbody></table></div>`;
}

// Wire feature-row clicks to open the Stammdaten drawer (editable timelines
// only — matrixHtml only emits the [data-feature-id] attribute when editable).
function wireFeatureClicks(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>('.pm-feature-editable[data-feature-id]').forEach((th) => {
    th.addEventListener('click', () => {
      const id = th.dataset.featureId;
      if (id) showFeatureForm(id);
    });
  });
}

// Wire the work-popover item clicks + single-popover behaviour (matrix + cards).
function wireWork(host: HTMLElement): void {
  host.querySelectorAll<HTMLButtonElement>('.pm-work-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.itemId;
      if (id) showDetailForId(id);
    });
  });
  host.querySelectorAll<HTMLDetailsElement>('details.pm-work').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      host.querySelectorAll<HTMLDetailsElement>('details.pm-work[open]').forEach((o) => {
        if (o !== d) o.open = false;
      });
    });
  });
}

// Entry point for the pricing section: header (title + view toggle + version
// switcher) plus the chosen body (matrix grid or highlight cards).
export function renderPricingView(): void {
  const file = state.activeSourceFile;
  const host = els.pricing;
  if (!host) return;
  if (!hasPricing(file)) {
    host.innerHTML = '<p class="pricing-empty">Kein Preismodell hinterlegt.</p>';
    return;
  }

  const versions = file.pricing!.versions ?? [];
  if (selectedVersion && !versions.includes(selectedVersion)) selectedVersion = null;
  const hasHighlights = (file.pricing!.highlights?.length ?? 0) > 0;
  // Cards need highlights; fall back to matrix when none are defined.
  if (subView === 'cards' && !hasHighlights) subView = 'matrix';

  const editable = isEditableView();
  const body =
    subView === 'cards' ? renderCardsHtml(file, versions, selectedVersion) : matrixHtml(file, versions, editable);

  const toggle = hasHighlights
    ? `<div class="pm-subview" role="group" aria-label="Darstellung">` +
      `<button type="button" class="pm-subview-btn" data-sub="matrix" aria-pressed="${subView === 'matrix'}">Matrix</button>` +
      `<button type="button" class="pm-subview-btn" data-sub="cards" aria-pressed="${subView === 'cards'}">Kacheln</button>` +
      `</div>`
    : '';

  const switcher = versions.length
    ? `<label class="pm-version-switch">Version` +
      `<select class="pm-version-select"><option value="">Alle</option>` +
      versions
        .map((v) => `<option value="${escapeHtml(v)}"${v === selectedVersion ? ' selected' : ''}>${escapeHtml(v)}</option>`)
        .join('') +
      `</select></label>`
    : '';

  host.innerHTML =
    `<div class="pricing-inner">` +
    `<div class="pricing-header">` +
    `<h2 class="pricing-title">${escapeHtml(file.name ?? 'Preismodell')} — Preise</h2>` +
    `<div class="pricing-controls">${toggle}${switcher}</div>` +
    `</div>` +
    body +
    `</div>`;

  host.querySelector<HTMLSelectElement>('.pm-version-select')?.addEventListener('change', (e) => {
    const sel = e.currentTarget as HTMLSelectElement;
    selectedVersion = sel.value || null;
    if (selectedVersion) localStorage.setItem(PRICING_VERSION_KEY, selectedVersion);
    else localStorage.removeItem(PRICING_VERSION_KEY);
    renderPricingView();
  });

  host.querySelectorAll<HTMLButtonElement>('.pm-subview-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      subView = (btn.dataset.sub as SubView) === 'cards' ? 'cards' : 'matrix';
      localStorage.setItem(PRICING_SUBVIEW_KEY, subView);
      renderPricingView();
    });
  });

  wireWork(host);
  wireFeatureClicks(host);
}

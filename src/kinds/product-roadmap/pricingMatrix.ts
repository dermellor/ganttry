// Pricing matrix for product timelines. Renders the timeline's `pricing`
// model (tiers × features). Each feature row carries a work indicator: an
// aggregate status dot (derived from the built-in item status of the roadmap
// items linked to that feature) plus a popover listing those items — each
// click opens the item in the detail drawer. A version switcher filters both
// the feature rows (cumulative) and the work items (exact selected version).
// On editable (DB-backed) timelines, clicking a feature row itself opens its
// Stammdaten in the same drawer (featureForm.ts). Tier/highlight editing still
// happens via the item form / MCP, not here.

import { escapeHtml } from '../../buildItems';
import {
  groupFeatures,
  featureVisibleForVersion,
  cellActiveForVersion,
  isNewFeature,
  isModifiedFeature,
  itemsForFeature,
  needsWorkWarning,
  readItemFeatureIds,
  resolveFeatureName,
  resolveFeatureDescriptionParts,
} from './pricing';
import { state, els, isEditableView } from '../../state';
import { showDetailForId } from '../../detailPanel';
import { showFeatureForm } from './featureForm';
import { renderCardsHtml } from './pricingCards';
import { workDotHtml } from './pricingWork';
import { type TimelineFile, type PricingFeature } from '../../types';

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
          const off = v === false || v == null || v === '';
          const dash = `<td class="pm-cell is-off"><span class="pm-dash" aria-hidden="true">–</span></td>`;
          if (off) return dash;
          // Version-gated cell: not yet available at the pinned version → dash.
          // In "Alle" mode (no pin) show the end state plus an "ab <version>" chip
          // stating from which version this tier includes the feature (mirrors the
          // feature-row chip). No chip once a version is pinned — the gating itself
          // (cell present vs. dash) already carries the information.
          const af = t.valueVersions?.[f.id];
          if (!cellActiveForVersion(af, versions, selectedVersion)) return dash;
          const chip =
            !selectedVersion && af
              ? ` <span class="pricing-badge-version pm-cell-ver">ab ${escapeHtml(af)}</span>`
              : '';
          if (v === true)
            return `<td class="pm-cell is-on"><span class="pm-check" aria-label="enthalten">✓</span>${chip}</td>`;
          return `<td class="pm-cell is-value">${escapeHtml(String(v))}${chip}</td>`;
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

      // In "Alle" mode (no pinned version) the Neu/Modified badges never fire, so
      // instead show a neutral "ab <version>" chip stating when the feature was
      // introduced. Pre-existing features (no version) get no chip.
      const badge = isNewFeature(f, versions, selectedVersion)
        ? '<span class="pricing-badge-new">Neu</span>'
        : isModifiedFeature(f, items, versions, selectedVersion)
          ? '<span class="pricing-badge-modified">Modified</span>'
          : !selectedVersion && f.version
            ? `<span class="pricing-badge-version">ab ${escapeHtml(f.version)}</span>`
            : '';
      const name = escapeHtml(resolveFeatureName(f, versions, selectedVersion));
      const featureThClass = editable ? 'pm-feature pm-feature-editable' : 'pm-feature';
      // Info icon only when there's an actual description (base text or version
      // notes) — availability alone is already conveyed by the badge/switcher.
      // The icon is the tooltip trigger; it reads the feature id off the <th>.
      const { base, notes } = resolveFeatureDescriptionParts(f, versions);
      const info =
        base || notes.length
          ? `<span class="pm-info" tabindex="0" role="button" aria-label="Beschreibung anzeigen"></span>`
          : '';
      // data-feature-id is emitted always — it lets the info-icon tooltip look up
      // the feature in read-only views too. Click-to-edit stays gated by
      // pm-feature-editable.
      bodyRows.push(
        `<tr><th class="${featureThClass}" scope="row" data-feature-id="${escapeHtml(f.id)}">${name}${badge}${info}</th>${cells}${workCell}</tr>`,
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

// ---- feature description tooltip -------------------------------------------
// A single styled tooltip, reused across all feature rows and re-renders. It
// lives on <body> and is position:fixed, so the table's `overflow-x` clip (which
// also clips overflow-y) can't cut it off, and it can sit right next to the row.

function ensureTip(): HTMLElement {
  let tip = document.getElementById('pm-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'pm-tip';
    tip.className = 'pm-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

// Structured description → styled tooltip HTML: availability line, base
// description, then per-version notes laid out underneath each other. '' when
// there is nothing to show (so the caller can skip opening the tooltip).
function featureTipHtml(f: PricingFeature, versions: string[]): string {
  const { base, notes } = resolveFeatureDescriptionParts(f, versions);
  if (!f.version && !base && !notes.length) return '';
  const parts: string[] = [];
  if (f.version) parts.push(`<div class="pm-tip-avail">ab Version ${escapeHtml(f.version)}</div>`);
  if (base) parts.push(`<p class="pm-tip-desc">${escapeHtml(base)}</p>`);
  if (notes.length) {
    parts.push(
      `<ul class="pm-tip-notes">` +
        notes
          .map(
            (n) =>
              `<li><span class="pm-tip-ver">ab ${escapeHtml(n.version)}</span>` +
              `<span class="pm-tip-note">${escapeHtml(n.text)}</span></li>`,
          )
          .join('') +
        `</ul>`,
    );
  }
  return parts.join('');
}

function positionTip(tip: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const gap = 8;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  let left = r.left;
  let top = r.bottom + gap;
  // Flip above the anchor only when we know the viewport height and it would
  // overflow the bottom. (Guarding on vh>0 avoids a spurious flip when viewport
  // metrics are unavailable, e.g. a not-yet-painted tab.)
  if (vh > 0 && top + th > vh - gap) top = r.top - gap - th;
  // Clamp inside the viewport when its width is known.
  if (vw > 0) left = Math.max(gap, Math.min(left, vw - gap - tw));
  top = Math.max(gap, top);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function wireFeatureTooltips(host: HTMLElement): void {
  const tip = ensureTip();
  tip.hidden = true; // reset across re-renders
  const hide = () => {
    tip.hidden = true;
  };
  const show = (icon: HTMLElement) => {
    const featureId = icon.closest<HTMLElement>('[data-feature-id]')?.dataset.featureId;
    const pricing = state.activeSourceFile?.pricing;
    const f = pricing?.features.find((x) => x.id === featureId);
    if (!f) return;
    const html = featureTipHtml(f, pricing?.versions ?? []);
    if (!html) return;
    tip.innerHTML = html;
    tip.hidden = false;
    positionTip(tip, icon);
  };
  host.querySelectorAll<HTMLElement>('.pm-info').forEach((icon) => {
    icon.addEventListener('mouseenter', () => show(icon));
    icon.addEventListener('mouseleave', hide);
    icon.addEventListener('focus', () => show(icon));
    icon.addEventListener('blur', hide);
    // Tap/click the icon: toggle the tip and don't let it open the edit form.
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tip.hidden) show(icon);
      else hide();
    });
  });
  // A stale tooltip after scrolling would float over the wrong icon — hide it.
  host.querySelector('.pricing-table-wrap')?.addEventListener('scroll', hide, { passive: true });
}

// The price row sticks directly beneath the head row, so its `top` offset must
// equal the head row's rendered height. That height varies by brand/font (and can
// change on resize if a tier name wraps), so we measure it and expose it as the
// --pm-head-row-h CSS custom property the sticky rule reads. A single ResizeObserver
// is reused across renders (disconnected first) to avoid leaking observers.
let headRowObserver: ResizeObserver | null = null;

function syncStickyHeadOffset(host: HTMLElement): void {
  headRowObserver?.disconnect();
  const wrap = host.querySelector<HTMLElement>('.pricing-table-wrap');
  const headRow = host.querySelector<HTMLElement>('.pricing-table thead tr');
  if (!wrap || !headRow) return;
  const apply = () => {
    const h = headRow.getBoundingClientRect().height;
    if (h > 0) wrap.style.setProperty('--pm-head-row-h', `${Math.round(h)}px`);
  };
  apply();
  if (typeof ResizeObserver !== 'undefined') {
    headRowObserver = new ResizeObserver(apply);
    headRowObserver.observe(headRow);
  }
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
  wireFeatureTooltips(host);
  if (subView === 'matrix') syncStickyHeadOffset(host);
  else headRowObserver?.disconnect();
}

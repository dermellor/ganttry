// Pricing matrix for product timelines. Renders the timeline's `pricing`
// model (tiers × features). Each feature row carries a work indicator: an
// aggregate status dot (derived from the built-in item status of the roadmap
// items linked to that feature) plus a popover listing those items — each
// click opens the item in the detail drawer. A version switcher filters both
// the feature rows (cumulative) and the work items (exact selected version).
// On editable (DB-backed) timelines the matrix is also its own editor: a feature
// row opens its Stammdaten (featureForm.ts), a tier column head opens its
// Stammdaten (tierForm.ts), a cell opens the value popover (cellEditor.ts), and
// rows can be added/reordered in place. Each writes only the row or cell it edits.
// Highlights and the version list are still authored via MCP.

import { escapeHtml } from '../../pluginHost/api';
import { Button, html, IconButton, SegmentedControl, Select, ToolbarControl } from '../../pluginHost/api';
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
  versionLabel,
} from './pricing';
// Aliased: this module has a local `file` for the snapshot it renders from, and
// shadowing the accessor would be a trap for the next reader.
import { file as currentFile, canWrite, hostApi } from './host';
import { showFeatureForm, addFeature, moveFeature } from './featureForm';
import { showTierForm, addTier } from './tierForm';
import { openCellEditor, closeCellEditor } from './cellEditor';
import { anchorRect, layerFor } from './popover';
import { renderCardsHtml } from './pricingCards';
import { workDotHtml } from './pricingWork';
import {
  type TimelineFile,
} from '../../types';
import {
  type PricingFeature,
} from './types';
import { hasPlugin } from '../../pluginHost/api';
import { PRODUCT_ROADMAP_PLUGIN } from './plugin';
import { currentPricing, hasPricingModel } from './compose';

import { t } from './messages';
const PRICING_VERSION_KEY = 'timelines.pricingVersion';
const PRICING_SUBVIEW_KEY = 'timelines.pricingSubview';

type SubView = 'matrix' | 'cards';

// Selected version for the switcher. null = "Alle" (no filter). Persisted so the
// choice survives re-renders (realtime, edits) and reloads.
let selectedVersion: string | null = localStorage.getItem(PRICING_VERSION_KEY) || null;
// Matrix (full grid) vs cards (curated highlight tiles). Persisted.
let subView: SubView = localStorage.getItem(PRICING_SUBVIEW_KEY) === 'cards' ? 'cards' : 'matrix';
// Which subview the DOM currently holds. A repaint replaces the whole subtree —
// scroll container included — so the offsets are carried across by hand, but only
// across a repaint of the *same* subview: switching matrix↔cards is a different
// body of content and belongs at the top.
let renderedSubView: SubView | null = null;

// The scrolling element of either subview (see the `.pricing-inner > …` rule in
// pricing.css — the header stays put and only the body scrolls).
function scrollBody(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.pricing-table-wrap, .pc-cards');
}

/** True when the active timeline is a product timeline with a populated pricing model. */
export function hasPricing(file: TimelineFile | null | undefined): file is TimelineFile {
  // Both halves still matter: enablement decides whether the plugin belongs here
  // at all, a populated model decides whether a view is worth offering. The second
  // one now asks the generic store rather than a field on the core file type.
  return hasPlugin(file, PRODUCT_ROADMAP_PLUGIN) && hasPricingModel(file);
}

// Build the full matrix table HTML (tiers × features + work column).
function matrixHtml(file: TimelineFile, versions: string[], editable: boolean): string {
  const { tiers, features, versionLabels } = currentPricing(file);
  const items = file.items ?? [];
  // Show the work column when any item is linked to any feature at all (regardless
  // of the current version filter — otherwise the column would flicker in/out), or
  // when a feature needs a "new but unworked" warning there (see needsWorkWarning).
  const anyLinked = items.some((it) => readItemFeatureIds(it.metadata).length > 0);
  const anyWarning = features.some((f) => needsWorkWarning(f, items, versions, selectedVersion));
  const showWorkCol = anyLinked || anyWarning;
  const totalCols = tiers.length + 1 + (showWorkCol ? 1 : 0);

  // A tier's column head is its edit affordance (the Stammdaten drawer), mirroring
  // the feature row header. data-tier-id is only emitted when editable — unlike the
  // feature rows, nothing read-only needs to look a tier up off the DOM.
  const head =
    `<tr><th class="pm-feature">Feature</th>` +
    tiers
      .map((t) =>
        editable
          ? `<th class="pm-tier pm-tier-editable" data-tier-id="${escapeHtml(t.id)}" title="Tarif bearbeiten">${escapeHtml(t.name)}</th>`
          : `<th class="pm-tier">${escapeHtml(t.name)}</th>`,
      )
      .join('') +
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
      // Per-section add, so a new row lands in the section the user is looking at
      // (the toolbar button leaves it ungrouped). Same two-affordance pattern the
      // list view uses for "+ Eintrag".
      const addInGroup = editable
        ? html(
            Button({
              label: t('feature.add'),
              variant: 'outline',
              size: 'sm',
              reveal: true,
              className: 'pm-add-inline',
              attrs: { 'data-add-feature-group': group },
            }),
          )
        : '';
      bodyRows.push(
        `<tr class="pm-group-row"><th class="pm-feature" colspan="${totalCols}">${escapeHtml(group)}${addInGroup}</th></tr>`,
      );
    }
    for (let i = 0; i < visible.length; i++) {
      const f = visible[i];
      const cells = tiers
        .map((t) => {
          const v = t.values?.[f.id];
          const off = v === false || v == null || v === '';
          // Version-gated cell: not yet available at the pinned version → dash.
          // In "Alle" mode (no pin) show the end state plus an "ab <version>" chip
          // stating from which version this tier includes the feature (mirrors the
          // feature-row chip). No chip once a version is pinned — the gating itself
          // (cell present vs. dash) already carries the information.
          const af = t.valueVersions?.[f.id];
          const gated = !off && !cellActiveForVersion(af, versions, selectedVersion);

          let cls: string;
          let inner: string;
          if (off || gated) {
            cls = 'pm-cell is-off';
            inner = '<span class="pm-dash" aria-hidden="true">–</span>';
          } else {
            const chip =
              !selectedVersion && af
                ? ` <span class="pricing-badge-version pm-cell-ver">ab ${escapeHtml(versionLabel(versionLabels, af))}</span>`
                : '';
            if (v === true) {
              cls = 'pm-cell is-on';
              inner = `<span class="pm-check" aria-label="enthalten">✓</span>${chip}`;
            } else {
              cls = 'pm-cell is-value';
              inner = `${escapeHtml(String(v))}${chip}`;
            }
          }
          // On an editable timeline every cell is a click target, an empty one
          // included — switching a feature on for a tier is exactly the edit that
          // starts from a dash.
          if (!editable) return `<td class="${cls}">${inner}</td>`;
          return (
            `<td class="${cls} pm-cell-editable" data-tier-id="${escapeHtml(t.id)}"` +
            ` data-feature-id="${escapeHtml(f.id)}" tabindex="0" role="button" title="Zelle bearbeiten">${inner}</td>`
          );
        })
        .join('');

      const workItems = itemsForFeature(f.id, items, selectedVersion);
      const workCell = showWorkCol
        ? `<td class="pm-work-col">${
            workItems.length
              ? workDotHtml(workItems)
              : needsWorkWarning(f, items, versions, selectedVersion)
                ? `<span class="pm-work-warn" title="${t('feature.noWork')}" aria-label="${t('feature.noWork.aria')}">⚠</span>`
                : ''
          }</td>`
        : '';

      // In "Alle" mode (no pinned version) the Neu/Modified badges never fire, so
      // instead show a neutral "ab <version>" chip stating when the feature was
      // introduced. Pre-existing features (no version) get no chip.
      const badge = isNewFeature(f, versions, selectedVersion)
        ? `<span class="pricing-badge-new">${t('badge.new')}</span>`
        : isModifiedFeature(f, items, versions, selectedVersion)
          ? '<span class="pricing-badge-modified">Modified</span>'
          : !selectedVersion && f.version
            ? `<span class="pricing-badge-version">ab ${escapeHtml(versionLabel(versionLabels, f.version))}</span>`
            : '';
      const name = escapeHtml(resolveFeatureName(f, versions, selectedVersion));
      const featureThClass = editable ? 'pm-feature pm-feature-editable' : 'pm-feature';
      // Row reordering anchors on the *visible* neighbour inside this section, so
      // one click moves the row one step in the direction the user sees — whatever
      // the global sort order does between groups, and whatever the version filter
      // has hidden. A row with no neighbour on that side simply gets no button.
      const prev = visible[i - 1];
      const next = visible[i + 1];
      const moveBtn = (fid: string, anchorAttr: string, glyph: string, label: string) =>
        html(
          IconButton({
            icon: glyph,
            ariaLabel: label,
            boxSize: 'sm',
            className: 'pm-move',
            attrs: { 'data-move-feature': f.id, [anchorAttr]: fid },
          }),
        );
      const reorder =
        editable && visible.length > 1
          ? `<span class="pm-reorder">` +
            (prev ? moveBtn(prev.id, 'data-move-before', '↑', 'Nach oben') : '') +
            (next ? moveBtn(next.id, 'data-move-after', '↓', 'Nach unten') : '') +
            `</span>`
          : '';
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
        `<tr><th class="${featureThClass}" scope="row" data-feature-id="${escapeHtml(f.id)}">${name}${badge}${info}${reorder}</th>${cells}${workCell}</tr>`,
      );
    }
  }

  return `<div class="pricing-table-wrap"><table class="pricing-table"><thead>${head}${priceRow}</thead><tbody>${bodyRows.join('')}</tbody></table></div>`;
}

// Wire feature-row clicks to open the Stammdaten drawer (editable timelines
// only — matrixHtml only emits the pm-feature-editable class when editable).
function wireFeatureClicks(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>('.pm-feature-editable[data-feature-id]').forEach((th) => {
    th.addEventListener('click', (e) => {
      // The reorder buttons live inside this th; a click on one of them is not a
      // request to open the form.
      if ((e.target as HTMLElement).closest('.pm-move')) return;
      const id = th.dataset.featureId;
      if (id) showFeatureForm(id);
    });
  });
}

// Editable-only wiring: tier column heads open the tier drawer, cells open the
// cell popover, the reorder buttons move a row, and the add buttons create rows /
// columns. All of it is gated by the attributes matrixHtml only emits when
// editable, so a read-only timeline wires nothing.
function wireEditing(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>('.pm-tier-editable[data-tier-id]').forEach((th) => {
    th.addEventListener('click', () => {
      const id = th.dataset.tierId;
      if (id) showTierForm(id);
    });
  });

  host.querySelectorAll<HTMLElement>('.pm-cell-editable').forEach((td) => {
    const open = () => {
      const { tierId, featureId } = td.dataset;
      if (tierId && featureId) openCellEditor(td, tierId, featureId);
    };
    td.addEventListener('click', open);
    // The cell is a focusable role=button, so it owes the keyboard the same opening.
    td.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });

  host.querySelectorAll<HTMLButtonElement>('.pm-move[data-move-feature]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { moveFeature: fid, moveBefore, moveAfter } = btn.dataset;
      if (!fid) return;
      void moveFeature(fid, moveBefore ? { before: moveBefore } : { after: moveAfter });
    });
  });

  host.querySelectorAll<HTMLButtonElement>('[data-add-feature-group]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void addFeature(btn.dataset.addFeatureGroup);
    });
  });

  host.querySelector<HTMLButtonElement>('[data-action="add-feature"]')?.addEventListener('click', () => {
    void addFeature();
  });
  host.querySelector<HTMLButtonElement>('[data-action="add-tier"]')?.addEventListener('click', () => {
    void addTier();
  });
}

// ---- feature description tooltip -------------------------------------------
// A single styled tooltip, reused across all feature rows and re-renders. The
// layer itself comes from the host (see popover.ts for why the plugin no longer
// builds it), which is also what places it clear of the table's own clipping.

function ensureTip() {
  return layerFor('pm-tip', 'pm-tip', 'tooltip');
}

// Structured description → styled tooltip HTML: availability line, base
// description, then per-version notes laid out underneath each other. '' when
// there is nothing to show (so the caller can skip opening the tooltip).
function featureTipHtml(f: PricingFeature, versions: string[], labels?: Record<string, string>): string {
  const { base, notes } = resolveFeatureDescriptionParts(f, versions);
  if (!f.version && !base && !notes.length) return '';
  const parts: string[] = [];
  if (f.version) parts.push(`<div class="pm-tip-avail">ab Version ${escapeHtml(versionLabel(labels, f.version))}</div>`);
  if (base) parts.push(`<p class="pm-tip-desc">${escapeHtml(base)}</p>`);
  if (notes.length) {
    parts.push(
      `<ul class="pm-tip-notes">` +
        notes
          .map(
            (n) =>
              `<li><span class="pm-tip-ver">ab ${escapeHtml(versionLabel(labels, n.version))}</span>` +
              `<span class="pm-tip-note">${escapeHtml(n.text)}</span></li>`,
          )
          .join('') +
        `</ul>`,
    );
  }
  return parts.join('');
}

function wireFeatureTooltips(host: HTMLElement): void {
  const tip = ensureTip();
  tip.hide(); // reset across re-renders
  const hide = () => tip.hide();
  const show = (icon: HTMLElement) => {
    const featureId = icon.closest<HTMLElement>('[data-feature-id]')?.dataset.featureId;
    const pricing = currentPricing(currentFile());
    const f = pricing?.features.find((x) => x.id === featureId);
    if (!f) return;
    const html = featureTipHtml(f, pricing?.versions ?? [], pricing?.versionLabels);
    if (!html) return;
    tip.element.innerHTML = html;
    tip.showAt(anchorRect(icon));
  };
  host.querySelectorAll<HTMLElement>('.pm-info').forEach((icon) => {
    icon.addEventListener('mouseenter', () => show(icon));
    icon.addEventListener('mouseleave', hide);
    icon.addEventListener('focus', () => show(icon));
    icon.addEventListener('blur', hide);
    // Tap/click the icon: toggle the tip and don't let it open the edit form.
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tip.visible) hide();
      else show(icon);
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
      // Handing the drawer back to the app: a work item belongs to the timeline,
      // and the app's own detail view is what should open for it.
      if (id) hostApi().panel?.showItem(id);
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
// The section the host handed us on the last render. Kept so this plugin's own
// edit paths (cell editor, feature/tier forms) can repaint themselves without
// threading the container through every callback — and so that the container
// stays the host's to own rather than something the plugin looks up by id.
let hostSection: HTMLElement | null = null;

/** Repaint into the section of the last render. No-op before the first one. */
export function repaintPricingView(): void {
  if (hostSection) renderPricingView(hostSection);
}

export function renderPricingView(host: HTMLElement): void {
  const file = currentFile();
  if (!host) return;
  hostSection = host;
  // A repaint replaces the cell the editor is anchored to, so a still-open popover
  // would float over a stale position (or over a cell that no longer exists).
  closeCellEditor();
  if (!hasPricing(file)) {
    host.innerHTML = '<p class="pricing-empty">Kein Preismodell hinterlegt.</p>';
    renderedSubView = null;
    return;
  }

  const model = currentPricing(file);
  const versions = model.versions ?? [];
  if (selectedVersion && !versions.includes(selectedVersion)) selectedVersion = null;
  const hasHighlights = (model.highlights?.length ?? 0) > 0;
  // Cards need highlights; fall back to matrix when none are defined.
  if (subView === 'cards' && !hasHighlights) subView = 'matrix';

  const editable = canWrite();
  const body =
    subView === 'cards' ? renderCardsHtml(file, versions, selectedVersion) : matrixHtml(file, versions, editable);

  // The two representations of one model, so a segmented control rather than two
  // buttons — the same component the header uses for Timeline/Liste, which is the
  // same kind of choice.
  const toggle = hasHighlights
    ? html(
        SegmentedControl({
          ariaLabel: 'Darstellung',
          className: 'pm-subview',
          segments: [
            { value: 'matrix', label: 'Matrix', selected: subView === 'matrix', attrs: { 'data-sub': 'matrix' } },
            { value: 'cards', label: 'Kacheln', selected: subView === 'cards', attrs: { 'data-sub': 'cards' } },
          ],
        }),
      )
    : '';

  // Add affordances for the matrix's two axes. Only in the matrix subview: the
  // cards view renders highlights, so a "+ Feature" there would add a row the user
  // can't see. "+ Feature" here leaves the row ungrouped — the per-section buttons
  // in the group rows are the way into a specific section.
  const addControls =
    editable && subView === 'matrix'
      ? `<div class="pm-add" role="group" aria-label="${t('add')}">` +
        html(Button({ label: t('feature.add'), variant: 'outline', attrs: { 'data-action': 'add-feature' } })) +
        html(Button({ label: t('tier.add'), variant: 'outline', attrs: { 'data-action': 'add-tier' } })) +
        `</div>`
      : '';

  const switcher = versions.length
    ? html(
        ToolbarControl({
          label: 'Version',
          className: 'pm-version-switch',
          children: Select({
            className: 'pm-version-select',
            block: false,
            options: [
              { value: '', label: 'Alle', selected: !selectedVersion },
              ...versions.map((v) => ({
                value: v,
                label: versionLabel(model.versionLabels, v),
                selected: v === selectedVersion,
              })),
            ],
          }),
        }),
      )
    : '';

  // Every edit repaints through here, so without carrying the scroll offsets the
  // matrix would jump back to the top after each saved cell — the row just edited
  // scrolling out from under the pointer.
  const prev = scrollBody(host);
  const carry = prev && renderedSubView === subView ? { top: prev.scrollTop, left: prev.scrollLeft } : null;

  host.innerHTML =
    `<div class="pricing-inner">` +
    `<div class="pricing-header">` +
    `<h2 class="pricing-title">${escapeHtml(file.name ?? 'Preismodell')} — Preise</h2>` +
    `<div class="pricing-controls">${addControls}${toggle}${switcher}</div>` +
    `</div>` +
    body +
    `</div>`;
  renderedSubView = subView;

  if (carry) {
    const next = scrollBody(host);
    if (next) {
      // Deleting rows can shorten the content; the browser clamps to the new max,
      // which lands as close to the old spot as the content allows.
      next.scrollTop = carry.top;
      next.scrollLeft = carry.left;
    }
  }

  host.querySelector<HTMLSelectElement>('.pm-version-select')?.addEventListener('change', (e) => {
    const sel = e.currentTarget as HTMLSelectElement;
    selectedVersion = sel.value || null;
    if (selectedVersion) localStorage.setItem(PRICING_VERSION_KEY, selectedVersion);
    else localStorage.removeItem(PRICING_VERSION_KEY);
    repaintPricingView();
  });

  host.querySelectorAll<HTMLButtonElement>('.pm-subview .ds-Segment').forEach((btn) => {
    btn.addEventListener('click', () => {
      subView = (btn.dataset.sub as SubView) === 'cards' ? 'cards' : 'matrix';
      localStorage.setItem(PRICING_SUBVIEW_KEY, subView);
      repaintPricingView();
    });
  });

  wireWork(host);
  wireFeatureClicks(host);
  if (editable) wireEditing(host);
  wireFeatureTooltips(host);
  if (subView === 'matrix') syncStickyHeadOffset(host);
  else headRowObserver?.disconnect();
}

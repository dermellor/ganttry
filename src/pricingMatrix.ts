// Read-only pricing matrix for product timelines. Renders the timeline's
// `pricing` model (tiers × features). Each feature row carries a work indicator:
// an aggregate status dot (derived from the built-in item status of the roadmap
// items linked to that feature) plus a popover listing those items — each click
// opens the item in the detail drawer. A version switcher filters both the
// feature rows (cumulative) and the work items (exact selected version).
// Editing happens via the item form / MCP, not here.

import { escapeHtml } from './buildItems';
import {
  groupFeatures,
  featureVisibleForVersion,
  itemsForFeature,
  aggregateWorkState,
  readItemFeatureIds,
  type WorkState,
} from './pricing';
import { state, els } from './state';
import { statusOrDefault, type StatusKey } from './status';
import { showDetailForId } from './detailPanel';
import { type TimelineFile, type TimelineFileItem } from './types';

const PRICING_VERSION_KEY = 'timelines.pricingVersion';

// Selected version for the switcher. null = "Alle" (no filter). Persisted so the
// choice survives re-renders (realtime, edits) and reloads.
let selectedVersion: string | null = localStorage.getItem(PRICING_VERSION_KEY) || null;

const WORK_LABEL: Record<Exclude<WorkState, 'none'>, string> = {
  doing: 'In Arbeit',
  done: 'Erledigt',
  open: 'Offen',
};

const STATUS_LABEL: Record<StatusKey, string> = { Open: 'Offen', Doing: 'In Arbeit', Done: 'Erledigt' };

function fmtDate(it: TimelineFileItem): string {
  const s = it.start?.slice(0, 10) ?? '';
  const e = it.end?.slice(0, 10) ?? '';
  return e ? `${s} → ${e}` : s;
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
  if (selectedVersion && !versions.includes(selectedVersion)) selectedVersion = null;

  const items = file.items ?? [];
  // Show the work column when any item is linked to any feature at all (regardless
  // of the current version filter — otherwise the column would flicker in/out).
  const anyLinked = items.some((it) => readItemFeatureIds(it.metadata).length > 0);
  const totalCols = tiers.length + 1 + (anyLinked ? 1 : 0);

  const head =
    `<tr><th class="pm-feature">Feature</th>` +
    tiers.map((t) => `<th class="pm-tier">${escapeHtml(t.name)}</th>`).join('') +
    (anyLinked ? `<th class="pm-work-col" title="Roadmap-Arbeit an diesem Feature">Arbeit</th>` : '') +
    `</tr>`;

  const priceRow =
    `<tr class="pm-price-row"><th class="pm-feature">Preis</th>` +
    tiers.map((t) => `<td class="pm-tier">${escapeHtml(t.price)}</td>`).join('') +
    (anyLinked ? `<td class="pm-work-col"></td>` : '') +
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

      let workCell = '';
      if (anyLinked) {
        const linked = itemsForFeature(f.id, items, selectedVersion);
        const st = aggregateWorkState(linked);
        if (st === 'none') {
          workCell = `<td class="pm-work-col"></td>`;
        } else {
          const pop = linked
            .map((it) => {
              const s = statusOrDefault(it.status);
              return (
                `<button type="button" class="pm-work-item" data-item-id="${escapeHtml(it.id ?? '')}">` +
                `<span class="pm-work-item-dot pm-work-${s.toLowerCase()}" aria-hidden="true"></span>` +
                `<span class="pm-work-item-name">${escapeHtml(it.content)}</span>` +
                `<span class="pm-work-item-meta">${escapeHtml(STATUS_LABEL[s])}${fmtDate(it) ? ' · ' + escapeHtml(fmtDate(it)) : ''}</span>` +
                `</button>`
              );
            })
            .join('');
          workCell =
            `<td class="pm-work-col">` +
            `<details class="pm-work"><summary class="pm-work-dot pm-work-${st}" title="${WORK_LABEL[st]} — ${linked.length} Item(s)">` +
            `<span class="pm-work-count">${linked.length}</span></summary>` +
            `<div class="pm-work-pop"><div class="pm-work-pop-head">${WORK_LABEL[st]}</div>${pop}</div></details>` +
            `</td>`;
        }
      }

      const versionAttr = f.version ? ` title="ab Version ${escapeHtml(f.version)}"` : '';
      bodyRows.push(
        `<tr${versionAttr}><th class="pm-feature" scope="row">${escapeHtml(f.name)}</th>${cells}${workCell}</tr>`,
      );
    }
  }

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

  // Clicking an item in a work popover opens it in the detail drawer.
  host.querySelectorAll<HTMLButtonElement>('.pm-work-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.itemId;
      if (id) showDetailForId(id);
    });
  });

  // Close any other open work popover when one opens (single-popover behaviour).
  host.querySelectorAll<HTMLDetailsElement>('details.pm-work').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      host.querySelectorAll<HTMLDetailsElement>('details.pm-work[open]').forEach((o) => {
        if (o !== d) o.open = false;
      });
    });
  });
}

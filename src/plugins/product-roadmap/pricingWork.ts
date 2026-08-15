// Shared work indicator: an aggregate status dot + popover listing the linked
// roadmap items. Used by both the matrix (per feature) and the cards (per
// highlight). Kept in its own module so pricingMatrix and pricingCards can share
// it without importing each other. The click wiring lives in pricingMatrix
// (wireWork), matching on the `.pm-work-item` class this markup emits.

import { el, escapeHtml, htmlAll, MenuItem } from '../../pluginHost/api';
import { aggregateWorkState } from './pricing';
import { statusOrDefault, type StatusKey } from '../../pluginHost/api';
import type { TimelineFileItem } from '../../types';
import { t } from './messages';

// Both maps hold message KEYS, not text, and are read through `t` at render time:
// a table of finished labels at module scope would be built on import, before the
// host has resolved a language, and would keep showing that one forever.
//
// `StatusKey` is the stored value („Open" sits in the item's status column), so it
// stays the lookup key and only what it maps to is translated — the boundary
// src/i18n/storedValues.test.ts holds.
const WORK_KEY: Record<'doing' | 'done' | 'open', string> = {
  doing: 'work.doing',
  done: 'work.done',
  open: 'work.open',
};
const STATUS_KEY: Record<StatusKey, string> = { Open: 'work.open', Doing: 'work.doing', Done: 'work.done' };

function fmtDate(it: TimelineFileItem): string {
  const s = it.start?.slice(0, 10) ?? '';
  const e = it.end?.slice(0, 10) ?? '';
  return e ? `${s} → ${e}` : s;
}

/** HTML for the aggregate work dot + item popover; '' when there are no items. */
export function workDotHtml(items: TimelineFileItem[]): string {
  const st = aggregateWorkState(items);
  if (st === 'none') return '';
  // Each linked roadmap item as a menu row: this popover is a list of things to
  // jump to, which is what a MenuItem is. The mark carries the plugin's own
  // traffic-light rather than the product's `--status-*` — see the note beside
  // those custom properties in pricing.css.
  const pop = htmlAll(
    items.map((it) => {
      const s = statusOrDefault(it.status);
      const when = fmtDate(it);
      const statusLabel = t(STATUS_KEY[s]);
      return MenuItem({
        label: it.content,
        detail: when ? `${statusLabel} · ${when}` : statusLabel,
        mark: el('span', { class: `pm-work-item-dot pm-work-${s.toLowerCase()}`, 'aria-hidden': 'true' }),
        className: 'pm-work-item',
        attrs: { 'data-item-id': it.id ?? '' },
      });
    }),
  );
  const stateLabel = t(WORK_KEY[st]);
  return (
    `<details class="pm-work"><summary class="pm-work-dot pm-work-${st}" title="${escapeHtml(stateLabel)} — ${escapeHtml(t('work.items', { count: items.length }))}">` +
    `<span class="pm-work-count">${items.length}</span></summary>` +
    `<div class="pm-work-pop"><div class="pm-work-pop-head">${escapeHtml(stateLabel)}</div>${pop}</div></details>`
  );
}

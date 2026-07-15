// Shared work indicator: an aggregate status dot + popover listing the linked
// roadmap items. Used by both the matrix (per feature) and the cards (per
// highlight). Kept in its own module so pricingMatrix and pricingCards can share
// it without importing each other. The click wiring lives in pricingMatrix
// (wireWork), matching on the `.pm-work-item` class this markup emits.

import { escapeHtml } from './buildItems';
import { aggregateWorkState } from './pricing';
import { statusOrDefault, type StatusKey } from './status';
import type { TimelineFileItem } from './types';

const WORK_LABEL: Record<'doing' | 'done' | 'open', string> = {
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

/** HTML for the aggregate work dot + item popover; '' when there are no items. */
export function workDotHtml(items: TimelineFileItem[]): string {
  const st = aggregateWorkState(items);
  if (st === 'none') return '';
  const pop = items
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
  return (
    `<details class="pm-work"><summary class="pm-work-dot pm-work-${st}" title="${WORK_LABEL[st]} — ${items.length} Item(s)">` +
    `<span class="pm-work-count">${items.length}</span></summary>` +
    `<div class="pm-work-pop"><div class="pm-work-pop-head">${WORK_LABEL[st]}</div>${pop}</div></details>`
  );
}

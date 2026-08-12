// Shared work indicator: an aggregate status dot + popover listing the linked
// roadmap items. Used by both the matrix (per feature) and the cards (per
// highlight). Kept in its own module so pricingMatrix and pricingCards can share
// it without importing each other. The click wiring lives in pricingMatrix
// (wireWork), matching on the `.pm-work-item` class this markup emits.

import { el, htmlAll, MenuItem } from '../../pluginHost/api';
import { aggregateWorkState } from './pricing';
import { statusOrDefault, type StatusKey } from '../../pluginHost/api';
import type { TimelineFileItem } from '../../types';

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
  // Each linked roadmap item as a menu row: this popover is a list of things to
  // jump to, which is what a MenuItem is. The mark carries the plugin's own
  // traffic-light rather than the product's `--status-*` — see the note beside
  // those custom properties in pricing.css.
  const pop = htmlAll(
    items.map((it) => {
      const s = statusOrDefault(it.status);
      const when = fmtDate(it);
      return MenuItem({
        label: it.content,
        detail: when ? `${STATUS_LABEL[s]} · ${when}` : STATUS_LABEL[s],
        mark: el('span', { class: `pm-work-item-dot pm-work-${s.toLowerCase()}`, 'aria-hidden': 'true' }),
        className: 'pm-work-item',
        attrs: { 'data-item-id': it.id ?? '' },
      });
    }),
  );
  return (
    `<details class="pm-work"><summary class="pm-work-dot pm-work-${st}" title="${WORK_LABEL[st]} — ${items.length} Item(s)">` +
    `<span class="pm-work-count">${items.length}</span></summary>` +
    `<div class="pm-work-pop"><div class="pm-work-pop-head">${WORK_LABEL[st]}</div>${pop}</div></details>`
  );
}

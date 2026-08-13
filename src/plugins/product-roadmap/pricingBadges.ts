// The three badges the pricing views put behind a name, in one place.
//
// Its own module for the reason pricingWork.ts is one: the matrix and the cards
// both emit „Neu" and „ab <version>", and neither may import the other. Before
// this they were five string literals across two files with three CSS rules
// behind them, which is how „Neu" ended up filled in one view and the version
// chip ended up two sizes.
//
// What each badge *is* — outlined or filled, shouted or not — is the `Badge`
// component's business now. What is left here is which of them applies when.
//
// Nodes, not strings: the matrix builds its cells as elements, and the cards still
// assemble markup as text. A node can become text with `html()`, so this is defined
// once in the direction that survives both.
//
// The words come from this plugin's own catalogue. Only the version *name* is passed
// in, because that one is the user's own text and never goes through a translation.

// `viewApi`, not `api`: this module builds elements, and `pluginHost/api.ts` is the
// DOM-free half of the contract (see the server-bundle check).
import { Badge } from '../../pluginHost/viewApi';
import { t } from './messages';

/**
 * A feature or highlight introduced at the pinned version.
 *
 * Filled, and the only filled badge in either view: it has to be read before the
 * row it sits in. „Modified" stays outlined so the two are told apart by fill
 * rather than by a second hue.
 */
export function newBadge(): HTMLElement {
  return Badge({ label: t('badge.new'), size: 'sm', caps: true, filled: true, className: 'pm-badge' });
}

/** An existing feature reworked in the pinned version. Secondary to „Neu". */
export function modifiedBadge(): HTMLElement {
  return Badge({ label: t('badge.modified'), size: 'sm', caps: true, tone: 'accent', className: 'pm-badge' });
}

/**
 * When a feature became available, shown in „Alle" mode where the Neu/Modified
 * badges never fire.
 *
 * `caps` is deliberately absent: this one carries a *value*, and „ab 1.0" in
 * uppercase reads as an abbreviation rather than as a version.
 *
 * `inCell` is the same badge inside a matrix cell rather than behind a feature
 * name — a tighter gap, because a tier column is narrow and the chip has to be
 * allowed to wrap under the value.
 */
export function versionBadge(label: string, inCell = false): HTMLElement {
  return Badge({
    label: `${t('version.fromShort')} ${label}`,
    size: 'sm',
    tone: 'muted',
    className: inCell ? 'pm-cell-ver' : 'pm-badge',
  });
}

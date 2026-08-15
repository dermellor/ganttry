// The temporal type of an item: the shape it takes on the timeline.
//
// A fixed, universal value set like `status`, so it lives in one pure module for
// the same reason (`src/status.ts`): the item form draws it as a picker, the
// grouping and filter dimensions offer it as values, and the list view names it
// in a column. Three copies of „point means Meilenstein" is how one of them ends
// up saying something else after a rename.
//
// The form additionally offers „Automatisch" (a stored type of nothing, resolved
// at build time from whether the item has an extent). That is a property of the
// *editor*, not of the value set, so it stays in the form.

import { t } from './i18n';

export type ItemTypeKey = 'point' | 'range' | 'background' | 'box';

/**
 * The value set, in the order the pickers offer it.
 *
 * Keys only. A `{ key, label }` table here would be built on import, which is
 * before the reader's language is known, and every label in the product would
 * then be whichever language the page booted in — see „Never call `t()` at module
 * scope" in [`src/i18n/index.ts`](./i18n/index.ts). The keys are what items store
 * and never move; `itemTypeLabel` answers for the word.
 */
export const ITEM_TYPE_KEYS: readonly ItemTypeKey[] = ['point', 'range', 'background', 'box'];

const KNOWN = new Set<string>(ITEM_TYPE_KEYS);

/** The label for a stored type, or the raw value when it is one we do not know. */
export function itemTypeLabel(type: string | undefined): string {
  if (!type) return '';
  return KNOWN.has(type) ? t(`itemType.${type as ItemTypeKey}`) : type;
}

/** The value set as `{ key, label }`, resolved now so the labels follow the language. */
export function itemTypes(): { key: ItemTypeKey; label: string }[] {
  return ITEM_TYPE_KEYS.map((key) => ({ key, label: itemTypeLabel(key) }));
}

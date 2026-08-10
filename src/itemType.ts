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

export type ItemTypeKey = 'point' | 'range' | 'background' | 'box';

export const ITEM_TYPES: { key: ItemTypeKey; label: string }[] = [
  { key: 'point', label: 'Meilenstein' },
  { key: 'range', label: 'Zeitraum' },
  { key: 'background', label: 'Phase' },
  { key: 'box', label: 'Markierung' },
];

const TYPE_LABELS = new Map(ITEM_TYPES.map((t) => [t.key as string, t.label]));

/** The label for a stored type, or the raw value when it is one we do not know. */
export function itemTypeLabel(type: string | undefined): string {
  return (type && TYPE_LABELS.get(type)) ?? type ?? '';
}

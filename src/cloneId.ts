// Synthetic ids for regrouped timeline lanes, and the way back to the real item.
//
// Kept in its own DOM-free module rather than inside grouping.ts, which is where
// the ids are minted: grouping.ts reaches app state and the shared dropdown, so
// importing it drags the whole client graph — vis-timeline included — into
// anything that only wants to map a display id back to an item. That is a broken
// unit test rather than a broken app, but it is also the seam the convention in
// AGENTS.md („a rule lives in exactly one place") exists to keep usable: the
// alternative was a second copy of the split in every consumer.

// U+241F (␟, "unit separator") can't occur in a real item/group id, so it is a
// safe delimiter for synthetic regroup ids: it lets us map a display id back to
// its real item by a plain string split, no lookup table needed as a fallback.
export const CLONE_SEP = '␟';

/** Prefix for the synthetic group lanes a tag/custom-field regroup creates. */
export const GROUP_PREFIX = `grp${CLONE_SEP}`;

/**
 * The real item id behind a display id. Identity for the ids of the default
 * 'group' dimension, which are not synthetic.
 */
export function realIdOf(displayId: string): string {
  const i = displayId.indexOf(CLONE_SEP);
  return i === -1 ? displayId : displayId.slice(0, i);
}

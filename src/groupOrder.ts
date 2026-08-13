// In what order the groups of a timeline are laid out.
//
// Its own module because it is a rule, and the rule decides the lane order of
// every timeline plus the column order of the graph. Kept DOM-free so it can be
// read and tested without the build around it — `buildFromJson` reaches the
// design system for the tag markup it writes into vis-timeline items, which drags
// a stylesheet into anything that imports it.

/** The subset of a group this ordering needs. */
export type OrderableGroup = { id: string };

export type GroupOrderMode = 'alpha' | 'declared';

/**
 * Sort groups in place-safe fashion (returns a new array).
 *
 * `alpha` is the default and the behaviour every timeline shipped with: the
 * committed examples number their group ids (`1-strategy`, `2-design`) precisely
 * to steer it. `declared` follows `declaredIds` instead, for the timelines whose
 * group ids carry meaning and cannot be renumbered — the folder names a directory
 * source derives its groups from are the case that needed it.
 *
 * `ungroupedId` always sorts last under either mode: it is the absence of a value,
 * not a value that competes with the others for a position.
 */
export function orderGroups<T extends OrderableGroup>(
  groups: readonly T[],
  declaredIds: readonly string[],
  mode: GroupOrderMode | undefined,
  ungroupedId: string,
): T[] {
  const declared = new Map(declaredIds.map((id, i) => [id, i]));
  const alpha = (a: T, b: T) => a.id.localeCompare(b.id, 'de');

  return [...groups].sort((a, b) => {
    if (a.id === ungroupedId) return 1;
    if (b.id === ungroupedId) return -1;
    if (mode !== 'declared') return alpha(a, b);
    const ai = declared.get(a.id);
    const bi = declared.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    // One is declared, the other was only ever seen on an item. The declaration
    // comes first, because it is the statement about order; the rest follow
    // alphabetically behind it rather than in whichever order the items happened
    // to mention them, which would make the layout depend on item order.
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return alpha(a, b);
  });
}

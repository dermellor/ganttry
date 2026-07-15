// Nested-group assignment rules, shared by the item form, the drag handler, the
// add-item defaults and the list view so they all agree on which groups an item
// may belong to.
//
// A group that declares children (`nestedGroups`) is a PARENT: it acts purely as
// a container/header row. Items must be assigned to one of its leaf children,
// never to the parent itself. Groups without children are leaves and are
// assignable. Nesting deeper than one level is supported: a child that is itself
// a parent is still only a container, and assignment descends to its leaves.

export type GroupLike = { id: string; nestedGroups?: string[] };

// IDs of every group that declares at least one child.
export function parentGroupIds(groups: GroupLike[]): Set<string> {
  const parents = new Set<string>();
  for (const g of groups) {
    if (g.nestedGroups && g.nestedGroups.length > 0) parents.add(g.id);
  }
  return parents;
}

// The leaf (assignable) descendants of a group, in declaration order. A leaf
// group resolves to just itself; a parent flattens to its assignable leaves.
// Unknown/cyclic references are skipped.
export function assignableLeaves(groupId: string, groups: GroupLike[]): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parents = parentGroupIds(groups);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!parents.has(id)) {
      if (byId.has(id)) out.push(id);
      return;
    }
    for (const child of byId.get(id)?.nestedGroups ?? []) walk(child);
  };
  walk(groupId);
  return out;
}

// Resolve the group an item should actually land in when the user targets `id`:
// a parent redirects to its first assignable leaf; a leaf stays put. Returns
// undefined when `id` isn't a known group or a parent has no assignable leaf.
export function resolveAssignableGroup(
  id: string | number | null | undefined,
  groups: GroupLike[],
): string | undefined {
  if (id == null) return undefined;
  return assignableLeaves(String(id), groups)[0];
}

// The first assignable (leaf) group in declaration order — the default group for
// a new item when no target is given.
export function firstAssignableGroup(groups: GroupLike[]): string | undefined {
  const parents = parentGroupIds(groups);
  for (const g of groups) if (!parents.has(g.id)) return g.id;
  return undefined;
}

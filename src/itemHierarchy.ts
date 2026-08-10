// Parent/child relationships between items — the rules, kept DOM-free so the
// build (buildItems), the two views, the item form and the tests all read the
// same ones. The sibling of groupHierarchy.ts, which does the same job for
// groups.
//
// The link is stored on the CHILD, as `metadata.parent` = the parent's item id,
// exactly like `metadata.dependsOn` stores an edge on the dependent side. Two
// consequences make that the cheaper shape: „one parent per item" is structural
// rather than a rule somebody has to enforce, and re-parenting is a one-item
// write instead of an edit to two.
//
// Everything downstream works on the *resolved* map from `resolveParents`, which
// is where the three ways a stored link can be wrong (self-link, unknown target,
// cycle) are dropped once. Hand-edited JSON and a stale reference after a delete
// both produce those, and a renderer that walks an unsanitized map recurses
// forever on the first cycle.

export const PARENT_META_KEY = 'parent';

/** The parent id an item's `metadata` declares, if any. */
export function readParentId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const v = (meta as Record<string, unknown>)[PARENT_META_KEY];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
}

/**
 * Sanitize raw child→parent links against the ids that actually exist.
 *
 * Dropped, in this order: a self-link, a parent that is not a known item, and
 * any edge that would close a cycle. The cycle case drops the edge that closes
 * it (the one being walked when the loop is detected) rather than the whole
 * chain, so a mistake in one item costs that one link and leaves its siblings
 * hanging where they were.
 */
export function resolveParents(
  raw: Map<string, string>,
  knownIds: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [child, parent] of raw) {
    if (!knownIds.has(child) || child === parent || !knownIds.has(parent)) continue;
    out.set(child, parent);
  }
  // Break cycles: walk each chain and drop the edge that revisits a node.
  for (const child of [...out.keys()]) {
    const seen = new Set<string>([child]);
    let cur = out.get(child);
    while (cur) {
      if (seen.has(cur)) {
        out.delete(cur);
        break;
      }
      seen.add(cur);
      cur = out.get(cur);
    }
  }
  return out;
}

/** parent id → its children, in the order the source declared them. */
export function childrenByParent(parents: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [child, parent] of parents) {
    const list = out.get(parent);
    if (list) list.push(child);
    else out.set(parent, [child]);
  }
  return out;
}

/**
 * How deep each item sits: 0 for an item with no parent, 1 for its children, and
 * so on. An item nobody links to and that links to nobody never gets an entry at
 * all, which is why every caller reads it as `?? 0`.
 */
export function hierarchyDepth(parents: Map<string, string>): Map<string, number> {
  const depth = new Map<string, number>();
  const walk = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const parent = parents.get(id);
    // Set before recursing so a map that somehow still holds a cycle terminates
    // instead of blowing the stack; resolveParents already removes them.
    depth.set(id, 0);
    const d = parent ? walk(parent) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const child of parents.keys()) walk(child);
  return depth;
}

/** The chain from an item's parent up to its root, nearest ancestor first. */
export function ancestorIds(parents: Map<string, string>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = parents.get(id);
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parents.get(cur);
  }
  return out;
}

/**
 * Would linking `childId` under `candidateId` close a cycle? Asked by the form
 * before it offers a candidate, so an impossible parent never appears in the
 * suggestions — rather than being accepted and then silently dropped by
 * `resolveParents`, which looks like the pick did not register.
 */
export function wouldCreateCycle(
  parents: Map<string, string>,
  childId: string,
  candidateId: string,
): boolean {
  if (childId === candidateId) return true;
  return ancestorIds(parents, candidateId).includes(childId);
}

/**
 * Every item hidden because one of its ancestors is collapsed. A collapsed item
 * hides its whole subtree, not just its direct children — otherwise collapsing
 * the root of a three-level tree would leave the grandchildren floating without
 * the row they belong to.
 */
export function hiddenByCollapse(
  parents: Map<string, string>,
  collapsed: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  if (collapsed.size === 0) return hidden;
  for (const child of parents.keys()) {
    if (ancestorIds(parents, child).some((a) => collapsed.has(a))) hidden.add(child);
  }
  return hidden;
}

export type Extent = { start?: string; end?: string };

/**
 * The span a set of children covers: earliest start to latest end (an item
 * without an end contributes its start, which is what a milestone occupies).
 * Returns null when no child carries a date. Compared as strings on purpose —
 * both `YYYY-MM-DD` and full ISO timestamps sort correctly that way, and the
 * result is only ever handed back to the same date formatter, never to date
 * maths.
 */
export function childRollup(children: Extent[]): { start: string; end: string } | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const c of children) {
    if (!c.start) continue;
    if (start === null || c.start < start) start = c.start;
    const own = c.end ?? c.start;
    if (end === null || own > end) end = own;
  }
  return start === null ? null : { start, end: end ?? start };
}

/**
 * Where children fall outside their parent's own dates. The parent's dates stay
 * authoritative (they are maintained by hand and a rollup would overwrite that),
 * so this is a *statement about the data*, not a correction of it: the interface
 * shows it, nothing rewrites the parent.
 */
export function extentOverflow(
  parent: Extent,
  children: Extent[],
): { before: string | null; after: string | null } {
  const roll = childRollup(children);
  if (!roll) return { before: null, after: null };
  const pStart = parent.start;
  const pEnd = parent.end ?? parent.start;
  return {
    before: pStart && roll.start < pStart ? roll.start : null,
    after: pEnd && roll.end > pEnd ? roll.end : null,
  };
}

/**
 * Depth-first order for a flat list: every item followed by its children, roots
 * keeping the incoming order. An item whose parent is not in `items` counts as a
 * root here — a section of the list view can show a child without its parent
 * (they carry different tags, say), and dropping it would make the item vanish
 * from a view it belongs in.
 */
export function treeOrder<T extends { id: string }>(
  items: T[],
  parents: Map<string, string>,
): { item: T; depth: number }[] {
  const present = new Set(items.map((i) => i.id));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const it of items) {
    const parent = parents.get(it.id);
    if (parent && present.has(parent)) {
      const list = kids.get(parent);
      if (list) list.push(it);
      else kids.set(parent, [it]);
    } else {
      roots.push(it);
    }
  }
  const out: { item: T; depth: number }[] = [];
  const emit = (it: T, depth: number): void => {
    out.push({ item: it, depth });
    for (const child of kids.get(it.id) ?? []) emit(child, depth + 1);
  };
  for (const root of roots) emit(root, 0);
  return out;
}

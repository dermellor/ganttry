// How an item gets its id, in one place.
//
// The viewer names items `i1`, `i2`, … and has done since before the API had a
// granular create. The server had no rule at all: `POST /api/source/<id>/item`
// took whatever `id` the body carried and passed it straight to the driver, so
// a request that omitted one (which the MCP contract explicitly allows — only
// `start` and `content` are required) reached postgres.js as `undefined` and
// came back as `UNDEFINED_VALUE: Undefined values are not allowed`, or as a
// not-null violation on the supabase path. Two drivers, two error messages, one
// missing rule.
//
// Sharing it rather than adding a second scheme server-side keeps ids readable
// and predictable however they were created, which matters because they show up
// in the UI, in URLs and in MCP output.
//
// Explicit .ts extension on the import side of this module's consumers: it is
// reachable from the Deno edge bundle (api.ts → itemId.ts), and Deno resolves
// relative imports only with their extension — the same note as in
// ./itemExtent.ts.

/**
 * The first free `<prefix><n>` given the ids already in use.
 *
 * Linear probing from 1 rather than "highest + 1": ids are freed by deletion,
 * and reusing a gap keeps them short and stable-looking. Uniqueness is what
 * matters, and it is checked against the set rather than assumed from a counter.
 */
export function nextItemId(used: Iterable<string>, prefix = 'i'): string {
  const taken = used instanceof Set ? used : new Set(used);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/**
 * Fill in every missing id on a list of items, in place. Returns whether
 * anything changed, which the caller uses to decide whether to persist.
 *
 * Ids assigned in one pass are added to the used set as they go, so two id-less
 * items in the same list cannot both become `i1`.
 */
export function assignMissingItemIds(
  items: { id?: string }[],
  prefix = 'i',
): boolean {
  const used = new Set(items.map((i) => i.id).filter(Boolean) as string[]);
  let changed = false;
  for (const item of items) {
    if (item.id) continue;
    const id = nextItemId(used, prefix);
    item.id = id;
    used.add(id);
    changed = true;
  }
  return changed;
}

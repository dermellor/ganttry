// Patch semantics for the MCP `update_*` tools, shared by the two servers that
// expose them: the local stdio one (scripts/mcp/server.ts, which rewrites a whole
// timeline file) and the remote one (netlify/functions/mcp.ts, which sends a
// sub-resource PATCH). Both promise the same contract to an agent, so the rule
// lives here rather than in two hand-kept copies — one of which was already wrong.
//
// Why the merge cannot move down into the API or the repo, which would be the
// obvious place for it: the viewer sends the *complete* metadata object on every
// save and relies on the column being replaced to drop a key the user emptied
// (see CLEARABLE_ITEM_FIELDS in src/persistence.ts). Merging server-side would
// make removing the last tag impossible — the reappears-on-reload bug that
// comment was written for. So the endpoint keeps replacing, and the two callers
// that documented a *patch* resolve it against the current value first.

import type { TimelineFileItem } from '../../src/types.js';
import type { TimelineGroupDecl } from '../db/timeline-repo.js';

type Meta = Record<string, unknown>;

/**
 * What a caller may send as an item patch. `metadata` is widened to accept an
 * explicit null (clear the object), which the stored item type has no room for —
 * the two are deliberately different shapes: one is a request, the other a record.
 */
export type ItemPatch = Omit<Partial<TimelineFileItem>, 'metadata'> & { metadata?: Meta | null };

/**
 * Apply a metadata patch to the value an item currently carries.
 *
 * A `null` value removes its key rather than storing a null: an emptied field
 * disappearing is what the rest of the codebase means by empty (see
 * `FieldPick.stored` in src/fieldValue.ts and the two `delete item.metadata`
 * sites in itemForm.ts), and without it a merge would leave an agent no way to
 * remove a key at all.
 */
export function mergeMetadata(current: Meta | undefined, patch: Meta): Meta {
  const out: Meta = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * Resolve an `update_item` patch against the item it targets: every field but
 * `metadata` passes through untouched, `metadata` is shallow-merged onto what the
 * item already has. An explicit `metadata: null` clears the lot, which is how the
 * viewer clears it too.
 *
 * The returned object is a new patch — the caller decides whether to assign it to
 * an in-memory item or to put it on the wire.
 */
export function resolveItemPatch(
  current: Pick<TimelineFileItem, 'metadata'> | undefined,
  patch: ItemPatch,
): Partial<TimelineFileItem> {
  if (!('metadata' in patch)) return { ...patch } as Partial<TimelineFileItem>;
  const { metadata, ...rest } = patch;
  const out = { ...rest } as Partial<TimelineFileItem>;
  // null clears everything; {} through the merge would be a no-op, so it has to
  // stay distinguishable from "merge nothing".
  out.metadata = metadata == null ? {} : mergeMetadata(current?.metadata, metadata);
  return out;
}

/**
 * Resolve an `update_group` patch against the group it targets.
 *
 * The remote server writes groups through an upsert, which rewrites `content`,
 * `nestedGroups` and `showNested` from the body alone — so a patch that names
 * only `content` silently dropped a group's nesting. Folding the patch onto the
 * current group first makes the upsert carry the untouched fields along, which is
 * what the local server's `Object.assign` has always done.
 */
export function resolveGroupPatch(
  current: TimelineGroupDecl | undefined,
  patch: Partial<TimelineGroupDecl>,
): Partial<TimelineGroupDecl> {
  return { ...(current ?? {}), ...patch };
}

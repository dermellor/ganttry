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
 * Apply an item patch to the timeline in place, with the semantics `update_item`
 * documents.
 *
 * Here rather than inline in the server because a plugin's tool produces the same
 * kind of change and has to behave identically: a second copy of this is how
 * „metadata: null clears the object" ends up true for one caller and not the
 * other. Being a plain function over a file is also what makes it testable — the
 * servers themselves connect a transport on import.
 */
export function applyItemPatchTo(
  file: { items: TimelineFileItem[] },
  itemId: string,
  patch: ItemPatch,
): void {
  const item = file.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`Item "${itemId}" not found.`);
  const rest = resolveItemPatch(item, patch);
  Object.assign(item, rest);
  // An emptied metadata object is dropped rather than written as `{}`: that is the
  // shape a read returns (rowToItem omits it) and what the form leaves behind, so a
  // round-trip through a tool does not add a key to the file.
  if (item.metadata && Object.keys(item.metadata).length === 0) delete item.metadata;
  // Extent fields are mutually exclusive: whichever the patch set wins and clears
  // the counterpart, so switching end↔duration never leaves both.
  if (rest.end != null) delete item.duration;
  else if (rest.duration != null) delete item.end;
}

/**
 * Append an item, with the semantics `add_item` documents.
 *
 * `enforceExtent` is injected rather than imported so this module stays free of
 * the repo layer: it is imported by the edge bundle, where pulling
 * `timeline-repo.ts` in for one helper would drag the driver along.
 */
export function appendItemTo(
  file: { items: TimelineFileItem[] },
  item: TimelineFileItem,
  enforceExtent: (item: TimelineFileItem) => void,
): void {
  if (item.id && file.items.some((i) => i.id === item.id)) {
    throw new Error(`Item id "${item.id}" already exists.`);
  }
  enforceExtent(item);
  // `metadata` is nullable so a patch can clear it; on a create there is nothing to
  // clear, and writing the null through would put it in the file.
  if (item.metadata == null) delete (item as { metadata?: unknown }).metadata;
  file.items.push(item);
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

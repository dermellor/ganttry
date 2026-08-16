// What is true of a timeline as a whole: its name, its description, the grouping
// it opens with. The rules for reading and writing those, DOM-free so both halves
// are unit-testable.
//
// The name exists twice, and that is not a mistake to clean up: `TimelineFile.name`
// is the source's own, live, and writable; `View.name` is what the build wrote into
// `config.json` when it discovered the source. For a database timeline the second
// is a snapshot taken at deploy time, so renaming one at runtime cannot update it.
// The rule below is therefore: for the timeline that is OPEN, its source wins,
// because that is the value the database actually holds. Every other entry in the
// picker stays with the built name, since nothing has loaded it.

import type { CustomFieldDef, TimelineFile, View } from './types';
import { GROUP_DIM } from './listGrouping';
import { sequencePositions } from './sequence';
import { t } from './i18n';

/**
 * What a PATCH body may carry. `graph` is an object, which is why this is not the
 * `Record<string, string | null>` it used to be.
 */
export type TimelineMetaBody = Record<string, unknown>;

/** The name to show for the open timeline: the source's own, else the built one. */
export function timelineName(view: View | null, file: TimelineFile | null): string {
  const live = file?.name?.trim();
  return live || view?.name || '';
}

/**
 * What the settings form edits.
 *
 * Every field is a string, empty meaning „not set", including the two that are
 * stored inside `graph`. A `<select>` has no other empty state, and flattening them
 * here keeps the diff below one comparison per control rather than a nested one.
 */
export type TimelineMetaDraft = {
  name: string;
  description: string;
  groupBy: string;
  /** '' = the alphabetical default; see src/groupOrder.ts. */
  groupOrder: string;
  /** `graph.bandRootGroup`: the group whose items become band headings. */
  bandRootGroup: string;
  /** `graph.referenceGroup`: the group listed on the nodes it references. */
  referenceGroup: string;
  /**
   * `scan.orderFrom`: the file in the folder whose wikilinks are the items' order.
   *
   * Always '' on a source that is not scanned, where the form draws no control for
   * it — so the diff below sees no change and sends no `scan` key to a store that
   * would refuse one.
   */
  orderFrom: string;
};

/** The default dimension, spelled out or left empty, as the form's empty option. */
function normalizeGroupBy(stored: string | undefined): string {
  const value = (stored ?? '').trim();
  return value === GROUP_DIM ? '' : value;
}

/** The current values, as the form should show them. */
export function timelineMetaDraft(view: View | null, file: TimelineFile | null): TimelineMetaDraft {
  return {
    name: timelineName(view, file),
    description: file?.description ?? '',
    // The stored default, not the dimension in force: what this field sets is what
    // the timeline opens with, and `state.groupBy` may be a per-person choice made
    // since (see „Where the display state lives" in docs/editing.md).
    //
    // `group` and `` are the same statement — open on the group dimension — and only
    // the empty one is an option, so a file saying `"groupBy": "group"` matched none
    // and the select rendered blank. Worse than blank: the form would then read ``
    // back as a change and clear the key on the next save of any other field.
    groupBy: normalizeGroupBy(file?.groupBy),
    groupOrder: file?.groupOrder ?? '',
    bandRootGroup: file?.graph?.bandRootGroup ?? '',
    referenceGroup: file?.graph?.referenceGroup ?? '',
    orderFrom: file?.scan?.orderFrom ?? '',
  };
}

/**
 * Is this timeline read by scanning a folder — the question „does the order-file
 * setting apply here at all?"
 *
 * The **presence** of the block answers it, not any value in it: a scanned
 * directory always carries one, empty when it declares nothing (see
 * `scanDirectory`). Reading `orderFrom` instead would hide the control on exactly
 * the folder that has yet to name a file.
 */
export function isScannedSource(file: TimelineFile | null): boolean {
  return !!file?.scan;
}

/**
 * An order file is named and positions nothing.
 *
 * Both ways that happens are silent — the named file is not in the folder, or it
 * holds no wikilink that resolves to an item of this timeline — and both leave
 * every item unpositioned, so the setting looks accepted and does nothing. They
 * are reported as one statement rather than told apart, because telling them apart
 * needs the scanner's view of the folder and the symptom the reader is looking at
 * is the same either way.
 *
 * `sequencePositions` rather than a count of stamped items, so an item that only
 * inherits its position from one that links to it counts as positioned too: the
 * question is whether the order file did anything, not how much of it it did.
 */
export function orderFileFindsNothing(file: TimelineFile | null): boolean {
  if (!file?.scan?.orderFrom) return false;
  return sequencePositions(file.items).size === 0;
}

/**
 * The PATCH body for a draft, or null when nothing changed.
 *
 * Only changed keys are sent, because `PATCH /api/source/<id>` touches exactly the
 * keys present in the body. Sending everything would make every save a write to
 * every field, which on a DB source bumps the row version and re-attributes it —
 * the same no-op-edit trap the item form has (see „Opening an item's form is a
 * read" in docs/editing.md).
 *
 * A cleared optional field goes as an explicit `null`, since an absent key means
 * „leave it alone" rather than „empty it".
 */
export function timelineMetaPatch(
  current: TimelineMetaDraft,
  next: TimelineMetaDraft,
): TimelineMetaBody | null {
  const patch: TimelineMetaBody = {};

  const name = next.name.trim();
  // The name is the one field with no empty state: a timeline with no name shows as
  // its id, and „" would replace a readable label with a slug. So an emptied name
  // is a no-op rather than a clear.
  if (name && name !== current.name.trim()) patch.name = name;

  const description = next.description.trim();
  if (description !== current.description.trim()) {
    patch.description = description || null;
  }

  const groupBy = next.groupBy.trim();
  if (groupBy !== current.groupBy.trim()) patch.groupBy = groupBy || null;

  const groupOrder = next.groupOrder.trim();
  if (groupOrder !== current.groupOrder.trim()) patch.groupOrder = groupOrder || null;

  // `graph` is replaced as a unit rather than merged into, on every path that writes
  // it (the MCP tool says so too). Merging would need a rule for a key the caller
  // may never have read, and „this is the graph configuration" is a small enough
  // statement to make whole. So both controls are diffed together, and one changed
  // control still sends the other's stored value back.
  const bandRootGroup = next.bandRootGroup.trim();
  const referenceGroup = next.referenceGroup.trim();
  if (
    bandRootGroup !== current.bandRootGroup.trim() ||
    referenceGroup !== current.referenceGroup.trim()
  ) {
    const graph: Record<string, string> = {};
    if (bandRootGroup) graph.bandRootGroup = bandRootGroup;
    if (referenceGroup) graph.referenceGroup = referenceGroup;
    // An empty object would be a `graph: {}` in the file and a `{}` in the column,
    // which reads as „configured, to nothing". Cleared is cleared.
    patch.graph = Object.keys(graph).length ? graph : null;
  }

  // `scan` goes the other way from `graph`: the key alone, merged by the store into
  // whatever else the block holds. The form edits one of its five settings, so a
  // replacement would clear the four it never showed — `dateFields: []` among them,
  // whose loss shows up as a folder full of items dated the day they were typed.
  // Cleared is `null`, which deletes the key rather than storing an empty name.
  const orderFrom = next.orderFrom.trim();
  if (orderFrom !== current.orderFrom.trim()) patch.scan = { orderFrom: orderFrom || null };

  return Object.keys(patch).length ? patch : null;
}

/**
 * The dimensions a timeline can open with, as `{ value, label }` for a `<select>`.
 * Built from the timeline's own declarations rather than from the active build, so
 * the choice does not depend on what the current filter happens to leave visible —
 * a default is a property of the timeline, and „Tag" must stay offerable on a
 * timeline whose tagged items are filtered away right now.
 */
export function groupByChoices(file: TimelineFile | null): { value: string; label: string }[] {
  const out = [
    { value: '', label: t('group.default') },
    { value: 'tag', label: t('dimension.tag') },
    { value: 'status', label: t('dimension.status') },
    { value: 'type', label: t('dimension.type') },
  ];
  for (const f of file?.customFields ?? []) {
    out.push({ value: `cf:${f.key}`, label: fieldLabel(f) });
  }
  return out;
}

/** The two ordering rules, the alphabetical one marked as the default it is. */
export function groupOrderChoices(): { value: string; label: string }[] {
  return [
    { value: '', label: t('groupOrder.alpha') },
    { value: 'declared', label: t('groupOrder.declared') },
  ];
}

/**
 * The groups a graph setting can name, for a `<select>` whose empty value clears it.
 *
 * **Declared and discovered both, in that order.** A timeline does not have to
 * declare its groups — the shipped examples name theirs on the items only, and a
 * directory source derives them from folder names — so offering `groups[]` alone
 * left the two controls with nothing but „Keine" on exactly the timelines the graph
 * was built for. Declared first because that order is the author's statement (see
 * `orderGroups`); the rest follow in the order the build found them.
 *
 * `ungroupedId` is left out for the reason `orderGroups` sorts it last: it is the
 * absence of a value rather than a value, and no band should be headed by it.
 *
 * `stored` is offered even when nothing declares or contains it, and that is the
 * point rather than defensiveness: a `<select>` silently reports its first option
 * when its value matches none, so a setting naming a group that was since renamed —
 * or emptied by a filter-shaped mistake — would show as „Keine" and then really be
 * cleared by the next save of any other field.
 */
export function graphGroupChoices(
  file: TimelineFile | null,
  discovered: readonly { id: string; label?: string }[],
  stored: string,
  ungroupedId: string,
): { value: string; label: string }[] {
  const out = [{ value: '', label: t('group.none') }];
  const add = (id: string, label: string) => {
    if (id === ungroupedId || out.some((c) => c.value === id)) return;
    out.push({ value: id, label: label || id });
  };
  for (const g of file?.groups ?? []) add(g.id, g.content);
  for (const g of discovered) add(g.id, g.label ?? '');
  if (stored) add(stored, stored);
  return out;
}

function fieldLabel(f: CustomFieldDef): string {
  const own = f.label || f.key;
  return f.group ? `${f.group} · ${own}` : own;
}

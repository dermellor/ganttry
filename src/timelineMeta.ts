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
import { t } from './i18n';

/** The name to show for the open timeline: the source's own, else the built one. */
export function timelineName(view: View | null, file: TimelineFile | null): string {
  const live = file?.name?.trim();
  return live || view?.name || '';
}

/** What the settings form edits. */
export type TimelineMetaDraft = {
  name: string;
  description: string;
  groupBy: string;
};

/** The current values, as the form should show them. */
export function timelineMetaDraft(view: View | null, file: TimelineFile | null): TimelineMetaDraft {
  return {
    name: timelineName(view, file),
    description: file?.description ?? '',
    // The stored default, not the dimension in force: what this field sets is what
    // the timeline opens with, and `state.groupBy` may be a per-person choice made
    // since (see „Where the display state lives" in docs/editing.md).
    groupBy: file?.groupBy ?? '',
  };
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
): Record<string, string | null> | null {
  const patch: Record<string, string | null> = {};

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

function fieldLabel(f: CustomFieldDef): string {
  const own = f.label || f.key;
  return f.group ? `${f.group} · ${own}` : own;
}

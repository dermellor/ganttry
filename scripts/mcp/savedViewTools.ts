// What an agent needs to write a saved view: the vocabulary of the timeline it is
// writing one for.
//
// A filter selection is `{ "<dimension>": ["<value>", …] }`, and neither half is
// guessable from the outside — `cf:tier` is not a field name anybody would invent,
// and a status bucket is `Open`, not „open". Without this an agent writes a filter
// that narrows nothing, which looks like the tool having worked.
//
// The dimensions themselves are NOT re-derived here. `groupByOptions` and
// `computeSections` (src/listGrouping.ts) are the same functions the interface's
// „Gruppieren" and „Filter" controls read, so what an agent is offered is exactly
// what a person is offered. All this module does is put a stored file into the
// shape those functions take — the browser gets there through the display build,
// which cannot run here (it imports the design system, and with it CSS).

import type { CustomFieldDef, SavedView, TimelineFile } from '../../src/types.ts';
import type { TimelineItem } from '../../src/buildItems.ts';
import {
  GROUP_DIM,
  NO_BUCKET,
  computeSections,
  groupByOptions,
  toValues,
  type GroupByOption,
  type SectionContext,
} from '../../src/listGrouping.ts';
import { derivedValuesFor, withDerived } from '../../src/pluginHost/derived.ts';
import { mergeFieldDefs, pluginFieldDefs } from '../../src/pluginHost/registry.ts';

export type DimensionReport = {
  key: string;
  label: string;
  values: { value: string; label: string }[];
};

/**
 * The stored items as the sectioning functions want them.
 *
 * Only the five fields those functions read are filled in, and the cast is what
 * says so: a `TimelineItem` carries display state (lane classes, rendered HTML)
 * that no dimension depends on, and manufacturing it here would mean carrying the
 * build's rules in a second place.
 */
function entriesOf(file: TimelineFile): TimelineItem[] {
  return (file.items ?? [])
    .filter((it) => it.type !== 'background')
    .map(
      (it) =>
        ({
          id: it.id ?? '',
          group: it.group,
          status: it.status,
          // Every built item has a resolved type, and `range` is what the build
          // resolves an absent one to — so the type dimension reports the same two
          // kinds the interface shows rather than an extra „Ohne Typ" bucket.
          type: it.type ?? 'range',
          tags: toValues(it.metadata?.tags ?? it.metadata?.tag),
        }) as unknown as TimelineItem,
    );
}

function contextOf(file: TimelineFile): SectionContext {
  // The same two-part answer the browser gives: what the item stores, plus what
  // the enabled plugins compute for it. An agent asked to write a filter on a
  // derived dimension would otherwise be told the timeline has no such values —
  // and a filter naming a value that „does not exist" narrows nothing, silently.
  const derive = derivedValuesFor(file);
  const meta = new Map(
    (file.items ?? []).map((it) => [it.id ?? '', withDerived(it.metadata, derive ? derive(it) : undefined)]),
  );
  return {
    groups: (file.groups ?? []).map((g) => ({ id: g.id, content: g.content })),
    // Stored definitions merged with the contributed ones, exactly as the item
    // form does it: a plugin's fields are dimensions too, and listing only the
    // stored half is what kept them out of an agent's vocabulary until now.
    customFields: mergeFieldDefs(
      (file.customFields ?? []) as CustomFieldDef[],
      pluginFieldDefs(file),
    ),
    metaOf: (id: string) => meta.get(id),
  };
}

/**
 * Every dimension this timeline offers and the values in it.
 *
 * `NO_BUCKET` is reported verbatim rather than hidden: it is a selectable value —
 * „items with no tier" is a narrowing somebody wants — and an agent that cannot
 * see it cannot express it.
 */
export function savedViewDimensions(file: TimelineFile): DimensionReport[] {
  const entries = entriesOf(file);
  const ctx = contextOf(file);
  const options: GroupByOption[] = groupByOptions(entries, ctx.customFields);
  return options.map((option) => {
    const { sections } = computeSections(entries, option.key, options, ctx);
    return {
      key: option.key,
      label: option.label,
      values: sections.map((s) => ({ value: s.empty ? NO_BUCKET : s.id, label: s.label })),
    };
  });
}

/** The grouping dimensions alone, for the `groupBy` field of a saved view. */
export function groupingKeys(file: TimelineFile): string[] {
  return savedViewDimensions(file).map((d) => d.key);
}

export { GROUP_DIM, NO_BUCKET };

/**
 * The one sentence every saved-view tool repeats, kept in one place so the four of
 * them cannot describe the same field differently.
 */
export const SAVED_VIEW_HELP =
  'A saved view is a named combination of presentation (`mode`), grouping dimension (`groupBy`) ' +
  'and filter selection (`filters`), stored on the timeline and applied in one click. Call ' +
  'describe_view_dimensions first: the dimension keys (`group`, `tag`, `status`, `type`, ' +
  '`cf:<field>`) and their values are properties of the timeline, and a filter naming one that ' +
  'does not exist narrows nothing. Set `owner` to a user from list_users to create a view FOR ' +
  'somebody — that is whose list it appears in. `visibility: "instance"` shares it with everybody; ' +
  'the default is private to its owner.';

/** The wire shape of a saved view, as the tools accept it. */
export type SavedViewInput = Partial<Pick<SavedView, 'id' | 'name' | 'mode' | 'groupBy' | 'owner'>> & {
  filters?: Record<string, string[]>;
  visibility?: 'private' | 'instance';
};

// Shared grouping logic for the timeline and list views. The pure sectioning
// (which bucket(s) an item belongs to, in what order) lives in listGrouping.ts;
// this module adds the app-state-aware pieces both views need: resolving the
// active dimension against the current build, syncing the shared "Gruppieren"
// dropdown, and — for the timeline — turning a chosen dimension into vis-timeline
// lanes (regrouping items into value tracks, cloning multi-valued items so they
// appear under every value, exactly like the list view lists them per section).

import { escapeHtml, type TimelineGroup, type TimelineItem } from './buildItems';
import { state, els } from './state';
import { getCustomFields } from './customFields';
import {
  bucketsFor,
  computeSections,
  groupByOptions,
  GROUP_DIM,
  NO_BUCKET,
  type GroupByOption,
  type SectionContext,
} from './listGrouping';

// U+241F (␟, "unit separator") can't occur in a real item/group id, so it is a
// safe delimiter for synthetic regroup ids: it lets us map a display id back to
// its real item by a plain string split, no lookup table needed as a fallback.
const CLONE_SEP = '␟';
const GROUP_PREFIX = `grp${CLONE_SEP}`;

// Frontmatter/metadata of a build item, keyed by id. Shared by the list
// sectioning and the timeline regroup so both read custom-field values the same
// way.
export function metaOf(id: string): Record<string, unknown> | undefined {
  return state.activeBuild?.details.get(id)?.frontmatter as Record<string, unknown> | undefined;
}

export function sectionContext(groups: { id: string; content: string }[]): SectionContext {
  return { groups, customFields: getCustomFields(), metaOf };
}

// The dimensions the filter can act on — the same categories the grouping
// dropdown offers (Gruppe / Tag / custom fields). Kept identical so grouping and
// filtering share one vocabulary.
export function filterDimensions(entries: TimelineItem[]): GroupByOption[] {
  return groupByOptions(entries, getCustomFields());
}

// The selectable values for a filter dimension, in the same order the list view
// sections them (declared custom-field options first, then first appearance),
// plus the "Ohne …" bucket when any entry lacks a value. Reuses computeSections
// so the ordering/labelling can't drift from the grouped views. `value` is the
// bucket key (NO_BUCKET for the "Ohne …" entry).
export function filterValueOptions(
  entries: TimelineItem[],
  dim: string,
  groups: { id: string; content: string }[],
): { value: string; label: string }[] {
  if (!dim) return [];
  const options = filterDimensions(entries);
  const { sections } = computeSections(entries, dim, options, sectionContext(groups));
  return sections.map((s) => ({ value: s.empty ? NO_BUCKET : s.id, label: s.label }));
}

// A filter is only in effect when a dimension is chosen AND at least one value is
// selected — an empty selection means "no restriction" (classic faceted filter).
export function isFilterActive(): boolean {
  return !!state.filterDim && state.filterValues.length > 0;
}

// Does an item pass the active value filter? Items with no value for the filter
// dimension pass only when the "Ohne …" bucket (NO_BUCKET) is among the selected
// values. Callers should gate on isFilterActive() first.
export function passesFilter(
  item: TimelineItem,
  groups: { id: string; content: string }[],
): boolean {
  if (!state.filterDim) return true;
  const buckets = bucketsFor(item, state.filterDim, sectionContext(groups));
  if (buckets.length === 0) return state.filterValues.includes(NO_BUCKET);
  return buckets.some((b) => state.filterValues.includes(b));
}

// Options offered for the current entries plus the resolved active dimension
// (state.groupBy validated against them, falling back to 'group').
export function resolveGrouping(entries: TimelineItem[]): {
  dim: string;
  options: GroupByOption[];
} {
  const options = groupByOptions(entries, getCustomFields());
  const dim = options.some((o) => o.key === state.groupBy) ? state.groupBy : GROUP_DIM;
  return { dim, options };
}

// Populate the shared "Gruppieren" dropdown, preserving the active selection.
// Rebuilt on every render so tag/custom-field changes keep the choices current;
// the `built` guard skips the DOM write when the option set is unchanged.
export function syncGroupByControl(options: GroupByOption[], dim: string): void {
  const sel = els.groupBy;
  if (!sel) return;
  const desired = options
    .map((o) => `<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}</option>`)
    .join('');
  if (sel.dataset.built !== desired) {
    sel.innerHTML = desired;
    sel.dataset.built = desired;
  }
  sel.value = dim;
}

// Map a timeline display id back to its real item id (strips the clone suffix).
export function realIdOf(displayId: string): string {
  const i = displayId.indexOf(CLONE_SEP);
  return i === -1 ? displayId : displayId.slice(0, i);
}

export type RegroupResult = {
  items: TimelineItem[];
  groups: TimelineGroup[];
  // display id -> real id (empty for the 'group' dimension = identity).
  displayToReal: Map<string, string>;
  // real id -> every display id it renders as (its clones across lanes).
  realToDisplay: Map<string, string[]>;
};

// Regroup display items into vis lanes for the active dimension. For the default
// 'group' dimension this is the identity (returns the inputs, empty maps). For a
// tag / custom-field dimension it builds one lane per value (in the same order
// the list view sections them) and emits each item once per value it carries —
// the first occurrence keeps the real id, extras get a `<id>␟<n>` clone id so
// vis can place the same item in several lanes. Phase-tint background items are
// passed through untouched (they span the full height and carry no group).
export function regroupForTimeline(
  items: TimelineItem[],
  groups: TimelineGroup[],
  dim: string,
  options: GroupByOption[],
): RegroupResult {
  if (dim === GROUP_DIM) {
    return { items, groups, displayToReal: new Map(), realToDisplay: new Map() };
  }

  const backgrounds = items.filter((it) => it.type === 'background');
  const real = items.filter((it) => it.type !== 'background');
  const { sections } = computeSections(real, dim, options, sectionContext(groups));

  const outGroups: TimelineGroup[] = sections.map((s) => ({
    id: GROUP_PREFIX + s.id,
    content: escapeHtml(s.label),
  }));

  const outItems: TimelineItem[] = [];
  const displayToReal = new Map<string, string>();
  const realToDisplay = new Map<string, string[]>();
  const count = new Map<string, number>();

  for (const s of sections) {
    const gid = GROUP_PREFIX + s.id;
    for (const it of s.items) {
      const n = count.get(it.id) ?? 0;
      count.set(it.id, n + 1);
      const did = n === 0 ? it.id : `${it.id}${CLONE_SEP}${n}`;
      outItems.push({ ...it, id: did, group: gid });
      displayToReal.set(did, it.id);
      const arr = realToDisplay.get(it.id);
      if (arr) arr.push(did);
      else realToDisplay.set(it.id, [did]);
    }
  }
  outItems.push(...backgrounds);

  return { items: outItems, groups: outGroups, displayToReal, realToDisplay };
}

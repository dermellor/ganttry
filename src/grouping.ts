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
  computeSections,
  groupByOptions,
  GROUP_DIM,
  NO_BUCKET,
  type GroupByOption,
  type SectionContext,
} from './listGrouping';
import { isFilterSelectionActive, passesFilters } from './filterRule';
import { withDerived } from './pluginHost/derived';

// The synthetic-id vocabulary lives in cloneId.ts (DOM-free) so a consumer that
// only needs the display-id → item-id mapping does not have to import this
// module and, with it, the app state and the dropdown. Re-exported because
// `realIdOf` has always been part of this module's surface.
export { realIdOf } from './cloneId';
import { CLONE_SEP, GROUP_PREFIX } from './cloneId';

// Frontmatter/metadata of a build item, keyed by id. Shared by the list
// sectioning and the timeline regroup so both read custom-field values the same
// way — and, since #131, the one place where a plugin's *derived* values join the
// stored ones. Grouping, the filter's dimensions, the filter's values and the
// timeline's lanes all come through here, so a derived field becomes a perspective
// and an extent without any of them knowing that it is computed.
export function metaOf(id: string): Record<string, unknown> | undefined {
  const note = state.activeBuild?.details.get(id);
  return withDerived(note?.frontmatter as Record<string, unknown> | undefined, note?.derived);
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

// A filter is only in effect while some dimension has a value selected — an empty
// selection means "no restriction" (classic faceted filter).
export function isFilterActive(): boolean {
  return isFilterSelectionActive(state.filters);
}

// Does an item pass the active value filter? The rule itself (AND across
// dimensions, OR within one, the "Ohne …" bucket per dimension) is in
// filterRule.ts, DOM-free and unit-tested; this only supplies the app state.
// Callers should gate on isFilterActive() first.
export function passesFilter(
  item: TimelineItem,
  groups: { id: string; content: string }[],
): boolean {
  return passesFilters(item, state.filters, sectionContext(groups));
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

  // A section's label is already plain text, so it is both halves here: escaped
  // for vis-timeline's group label, raw for the consumers that build DOM.
  const outGroups: TimelineGroup[] = sections.map((s) => ({
    id: GROUP_PREFIX + s.id,
    content: escapeHtml(s.label),
    label: s.label,
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

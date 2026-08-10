// Pure sectioning logic for the list view, kept free of any DOM/app-state
// imports so it can be unit-tested in Node (listGrouping.test.ts) and reused by
// listView.ts. It turns a flat list of entries into ordered sections for a
// chosen grouping dimension: the item's own group, its tags, or a custom field.

import type { TimelineItem } from './buildItems';
import { ITEM_STATUSES } from './status';
import { ITEM_TYPES } from './itemType';
import type { CustomFieldDef } from './types';

export const GROUP_DIM = 'group';
export const TAG_DIM = 'tag';
export const STATUS_DIM = 'status';
export const TYPE_DIM = 'type';
export const CF_PREFIX = 'cf:';
// Sentinel bucket key for entries that carry no value for the active dimension
// (the "Ohne …" section). Exported so the filter can offer it as a selectable
// value ("show only items without a value").
export const NO_BUCKET = ' __nobucket';

export type GroupByOption = { key: string; label: string };
// `empty` marks the synthetic "Ohne …" bucket (items without a value for the
// dimension) so the renderer can treat it specially (no per-group add button).
export type ListSection = { id: string; label: string; empty: boolean; items: TimelineItem[] };

// Context the sectioning needs, decoupled from the module-level app state.
export type SectionContext = {
  groups: { id: string; content: string }[];
  customFields: CustomFieldDef[];
  metaOf: (id: string) => Record<string, unknown> | undefined;
};

// Normalise a metadata value into a list of string bucket values. Accepts a
// single scalar or an array (multi-select). Trims, drops empties, de-dupes.
export function toValues(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of arr) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Bucket keys an item belongs to under the current dimension. Empty = ungrouped.
export function bucketsFor(item: TimelineItem, dim: string, ctx: SectionContext): string[] {
  if (dim === TAG_DIM) return item.tags ?? [];
  // Single-valued and never the default: an item without a stored status lands in
  // the "Ohne Status" bucket rather than under `Open`, because the two are
  // different states of the source (see „The default is shown, not stored" in
  // docs/items.md) and filtering for `Open` must not sweep in items that only
  // display as one.
  if (dim === STATUS_DIM) return item.status ? [item.status] : [];
  // Every built item has a resolved type, so this dimension has no „Ohne …"
  // bucket in practice. It is what „nur Meilensteine" became: a value among
  // values, rather than a checkbox of its own two rows from the filter.
  if (dim === TYPE_DIM) return item.type ? [item.type] : [];
  if (dim.startsWith(CF_PREFIX)) return toValues(ctx.metaOf(item.id)?.[dim.slice(CF_PREFIX.length)]);
  // Default: the item's own group, if it resolves to a real group.
  const groupIds = new Set(ctx.groups.map((g) => g.id));
  return item.group && groupIds.has(item.group) ? [item.group] : [];
}

// Label a custom field is listed under as a dimension. A grouped field (a
// plugin's, or a stored one that declares a group) is qualified with its section
// title, so two fields named "Version" from different sources stay tellable
// apart in the Gruppieren / Filter dropdowns.
export function dimensionLabel(f: CustomFieldDef): string {
  const own = f.label || f.key;
  return f.group ? `${f.group} · ${own}` : own;
}

// Grouping dimensions offered for the current build: always the item group,
// "Tag" when anything is tagged, "Status" when anything carries one, plus one
// entry per declared custom field. Status is offered on evidence rather than
// unconditionally: a file-based source has no status concept at all, and a
// dimension whose only bucket is "Ohne Status" is a choice that cannot do
// anything.
export function groupByOptions(
  entries: TimelineItem[],
  customFields: CustomFieldDef[],
): GroupByOption[] {
  const opts: GroupByOption[] = [{ key: GROUP_DIM, label: 'Gruppe' }];
  if (entries.some((it) => (it.tags?.length ?? 0) > 0)) opts.push({ key: TAG_DIM, label: 'Tag' });
  if (entries.some((it) => it.status)) opts.push({ key: STATUS_DIM, label: 'Status' });
  // On evidence, like Status: a timeline whose items are all ranges has one
  // bucket here, and narrowing to „the only kind there is" does nothing. Two
  // distinct kinds is exactly the case „nur Meilensteine" existed for.
  if (new Set(entries.map((it) => it.type)).size > 1) opts.push({ key: TYPE_DIM, label: 'Typ' });
  for (const f of customFields) opts.push({ key: `${CF_PREFIX}${f.key}`, label: dimensionLabel(f) });
  return opts;
}

// The values a dimension declares up front, in the order they should appear:
// the fixed status sequence, or a custom field's `options`. Everything else
// declares nothing and is ordered by first appearance.
function declaredOrder(dim: string, ctx: SectionContext): { value: string; label?: string }[] {
  if (dim === STATUS_DIM) return ITEM_STATUSES.map((s) => ({ value: s.key, label: s.label }));
  if (dim === TYPE_DIM) return ITEM_TYPES.map((t) => ({ value: t.key, label: t.label }));
  if (dim.startsWith(CF_PREFIX)) {
    return ctx.customFields.find((f) => `${CF_PREFIX}${f.key}` === dim)?.options ?? [];
  }
  return [];
}

// Human label of the "Ohne …" fallback bucket for the active dimension.
function emptyBucketLabel(dim: string, options: GroupByOption[]): string {
  const opt = options.find((o) => o.key === dim);
  return `Ohne ${opt ? opt.label : 'Gruppe'}`;
}

// Split entries (assumed start-sorted) into ordered sections for the active
// dimension. Group order follows the build; tag / custom-field order follows
// the field's declared options first (if any), then first appearance. Returns
// `grouped=false` only when the default group dimension collapses to a single
// ungrouped bucket (a timeline without groups) — an explicitly-chosen dimension
// always keeps its headers so "Ohne Tier" confirms the grouping is active.
export function computeSections(
  entries: TimelineItem[],
  dim: string,
  options: GroupByOption[],
  ctx: SectionContext,
): { sections: ListSection[]; grouped: boolean } {
  const buckets = new Map<string, TimelineItem[]>();
  for (const it of entries) {
    const keys = bucketsFor(it, dim, ctx);
    for (const key of keys.length ? keys : [NO_BUCKET]) {
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(it);
    }
  }

  const order: { id: string; label: string }[] = [];
  if (dim === GROUP_DIM) {
    for (const g of ctx.groups) {
      if (buckets.has(g.id)) order.push({ id: g.id, label: g.content || g.id });
    }
  } else {
    const seen = new Set<string>();
    // A dimension with a declared value order uses it, so the sections read
    // Open → Doing → Done (and a custom field follows its own options) instead of
    // whichever value the earliest item happened to carry.
    for (const opt of declaredOrder(dim, ctx)) {
      if (buckets.has(opt.value) && !seen.has(opt.value)) {
        order.push({ id: opt.value, label: opt.label || opt.value });
        seen.add(opt.value);
      }
    }
    for (const it of entries) {
      for (const v of bucketsFor(it, dim, ctx)) {
        if (buckets.has(v) && !seen.has(v)) {
          order.push({ id: v, label: v });
          seen.add(v);
        }
      }
    }
  }
  if (buckets.has(NO_BUCKET)) order.push({ id: NO_BUCKET, label: emptyBucketLabel(dim, options) });

  const grouped =
    order.length > 1 ||
    (order.length === 1 && !(dim === GROUP_DIM && order[0].id === NO_BUCKET));

  const sections = order
    .filter((o) => buckets.has(o.id))
    .map((o) => ({ id: o.id, label: o.label, empty: o.id === NO_BUCKET, items: buckets.get(o.id)! }));
  return { sections, grouped };
}

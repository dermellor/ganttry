// The item fields the product-roadmap plugin contributes to the generic form.
//
// These are *derived* fields: their options come from the timeline's pricing
// model, so they are never part of the stored `customFields` array and never get
// persisted back as definitions. Routing them through the custom-field machinery
// gives them a form control, keeps their keys out of the raw metadata box, and
// offers grouping/filtering by them — all without a parallel code path.
//
// Deliberately importable from the generic core (kinds/registry.ts holds the
// only reference): this module imports nothing but types and the plugin helper,
// so it adds NO static edge into the pricing chunk. Everything pricing-heavy
// stays behind the descriptor's dynamic `load()`.

import { PRODUCT_ROADMAP_PLUGIN, hasPlugin } from '../../plugins';
import {
  PRICING_FEATURE_META_KEY,
  PRICING_ITEM_VERSION_META_KEY,
  PRICING_TIER_META_KEY,
  type CustomFieldDef,
  type TimelineFile,
} from '../../types';

// Chip colour for a derived tier option. A tier has no colour of its own in the
// pricing model, and hand-picking one here would reintroduce exactly the
// duplication this field exists to remove — so the hue is derived from the tier
// id: stable across renames of the *name*, and unchanged when tiers are
// reordered or inserted (unlike a positional palette).
function tierColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 45%)`;
}

// The plugin lays out its own section: the order of this array is the order the
// fields render in, and `width` decides whether a field shares its row. Version
// and Tier are compact pickers and pair up on the first row; Features carries
// long feature names as chips and takes the full width below them.
export function productRoadmapFields(file: TimelineFile | null | undefined): CustomFieldDef[] {
  if (!file || !hasPlugin(file, PRODUCT_ROADMAP_PLUGIN)) return [];
  const defs: CustomFieldDef[] = [];

  // Which pricing version this item's work targets (drives the matrix's
  // version-dependent work indicator). Single-select from the declared versions.
  const versions = file.pricing?.versions ?? [];
  if (versions.length) {
    defs.push({
      key: PRICING_ITEM_VERSION_META_KEY,
      label: 'Version',
      type: 'select',
      options: versions.map((v) => ({ value: v })),
    });
  }

  // Which tiers an item concerns. Was a hand-seeded stored custom field whose
  // options were a copy of the tier names — so renaming a tier in the pricing
  // model left the field offering the old label. Derived from the model, it
  // cannot drift. Values are tier *ids* (like the feature field), not names, so a
  // rename doesn't orphan the values stored on items.
  const tiers = file.pricing?.tiers ?? [];
  if (tiers.length) {
    defs.push({
      key: PRICING_TIER_META_KEY,
      label: 'Tier',
      type: 'multi-select',
      options: tiers.map((t) => ({ value: t.id, label: t.name, color: tierColor(t.id) })),
    });
  }

  // Which pricing features this item's work touches (n:m).
  const features = file.pricing?.features ?? [];
  if (features.length) {
    defs.push({
      key: PRICING_FEATURE_META_KEY,
      label: 'Features',
      type: 'multi-select',
      width: 'full',
      options: features.map((f) => ({ value: f.id, label: f.name })),
    });
  }

  return defs;
}

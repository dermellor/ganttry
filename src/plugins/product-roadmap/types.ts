// The pricing model: this plugin's own domain types.
//
// They lived in `src/types.ts` next to `TimelineFile`, and `TimelineFile` had a
// `pricing` field — the core file format knowing one plugin's data by name. That
// was the last shape of the privilege issue #17 removes, and it is why these
// types moved here rather than being deleted: they are still the vocabulary the
// views, the matrix and the card renderer speak. What changed is who owns them.
//
// They are no longer a storage format. The host stores four collections of
// undistinguished rows (`docs/plugin-storage.md`); `./compose.ts` turns those
// rows into the model below and back. So a field added here needs no migration
// and no schema regeneration — it is one plugin's business, which is the whole
// point of the seam.
//
// One naming rule survives the move because it caused a real bug: `version` on a
// feature is the domain „ab Version" label, and `rowVersion` is the host's lock
// counter. Two different things, one word, and a patch that sent the wrong one
// silently overwrote a concurrent edit.

// Two entities: features (the capabilities a product ships) and tiers (named,
// priced plans that each bundle a subset of features). A timeline *item* links to
// features via metadata[PRICING_FEATURE_META_KEY] (string[]).
export type PricingFeature = {
  id: string;
  name: string;
  // Optional grouping label for the matrix rows, e.g. "Funktionen".
  group?: string;
  description?: string;
  // Version from which this feature is available; must be one of Pricing.versions.
  // Absent = available from the start (always shown, regardless of the switcher).
  version?: string;
  // Version-scoped display-name overrides, keyed by a Pricing.versions entry.
  // Resolved cumulatively like `version` (see resolveFeatureName in pricing.ts):
  // the latest override at or before the selected version wins, falling back to
  // `name`. Lets a feature rename itself across versions without becoming a
  // different feature id, e.g. "Termine vereinbaren" (1.0/2.0) → "Termine
  // vereinbaren und ändern" (ab 3.0).
  nameByVersion?: Record<string, string>;
  // Additive, version-scoped descriptions on top of `description`, keyed by a
  // Pricing.versions entry (PR #22). Unlike `nameByVersion` (a cumulative
  // *override* of the name), these are ADDITIVE changelog notes: the base
  // `description` always stays, and each entry renders as its own
  // "ab <version>: <text>" line, in declared version order (see
  // resolveFeatureDescription in pricing.ts).
  descriptionByVersion?: Record<string, string>;
  // Server-managed optimistic-lock counter of the backing row (peer of
  // TimelineFileItem.version). Named `rowVersion` — NOT `version` — because
  // `version` above is the domain "available from" label. Surfaced only on the
  // editable path, sent back as If-Match on a feature
  // PATCH, and stripped from public output. Ignored by render / markdown.
  rowVersion?: number;
};

export type PricingTier = {
  id: string;
  name: string;
  // Optional segment/tagline shown under the tier name on the card
  // (e.g. "Micro · 1–5 Anrufe/Tag").
  tagline?: string;
  // One-line positioning / primary use case (e.g. "Verpasste Anrufe auffangen").
  // Shown as the card's sub-headline (falls back to `tagline`).
  useCase?: string;
  // Longer target-group description ("Einstiegslösung für kleine Unternehmen").
  // Shown as a "Zielgruppe" block at the top of the card body.
  targetGroup?: string;
  // Free-form price string — carries currency and qualifiers ("ab 449,95 €").
  price: string;
  // Per-tier feature values, keyed by feature id:
  //   true          → included, rendered as a check (✓)
  //   false / absent → not included, rendered as a dash (–)
  //   string         → shown verbatim in the cell ("3.000", "unbegrenzt (RAG)")
  // This lets one feature (e.g. "Inkludierte Minuten") differ per tier instead of
  // exploding into a boolean row per value.
  values: Record<string, string | boolean>;
  // Optional per-cell "available from" version labels, keyed by feature id (a
  // subset of `values`' keys). A cell listed here counts as included only from
  // that version onward; before it the cell renders as "–" (see
  // cellActiveForVersion in pricing.ts). The stored `values[fid]` stays the
  // end-state value — this map only gates *when* it appears, mirroring
  // PricingFeature.version but at the tier×feature level. Absent key = available
  // from the start (unchanged behaviour). An additive sibling of `values`, so
  // every existing reader of `values` is untouched.
  valueVersions?: Record<string, string>;
  // Server-managed optimistic-lock counter of the backing tier row (see
  // PricingFeature.rowVersion). Stripped from public output.
  rowVersion?: number;
};

// A curated highlight tile for the card view: bundles one or more raw features
// under a simplified label (the "Zwischenschicht"). Only features referenced by
// some highlight are considered important and surface in the card view; the raw
// matrix still shows everything. Per-tier presence/value is derived from the
// tiers' existing `values`, so there is no separate per-tier maintenance.
export type PricingHighlight = {
  id: string;
  label: string;
  // Card section this bullet belongs to (e.g. "Inkludiert", "Agent Skills").
  // Highlights are grouped by section on the tier cards; order follows first-seen.
  section?: string;
  // Optional semantic icon key (resolved by the brand, like item icons).
  icon?: string;
  // Raw feature ids this tile summarizes.
  featureIds: string[];
  description?: string;
  // Version-scoped label overrides, same semantics as PricingFeature.nameByVersion.
  labelByVersion?: Record<string, string>;
  // Server-managed optimistic-lock counter of the backing highlight row (see
  // PricingFeature.rowVersion). Stripped from public output.
  rowVersion?: number;
};

export type Pricing = {
  features: PricingFeature[];
  tiers: PricingTier[];
  // Curated tiles for the card view (bundle features). Absent/empty = card view
  // shows nothing (fall back to the matrix).
  highlights?: PricingHighlight[];
  // Ordered list of version labels (e.g. ["1.0", "2.0", "3.0"]). Defines both the
  // ordering used for the cumulative version filter and the options of the
  // version switcher in the matrix view. A feature's `version` references one of
  // these. Absent/empty = no versioning (switcher hidden).
  versions?: string[];
};

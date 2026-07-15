import type { StatusKey } from './status';

export type Note = {
  id: string;
  path: string;
  filename: string;
  folder: string;
  title: string;
  start: string | null;
  end: string | null;
  dateSource: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
};

export type NotesData = {
  generatedAt: string;
  count: number;
  notes: Note[];
};

export type FilterClause = {
  filenameContains?: string;
  folder?: string | string[];
  status?: string | string[];
  categories?: string | string[];
  tags?: string | string[];
  draft?: boolean;
  has?: string | string[];
  anyOf?: FilterClause[];
  allOf?: FilterClause[];
  not?: FilterClause;
};

export type ViewSource = { type: 'json'; id: string };

export type View = {
  id: string;
  name: string;
  description?: string;
  filter: FilterClause;
  dateFields?: string[];
  groupBy?: string;
  colorBy?: string;
  source?: ViewSource;
};

export type TimelineFileItem = {
  id?: string;
  // Optional: a list-created item can exist without a date yet. The timeline
  // view hides start-less items (vis-timeline needs a start to place them); the
  // list view shows them with an em-dash.
  start?: string;
  end?: string;
  duration?: string | number;
  content: string;
  group?: string;
  title?: string;
  type?: 'point' | 'range' | 'background' | 'box';
  className?: string;
  icon?: string;
  status?: StatusKey; // built-in item status (Open/Doing/Done); defaults to Open
  body?: string;
  metadata?: Record<string, unknown>;
  version?: number; // DB row version for optimistic locking (server-managed)
  // Server-managed audit fields (read-only). ISO timestamps + attribution.
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type TimelinePhase = {
  id?: string;
  label: string;
  start: string;
  end?: string;
  duration?: string | number;
  color?: string;
  icon?: string;
};

// Per-timeline custom fields. The *definitions* are timeline-level config
// (stored on the timeline row, like `phases`); a field's *value* lives per item
// in `metadata[key]` — a string for `text`/`select`, a string[] for
// `multi-select`. Configuration is backend-side for now (no in-app editor for
// the definitions); they're seeded via the DB / MCP `set_custom_fields`.
export type CustomFieldType = 'text' | 'select' | 'multi-select';

export type CustomFieldOption = {
  value: string;
  label?: string;
  // Optional pill colour (hex), used for select / multi-select chips.
  color?: string;
};

export type CustomFieldDef = {
  key: string;
  label: string;
  type: CustomFieldType;
  // Allowed choices for `select` / `multi-select`. Ignored for `text`.
  options?: CustomFieldOption[];
};

// Pricing model, only meaningful for `type: 'product'` timelines. Two entities:
// features (the capabilities a product ships) and tiers (named, priced plans
// that each bundle a subset of features). A timeline *item* links to features
// via metadata[PRICING_FEATURE_META_KEY] (string[]). The whole model is a
// timeline-level config blob, stored like `phases` / `customFields`.
export type PricingFeature = {
  id: string;
  name: string;
  // Optional grouping label for the matrix rows, e.g. "Funktionen".
  group?: string;
  description?: string;
  // Version from which this feature is available; must be one of Pricing.versions.
  // Absent = available from the start (always shown, regardless of the switcher).
  version?: string;
};

export type PricingTier = {
  id: string;
  name: string;
  // Free-form price string — carries currency and qualifiers ("ab 449,95 €").
  price: string;
  // Per-tier feature values, keyed by feature id:
  //   true          → included, rendered as a check (✓)
  //   false / absent → not included, rendered as a dash (–)
  //   string         → shown verbatim in the cell ("3.000", "unbegrenzt (RAG)")
  // This lets one feature (e.g. "Inkludierte Minuten") differ per tier instead of
  // exploding into a boolean row per value.
  values: Record<string, string | boolean>;
};

// A curated highlight tile for the card view: bundles one or more raw features
// under a simplified label (the "Zwischenschicht"). Only features referenced by
// some highlight are considered important and surface in the card view; the raw
// matrix still shows everything. Per-tier presence/value is derived from the
// tiers' existing `values`, so there is no separate per-tier maintenance.
export type PricingHighlight = {
  id: string;
  label: string;
  // Optional semantic icon key (resolved by the brand, like item icons).
  icon?: string;
  // Raw feature ids this tile summarizes.
  featureIds: string[];
  description?: string;
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

// Item metadata key holding the feature ids an item is assigned to (string[]).
export const PRICING_FEATURE_META_KEY = 'featureIds';

// Item metadata key holding the pricing version an item's work targets (string,
// one of Pricing.versions). Drives the version-dependent work indicator in the
// matrix (an item is "work for version X on feature Y").
export const PRICING_ITEM_VERSION_META_KEY = 'featureVersion';

export type TimelineFile = {
  name?: string;
  description?: string;
  groupBy?: string;
  // Timeline kind. 'product' unlocks the `pricing` model + matrix view.
  type?: string;
  phases?: TimelinePhase[];
  customFields?: CustomFieldDef[];
  pricing?: Pricing;
  items: TimelineFileItem[];
  groups?: {
    id: string;
    content: string;
    nestedGroups?: string[];
    showNested?: boolean;
  }[];
};

export type Config = {
  notesDir: string;
  defaultView: string;
  dateFields: string[];
  filenameDatePatterns: string[];
  views: View[];
};

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

// Where a source-backed view gets its data. The `kind` is the explicit
// discriminator that drives loading — deliberately NOT a "try the API, then
// fall back to a static file" guess, which conflates a live DB timeline with a
// stale snapshot (see AGENTS.md „keine Notfall-Daten"). Extensible to further
// API-served kinds (e.g. 'gsheet', external 'pg') later.
//   - 'db'   → live from the DB via /api/source/<id> (editable, no fallback)
//   - 'file' → read-only from the static /data/sources/<id>.json (the file IS
//              the source, not a snapshot — so loading it is correct)
export type SourceKind = 'db' | 'file';

export type ViewSource = { kind: SourceKind; id: string };

// How a source delivers other people's changes to an open viewer:
//   'realtime' — pushed over a WebSocket (Supabase Realtime)
//   'poll'     — the client polls a cheap watermark endpoint on an interval
//   'none'     — no live updates; changes appear only on reload (file sources)
// Declared server-side on a SourceAdapter's capabilities and surfaced to the
// client (via the X-Source-Live response header) so the live-update seam can
// pick its implementation. Lives here (not in scripts/db/api.ts) so both the
// client and the Deno-bundled server share one definition.
export type SourceLive = 'realtime' | 'poll' | 'none';

export type SourceCapabilities = { editable: boolean; live: SourceLive };

// Cheap change-detection signature for polling (GET /api/source/<id>/watermark).
// Any field differing between two reads means "something changed, reload":
//   v — max item `version` (also an own-echo hint)
//   n — item count (catches inserts/deletes, which v/t alone miss)
//   t — max `updated_at` across the items and the timeline row (ISO string),
//       so item edits, phase/meta writes and renames all bump it
export type Watermark = { v: number; n: number; t: string | null };

/**
 * One entry of the user directory (`app_users`, served by `GET /api/users`).
 * The e-mail is the identity an item's `metadata.owner` stores; `name` is only
 * for display and may be missing (a row backfilled from edit attribution knows
 * the address but not the name until that person's next visit).
 *
 * Structurally a `PresenceUser` (src/presenceModel.ts), which is why the label /
 * initials / hue helpers there serve both: the same person shown as a presence
 * avatar and as an item's owner has to look like the same person.
 */
export type DirectoryUser = { email: string; name?: string };

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
  // Optional section title the field is rendered under in the item form, and
  // the prefix its grouping/filter dimension is listed with ("Produkt · Version").
  // Plugin-contributed fields get their plugin's label stamped on here
  // (kinds/registry.ts `pluginFieldDefs`); a stored definition may declare one
  // too, to file itself under the same heading. Ungrouped fields render flat,
  // ahead of the grouped sections.
  group?: string;
  // How much of the form's two-column grid the control takes: `half` (the
  // default) shares a row with its neighbour, `full` spans both columns. Together
  // with the order of the definitions this is what lets a plugin lay out its own
  // fields — a chip field with long labels wants the full width, two compact
  // pickers read better side by side.
  width?: 'half' | 'full';
  // Whether the field can also be set straight from an item's right-click menu,
  // where it appears as a submenu of its options (see contextMenu.ts). Off by
  // default: a menu of every field would defeat the point of a *quick* action, so
  // each definition opts in. Only meaningful for `select` / `multi-select` — a
  // `text` field has no fixed option set for a menu to offer, so the flag is
  // ignored on one (`contextMenuFields` in customFields.ts owns that rule).
  contextMenu?: boolean;
};

// Pricing model, only meaningful for product-roadmap timelines. Two entities:
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
  // editable path (getTimeline), sent back as If-Match on a granular feature
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

// Item metadata key holding the feature ids an item is assigned to (string[]).
export const PRICING_FEATURE_META_KEY = 'featureIds';

// Item metadata key holding the pricing version an item's work targets (string,
// one of Pricing.versions). Drives the version-dependent work indicator in the
// matrix (an item is "work for version X on feature Y").
export const PRICING_ITEM_VERSION_META_KEY = 'featureVersion';

// Item metadata key holding the pricing tier ids an item concerns (string[]).
// Keeps the historical key of the hand-seeded `tier` custom field it replaces —
// the field is now derived from Pricing.tiers (see kinds/product-roadmap/fields).
export const PRICING_TIER_META_KEY = 'tier';

// A plugin (a.k.a. timeline kind) enabled on a timeline. Enablement is pure data
// — a row in `timeline_plugins`, no core-schema change — so this array replaces
// the old plugin-specific `type` column/field. `config` is the plugin's opaque
// bag; for 'product-roadmap' it carries `{ versions: string[] }`. Helpers +
// stable ids live in ./plugins.
export type PluginRef = { id: string; config?: Record<string, unknown> };

export type TimelineFile = {
  /** Points editors at schema/timeline.schema.json for completion + validation. */
  $schema?: string;
  name?: string;
  description?: string;
  groupBy?: string;
  // Plugins enabled on this timeline (e.g. 'product-roadmap' → pricing matrix).
  // Replaces the former `type: 'product'` gate; see ./plugins.
  plugins?: PluginRef[];
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
  /** Points editors at schema/config.schema.json for completion + validation. */
  $schema?: string;
  notesDir: string;
  defaultView: string;
  dateFields: string[];
  filenameDatePatterns: string[];
  views: View[];
};

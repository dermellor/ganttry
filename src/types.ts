import type { StatusKey } from './status';

// Where a source-backed view gets its data. The `kind` is the explicit
// discriminator that drives loading — deliberately NOT a "try the API, then
// fall back to a static file" guess, which conflates a live DB timeline with a
// stale snapshot (see AGENTS.md „keine Notfall-Daten"). Extensible to further
// API-served kinds (e.g. 'gsheet', external 'pg') later.
//   - 'db'    → live from the DB via /api/source/<id> (editable, no fallback)
//   - 'local' → a file the user owns. Whether it is editable is a property of
//               the RUNTIME, not of the format: a process with filesystem
//               access serves it through /api/source/<id>, a static deploy has
//               nothing to write with and serves the built copy read-only. See
//               [`docs/local-sources.md`](../docs/local-sources.md).
export type SourceKind = 'db' | 'local';

/**
 * `editable` is stamped at BUILD time for local sources, because the build is
 * what knows which of the two runtimes it is producing for. Deciding it at
 * runtime would mean probing ("try the API, fall back to the static file"),
 * which is the pattern that made a stale copy indistinguishable from live data
 * (AGENTS.md → „No fallback data, ever"). Absent = not editable.
 *
 * DB sources leave it unset and learn their capabilities from the response
 * header instead: theirs depend on the server's env, not on the build's.
 */
export type ViewSource = { kind: SourceKind; id: string; editable?: boolean };

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
//   pv/pn — the same pair over the plugin-owned rows (`plugin_data`).
//
// The plugin dimension is two extra fields rather than a widening of `v`/`n`,
// because those two carry documented meanings the rest of the code relies on —
// `v` is the item row version, and folding a second counter space into it would
// make it useless for the own-echo hint. They are optional so a source without
// plugin rows omits them, and both sides of a compare then agree on `undefined`.
// A local source leaves them unset on purpose: its version IS the file's mtime,
// which a plugin write moves along with everything else.
export type Watermark = { v: number; n: number; t: string | null; pv?: number; pn?: number };

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

/**
 * One entry in the viewer's view picker. Every view names a source: since the
 * Markdown notes pipeline was retired there is no other way for one to exist,
 * which is what removed the „view without a source" branch from the renderer.
 */
export type View = {
  id: string;
  name: string;
  description?: string;
  groupBy?: string;
  colorBy?: string;
  source: ViewSource;
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

// A plugin (a.k.a. timeline kind) enabled on a timeline. Enablement is pure data
// — a row in `timeline_plugins`, no core-schema change — so this array replaces
// the old plugin-specific `type` column/field. `config` is the plugin's opaque
// bag; for 'product-roadmap' it carries `{ versions: string[] }`. Helpers +
// stable ids live in ./plugins.
export type PluginRef = { id: string; config?: Record<string, unknown> };

/**
 * Where a plugin's code came from.
 *
 * Recorded rather than inferred, because uninstalling, re-verifying and
 * reinstalling all need to know: a URL can be refetched, a package resolved
 * again, a vendored directory re-read. `builtin` is the honest label for a plugin
 * that shipped inside the build and has no artifact of its own — an instance can
 * only run what it shipped with until the loader exists (issue #14), and calling
 * that anything else would invite a reinstall of something that was never
 * fetched.
 */
export type PluginArtifactKind = 'builtin' | 'url' | 'package' | 'vendored';

/**
 * One installed plugin, at INSTANCE level.
 *
 * Two levels, deliberately separate: installed (here) is „this instance has this
 * plugin's code and granted it these capabilities", enabled is a `PluginRef` on
 * one timeline. A plugin has to be installed before it can be enabled anywhere,
 * and disabling it on a timeline says nothing about the install.
 *
 * `manifest` is stored, not re-derived: the host has to be able to list, verify
 * and version-check a plugin without executing it, and it is also what the write
 * path enforces a plugin's collections against (docs/plugin-storage.md). Keeping
 * the copy that was validated at install time is what makes those checks
 * independent of whether the artifact is reachable right now.
 */
export type InstalledPlugin = {
  id: string;
  /** The artifact's own version, as its manifest declared it. */
  version: string;
  /** The host contract range the artifact was built against, e.g. `^1`. */
  apiVersion: string;
  artifact: { kind: PluginArtifactKind; source?: string; integrity?: string };
  /** Capabilities granted at install time — never widened by the plugin itself. */
  capabilities: string[];
  manifest: Record<string, unknown>;
  /**
   * Instance-level off switch. Distinct from „not enabled on this timeline": this
   * one stops the plugin everywhere without discarding what it stored, which is
   * what makes turning it back on lossless.
   */
  enabled: boolean;
  installedAt?: string;
  updatedAt?: string;
  updatedBy?: string;
};

/**
 * An installed plugin plus what the host currently thinks of it — the shape the
 * interface and the loader read.
 *
 * `problem` is a sentence for the person who installed it, not a code. A version
 * error nobody can read is indistinguishable from a broken plugin and gets
 * reported as one.
 */
export type PluginStatus = InstalledPlugin & {
  /** May the host run this plugin's code? False when `problem` is set. */
  loadable: boolean;
  /**
   * Why not, as a code the interface can word itself. Absent when the plugin is
   * fine.
   *
   * It exists alongside `problem` because the two have different readers: this
   * one is for the viewer, which is German and must not print a server's English
   * sentence at a user; `problem` is the diagnostic, which carries detail no
   * fixed phrase can (which version, which manifest field) and goes into logs
   * and to whoever wrote the plugin.
   */
  reason?: 'disabled' | 'api-version' | 'invalid-manifest';
  /** Why not, in one sentence with the specifics. Absent when the plugin is fine. */
  problem?: string;
};

/**
 * One row of a collection a plugin owns, in the shape it travels in everywhere:
 * the wire, the host API, and the section a local file carries.
 *
 * `data` is the plugin's own object, validated against the collection's declared
 * JSON Schema on the write path. Everything beside it is host-managed and a
 * plugin never sets it.
 *
 * `version` is the optimistic-lock counter sent back as `If-Match`. What it
 * counts differs by backing store, and the difference is real rather than
 * cosmetic: a DB row has its own counter, so two people can edit two rows of one
 * collection at once; a local file has one version for the whole document, so
 * the same header there means „the file has not changed since you read it".
 * Items already work exactly this way — see „Locking" in docs/plugin-storage.md.
 *
 * There is no `sort` field. Order is the array's order in `PluginCollectionData`,
 * which is the only representation a JSON file has; the DB's `sort` column exists
 * to reproduce it and stays behind the repo.
 */
export type PluginDataRow = {
  id: string;
  data: Record<string, unknown>;
  version?: number;
  updatedAt?: string;
  updatedBy?: string;
};

/** A plugin's collections, keyed by the collection id its manifest declares. */
export type PluginCollectionData = Record<string, PluginDataRow[]>;

/**
 * Every enabled plugin's rows, keyed by plugin id.
 *
 * It sits on the timeline file rather than behind a second request because a
 * local source has no server to ask: a static deploy materializes the file and
 * that copy has to be complete, or the plugin renders nothing. Making the DB
 * path match means one payload shape for both, and it keeps a local timeline
 * self-contained — copying the file copies the plugin's data with it.
 *
 * Only plugins actually enabled on the timeline are included, which is the same
 * gate that decides whether their code loads at all.
 */
export type PluginData = Record<string, PluginCollectionData>;

export type TimelineFile = {
  /** Points editors at schema/timeline.schema.json for completion + validation. */
  $schema?: string;
  name?: string;
  description?: string;
  groupBy?: string;
  // Plugins enabled on this timeline (e.g. 'product-roadmap' → pricing matrix).
  // Replaces the former `type: 'product'` gate; see ./plugins.
  plugins?: PluginRef[];
  // Rows owned by the enabled plugins, stored generically by the host. A plugin
  // never ships a migration, so this is where a plugin's own data lives on every
  // source kind; see docs/plugin-storage.md.
  pluginData?: PluginData;
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

/**
 * The `timeline.json` at the root of a **directory** source: everything a
 * timeline carries above item level, for the case where the items are one
 * Markdown file each (see docs/local-sources.md).
 *
 * A separate type rather than `TimelineFile` with an optional `items`. Making
 * `items` optional would weaken it at the dozen call sites that iterate it, none
 * of which a container file ever reaches — they all work on the *scanned*
 * result, which always has items. The cost is one more generated schema; the
 * benefit is that `file.items` stays something you can use without a guard.
 */
export type TimelineContainer = Omit<TimelineFile, 'items'>;

export type Config = {
  /** Points editors at schema/config.schema.json for completion + validation. */
  $schema?: string;
  defaultView: string;
  /**
   * Frontmatter keys tried in order for an item's start, and the filename
   * patterns tried when none of them carries one. Both are read by the
   * directory scanner (`scripts/local/scan.ts`); a JSON source states its dates
   * outright and never consults them.
   */
  dateFields: string[];
  filenameDatePatterns: string[];
};

/**
 * What the client actually loads: the committed config plus the views the build
 * discovered (local sources under `data/`, timelines found in the database).
 *
 * Two types rather than one with an optional `views`, for the same reason
 * `TimelineContainer` is separate from `TimelineFile`: optional would push an
 * undefined-check into every one of the half-dozen places that iterate the
 * views, none of which ever sees the committed file. The committed one is
 * validated against `schema/config.schema.json`; this one is a build artefact
 * and needs no schema.
 */
export type BuiltConfig = Config & {
  views: View[];
  /**
   * The instance's install registry as of the build.
   *
   * Baked in for the same reason a plugin's rows travel inside the timeline file:
   * a static deploy has no API to ask. A served instance re-reads it from
   * `GET /api/plugins`, so this copy is a starting point rather than the truth —
   * and it is metadata about which plugins exist, never anybody's content, which
   * is what keeps it clear of „No fallback data, ever".
   */
  plugins?: PluginStatus[];
};

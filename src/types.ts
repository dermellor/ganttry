import type { StatusKey } from './status';
import type { MemberRole, MemberStatus } from './access';

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
import type { Locale } from './i18n/locale.ts';

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
 * One membership of this instance: a directory entry plus what it may do.
 *
 * `Member extends DirectoryUser` is the type-level statement of migration 0016's
 * decision — the directory and the member list are one table, because once an
 * invitation is the only way in they are the same set of people. The rules that
 * read `role` and `status` live in [`src/access.ts`](./access.ts), which is also
 * where the two unions come from, so a role added there cannot be forgotten here.
 *
 * Timestamps are ISO strings rather than `Date`, like everything else that
 * crosses the API boundary.
 */
export type Member = DirectoryUser & {
  role: MemberRole;
  status: MemberStatus;
  /** Who sent the invitation; absent for rows that predate membership. */
  invitedBy?: string;
  invitedAt?: string;
  /** When the invitation was accepted, which is the first successful sign-in. */
  acceptedAt?: string;
  /**
   * When an outstanding invitation stops being accepted at sign-in. Absent once
   * accepted: `setMemberStatus` clears it, so a stale expiry cannot later refuse
   * somebody who is long since active.
   */
  inviteExpiresAt?: string;
  lastSeenAt?: string;
};

/**
 * Where an instance-wide setting's value comes from.
 *
 * `env` is the host's environment or the instance profile, `build` is baked into
 * the artefact, `db` is state the running app writes through its own API. No
 * declaration is `db` yet — the plugin install registry is the first one, and it
 * arrives without this union changing, which is the point of declaring the home
 * rather than hardcoding one per setting.
 */
export type SettingHome = 'env' | 'db' | 'build';

/**
 * One instance-wide setting as served to the operator interface.
 *
 * The declaration it comes from lives in [`src/settings.ts`](./settings.ts),
 * together with the reasoning for the two fields that are easy to misread:
 * `value` is absent (rather than empty or masked) whenever the declaration does
 * not allow the value to be served, and `set` is therefore the only thing that
 * can be said about a secret.
 */
export type DeclaredSetting = {
  key: string;
  group: string;
  label: string;
  home: SettingHome;
  /** Whether this deployment can change the value here, in the app. */
  editable: boolean;
  /** Does this instance set it at all? Served for every setting. */
  set: boolean;
  /** The effective value — only for settings declared safe to serve. */
  value?: string;
};

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

/**
 * One wikilink a directory scan found on a note, with the frontmatter key it sat
 * under. Recorded as a list on `metadata.wikilinks` when `scan.linkEdges` is on.
 *
 * It exists because `metadata.dependsOn` flattens every link into one relation
 * with one direction, and the field name is what says which direction was meant:
 * a key listing what leads *to* a note points the opposite way from a link the
 * author wrote mid-sentence. Once the name is gone no consumer can recover it, so
 * the scanner keeps it and leaves the interpretation to whoever draws the edges.
 *
 * The key is `wikilinks` and not `links` because the scanner's own metadata keys
 * overwrite the note's frontmatter (`{ ...fm, path, filename, dateSource }`), and
 * `links:` is a plausible key for a vault to already use.
 */
export type ItemLink = {
  /** The top-level frontmatter key the link sat under; `null` for body prose. */
  field: string | null;
  /** The resolved id of the linked item. */
  target: string;
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
  // The plugin that contributed this field computes its value per item, so nothing
  // is stored in `metadata[key]` and nobody edits it: the form shows it read-only
  // and the write path leaves the key alone
  // ([`src/pluginHost/derived.ts`](src/pluginHost/derived.ts)). Only a contributed
  // field may claim it — a stored definition has no code behind it, so a derived one
  // would be a field with no value at all, which is why `mergeFieldDefs` drops the
  // flag from a stored def rather than trusting the file. What it prevents is a value that
  // *follows* from the item (the sprint its dates fall into) being kept as a copy:
  // the copy survives the item moving, and a stale bucket is indistinguishable
  // from a chosen one.
  derived?: boolean;
};


// A plugin (a.k.a. timeline kind) enabled on a timeline. Enablement is pure data
// — a row in `timeline_plugins`, no core-schema change — so this array replaces
// the old plugin-specific `type` column/field. `config` is the plugin's opaque
// bag; for 'dev.zeitlines.product-roadmap' it carries `{ versions: string[] }`. Helpers +
// stable ids live in ./plugins.
export type PluginRef = {
  id: string;
  config?: Record<string, unknown>;
  /**
   * Consent to serve this plugin's declared `publicRead` collections without
   * authentication. Absent = no.
   *
   * Separate from being enabled, and deliberately so: plenty of timelines carry a
   * pricing model that is not meant to be public, and „the plugin is on" must not
   * be read as „the world may read it". On a `db` source this is the
   * `timeline_plugins.public` column; here it is the same fact on the file, so the
   * decision travels with the document a user owns.
   */
  public?: boolean;
};

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

/**
 * What the relation graph needs told about a timeline, beyond its items and
 * relations.
 *
 * Both fields name a **group**, because that is the vocabulary a timeline already
 * has for „what kind of thing is this" — no new dimension, and a folder-derived
 * group works as well as a declared one.
 */
export type GraphConfig = {
  /**
   * The group whose items are **band roots**: each one claims everything reachable
   * from it, its title becomes the band's heading, and it is taken out of the
   * columns.
   *
   * Without it a band is an anonymous connected component, which is honest but
   * says nothing. With it, a strand is labelled by the thing it hangs off — the
   * plan a set of tasks serves, the epic a set of stories belongs to. Members
   * nothing claims fall back to anonymous components behind the titled ones.
   */
  bandRootGroup?: string;
  /**
   * The group whose items are shown **on** a node rather than beside it: every
   * item of that group which references this node is listed under its title.
   *
   * It exists for the references that are context and not structure. A revelation
   * surfaces in four scenes; drawn as four edges that is noise, and it also
   * disappears the moment the extent hides scenes. As a line on the node it
   * survives both.
   */
  referenceGroup?: string;
};

/**
 * Who a saved view is for.
 *
 * `private` is the default because a half-built narrowing is the normal state of
 * one: somebody sets a filter, keeps it, and refines it over a week. Publishing is
 * a separate act, and it needs `write` — a `viewer` may keep their own without
 * being able to put one in front of everybody (see docs/users.md).
 */
export type SavedViewVisibility = 'private' | 'instance';

/**
 * A named combination of presentation, grouping dimension and filter selection,
 * stored with the timeline rather than in one person's browser.
 *
 * The display state itself is per person and per timeline in `localStorage`
 * (docs/editing.md → „Where the display state lives"). That answers „how am I
 * looking at this right now" and cannot answer „the way we look at this every
 * Monday", because it has no name, no second reader and no address.
 *
 * What it deliberately does NOT carry is the visible time window. An absolute
 * window ages into something nobody wants to see within a quarter, and „the next
 * three months" is a relative window — a different feature that this one must not
 * smuggle in under the same name.
 */
export type SavedView = {
  /** Unique within its timeline; travels in the hash as `sv=<id>`. */
  id: string;
  name: string;
  /**
   * The presentation to open in — a `ViewMode` string (`timeline`, `list`,
   * `plugin:<id>:<view>`). Absent means „leave the presentation alone", which is
   * what makes a view that is only about the narrowing possible.
   */
  mode?: string;
  /** The grouping dimension, as `state.groupBy` spells it (`group`, `cf:tier`, …). */
  groupBy?: string;
  /** Selected values per filter dimension; the shape `FilterSelection` describes. */
  filters?: Record<string, string[]>;
  /**
   * Which recorded link fields become edges, and which way they point (see
   * src/linkEdges.ts). Only fields deviating from the default are stored, so an
   * absent value means „every field incoming" — which is what every view saved
   * before this existed was showing.
   *
   * Round-trips through a **local** source, whose saved views are stored as this
   * JSON. The database path enumerates its columns and has no `edges` one, so a
   * DB-backed view drops it — deliberately, because only a directory scan records
   * the link origins this acts on, and the control never appears without them. A
   * DB source that ever records them needs the migration before it needs this.
   */
  edges?: Record<string, 'off' | 'in' | 'out'>;
  /** The address of whoever created it. Empty on a source with no identity. */
  owner?: string;
  /** Defaults to `private` when absent, which is what an older file spells. */
  visibility?: SavedViewVisibility;
  /** Optimistic-lock counter, server-managed like an item's. */
  version?: number;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type TimelineFile = {
  /** Points editors at schema/timeline.schema.json for completion + validation. */
  $schema?: string;
  name?: string;
  description?: string;
  groupBy?: string;
  /**
   * In what order the groups are laid out: alphabetically by id (the default and
   * the behaviour every existing timeline has), or in the order `groups` declares.
   *
   * `alpha` is the default rather than the obvious `declared` because it is what
   * shipped: the committed examples number their group ids (`1-strategy`,
   * `2-design`) precisely to steer the alphabetical sort, and flipping the default
   * would silently reorder the lanes of every timeline in existence — including
   * ones whose declared order was never meant to be read.
   *
   * `declared` is for the case the workaround cannot reach: group ids that carry
   * meaning of their own and cannot be renumbered, such as the folder names a
   * directory source derives its groups from. Groups that only appear on items,
   * with no declaration, follow the declared ones alphabetically either way.
   */
  groupOrder?: 'alpha' | 'declared';
  /** How the relation graph reads this timeline. See `GraphConfig`. */
  graph?: GraphConfig;
  /**
   * Named ways of looking at this timeline. On a `db` source these are rows of
   * the `saved_views` table folded in for the caller; in a file they are the
   * store itself, which is what keeps a local timeline self-contained — the same
   * split `pluginData` makes (docs/plugin-storage.md).
   *
   * What reaches a client is already filtered by who asked: a private view of
   * somebody else is never in this array.
   */
  savedViews?: SavedView[];
  // Plugins enabled on this timeline (e.g. 'dev.zeitlines.product-roadmap' → pricing matrix).
  // Replaces the former `type: 'product'` gate; see ./plugins.
  plugins?: PluginRef[];
  // Rows owned by the enabled plugins, stored generically by the host. A plugin
  // never ships a migration, so this is where a plugin's own data lives on every
  // source kind; see docs/plugin-storage.md.
  pluginData?: PluginData;
  phases?: TimelinePhase[];
  customFields?: CustomFieldDef[];
  items: TimelineFileItem[];
  groups?: {
    id: string;
    content: string;
    nestedGroups?: string[];
    showNested?: boolean;
    /**
     * The group's own colour, any CSS colour. Unset falls back to the positional
     * lane palette, so no existing timeline changes appearance.
     *
     * It exists because the lane palette answers „which track is this" and some
     * timelines need „what kind of thing is this": a hint is green and an
     * antagonist's move is red because of what they mean, not because of which
     * column they landed in. That mapping is the author's to make, which is why it
     * is a value in the data rather than a rule in the code — the same reasoning
     * behind `phases[].color` and `customFields[].options[].color`.
     *
     * **Honoured by the relation graph only, for now.** The chart's lane colouring
     * runs through `.lane-N` selectors on the item elements, and widening that to
     * arbitrary per-group colours is its own change to the drawing path; claiming
     * this field is global while half the app ignored it would be worse than the
     * documented limit.
     */
    color?: string;
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
/**
 * How a directory's Markdown files are read into items.
 *
 * It sits on the container rather than in an env var or in `timelines.config.json`
 * because it is a property of *that* folder: which frontmatter key holds a date,
 * whether the subfolder means something, whether wikilinks are relations. A folder
 * of meeting notes and a folder holding a novel answer differently, and the answer
 * has to travel with the folder — otherwise moving or copying it changes what it
 * means (the same reasoning that put `groups` and `phases` here, see
 * docs/local-sources.md).
 */
export type ScanConfig = {
  /**
   * Frontmatter keys tried in order for an item's start. Defaults to
   * `["date", "scheduled", "created"]`.
   *
   * An **empty array** is the meaningful setting rather than a degenerate one: it
   * says none of this folder's dates are the item's date. A vault stamps `created`
   * on every note, and reading that as the start puts a hundred items on the day
   * they were typed — a timeline that looks like data and is an artefact of the
   * editor.
   */
  dateFields?: string[];
  /** Regexes tried against the filename when no frontmatter date is found. */
  filenameDatePatterns?: string[];
  /**
   * Take the item's group from the subfolder it sits in, when its frontmatter
   * names none. Off by default: a flat folder has nothing to derive, and a folder
   * whose subdirectories are storage rather than meaning would gain groups that
   * say nothing.
   */
  groupFromFolder?: boolean;
  /**
   * Read `[[wikilinks]]` as relations between items, recorded on
   * `metadata.dependsOn` and, one entry per link with the frontmatter key it came
   * from, on `metadata.wikilinks`. Off by default, because in most folders a link
   * is a reference and not a dependency.
   */
  linkEdges?: boolean;
};

export type TimelineContainer = Omit<TimelineFile, 'items'> & {
  /** Directory sources only: how the Markdown files are read. */
  scan?: ScanConfig;
};

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
  /**
   * `TIMELINES_DEFAULT_LANGUAGE`: the interface language for somebody on this
   * deployment who has never chosen one.
   *
   * In the built config because the client needs it before the first paint. A
   * person's own choice may arrive a round trip late — the device remembers it —
   * but a first-ever visit has nothing remembered, and a default fetched
   * afterwards paints English and then visibly re-renders into the instance's
   * language. Absent when unset, so the client falls through to the product
   * default rather than being handed one that outranks nothing.
   */
  defaultLanguage?: Locale;
};

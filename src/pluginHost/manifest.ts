// What a plugin declares about itself, and the check that a declaration is
// coherent before anything of the plugin runs.
//
// The manifest is static data on purpose: the host has to be able to list, verify
// and version-check a plugin *without executing it*. That is what makes an install
// flow possible at all, and it is why everything a plugin needs from the host is
// declared here rather than requested at runtime.
//
// Two of these sections do work the database does today. A plugin cannot ship DDL
// and must not ship server code, so the constraints Postgres enforces for a
// built-in plugin (shape, references with cascade) move into `collections` and
// `references`, which the host enforces on the write path. Those two are declared
// here and enforced in #12; everything else in this module is live now.

import { satisfiesApiVersion, type ApiVersion } from './apiVersion.ts';
import { unsupportedKeywords } from './dataSchema.ts';
import type { BuiltinViewMode } from './viewMode.ts';

/**
 * What a plugin is allowed to do. Coarse on purpose: this list is shown to the
 * person installing the plugin ("may modify your items"), and a list of forty
 * fine-grained scopes is a list nobody reads.
 */
export const CAPABILITIES = [
  'items:read',
  'items:write',
  'fields',
  'views',
  'data:own',
  'tools',
  'public:read',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Which of the presentation level's shared controls apply to a view. Both default
 * to false, so a view that renders something other than the item list gets a bar
 * with nothing inert on it.
 *
 * Declared per accessory rather than as one „toolbar" boolean, because the two are
 * different questions: the perspective bundles the same set, the extent narrows it.
 * A view can honour one and not the other, and the boolean forced the host to
 * decide for it. See „Level 4 has two halves" (docs/information-architecture.md).
 */
export type ViewAccessories = {
  /** The perspective control: the grouping dimension. */
  grouping?: boolean;
  /** The extent control: the value filter. */
  filter?: boolean;
  /**
   * „+ Eintrag": creating a timeline item from this presentation. A view that does
   * not show items has no business offering it — the object would be created
   * somewhere the user cannot see it. A plugin's own rows get their own
   * affordances inside the view.
   */
  create?: boolean;
  /** „Export HTML": exporting what this presentation shows. */
  export?: boolean;
};

export const ACCESSORY_KEYS = ['grouping', 'filter', 'create', 'export'] as const;

export type ManifestView = {
  id: string;
  label: string;
  /** Inline SVG for the header toggle. */
  icon: string;
  /** Which shared controls apply. Absent = none. */
  accessories?: ViewAccessories;
  /**
   * @deprecated The one boolean `accessories` replaced, and the reason it did:
   * it could only say „all of them" or „none". Still read, as
   * `{ grouping: true, filter: true }`, because a plugin declaring `^1` was built
   * against it and the point of a versioned contract is that such an artifact
   * keeps running. Never written by anything in this repository.
   */
  toolbar?: boolean;
};

/**
 * What each built-in presentation gets.
 *
 * This table exists because „built-in" stopped being a single answer. Timeline and
 * list are two renderings of the item list and take all four; the graph is not one
 * of them, and handing it „+ Eintrag" and „Export HTML" because it happens to be
 * built in would put two controls in its bar that cannot do anything — the exact
 * failure the per-accessory declaration was introduced to stop, one level up from
 * where it was fixed for plugin views.
 */
const BUILTIN_ACCESSORIES: Record<BuiltinViewMode, Required<ViewAccessories>> = {
  timeline: { grouping: true, filter: true, create: true, export: true },
  list: { grouping: true, filter: true, create: true, export: true },
  graph: {
    // The grouping dimension *is* the graph's columns, so the perspective is not
    // merely allowed here, it is what the presentation is built on.
    grouping: true,
    filter: true,
    // An item with no date is exactly what this presentation can show, and the
    // other two cannot — so creating one from here is the point rather than a
    // concession.
    create: true,
    // Nothing renders a graph to HTML yet. Declaring it would offer an action that
    // exports the timeline instead, which is worse than not offering one.
    export: false,
  },
};

/**
 * What a view actually gets. One place, so „built-in" and „declared by a plugin"
 * are answered the same way: the host asks the presentation instead of branching
 * on whether it belongs to a plugin, which is what `toolbar` made it do.
 *
 * A built-in presentation is named by its mode. No argument means the timeline —
 * the presentation everything falls back to when a plugin view stops applying.
 */
export function viewAccessories(
  view?: ManifestView | BuiltinViewMode | null,
): Required<ViewAccessories> {
  if (!view) return BUILTIN_ACCESSORIES.timeline;
  if (typeof view === 'string') return BUILTIN_ACCESSORIES[view];
  const declared = view.accessories;
  if (declared) {
    return {
      grouping: !!declared.grouping,
      filter: !!declared.filter,
      create: !!declared.create,
      export: !!declared.export,
    };
  }
  // The retired boolean spoke about the grouping/filter bar and about nothing else,
  // so it must not be read as permission to create or export: a plugin declaring it
  // never said anything about those.
  return { grouping: !!view.toolbar, filter: !!view.toolbar, create: false, export: false };
}

/** A set of rows the plugin owns, stored generically by the host (#12). */
export type CollectionDecl = {
  id: string;
  /**
   * JSON Schema for one row, applied by the host on every write.
   *
   * Only the subset in `./dataSchema` is allowed, and a schema using anything
   * else makes the manifest invalid rather than being partly applied — see the
   * note there for why an unenforced keyword is worse than a rejected one.
   */
  schema?: Record<string, unknown>;
  /**
   * Fields whose values form the row's identity, for a composite key like a
   * matrix cell (tier × feature). Absent = the row carries its own single id.
   */
  keyFields?: string[];
  /** Does row order matter (host-maintained `sort` plus a relative move)? */
  ordered?: boolean;
};

/** A link between two of the plugin's own collections. */
export type ReferenceDecl = {
  /** Collection holding the reference. */
  from: string;
  /** Field on `from` carrying the target row id. */
  field: string;
  /** Collection being referenced. */
  to: string;
  /**
   * Does `field` hold an ARRAY of target ids rather than one?
   *
   * Declared because a many-to-many link is not a rarity to be special-cased:
   * product-roadmap's highlights each bundle a list of feature ids, and without
   * this the host cannot see the relation at all. It could then neither refuse a
   * list naming a feature that does not exist, nor clean the id out when one is
   * deleted — which is precisely the loop `deleteFeature` writes by hand today.
   */
  array?: boolean;
  /**
   * What happens to `from` rows when the target disappears:
   *
   *   - `cascade` (the default) — the referencing row goes too.
   *   - `restrict` — the delete is refused while any row still points here.
   *   - `unlink` — the reference is cleared and the row stays. For an `array`
   *     field that means dropping the one id, which is the only correct answer
   *     for a bundle: deleting one of five features must not delete the tile.
   */
  onDelete?: 'cascade' | 'restrict' | 'unlink';
};

/**
 * One agent verb the plugin contributes.
 *
 * The half of a plugin that fields cannot express: an agent gets `add_item` and
 * `update_item` from the core, and everything domain-specific about *when* to
 * apply them has to come from somewhere. A rule carried in a prompt cannot be
 * tested and cannot be reused, and it is wrong in a way nobody notices until a
 * date is wrong.
 *
 * Declared here rather than exported by the plugin's code for the reason the
 * whole manifest exists: the host has to be able to list and version-check a
 * tool without executing the plugin. What runs is a pure function (see
 * `./tools.ts`), which is what keeps a domain rule unit-testable and lets the
 * host apply the result through the write path it already owns.
 *
 * A plugin whose verbs are the point of it should declare `apiVersion: "^1.3"`,
 * the version this section arrived in. `^1` is accepted, because the section is
 * additive and an artifact built against 1.0 has to keep loading — but any host
 * older than 1.3 will load such a plugin and list its tools nowhere, and that is
 * not something a newer host can warn about on the older one's behalf.
 */
export type ToolDecl = {
  /**
   * The name an agent calls, in a namespace shared by every installed plugin.
   *
   * Bare snake_case, because a tool name is not an id: the MCP tool namespace is
   * flat and the common constraint on it is `[a-zA-Z0-9_-]`, so the reverse-DNS
   * plugin id cannot be a prefix. Two plugins claiming one verb is therefore
   * possible, and is resolved where the list is assembled (`pluginTools`) rather
   * than by mangling the name into something no one would type.
   */
  name: string;
  title: string;
  /**
   * What it does, for the agent choosing between tools. This is the only thing a
   * model sees before calling, so „applies the rule" is not a description.
   */
  description: string;
  /**
   * JSON Schema for the arguments, in the `./dataSchema` subset.
   *
   * `id` is reserved: a tool always runs against one timeline, and the host
   * supplies it under that name.
   */
  inputSchema?: Record<string, unknown>;
  /**
   * What the tool may change. Absent means it answers a question and changes
   * nothing, which is a real category (`check_regulatory_gates`) and not an
   * oversight — a plan from such a tool carrying changes is refused rather than
   * applied, so an analysis tool cannot quietly become a write.
   */
  writes?: 'items';
};

/**
 * What the catalogue renders for this plugin.
 *
 * Here rather than in a list somebody maintains, because a hand-kept list is fine
 * at three plugins and a wall of links at fifty, and the copy in the list is the
 * one that goes stale. The catalogue page is generated from these entries and CI
 * compares the committed copy, the same shape `schema:check` and `openapi:check`
 * already use.
 *
 * **Optional to load, required to publish.** A plugin with no entry still runs —
 * refusing it would make a catalogue field a boot requirement, which is the wrong
 * severity for a publication concern. `plugins:catalogue:check` is what insists.
 */
export type CatalogueEntry = {
  /**
   * One sentence, the card's subtitle. Single line and short on purpose: this is
   * the text a reader skims in a list of fifty and the one an engine quotes.
   */
  summary: string;
  /**
   * The category the catalogue groups by, as a lowercase slug (`legal`,
   * `construction`, `product`).
   *
   * Free-form rather than a fixed list in this file, and that is the deliberate
   * trade: a controlled vocabulary would mean editing a core file to publish a
   * plugin in a new domain, which is exactly the „one folder, one registration
   * line, no core file touched" budget a plugin is supposed to fit in. The cost is
   * that two plugins can spell one domain differently, which the catalogue makes
   * visible by grouping.
   */
  domain: string;
  /** What somebody would search for. The words a reader uses, not ours. */
  keywords: string[];
  /**
   * The view id of the example timeline that demonstrates the plugin, e.g.
   * `src:example-produkt-roadmap`.
   *
   * One field, two jobs, which is why it is here rather than in a README link:
   * the catalogue links it so a reader can see the plugin before installing it,
   * and `plugins:preview` renders the preview image from it. Two copies of „which
   * example is this plugin's" is how the picture ends up showing a timeline the
   * page does not link.
   */
  example?: string;
};

/** Collections (and fields) the host may serve unauthenticated (#20). */
export type PublicReadDecl = {
  collections: string[];
  /** Per collection, the fields exposed. Absent = every field except internals. */
  fields?: Record<string, string[]>;
};

export type PluginManifest = {
  /** Globally unique. Keys `timeline_plugins` and the plugin's own rows. */
  id: string;
  name: string;
  /** The artifact's own version (semver). */
  version: string;
  /** What the generated catalogue renders. Required to publish, not to load. */
  catalogue?: CatalogueEntry;
  /** The host contract range this was built against, e.g. "^1" or "^1.2". */
  apiVersion: string;
  /** ES module entry, relative to the manifest. Absent for an in-tree plugin. */
  entry?: string;
  capabilities?: Capability[];
  views?: ManifestView[];
  /** JSON Schema for the `timeline_plugins.config` bag. */
  configSchema?: Record<string, unknown>;
  collections?: CollectionDecl[];
  references?: ReferenceDecl[];
  /** Agent verbs this plugin contributes. */
  tools?: ToolDecl[];
  /** Item `metadata` keys this plugin owns, so uninstalling can clean them up. */
  metadataKeys?: string[];
  publicRead?: PublicReadDecl;
  /** Bare view-mode ids this plugin's views used to answer to (legacy links). */
  legacyModeIds?: Record<string, string>;
};

export type ManifestProblem = string;
export type ValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; problems: ManifestProblem[] };

/**
 * **Reverse-DNS, and nothing else.**
 *
 * An id is global — it keys `timeline_plugins`, the plugin's own rows in
 * `plugin_data` and the metadata on items — so a collision is a data collision
 * rather than a naming annoyance. With no central registry to hand out names,
 * the only thing that makes a name safe to claim is that it derives from
 * something the author already owns: a domain.
 *
 * An npm scope (`@acme/sprints`) expresses the same idea and was rejected,
 * because this id is three things at once and that form breaks two of them:
 *
 *   - a **path segment** (`/api/source/<id>/plugin/<pluginId>/…`), where `@` and
 *     `/` have to be percent-encoded at every call site and in every hand-written
 *     request;
 *   - a **directory name** (`plugins/<id>/manifest.json`), where a slash makes it
 *     a nested directory and the flat scan stops finding it;
 *   - a database key, which is the only one it survives.
 *
 * `com.acme.sprints` is a plain segment in all three.
 *
 * Two labels minimum, so a bare word cannot be claimed: `sprints` is the name a
 * hundred people would pick, `com.acme.sprints` is one nobody else will.
 */
const ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A tool name: snake_case, at least four characters, no dots.
 *
 * The shape agents already meet everywhere (`add_item`, `read_plugin_data`), and
 * a subset of the `[a-zA-Z0-9_-]` every tool namespace accepts. The minimum
 * length is there because a two-letter verb in a namespace shared by every
 * installed plugin is a collision waiting to happen.
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{3,47}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** How long a card subtitle may get before it stops being one. */
const SUMMARY_MAX = 200;
const DOMAIN_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Everything wrong with a catalogue entry.
 *
 * Exported because two callers need the same answer: `validateManifest` applies it
 * to an entry that exists, and `plugins:catalogue:check` applies it to insist that
 * one does. A second copy is how „the summary must be one line" ends up enforced
 * in the generator and not in the manifest.
 */
export function catalogueProblems(entry: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(entry)) return ['catalogue must be an object with summary, domain and keywords'];
  const e = entry as Partial<CatalogueEntry>;

  if (typeof e.summary !== 'string' || !e.summary.trim()) {
    problems.push('catalogue.summary is required: one sentence saying what the plugin does');
  } else {
    if (e.summary.length > SUMMARY_MAX) {
      problems.push(`catalogue.summary is ${e.summary.length} characters; a card subtitle stops at ${SUMMARY_MAX}`);
    }
    // A line break makes the card two lines in some renderers and one in others,
    // and the entry is read by both a page and a crawler.
    if (/[\r\n]/.test(e.summary)) problems.push('catalogue.summary must be a single line');
  }

  if (typeof e.domain !== 'string' || !DOMAIN_RE.test(e.domain)) {
    problems.push('catalogue.domain must be a lowercase slug (e.g. "legal", "construction")');
  }

  if (e.example != null && (typeof e.example !== 'string' || !e.example.trim())) {
    problems.push('catalogue.example must be a view id (e.g. "src:example-produkt-roadmap")');
  }

  if (!Array.isArray(e.keywords) || !e.keywords.length) {
    problems.push('catalogue.keywords needs at least one entry: what somebody would search for');
  } else {
    const seen = new Set<string>();
    for (const keyword of e.keywords) {
      if (typeof keyword !== 'string' || !keyword.trim()) {
        problems.push('catalogue.keywords entries must be non-empty strings');
        continue;
      }
      const key = keyword.trim().toLowerCase();
      if (seen.has(key)) problems.push(`catalogue.keywords repeats "${keyword}"`);
      seen.add(key);
    }
  }

  return problems;
}

/**
 * Check a manifest. Returns every problem rather than the first, because an
 * author fixing one line at a time through a loader's error message is the slow
 * way to find out that three fields are wrong.
 *
 * Strict by design: an unknown capability, a reference to a collection that does
 * not exist, or a declaration the capabilities do not cover all mean the plugin
 * does not load. A silently-ignored declaration is worse than a refusal, because
 * the plugin then runs with less access than it thinks it has and fails somewhere
 * far away from the cause.
 */
export function validateManifest(input: unknown, host?: ApiVersion): ValidationResult {
  const problems: ManifestProblem[] = [];
  if (!isPlainObject(input)) return { ok: false, problems: ['manifest must be an object'] };
  const m = input as Partial<PluginManifest>;

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    problems.push(
      'id must be reverse-DNS: at least two lowercase labels separated by dots, derived from a domain ' +
        'you own (e.g. "com.acme.sprints"). A bare name is not global enough to key data with.',
    );
  }
  if (typeof m.name !== 'string' || !m.name.trim()) problems.push('name is required');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    problems.push('version must be semver (e.g. "1.2.0")');
  }
  if (typeof m.apiVersion !== 'string' || !satisfiesApiVersion(m.apiVersion, host)) {
    problems.push(
      typeof m.apiVersion === 'string'
        ? `apiVersion "${m.apiVersion}" is not satisfied by this host`
        : 'apiVersion is required (e.g. "^1")',
    );
  }
  if (m.entry != null && (typeof m.entry !== 'string' || !m.entry.trim())) {
    problems.push('entry must be a non-empty string when present');
  }

  // Checked when present, never demanded: a missing catalogue entry is a plugin
  // that is not ready to publish, not one that must refuse to run.
  if (m.catalogue != null) {
    for (const problem of catalogueProblems(m.catalogue)) problems.push(problem);
  }

  const caps = new Set<string>(m.capabilities ?? []);
  for (const cap of caps) {
    if (!(CAPABILITIES as readonly string[]).includes(cap)) problems.push(`unknown capability "${cap}"`);
  }

  const viewIds = new Set<string>();
  for (const v of m.views ?? []) {
    if (!isPlainObject(v) || typeof v.id !== 'string' || !v.id.trim()) {
      problems.push('every view needs a non-empty id');
      continue;
    }
    if (v.id.includes(':')) problems.push(`view id "${v.id}" must not contain ":" (it addresses the view mode)`);
    if (viewIds.has(v.id)) problems.push(`duplicate view id "${v.id}"`);
    viewIds.add(v.id);
    if (typeof v.label !== 'string' || !v.label.trim()) problems.push(`view "${v.id}" needs a label`);
    if (typeof v.icon !== 'string' || !v.icon.trim()) problems.push(`view "${v.id}" needs an icon`);
    // Refused rather than partly applied, for the same reason an unknown
    // capability is: a declaration the host silently dropped leaves the plugin
    // running as if it had been honoured, and the symptom then surfaces far from
    // the cause — here as a control that is missing or inert with no explanation.
    if (v.accessories != null) {
      if (!isPlainObject(v.accessories)) {
        problems.push(`view "${v.id}": accessories must be an object`);
      } else {
        for (const [key, value] of Object.entries(v.accessories)) {
          if (!(ACCESSORY_KEYS as readonly string[]).includes(key)) {
            problems.push(`view "${v.id}": unknown accessory "${key}"`);
          } else if (typeof value !== 'boolean') {
            problems.push(`view "${v.id}": accessory "${key}" must be a boolean`);
          }
        }
      }
    }
    if (v.toolbar != null && typeof v.toolbar !== 'boolean') {
      problems.push(`view "${v.id}": toolbar must be a boolean`);
    }
  }
  if (viewIds.size && !caps.has('views')) problems.push('declaring views requires the "views" capability');

  const collectionIds = new Set<string>();
  for (const c of m.collections ?? []) {
    if (!isPlainObject(c) || typeof c.id !== 'string' || !c.id.trim()) {
      problems.push('every collection needs a non-empty id');
      continue;
    }
    if (collectionIds.has(c.id)) problems.push(`duplicate collection "${c.id}"`);
    collectionIds.add(c.id);
    if (c.schema != null && !isPlainObject(c.schema)) problems.push(`collection "${c.id}": schema must be an object`);
    // A declared schema has to be one the host can actually apply. Accepting a
    // keyword it then skips is the failure this refusal prevents: the author
    // reads their constraint in the manifest and believes every write is checked
    // against it. See SUPPORTED_KEYWORDS in ./dataSchema.
    else if (c.schema != null) {
      for (const problem of unsupportedKeywords(c.schema)) problems.push(`collection "${c.id}" schema ${problem}`);
    }
    if (c.keyFields != null && (!Array.isArray(c.keyFields) || !c.keyFields.length)) {
      problems.push(`collection "${c.id}": keyFields must be a non-empty array when present`);
    }
  }
  if (collectionIds.size && !caps.has('data:own')) {
    problems.push('declaring collections requires the "data:own" capability');
  }

  for (const r of m.references ?? []) {
    if (!isPlainObject(r) || typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.field !== 'string') {
      problems.push('every reference needs from, field and to');
      continue;
    }
    if (!collectionIds.has(r.from)) problems.push(`reference from unknown collection "${r.from}"`);
    if (!collectionIds.has(r.to)) problems.push(`reference to unknown collection "${r.to}"`);
    if (r.onDelete != null && !['cascade', 'restrict', 'unlink'].includes(r.onDelete)) {
      problems.push(`reference ${r.from}.${r.field}: onDelete must be "cascade", "restrict" or "unlink"`);
    }
    if (r.array != null && typeof r.array !== 'boolean') {
      problems.push(`reference ${r.from}.${r.field}: array must be a boolean when present`);
    }
  }

  const toolNames = new Set<string>();
  for (const t of m.tools ?? []) {
    if (!isPlainObject(t) || typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) {
      problems.push(
        'every tool needs a snake_case name of at least four characters ' +
          '(e.g. "recalculate_deadlines"); a tool namespace is flat and takes no dots',
      );
      continue;
    }
    if (toolNames.has(t.name)) problems.push(`duplicate tool "${t.name}"`);
    toolNames.add(t.name);
    if (typeof t.title !== 'string' || !t.title.trim()) problems.push(`tool "${t.name}" needs a title`);
    // The description is what a model reads when it decides whether to call the
    // tool at all, so an empty one does not make the tool unavailable — it makes
    // it invisible, which is the harder failure to diagnose.
    if (typeof t.description !== 'string' || !t.description.trim()) {
      problems.push(`tool "${t.name}" needs a description; it is what an agent chooses on`);
    }
    if (t.inputSchema != null) {
      if (!isPlainObject(t.inputSchema)) problems.push(`tool "${t.name}": inputSchema must be an object`);
      // Same rule as a collection's schema, and for the same reason: a keyword the
      // host cannot apply is refused here rather than skipped on every call, where
      // the author would keep believing their constraint was checked.
      else {
        for (const problem of unsupportedKeywords(t.inputSchema)) problems.push(`tool "${t.name}" inputSchema ${problem}`);
        // A tool always runs against one timeline, and the host passes it as `id`.
        // A declared argument of that name would shadow it, which does not fail —
        // it sends the rule someone else's timeline.
        const props = t.inputSchema.properties;
        if (isPlainObject(props) && 'id' in props) {
          problems.push(`tool "${t.name}": "id" is reserved for the timeline the tool runs against`);
        }
      }
    }
    if (t.writes != null && t.writes !== 'items') {
      problems.push(`tool "${t.name}": writes must be "items" when present`);
    }
    if (t.writes === 'items' && !caps.has('items:write')) {
      problems.push(`tool "${t.name}" writes items, which requires the "items:write" capability`);
    }
  }
  if (toolNames.size && !caps.has('tools')) problems.push('declaring tools requires the "tools" capability');

  for (const k of m.metadataKeys ?? []) {
    if (typeof k !== 'string' || !k.trim()) problems.push('metadataKeys entries must be non-empty strings');
  }
  if ((m.metadataKeys ?? []).length && !caps.has('items:write') && !caps.has('items:read')) {
    problems.push('owning item metadata keys requires an "items:read" or "items:write" capability');
  }

  if (m.publicRead != null) {
    if (!isPlainObject(m.publicRead) || !Array.isArray(m.publicRead.collections)) {
      problems.push('publicRead needs a collections array');
    } else {
      for (const c of m.publicRead.collections) {
        if (!collectionIds.has(c)) problems.push(`publicRead names unknown collection "${c}"`);
      }
      if (!caps.has('public:read')) problems.push('publicRead requires the "public:read" capability');
    }
  }

  for (const [legacyId, viewId] of Object.entries(m.legacyModeIds ?? {})) {
    if (!viewIds.has(viewId)) problems.push(`legacyModeIds "${legacyId}" points at unknown view "${viewId}"`);
  }

  return problems.length ? { ok: false, problems } : { ok: true, manifest: m as PluginManifest };
}

/** Was this capability granted? The one place a capability check is spelled out. */
export function grants(manifest: PluginManifest, capability: Capability): boolean {
  return (manifest.capabilities ?? []).includes(capability);
}

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

import { satisfiesApiVersion, type ApiVersion } from './apiVersion';

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
  'public:read',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type ManifestView = {
  id: string;
  label: string;
  /** Inline SVG for the header toggle. */
  icon: string;
  /** Does the shared grouping/filter toolbar apply? Default false. */
  toolbar?: boolean;
};

/** A set of rows the plugin owns, stored generically by the host (#12). */
export type CollectionDecl = {
  id: string;
  /**
   * JSON Schema for one row. Kept opaque here (the validator only checks that it
   * is an object) so this module stays dependency-free; the host compiles it on
   * the write path.
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
  /** What happens to `from` rows when the target disappears. Default 'cascade'. */
  onDelete?: 'cascade' | 'restrict';
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

// Reverse-DNS or npm-style. Ids are global — they key `timeline_plugins` rows and
// the plugin's own data — so a collision is a data collision, not a naming
// annoyance. Restricting the shape is what keeps two plugins from claiming one id
// by accident.
const ID_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
    problems.push('id must be npm-style or scoped, lowercase (e.g. "sprints" or "@acme/sprints")');
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
    if (r.onDelete != null && r.onDelete !== 'cascade' && r.onDelete !== 'restrict') {
      problems.push(`reference ${r.from}.${r.field}: onDelete must be "cascade" or "restrict"`);
    }
  }

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

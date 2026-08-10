// The plugin contract, as one import.
//
// This barrel is what a plugin author depends on: the manifest shape, the host
// API, the version helpers, and the design system a plugin's views are built
// from. It deliberately pulls in **no feature code from the app** — the manifest
// and version halves are types plus three pure functions, and the design system
// is a self-contained layer with no knowledge of timelines — so depending on the
// contract never means vendoring the viewer.
//
// The design system is part of the contract rather than something a plugin
// reaches for on its own, and that is the point: a plugin view is a first-class
// surface of the product, so a button in one has to be the button. Re-exporting
// it here is what makes „use the components" reachable without an import path
// into the app's internals — see docs/design-system.md.
//
// Packaging it as `@zeitlines/plugin-api` belongs with distribution
// (<https://github.com/dermellor/zeitlines/issues/15>); until a plugin is built
// outside this repository (<https://github.com/dermellor/zeitlines/issues/16>) the
// path is the package.

export {
  CAPABILITIES,
  grants,
  validateManifest,
  type Capability,
  type CollectionDecl,
  type ManifestProblem,
  type ManifestView,
  type PluginManifest,
  type PublicReadDecl,
  type ReferenceDecl,
  type ValidationResult,
} from './manifest';

export {
  HOST_API_VERSION,
  apiVersionMismatch,
  parseApiRange,
  satisfiesApiVersion,
  type ApiVersion,
} from './apiVersion';

export {
  createHostApi,
  type DataApi,
  type HostApi,
  type HostApiBackend,
  type ItemsApi,
  type PluginRow,
  type TimelineSnapshot,
} from './hostApi';

export { pluginViewMode, parsePluginViewMode, type PluginViewMode, type ViewMode } from './viewMode';

/**
 * What an artifact exports. A plugin implements this; the host calls it.
 *
 * `fields(file)` is optional and synchronous, because it runs on the item form's
 * path where an await would show an empty form first. `renderView` receives the
 * gated `HostApi` as its third argument rather than importing anything, which is
 * what lets an artifact be a file fetched from a URL with nothing to resolve at
 * load time.
 */
export type { PluginModule } from './registry';

// The design system: components, the element builder they are written against,
// and the tokens. A plugin stylesheet that spends a raw colour or a raw spacing
// value is what scripts/ci/check-design-system.sh rejects.
//
// **This serves IN-TREE plugins, and only them.** A plugin compiled into the app
// is bundled with it and resolves this import like any other. A plugin loaded at
// runtime cannot: it is fetched as bytes and executed from a blob URL, with no
// bundler and no import map, so a bare specifier fails outright —
// „Failed to resolve module specifier". Handing components over `HostApi` would
// not help either, because a factory returning an `HTMLElement` is exactly the
// live object that contract excludes, on purpose, so the API can move behind a
// sandbox later (see ./hostApi.ts).
//
// What a runtime-loaded plugin uses instead is the CSS half: the tokens and the
// `ds-*` class names, which are already on the page and need nothing resolved.
// That makes those class names part of the versioned contract rather than an
// internal convention — see „Making it look like the app"
// (docs/plugin-authoring.md) and
// <https://github.com/zeitlines/zeitlines/issues/60>.
export * from '../design-system';

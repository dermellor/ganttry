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
// (<https://github.com/zeitlines/zeitlines/issues/15>); until a plugin is built
// outside this repository (<https://github.com/zeitlines/zeitlines/issues/16>) the
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

// The design system: components, the element builder they are written against,
// and the tokens. A plugin styles its views with these and with the custom
// properties they read; a plugin stylesheet that spends a raw colour or a raw
// spacing value is what scripts/ci/check-design-system.sh rejects.
export * from '../design-system';

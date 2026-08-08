// The plugin contract, as one import.
//
// This barrel is what a plugin author depends on: the manifest shape, the host
// API, and the version helpers. It deliberately pulls in **no runtime code from
// the app** — everything here is types plus three pure functions — so depending on
// the contract never means vendoring the viewer.
//
// Packaging it as `@ganttry/plugin-api` belongs with distribution
// (<https://github.com/dermellor/ganttry/issues/15>); until a plugin is built
// outside this repository (<https://github.com/dermellor/ganttry/issues/16>) the
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

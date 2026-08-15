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
//
// **What is in here is decided by what a plugin actually needed.** Every entry
// below the host API arrived because `product-roadmap` was reaching past this
// barrel into the app to get it (#117), which is the only evidence that carries:
// a contract assembled from guesses is a contract with the wrong things in it.

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

/** The detail drawer a plugin's own forms open in. */
export type { PanelApi, PanelForm } from './panel';

/**
 * What a host write throws when the row changed underneath it. A plugin that sends
 * a lock counter has to be able to catch this.
 */
export { ConflictError } from './errors';

/**
 * Reading a plugin's own registration off a timeline snapshot.
 *
 * A plugin needs both to answer „am I enabled here" in its `matches` predicate and
 * to read its config outside a view, where no `HostApi` has been handed over yet.
 * Free of plugin ids by construction — see `./plugins.ts`.
 */
export { hasPlugin, pluginConfig } from './plugins';

/**
 * The host-owned overlay layer. A plugin asks for a layer instead of attaching one
 * to `document.body`, and anchors it with a **rectangle** rather than an element —
 * plain data, so the call survives the boundary a sandbox would put here
 * (docs/plugin-isolation.md).
 */
export { overlays, type Overlay, type OverlayRect } from './overlay';

/**
 * The built-in item status: its vocabulary and the normalisation around it.
 *
 * Part of the contract because status is core domain, not a plugin's invention —
 * „Open / Doing / Done" means the same thing in every plugin, and one that
 * reimplemented the defaulting would disagree with the item form about what an
 * absent value means.
 */
export { ITEM_STATUSES, DEFAULT_STATUS, normalizeStatus, statusOrDefault, type StatusKey } from '../status';

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

/**
 * What an in-tree plugin hands the registry: the manifest, its availability
 * predicates, its contributed fields, its tool handlers and the dynamic import of
 * its view module.
 *
 * Only in-tree plugins build one — for an installed artifact the loader assembles it
 * (`descriptorFor`). It is part of the contract because a plugin's own
 * `descriptor.ts` is the one file that has to name the type, and reaching into the
 * registry for it was the last import #117 left standing.
 */
export type { PluginDescriptor } from './registry';

/**
 * The per-item half of a derived field: what `descriptor.derive(file)` returns.
 *
 * Exported for the same reason `PluginDescriptor` is — a plugin's own `fields.ts`
 * is where the rule lives, and it should be able to name the type of the function
 * it hands back without reaching into the registry.
 */
export type { DeriveFn, DerivedValues } from './registry';

/**
 * Calendar-day and duration arithmetic, from the core's own module.
 *
 * Exported because the alternative is every date-shaped plugin restating it, and the
 * first one that did got it wrong in a way only its own example revealed: an item
 * carrying `duration` instead of `end` burned on the day it *started*, so a burndown
 * described when work began. `durationToMs` plus `endFromDuration` is the pair that
 * resolves an item's real extent, and they are the same functions the viewer places
 * bars with — which is the point, since a plugin that computes a different end than
 * the one drawn on screen is wrong wherever the two are compared.
 */
export { durationToMs, endFromDuration, isoDateOnly, parseLocalDay, shiftDays } from '../date';

/**
 * What a plugin's tools receive and return, and the checks the host puts around
 * them. `validateToolPlan` is exported so a plugin's own tests can assert that a
 * rule produces a plan the host will accept, rather than finding out through a
 * refused call.
 */
export {
  validateToolArgs,
  validateToolPlan,
  type ItemChange,
  type ToolContext,
  type ToolHandler,
  type ToolPlan,
} from './tools';

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
/**
 * How a plugin ships text in more than one language, and the host's own
 * locale-aware formatters.
 *
 * A plugin cannot import the core catalogue — its keys are not in `MessageKey`,
 * and reaching past this barrel is what `check-plugin-isolation.mjs` forbids — so
 * it brings its own and gets back a lookup bound to the language the host is
 * rendering in. `formatDay`, `formatNumber` and `compare` come from here for the
 * same reason the components do: one set of conventions across a screen that
 * mixes core and plugin text.
 *
 * What must never go through `t`: a stored value. Only `label` moves; a select
 * option's `value` is an id in item metadata (src/i18n/storedValues.test.ts).
 *
 * DOM-free, like the rest of this file: a plugin's catalogue is read by the
 * server too, when it asks for the plugin's fields. The components moved to
 * ./viewApi.ts for exactly that reason.
 */
export { pluginMessages, type PluginCatalogues, type PluginT } from './messages';
export { compare, formatDay, formatDateTime, formatNumber, locale, type Locale } from '../i18n';

/**
 * Where this plugin's view lives, for a plugin that ships **inside** this
 * repository. Called from its own `view.ts`; see ./viewLoaders.ts for why it is
 * not a field on the descriptor, and what broke when it was.
 *
 * A runtime-installed plugin does not use it: its artifact carries the view and
 * the host loads it from a blob URL.
 */
export { attachView } from './viewLoaders';

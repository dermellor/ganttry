# Architecture

The extension seams: where data comes from, and what a timeline renders.

Part of the Ganttry documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Architecture

Two-step:

1. **Build script** (`scripts/build-data.ts`) walks the notes directory, parses YAML frontmatter (`gray-matter`), extracts dates, writes `public/data/notes.json` + a copy of the config.
2. **Static viewer** (Vite + TypeScript, `src/`) loads the JSON, applies the active view's filter, renders a vis-timeline, styled through the CSS custom properties in `src/styles/theme.css`.

Electron wrapper can later embed the same `dist/` build.

### Source kinds (adapters)

A source-backed view carries an explicit **kind** on `view.source`
(`{ kind, id }`, `SourceKind` in [`src/types.ts`](../src/types.ts)) that drives how
its data is loaded. This is deliberately **not** a "try the API, then fall back
to a static file" guess — that conflated a live DB timeline with a stale
snapshot (see „Principle: no emergency or fallback data"). The kind is set at build
time and flows through the built config to the client:

- **`db`** — live from the DB via `GET /api/source/<id>`, editable, **no** static
  fallback (a DB failure surfaces loudly). `build-data.ts` discovers these by
  querying the DB at build time (`collectDbSources`) and marks each view's source
  `kind: "db"`; the registration stub it writes (metadata only) goes to the
  gitignored build output, never to the committed tree.
- **`local`** — a file the user owns, in one of two shapes: a **JSON file** (any
  `data/**/*.json` without the `db` marker), or a **directory** holding a
  `timeline.json` plus one Markdown file per item. Both produce the same
  `TimelineFile` ([`scripts/local/scan.ts`](../scripts/local/scan.ts) does the
  directory half), so nothing downstream knows which it is. A directory is
  read-only for now; a write answers `501`. Whether it is editable is a property of the **runtime**, not of the
  format: a process with filesystem access serves it through
  `GET /api/source/<id>` and accepts writes, a static deploy has nothing to write
  with and serves the built copy from `/data/sources/<id>.json` read-only. The
  answer is stamped into `view.source.editable` **at build time**, so the client
  routes deterministically instead of probing — probing is what conflated a live
  source with a stale copy in the first place. See
  [`docs/local-sources.md`](local-sources.md).

The local source is served by a **third `TimelineRepo` implementation**
([`scripts/local/file-repo.ts`](../scripts/local/file-repo.ts)) rather than by a
dispatcher of its own, which is why every sub-resource, every status code and
both shared validations (item extent, phase overlap) apply to it unchanged. It
is injected into `DbConnections.local` by the Node glue instead of imported by
`api.ts`, so the Deno edge bundle stays free of `node:fs` — and the edge
functions leaving it unset is precisely what makes a static deploy read-only.
Its version is the file's mtime in milliseconds, forced strictly forward on each
write so two edits inside one millisecond cannot share a version. The pricing
sub-resources answer `501` (`NotSupportedError`) rather than pretending to
succeed.

`loadSource(source)` ([`src/editor.ts`](../src/editor.ts)) routes on `kind`;
`render.ts` renders a view whenever it has a `source` (notes-backed views have
none). Adding a further API-served kind later (e.g. `gsheet`, external `pg`) is a
new `SourceKind` value plus its loader — the routing seam already exists.

**Server-side adapter seam:** the runtime glue (Vite middleware +
`timelines-api` edge function) no longer calls the DB dispatcher directly. It
resolves a `SourceAdapter` via `resolveAdapter(conns, id, live)`
([`scripts/db/api.ts`](../scripts/db/api.ts)) and dispatches through
`adapter.handle(req)`. The DB-backed source has **two interchangeable drivers**
behind that one adapter, selected by env (see „Postgres as the data source →
Drivers"): supabase-js (the Netlify default) and native postgres.js (opt-in).
Both satisfy the same `TimelineRepo` seam ([`scripts/db/repo.ts`](../scripts/db/repo.ts));
`handleTimelineApi(repo, req)` dispatches through the bound repo and never sees
the driver. The adapter's `capabilities` declare `editable` and a `live` mode
(`realtime` by default). Future API-served kinds register in `resolveAdapter`
without touching the middleware/edge glue. File sources are static and never
reach this seam.

### Plugins (`src/pluginHost/`, `src/plugins/<id>/`)

A **plugin** is the *orthogonal* axis to source kinds: it decides what a timeline
carries beyond items and groups (extra item fields, and optionally extra views),
not where its data comes from. The generic timeline+list core knows nothing
plugin-specific; a plugin plugs into a registration seam
([`src/pluginHost/registry.ts`](../src/pluginHost/registry.ts)).

The split in the file tree says which half is which. `src/pluginHost/` is core and
permanent: the registry, the view-mode encoding, the DOM a plugin view gets.
`src/plugins/<id>/` holds the plugins themselves, in-tree only for as long as they
have to be — when one moves out to its own repository, nothing in `pluginHost/`
notices. Today one plugin lives there, `product-roadmap` (the pricing matrix and
cards, its editors, its fields and its stylesheet). A timeline with no plugin is
just timeline + list.

A `PluginDescriptor` exposes a cheap synchronous `matches(file)` predicate, a
`label` (its display name), the `views` it declares, the item `fields(file)` it
contributes, and a **`load()` that is a dynamic `import()`**. The core
(`main.ts`, `render.ts`) only ever touches the descriptor's data, so it has **no
static import of any plugin *view* module**: Rollup code-splits each plugin into
its own chunk, and a generic build downloads none of it. The plugin imports its own
CSS inside that chunk, so a deploy without the plugin ships neither its code nor its
stylesheet. Both halves are asserted by
[`scripts/ci/check-bundle-split.sh`](../scripts/ci/check-bundle-split.sh).

**The manifest is what the host reads before running anything.**
[`src/pluginHost/manifest.ts`](../src/pluginHost/manifest.ts) defines it: id, name,
version, the contract range it was built against, its capabilities, its views, the
config schema, and (for the generic store) the collections, references and item
metadata keys it owns. Static data on purpose — listing, verifying and
version-checking a plugin has to work **without executing it**, which is what makes
installing one possible at all.

`register()` refuses a manifest that does not validate, loudly. Strictness is the
point: a declaration the host silently ignored leaves the plugin running as if it
had access it was never granted, and the symptom then surfaces far from the cause.
The validator also insists that declarations are covered by capabilities (views
need `views`, collections need `data:own`, `publicRead` needs `public:read`), which
is what keeps the capability list meaningful rather than decorative — it is the
list shown to whoever installs the plugin.

**The contract is versioned** ([`src/pluginHost/apiVersion.ts`](../src/pluginHost/apiVersion.ts)).
The host declares `HOST_API_VERSION`, a plugin declares a range (`^1`, `^1.2`), and
an incompatible plugin is refused with a sentence saying which side is behind.
A plugin is an artifact that is not rebuilt when the host changes, so without this
the first removed field fails somewhere in the middle of a render.

**The host API is async and serializable throughout**
([`src/pluginHost/hostApi.ts`](../src/pluginHost/hostApi.ts)), even though plugins
currently run in the app's own realm where a direct call would be cheaper. The
isolation decision is still open (<https://github.com/dermellor/ganttry/issues/14>),
and an API shaped around shared objects cannot be moved behind an iframe or a
worker afterwards without rewriting every plugin. `createHostApi` gates by
capability structurally: without `items:write` there is no item-write method to
call, rather than a check that refuses at call time.

The contract is re-exported as one import from
[`src/pluginHost/api.ts`](../src/pluginHost/api.ts), which pulls in no runtime code
from the app. Publishing it as a package belongs with distribution
(<https://github.com/dermellor/ganttry/issues/15>).

**A plugin declares its views; the host builds the chrome.** `PluginView` carries
an id, a label and the icon markup for the header toggle. The host creates one
button and one `.plugin-view` section per declared view
([`src/pluginHost/views.ts`](../src/pluginHost/views.ts)) and hands the section to
`renderView(container, viewId)`. Nothing plugin-shaped is in `index.html`, which is
what makes a second view possible without touching the core.

**A view is addressable.** `ViewMode` is `timeline`, `list`, or
`plugin:<pluginId>:<viewId>`, and that one scalar is what `state.viewMode`, the
`?mode=` hash parameter and the persisted `timelines.viewMode` key all carry
([`src/pluginHost/viewMode.ts`](../src/pluginHost/viewMode.ts)). Modes from before
plugin views were addressable (`mode=pricing`) resolve through the descriptor's
`legacyModeIds`, so old deep links and every user's stored preference keep working;
dropping that mapping would silently reset both.

**`matches` and `applies` are deliberately different questions.** `matches` decides
whether a view is *offered* and may demand a populated model; `applies` decides
whether the user *stays* in a view and only asks whether the plugin is enabled. A
DB-backed source assembles its plugin model a tick after the first paint, so
deciding both with `matches` kicked a restored view back to the timeline on every
load.

**Plugins contribute item fields** through `fields(file)` — synchronous,
data-derived `CustomFieldDef[]`, gated internally on the plugin being enabled and
therefore independent of `matches`. `pluginFieldDefs(file)` collects every enabled
plugin's fields and stamps each with the plugin's `label` as its `group`, which is
what sections them under a plugin heading in the item form (see „Custom fields →
Plugin-contributed fields"). The product-roadmap implementation lives in
[`src/plugins/product-roadmap/fields.ts`](../src/plugins/product-roadmap/fields.ts):
it imports only types plus the plugin helper, so it is statically importable from
the registry **without** adding an edge into the plugin's chunk. `customFields.ts`
reads plugin fields through that one seam and knows no plugin ids.

Adding a plugin is a `register()` call plus a `src/plugins/<id>/` folder, and no
core-file change. The step-by-step is
[`docs/plugin-playbook.md`](plugin-playbook.md); the endgame, where a plugin is
installed at runtime instead of registered at build time, is
<https://github.com/dermellor/ganttry/issues/9>.

**Enablement is pure data (the plugin registry table).** Which plugins a timeline
carries is **not** a column on a core table. It lives in the generic
`timeline_plugins` table (one row per `(timeline_id, plugin_id)` + a `config` jsonb
bag; see „Schema" (docs/database.md) → `timeline_plugins`), surfaced to the client as
`TimelineFile.plugins` (`PluginRef[]`). So enabling a plugin on a timeline is an
INSERT, never an `ALTER TABLE`. How enablement is read off a file lives in
[`src/pluginHost/plugins.ts`](../src/pluginHost/plugins.ts) (`hasPlugin`,
`pluginConfig`), which knows no plugin ids; a plugin's own ids, metadata keys and
write rules live with the plugin (for product-roadmap:
[`src/plugins/product-roadmap/plugin.ts`](../src/plugins/product-roadmap/plugin.ts),
imported by the client gates and by both DB drivers). A populated `file.pricing`
auto-enables `product-roadmap` on write (`resolveWritePlugins`), and its ordered
version list lives in that plugin's `config.versions`. Adding a further plugin needs
(at most) its own data — never a new core column or discriminator value.

**Accepted first-cut deviations (documented, not blockers):**
- The pricing `api*` wrappers stay in [`src/editor.ts`](../src/editor.ts) —
  `apiAddFeature`/`apiUpdateFeature`/`apiDeleteFeature`/`apiMoveFeature`,
  `apiAddTier`/`apiUpdateTier`/`apiDeleteTier`, `apiSetTierValue`: type-only-typed
  fetch wrappers, so the generic entry chunk carries their URL fragments
  (`/feature/`, `/tier/`, `/tier-value`) and nothing else. The acceptance check is
  about the pricing *view* code — `pm-cell-ver`, `pm-cell-editable`,
  `pricing-badge-new`, `pc-card` are all absent from the entry chunk.
- The **server side** of the plugin (the `pricing-api` edge function, the pricing
  MCP tools, the `pricing_*` tables + `assemblePricing` in `timeline-repo.ts`)
  stays in place, and so does `TimelineFile.pricing` in the core types: a plugin
  has no data channel of its own until the generic store lands
  (<https://github.com/dermellor/ganttry/issues/12>), so moving them now would mean
  either breaking the pricing path or inventing a placeholder indirection. Tracked
  as <https://github.com/dermellor/ganttry/issues/17>, which also removes the
  option of leaving it that way.

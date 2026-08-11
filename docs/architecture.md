# Architecture

The extension seams: where data comes from, and what a timeline renders.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Architecture

Two-step:

1. **Build script** (`scripts/build-data.ts`) discovers the sources — the local ones under `data/` (a JSON file, or a directory of Markdown scanned by `scripts/local/scan.ts`) and the timelines in the database — registers each as a view, and writes the merged config plus a materialized copy of every local source to `public/<data dir>/`.
2. **Static viewer** (Vite + TypeScript, `src/`) loads that config, loads the active view's source (live from the API where the runtime allows it, otherwise the materialized copy), and renders a vis-timeline, styled through the CSS custom properties in `src/design-system/tokens/tokens.css`.

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
  directory half), so nothing downstream knows which it is. Editing a directory
  writes back into the individual notes, one frontmatter key at a time
  ([`scripts/local/frontmatter.ts`](../scripts/local/frontmatter.ts)). Whether it is editable is a property of the **runtime**, not of the
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
write so two edits inside one millisecond cannot share a version. Plugin-owned rows
go into the same document ([`plugin-storage.md`](plugin-storage.md)) and are
written through the same generic routes, so a plugin's data is editable on a file
the user owns with no database involved. Sixteen `NotSupportedError` → `501`
answers used to sit here for one plugin's sub-resources; they went with the
methods behind them.

`loadSource(source)` ([`src/editor.ts`](../src/editor.ts)) routes on `kind`;
`render.ts` renders a view whenever it has a `source` (notes-backed views have
none). Adding a further API-served kind later (e.g. `gsheet`, external `pg`) is a
new `SourceKind` value plus its loader — the routing seam already exists.

**Three runtimes, one HTTP layer.** The API is served by the Vite dev
middleware, the Netlify edge functions, and the self-hosted Node server
([`scripts/serve.ts`](../scripts/serve.ts), `npm start`). What differs between
them is genuinely their own: which credentials they hold, who the caller is, and
whether there is a filesystem behind the request. Everything else — route
matching, body reading, `If-Match`, the `X-Source-Live` header, the error
mapping — is [`scripts/db/http.ts`](../scripts/db/http.ts), a
`Request` → `Response` handler all three call. It was two hand-kept copies
before the third runtime existed, and they had already drifted.

Being Fetch-shaped is what makes it testable without a server: the tests in
`scripts/db/http.test.ts` build a `Request` and assert on the `Response`, no
port and no database. The two Node runtimes reach it through one adapter,
[`scripts/node-http.ts`](../scripts/node-http.ts); the edge functions speak Fetch
natively.

**Server-side adapter seam:** that HTTP layer does not call the DB dispatcher
directly either. It
resolves a `SourceAdapter` via `resolveAdapter(conns, id, liveOverride)`
([`scripts/db/api.ts`](../scripts/db/api.ts)) and dispatches through
`adapter.handle(req)`. The DB-backed source has **two interchangeable drivers**
behind that one adapter, selected by env (see „Postgres as the data source →
Drivers"): supabase-js (the Netlify default) and native postgres.js (opt-in).
Both satisfy the same `TimelineRepo` seam ([`scripts/db/repo.ts`](../scripts/db/repo.ts));
`handleTimelineApi(repo, req)` dispatches through the bound repo and never sees
the driver. The adapter's `capabilities` declare `editable` and a `live` mode,
which `defaultLive` derives from the configured backend (a Supabase project gets
`realtime`, a bare Postgres `poll`); `TIMELINES_DB_LIVE` overrides it in either
direction. Future API-served kinds register in `resolveAdapter`
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
notices. Each folder is self-contained down to its documentation: its `README.md`
is the public page and its `AGENTS.md` the conventions for changing it, so
uninstalling a plugin leaves the core chapters shorter rather than wrong. A
timeline with no plugin is just timeline + list.

A `PluginDescriptor` exposes a cheap synchronous `matches(file)` predicate, a
`label` (its display name), the `views` it declares, the item `fields(file)` it
contributes, and a **`load()` that is a dynamic `import()`**. The core
(`main.ts`, `render.ts`) only ever touches the descriptor's data, so it has **no
static import of any plugin *view* module**: Rollup code-splits each plugin into
its own chunk, and a generic build downloads none of it. The plugin imports its own
CSS inside that chunk, so a deploy without the plugin ships neither its code nor its
stylesheet. Both halves are asserted by
[`scripts/ci/check-bundle-split.sh`](../scripts/ci/check-bundle-split.sh), which
takes its markers out of each plugin's own stylesheet rather than from a list in
the script — a hardcoded list is a plugin fact in a core file, and it goes stale
silently.

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

**Plugins run in the app's own realm, and installing one is trusting its author.**
The sandbox was considered and rejected: its cost is paid per view, and views are
the normal case here rather than the exception. What protects an instance instead
is an integrity pin on the artifact, a fail-closed CSP that closes the easy
exfiltration routes, capability grants recorded at install, and failure containment
so a throwing plugin costs the user that plugin. The decision, the rejected
alternatives and the condition that would bring them back are in
[`plugin-isolation.md`](plugin-isolation.md). Two things keep that door open at no
running cost: the host API below, and overlays coming from the host rather than a
plugin attaching one to `document.body`.

**The host API is async and serializable throughout**
([`src/pluginHost/hostApi.ts`](../src/pluginHost/hostApi.ts)), even though plugins
currently run in the app's own realm where a direct call would be cheaper. The
isolation decision is still open (<https://github.com/dermellor/zeitlines/issues/14>),
and an API shaped around shared objects cannot be moved behind an iframe or a
worker afterwards without rewriting every plugin. `createHostApi` gates by
capability structurally: without `items:write` there is no item-write method to
call, rather than a check that refuses at call time.

The contract is re-exported as one import from
[`src/pluginHost/api.ts`](../src/pluginHost/api.ts), which pulls in no runtime code
from the app. Publishing it as a package belongs with distribution
(<https://github.com/dermellor/zeitlines/issues/15>).

**Which plugins an instance HAS is a row, not a build.** `installed_plugins`
records the artifact, its pinned version, the capabilities an operator granted and
the manifest that was validated at install time — and that stored manifest is what
the write path enforces against, so the checks keep working when the artifact's
origin is unreachable. Enabling one on a timeline stays a separate, reversible
act. Installing is operator-only, because loading third-party code into everyone's
session cannot share a permission with „may change an item". The chapter is
[`plugin-lifecycle.md`](plugin-lifecycle.md).

**A plugin's own rows are stored generically, on every source kind.** A plugin
installed at runtime cannot ship a migration, so what Postgres would enforce for it
— the column shape, the foreign keys, the row order, a composite primary key — is
declared in the manifest and enforced above the repo, which is what lets one
implementation serve the `plugin_data` table, a JSON file and a Markdown directory
alike. The chapter is [`plugin-storage.md`](plugin-storage.md); the reason it sits
on the repo seam rather than in Postgres is that `data:own` must not become a
Postgres-only capability, which would undo the symmetry the source adapters just
achieved.

**A plugin declares its views; the host builds the chrome.** `PluginView` carries
an id, a label, the icon markup for the header toggle, and the **accessories** the
view wants. The host creates one button and one `.plugin-view` section per declared
view ([`src/pluginHost/views.ts`](../src/pluginHost/views.ts)) and hands the section
to `renderView(container, viewId)`. Nothing plugin-shaped is in `index.html`, which
is what makes a second view possible without touching the core.

**Accessories are declared per control, and the host asks every presentation the
same way.** `accessories: { grouping?, filter?, create?, export? }` says whether the
perspective control, the extent control, „+ Eintrag" and „Export HTML" apply; all
default to false, so a view that renders something other than the item list gets a
bar with nothing inert on it. `create` and `export` joined the list when those two
actions moved into the presentation's own bar (`HOST_API_VERSION` 1.2): standing in
a view's bar, „+ Eintrag" would create an item that view cannot show.
`viewAccessories(view)` ([`src/pluginHost/manifest.ts`](../src/pluginHost/manifest.ts))
answers for a declared view and, with no argument, for the built-in timeline and
list — which is why `main.ts` no longer asks „is this a plugin view?" and a second
plugin view needs no change there.

It replaces a single `toolbar` boolean that could only say „all of them" or „none",
and that boolean was the host deciding on the view's behalf. The two are different
questions (the perspective bundles the same set, the extent narrows it), so a view
can honour one and not the other. `toolbar` is **still read**, as `{ grouping: true, filter: true }` and nothing more
— it spoke about that one bar, so reading it as permission to create or export would
grant what it never claimed. A plugin declaring `^1` was built against it,
and the version contract exists so such an artifact keeps running. That is also why
adding accessories was a **minor** bump (`HOST_API_VERSION` 1.1) rather than a major
one — dropping that reading is what would make it major. An unknown accessory key
makes the manifest invalid rather than being silently ignored, for the reason every
declaration here is checked: one the host quietly dropped surfaces far from its
cause, as a control that is missing with no explanation.

**A view is addressable.** `ViewMode` is `timeline`, `list`, or
`plugin:<pluginId>:<viewId>`, and that one scalar is what `state.viewMode`, the
`?mode=` hash parameter and the mode persisted per timeline all carry
([`src/pluginHost/viewMode.ts`](../src/pluginHost/viewMode.ts)). Modes from before
plugin views were addressable — a bare view id, with no plugin in front of it —
resolve through the descriptor's `legacyModeIds`, so old deep links and every
user's stored preference keep working; dropping that mapping would silently reset
both. Which old ids a plugin still answers to is its own declaration.

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
Plugin-contributed fields"). A plugin's `fields.ts` may import only types plus the
plugin helper, so the registry can import it **statically without** adding an edge
into the plugin's view chunk — that constraint is the whole reason it is a
separate file from the views. `customFields.ts` reads plugin fields through that
one seam and knows no plugin ids.

Adding a plugin is a `register()` call plus a `src/plugins/<id>/` folder, and no
core-file change. The step-by-step is
[`docs/plugin-playbook.md`](plugin-playbook.md); the endgame, where a plugin is
installed at runtime instead of registered at build time, is
<https://github.com/dermellor/zeitlines/issues/9>.

**Enablement is pure data (the plugin registry table).** Which plugins a timeline
carries is **not** a column on a core table. It lives in the generic
`timeline_plugins` table (one row per `(timeline_id, plugin_id)` + a `config` jsonb
bag; see „Schema" (docs/database.md) → `timeline_plugins`), surfaced to the client as
`TimelineFile.plugins` (`PluginRef[]`). So enabling a plugin on a timeline is an
INSERT, never an `ALTER TABLE`. How enablement is read off a file lives in
[`src/pluginHost/plugins.ts`](../src/pluginHost/plugins.ts) (`hasPlugin`,
`pluginConfig`), which knows no plugin ids; a plugin's own id, its metadata keys
and its rules live in its folder, imported by the client registry and by nothing
else in the core. A plugin whose
rows are in a bulk write is enabled by that alone (`pluginsForWrite`), which is a
generic rule rather than one plugin's: storing rows nothing reads would leave the
timeline looking empty while the data sat there. Adding a further plugin needs
(at most) its own data — never a new core column or discriminator value.

**The deviations are gone, and a check keeps them gone.** The first cut of this
seam left the plugin's server side in place: an edge function at
`/api/pricing/<id>`, thirteen MCP tools, four `pricing_*` tables with fifteen
methods on `TimelineRepo`, the write wrappers in `src/editor.ts`, and a `pricing`
field on the core `TimelineFile`. Each was reasonable at the time — a plugin had
no data channel of its own until the generic store landed — and together they
were the thing this seam claims not to have: a privilege no third party can get.

Issue #17 removed all of it, and
[`scripts/ci/check-plugin-isolation.mjs`](../scripts/ci/check-plugin-isolation.mjs)
asserts it stays removed: no core file imports from a plugin folder (bar the two
registries and two dated migration modules), no plugin id appears as a literal
outside its folder, `TimelineRepo` carries only methods on a known-generic list,
and `index.html` links no plugin's markup. Each check was verified against a
deliberately introduced violation. The bundle-split check
([`check-bundle-split.sh`](../scripts/ci/check-bundle-split.sh)) covers the other
half of the promise: a generic build downloads no plugin view code.

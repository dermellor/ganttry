# Timelines

Generic timeline viewer. Reads frontmatter dates from a notes directory of Markdown files (configurable via `notesDir` / `TIMELINES_NOTES_DIR`), builds timelines via [vis-timeline](https://visjs.github.io/vis-timeline/), and ships a single neutral theme themeable through CSS custom properties.

## Branching, Commits & Session Isolation

"I thought the feature was live, but it never shipped" has two root causes that
pull in opposite directions — so guarding against only one reintroduces the other:

- **Branch rot:** work committed to a branch that was never merged.
- **Working-tree rot:** work never committed at all — concurrent sessions piling
  uncommitted changes into the *same* working directory until they entangle and
  none of it ships.

Feature branches *are* branch rot and don't fix working-tree rot, so
"branch vs main" is the wrong axis. The rules below attack both roots directly:
**session isolation**, a **hard done-gate**, and disciplined integration.

**Base invariant — local `main` mirrors `origin/main` at all times.** Every
divergence disaster starts here: the shared checkout accumulates commits that
never reach `origin` (or the same work lands on `origin` via a squash-merge under
a *different* SHA), so the two histories split while looking identical, and Git
then reports conflicts where there is no real content difference. Prevent it —
don't reconcile it after the fact:

- **Start clean.** Before any change-session — and before spawning a worktree —
  run `git fetch origin && git switch main && git merge --ff-only origin/main`.
  If the fast-forward is refused, local `main` has already drifted: stop and
  reconcile it *first* (rebase/merge the unique local commits onto `origin/main`,
  or discard them), never build on top of the drift.
- **Cut worktrees from `origin/main`, never from local `HEAD`.** A worktree
  branched off a stale checkout inherits the drift and yields a PR whose base is
  wrong — the noisy-diff / phantom-conflict trap.
- **Never leave commits sitting on local `main` unpushed.** Push is a separate,
  explicit step (never auto-coupled to the commit), but it must not be *deferred*:
  push before you end the session, before you cut a worktree, and before you step
  away. Unpushed local-`main` commits are the seed of every "same feature, two
  SHAs" conflict, especially once the same work also arrives through a PR.
- **Re-sync the serving checkout after every merge.** PM2 serves 3120 from the
  main checkout; merging a PR on GitHub does **not** update it. After a merge, in
  the main checkout run `git fetch origin && git merge --ff-only origin/main`
  (restart the PM2 service if it caches build output). Skip this and the live
  preview keeps showing stale code — the exact "I don't see my change" trap.

### 1. Isolate every change-session in its own git worktree

Any session that will modify code works in its **own git worktree**, never in the
shared main checkout. Two concurrent sessions then cannot entangle each other's
working tree. (Claude Code: use `isolation: "worktree"`.) The worktree is
disposable; what matters is that its changes reach `main` via the done-gate below
before the session ends.

**Clean up the worktree when you're done.** Once its changes have reached `main`,
remove it — `git worktree remove <path>`, and `git worktree prune` for any that
were deleted by hand. Never leave abandoned worktrees behind: they accumulate in
`git worktree list`, hold stale copies that mislead the next session, and
detached-HEAD leftovers are pure clutter. Claude Code's `isolation: "worktree"`
auto-removes a worktree that ends unchanged, but any worktree you committed work
in must be cleaned up explicitly.

**Live-preview caveat:** the Vite dev server (PM2) runs from the main checkout and
does **not** see edits made in a worktree. When a task needs live visual
verification, start the worktree server on a five-digit preview port from the
**31200–31209** pool (`npm run dev:worktree`, default 31200) so PM2 keeps serving
3120 — **never stop PM2** to free 3120 (that tears down `timelines.localhost` for
every other session). Details: „Ports → Worktree-Live-Preview". Alternatively
merge to `main` and verify there.
Never assume the running app reflects worktree edits — that mismatch is a known
trap.

### 2. Done = committed + pushed + deploy-verified

A change is not "done" until it is committed, pushed to `main`, and the resulting
Netlify deploy is confirmed green. **Never end a session with uncommitted or
unpushed changes that belong to the task.** Committing and pushing are separate
steps: commit as you go, but **push is always an explicit step** — never auto-push
on commit, never bundle "commit + push" into one action (global rule: never
`git push` without asking). At session end, `git status` must be
clean except for deliberately-ignored artifacts. If work is genuinely unfinished,
say so explicitly and leave it committed on a clearly-named branch — not loose in a
working tree.

### 3. Choose the integration path at the first change of a session

- **Direct to `main`** — for small, low-risk changes. No branch, no issue ceremony.
  Commit on `main`; the push follows as a separate explicit step.
- **Worktree + branch + GitHub issue + PR** — for larger or riskier features where
  a review/merge checkpoint and traceability are worth it. An opened PR must be
  merged or closed within the session — never left to rot.

Either way, the done-gate (rule 2) applies. If a change is too risky for `main`,
gate it with a feature flag, not a long-lived branch. Issues live in this repo's
own tracker (<https://github.com/dermellor/timelines/issues>); reference them from
the closing commit with `Closes #NN`.

### 4. Guard against foreign in-flight work

At the start of a change-session, check `git status`. If it already contains
uncommitted changes you did not create, another session owns them — do not build on
top of or commit them blindly. Surface them and either work in a fresh worktree off
`origin/main` (per the base invariant — never off a possibly-stale local `HEAD`)
or coordinate before touching shared files.

## Ports

Belegt im 3120er-Block (siehe [`~/Development/PORTS.md`](../PORTS.md)).

| Port          | Service                                            |
| ------------- | -------------------------------------------------- |
| 3120          | Vite dev server (Timeline UI) — PM2, Main-Checkout |
| 31200–31209   | Vite dev server für Worktree-Live-Previews (Pool)  |

URLs:

- `https://timelines.localhost` — primärer Zugang über Caddy (HTTPS, von PM2 verwaltet)
- `http://localhost:3120` — direkt auf Vite (Main-Checkout, von PM2)
- `http://localhost:31200` … `31209` — Worktree-Previews (siehe unten)

Crasht bei Port-Konflikt (`strictPort: true`), kein Auto-Fallback.

### Worktree-Live-Preview (Pool 31200–31209) — PM2 nie stoppen

Der PM2-Dev-Server auf 3120 läuft aus dem **Main-Checkout** und sieht
Worktree-Edits nicht (siehe „Live-preview caveat" oben). Um Änderungen aus einem
Worktree live zu sehen, **niemals PM2 stoppen** (das reißt `timelines.localhost`
für alle anderen Sessions weg). Stattdessen den Worktree-Server auf einem eigenen
fünfstelligen Preview-Port starten — PM2 bleibt parallel auf 3120:

```bash
npm run dev:worktree              # Default-Port 31200
WT_PORT=31201 npm run dev:worktree  # zweite Worktree parallel, usw.
```

Die Preview-Ports leben bewusst **außerhalb** des engen 3120er-Blocks in einem
fünfstelligen Pool **31200–31209** (abgeleitet: `3120` → `31200` + Index), damit
beliebig viele Worktrees gleichzeitig laufen können, ohne sich oder andere
Services zu blockieren. Default ist 31200; für weitere parallele Previews den
`WT_PORT` hochzählen. Das Script lässt `dev-prep.sh` bewusst aus (killt also nicht
den 3120-Prozess). In Claude Code entsprechen die Launch-Configs `vite-worktree`
(31200), `vite-worktree-2` (31201), `vite-worktree-3` (31202) in
`.claude/launch.json`. Regel: **Worktree-Previews immer auf 31200+, PM2 auf 3120
laufen lassen — nie umgekehrt.**

## Architecture

Two-step:

1. **Build script** (`scripts/build-data.ts`) walks the notes directory, parses YAML frontmatter (`gray-matter`), extracts dates, writes `public/data/notes.json` + a copy of the config.
2. **Static viewer** (Vite + TypeScript, `src/`) loads the JSON, applies the active view's filter, renders a vis-timeline, styled through the CSS custom properties in `src/styles/theme.css`.

Electron wrapper can later embed the same `dist/` build.

### Source kinds (adapters)

A source-backed view carries an explicit **kind** on `view.source`
(`{ kind, id }`, `SourceKind` in [`src/types.ts`](src/types.ts)) that drives how
its data is loaded. This is deliberately **not** a "try the API, then fall back
to a static file" guess — that conflated a live DB timeline with a stale
snapshot (see „Prinzip: keine Notfall-/Fallback-Daten"). The kind is set at build
time and flows through the built config to the client:

- **`db`** — live from the DB via `GET /api/source/<id>`, editable, **no** static
  fallback (a DB failure surfaces loudly). `build-data.ts` discovers these by
  querying the DB at build time (`collectDbSources`) and marks each view's source
  `kind: "db"`; the registration stub it writes (metadata only) goes to the
  gitignored build output, never to the committed tree.
- **`file`** — read-only from the static `/data/sources/<id>.json` (`editable:
  false`). The file genuinely *is* the source here (not a snapshot of something
  live), so loading it is correct. Any `data/**/*.json` without the `db` marker
  is a file source.

`loadSource(source)` ([`src/editor.ts`](src/editor.ts)) routes on `kind`;
`render.ts` renders a view whenever it has a `source` (notes-backed views have
none). Adding a further API-served kind later (e.g. `gsheet`, external `pg`) is a
new `SourceKind` value plus its loader — the routing seam already exists.

**Server-side adapter seam:** the runtime glue (Vite middleware +
`timelines-api` edge function) no longer calls the DB dispatcher directly. It
resolves a `SourceAdapter` via `resolveAdapter(conns, id, live)`
([`scripts/db/api.ts`](scripts/db/api.ts)) and dispatches through
`adapter.handle(req)`. The DB-backed source has **two interchangeable drivers**
behind that one adapter, selected by env (see „Supabase als Datenquelle →
Treiber"): supabase-js (the Netlify default) and native postgres.js (opt-in).
Both satisfy the same `TimelineRepo` seam ([`scripts/db/repo.ts`](scripts/db/repo.ts));
`handleTimelineApi(repo, req)` dispatches through the bound repo and never sees
the driver. The adapter's `capabilities` declare `editable` and a `live` mode
(`realtime` by default). Future API-served kinds register in `resolveAdapter`
without touching the middleware/edge glue. File sources are static and never
reach this seam.

### Timeline kinds (`src/kinds/`)

A **timeline kind** is the *orthogonal* axis to source kinds: it's the timeline's
*flavour* (what extra views/renderers and extra item fields it carries), not where
its data comes from. The generic timeline+list core knows nothing kind-specific; a
kind plugs into a registration seam ([`src/kinds/registry.ts`](src/kinds/registry.ts)):

- **`generic`** — the default: just timeline + list, no extra code.
- **`product-roadmap`** — the pricing matrix/cards + feature form, living entirely
  under [`src/kinds/product-roadmap/`](src/kinds/product-roadmap/) (`pricing.ts`,
  `pricingCards.ts`, `pricingMatrix.ts`, `pricingWork.ts`, `featureForm.ts`,
  `fields.ts`, `index.ts`).

A `KindDescriptor` exposes a cheap synchronous `matches(file)` predicate, a
`label` (its display name), the extra `viewModes` it adds and the extra item
`fields(file)` it contributes, plus a **`load()` that is a dynamic `import()`**.
The core (`main.ts`, `render.ts`) only ever touches the descriptor's data
(`activeKind`, `ensureKindLoaded`, `loadedKindView`) — it has **no static import
of any pricing *view* module**, so Rollup code-splits the kind into its own chunk
and a **generic build downloads no pricing code** (the acceptance check: the entry
chunk referenced by `dist/index.html` contains no `pm-cell-ver`/pricing strings;
they live only in the lazily-loaded chunk). The chunk loads only when a product
timeline enters the pricing view.

**Kinds contribute item fields** through `fields(file)` — synchronous,
data-derived `CustomFieldDef[]`, gated internally on the plugin being enabled and
therefore independent of `matches` (which additionally demands a populated pricing
model before offering the *view*). `pluginFieldDefs(file)` collects every enabled
kind's fields and stamps each with the kind's `label` as its `group`, which is
what sections them under a plugin heading in the item form (see „Custom fields →
Plugin-contributed fields"). The product-roadmap implementation lives in
[`src/kinds/product-roadmap/fields.ts`](src/kinds/product-roadmap/fields.ts): it
imports only `types` + `plugins`, so it is statically importable from the registry
**without** adding an edge into the pricing chunk — the acceptance check above
still passes. `customFields.ts` reads plugin fields through that one seam and
knows no plugin ids.

Adding a third kind is a new `KINDS[]` entry + a `src/kinds/<name>/` folder — no
core-file change.

**Enablement is pure data (the plugin registry).** Which kind a timeline carries
is **not** a column on a core table. It lives in the generic `timeline_plugins`
table (one row per `(timeline_id, plugin_id)` + a `config` jsonb bag; see „Schema"
→ `timeline_plugins`), surfaced to the client as `TimelineFile.plugins`
(`PluginRef[]`). So enabling a plugin on a timeline is an INSERT, never an
`ALTER TABLE`. The single place that knows plugin ids and reads/writes this off a
file is [`src/plugins.ts`](src/plugins.ts) (`PRODUCT_ROADMAP_PLUGIN`, `hasPlugin`,
`pluginConfig`, `versionsFromConfig`, `resolveWritePlugins`); client gates
(`kinds/registry.ts` `matches`, `customFields.ts`) and both DB drivers import from
there instead of testing a `type === 'product'` literal. A populated `file.pricing`
auto-enables `product-roadmap` on write (`resolveWritePlugins`), and its ordered
version list lives in that plugin's `config.versions` (was the dropped
`timelines.pricing_versions` column). Adding a further plugin needs (at most) its
own data/tables — never a new core column or discriminator value.

**Accepted first-cut deviations (documented, not blockers):**
- `apiUpdateFeature`/`apiDeleteFeature` stay in [`src/editor.ts`](src/editor.ts):
  type-only-typed fetch wrappers (zero bundle weight).
- The **server side** of the kind (the `pricing-api` edge function, the pricing MCP
  tools, the `pricing_*` tables + `assemblePricing` in `timeline-repo.ts`) stays in
  place — DoD is about the *client* generic bundle, and the Deno edge import graph
  (with its explicit `.ts` extensions) must not be disturbed. Co-locating the
  server pieces under the kind is a possible follow-up.

## Data extraction

- **Date sources** (default order, configurable per view): `date` → `scheduled` → `created` → filename pattern.
- **Filename patterns**: `2026-01-09…`, `20210917…` (regex list in `timelines.config.json`).
- **Range items**: `duration` field (`7d`, `2w`, `90m`, ISO `P7D`) on top of start, OR explicit `end` / `until` field.
- **Skipped**: notes without any resolvable date are omitted.

## Standalone JSON timelines

Drop a `*.json` file into the project's `data/` folder. The build script copies it to `public/data/sources/<basename>.json` and adds it as an automatic view (`id: "src:<basename>"`). No config edit needed.

File shape:

```jsonc
{
  "name": "Projektplan 2026",            // optional, falls back to filename
  "description": "...",                  // optional
  "items": [
    {
      "id": "kickoff",                   // optional
      "start": "2026-01-15",             // optional; a date-less item shows only in the list view (see below)
      "end": "2026-02-28",               // optional; mutually exclusive with duration (end wins)
      "duration": "3w",                  // optional ("7d", "2w", "90m", number = ms) — only when no end
      "content": "Kickoff",
      "group": "Phase 1",                // optional
      "title": "Tooltip text",           // optional
      "type": "point",                   // optional: point | range | background | box
      "icon": "milestone",               // optional: semantic icon key (see "Item icons")
      "status": "Open",                  // optional: Open | Doing | Done (see "Item status"); defaults to Open
      "body": "Markdown shown in detail panel",  // optional
      "metadata": { "owner": "Product Lead", "tags": ["Qualität & Daten"] }  // optional
    }
  ],
  "groups": [
    { "id": "Phase 1", "content": "Phase 1: Discovery" },
    {
      "id": "comm",
      "content": "Kommunikation",
      "nestedGroups": ["comm-product", "comm-tech"],  // optional: children rendered indented under parent, collapse-/expandierbar
      "showNested": true                              // optional, default true
    }
  ],                                     // optional, derived from items if missing
  "phases": [                            // optional: labeled ribbon across the top
    {
      "id": "ph-pre",                    // optional, but needed to edit reliably
      "label": "Pre-Launch",
      "start": "2026-06-28",
      "end": "2026-09-15",               // optional, OR
      "duration": "6w",                  // optional (same format as items)
      "color": "#64748B",                // optional
      "icon": "launch"                   // optional: semantic icon key (see "Item icons")
    }
  ]
}
```

A phase needs a `label`, a `start`, and an extent (`end` or `duration`) to
render; phases missing any of these are skipped. They show as a labeled ribbon
pinned to the top plus a faint full-height tint behind the items. The ribbon
segment is positioned through vis-timeline's own time→pixel conversion
(`body.util.toScreen` over the content width, with day strings parsed as *local*
midnight — see [`src/phaseBand.ts`](src/phaseBand.ts) / [`src/date.ts`](src/date.ts)),
so the bar stays pixel-aligned with its tint regardless of zoom or a reserved
scrollbar. Adjacent bars keep a small fixed gap (the tints stay flush).

**Phases must not overlap in time** — touching boundaries (one phase's `end` ==
the next's `start`) and gaps are both fine, but real overlaps are forbidden. The
rule lives once in [`src/phaseOverlap.ts`](src/phaseOverlap.ts) and is enforced on
both sides: the server write path (`updatePhases` / `replaceTimeline`) rejects an
overlapping write with `400` from any source (UI, MCP, direct API), and the
client prevents it proactively (ribbon drag/resize clamps to the neighbour edge,
the phase form blocks a save that would overlap). Without this, an underlying
phase used to show through the gap between overlapping bars.

A group with `nestedGroups` is a **parent/container only** — items are assignable
solely to its leaf children, never to the parent itself. The editor enforces this
everywhere (form dropdown renders parents as non-selectable `<optgroup>` headings,
a drag onto a parent lane snaps into its first leaf, new items default to the
first leaf group). The rule lives once in [`src/groupHierarchy.ts`](src/groupHierarchy.ts).

Items without `content` are skipped. `start` is optional: a date-less item is
kept and shown in the **list view** (dates render as „—"), but the **timeline
view** filters it out (vis-timeline needs a start to place an item) and the
status line notes how many are hidden. Two reference files live in `data/`:

- `example-projektplan.json` — minimal 4-phase plan, single track per phase.
- `launch-roadmap.json` — 5 parallel tracks with `dependsOn` cross-references in `metadata`.

### Roadmap conventions

When generating a roadmap (whether for this project or invoked from elsewhere — see the global pointer in `~/.claude/CLAUDE.md`), follow these conventions so files stay consistent and easy to scan:

- **One file per roadmap.** Filename in kebab-case, no umlauts: `q3-roadmap-2026.json`, `feature-x-launch.json`. Becomes `src:<filename>` in the view list automatically.
- **Group IDs with sort prefix.** `1-strategy`, `2-design`, `3-engineering` — vis-timeline sorts groups alphanumerically; the prefix locks the row order.
- **Item IDs use track prefix + counter.** `S-1`, `D-2`, `E-3`, `M-4`, `O-5`. Short, easy to reference from `metadata.dependsOn`.
- **Milestones as `type: "point"`** with no `duration`/`end`. Phase backgrounds as `type: "background"` in their own group.
- **Dependencies live in `metadata.dependsOn: ["id1", "id2"]`.** The viewer renders subtle right-angle "Gantt" connectors (SVG overlay in [`src/arrows.ts`](src/arrows.ts)) from each predecessor's finish to the successor's start (its left edge). Back-to-back/overlapping items are routed to stay readable, and several predecessors on one target enter at vertically staggered points so they don't stack into one arrow. Off-screen sources/targets simply hide the arrow until they scroll into view. Make sure dependency target items have explicit `id`s so they can be referenced.
- **Bodies are Markdown.** Use them for owner notes, success criteria, links — they show up as the side panel content when the item is clicked.
- **Tags live in `metadata.tags: ["Label", …]`.** Lightweight coloured theme markers rendered as pills before the item's title (a legacy singular `metadata.tag` string is still read for backwards compatibility). Colours are resolved centrally in [`src/buildItems.ts`](src/buildItems.ts) (`TAG_COLORS`, with a grey fallback for unknown labels). Responsive: the label text collapses to just a coloured dot once the view is zoomed out below `TAG_TEXT_MIN_PX_PER_DAY` px/day ([`src/main.ts`](src/main.ts), `updateTagDensity`), and reappears when you zoom back in.
- **Dates as `YYYY-MM-DD`** without time component unless precision matters. `duration` accepts `Nh|d|w|mo|y` or raw milliseconds.

## Item icons

Items can carry an optional `icon` — a small glyph rendered before the content on
the bar. The value is a **semantic key** (what the icon means, not a concrete
SVG): the key resolves to a glyph via a `--icon-<key>` CSS custom property. The
stored `content` stays clean (the glyph is prepended at render time via the
vis-timeline `template`), so it round-trips through the editor, the DB, and
exports unchanged.

Curated key set (defined once in [`src/icons.ts`](src/icons.ts)):

`milestone` · `launch` · `done` · `warning` · `blocked` · `review` ·
`deadline` · `meeting` · `idea` · `research` · `design` · `build` · `bug` ·
`release` · `decision` · `goal` · `info` · `note`

Unknown values are dropped (validated by `normalizeIcon`). The base glyphs are
defined in the `:root` block of
[`src/styles/theme.css`](src/styles/theme.css).

**How to render / extend:**

- **Render:** the glyph is a CSS `mask` on `.item-icon` (see
  [`src/styles/timeline.css`](src/styles/timeline.css)), coloured with
  `currentColor` — it adapts to the item text colour automatically.
- **Change the icon look:** override any key in your own stylesheet, e.g.
  `:root { --icon-milestone: url("…"); }`.
- **Add a new semantic key:** add it to `IconKey` + `TIMELINE_ICONS` in
  `src/icons.ts` (label shown in the icon picker) and add a matching
  `--icon-<key>` to the `:root` set in `theme.css`. It then appears in the edit
  form, the `timeline_items.icon` column, and the MCP `add_item`/`update_item` tools.

Icons render on the live viewer, exported HTML, and the read-only Netlify deploy.

## Item status

Every item carries a built-in **status** — a first-class field with a fixed,
universal value set: `Open` · `Doing` · `Done`, defaulting to `Open`. Unlike a
per-timeline custom field, status is the *same* concept everywhere and is stored
as its own column (`timeline_items.status`, `NOT NULL DEFAULT 'Open'` + a CHECK
constraint), a peer of `icon` — so it round-trips through the DB, the editor,
exports and the MCP tools unchanged, and every existing/new item always has
exactly one of the three states.

- **Single source of truth:** the value set + default + `normalizeStatus` /
  `statusOrDefault` live in [`src/status.ts`](src/status.ts) (`StatusKey`,
  `ITEM_STATUSES`, `DEFAULT_STATUS`), imported by both the client form and the
  server data-access layer — no duplicated list.
- **Editing:** the item form renders a Status dropdown
  ([`src/itemForm.ts`](src/itemForm.ts)); new items seed `DEFAULT_STATUS`
  ([`src/render.ts`](src/render.ts)).
- **Server write:** `itemToRow` always writes a canonical value (never `null`,
  so inserts satisfy `NOT NULL`); `updateItem`'s patch map carries `status`
  ([`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts)).
- **MCP:** `add_item` / `update_item` accept `status` as an enum
  ([`scripts/mcp/server.ts`](scripts/mcp/server.ts)).
- **Add/rename a state:** change `ITEM_STATUSES` in `src/status.ts` and the DB
  CHECK constraint (a new migration). It then flows to the form, column and MCP.

Status also surfaces on the built `TimelineItem` ([`src/buildItems.ts`](src/buildItems.ts))
and renders as a **Status column in the Liste view** ([`src/listView.ts`](src/listView.ts));
items without a status (file-based sources) show „—".

> There is **no visual timeline-bar treatment yet** — on the bars status is
> field-only for now (stored + editable). A status mark on the bar is the
> intended first consumer of the item rail (see below).

## Item rail (marks inside the bar's right edge)

A range bar reserves a strip at its inner right edge for small marks, and the
label fades into the bar's own fill under it instead of being hard clipped. The
only mark today is the **delete affordance**, which appears on **hover as well as
on selection**. The strip is built as a general mechanism so a data mark (a
status glyph, say) can join it.

**The mark is ours, not vis-timeline's** (`editable.remove` is off, and vis's
`onRemove` handler is gone with it). vis creates its `.vis-delete` button only
while an item is *selected* — hovering a bar showed nothing, so the only way to
find out a bar was deletable was to click it, which also opens its edit form.
Owning the mark ([`src/itemRail.ts`](src/itemRail.ts)) keeps hover and selection
one affordance with one implementation instead of vis's button for the one state
and a copy of it for the other. Clicking it runs `deleteItem`
([`src/itemForm.ts`](src/itemForm.ts)) — the same path the form's Löschen button
takes, so there is one delete flow, not two.

Geometry and states are **CSS**, in [`src/styles/timeline.css`](src/styles/timeline.css)
(rail block), with the glyph in [`src/styles/theme.css`](src/styles/theme.css)
(`--ui-icon-delete`, kept apart from the `--icon-<key>` item set because chrome
glyphs have no key). Slots are counted right-to-left from the bar's inner edge,
so a mark's position is arithmetic on `--rail-slot` and marks line up without
measuring anything.

- **JS renders, CSS decides when.** `attachItemRail` puts a `.rail-delete` button
  on every mounted editable item (phase-background items excluded) and re-applies
  after vis mounts item DOM — the `'changed'` hook and repaint-via-timer notes
  from [`src/itemPresence.ts`](src/itemPresence.ts) apply verbatim. Visibility is
  left to `:hover` / `.vis-selected` in CSS; tracking hover in JS would duplicate
  what the selector already knows, and the mark is in the DOM either way.
- **The mark swallows the events vis builds gestures from** (`mousedown`,
  `pointerdown`, `touchstart`), or else deleting would also select the item and
  open its form. They are caught in the **capture** phase on the timeline
  container: vis binds its listeners further down the tree, so a bubbling
  listener would run after them, too late to stop anything. Those delegated
  listeners are wired once per container, not per render — the container outlives
  the timeline instances rendered into it.

- **Geometry** lives entirely in the vars on `.vis-item`: `--rail-mark` (mark
  box), `--rail-gap`, `--rail-inset`, `--rail-fade` (the gradient ramp),
  `--rail-slot` (mark + gap), and `--rail-w` (the space the occupied rail
  claims). `--bar-gutter` names the 2px gutter a range bar reserves so
  back-to-back bars don't touch — a mark sits inside the *visible* bar, so the
  rail has to offset by it.
- **Occupancy** is read off the DOM (`:has(> .rail-delete)`), not off a state
  class, so a read-only timeline neither reserves the slot nor fades its labels.
  The slot is claimed only while the mark is actually visible, so an unhovered,
  unselected bar keeps its full width for the label. `--rail-delete` +
  `--rail-marks` add up to `--rail-slots`.
- **Marks fill the strip from the edge inward, delete outermost.** A data mark
  therefore sits at slot `--rail-delete` (0 normally, 1 while the delete shows)
  and keeps a stable place at the edge instead of leaving a hole there when the
  item is deselected.
- **The fade** is an `::after` on `.vis-item-overflow` painted in
  `background-color: inherit` (whatever lane colour the wrapper carries) and
  masked into a ramp. Masking the wrapper itself would fade its border and fill
  along with the text. It stays in the DOM at `opacity: 0` so it fades in with
  the mark rather than snapping on.
- **A range bar takes the in-bar slot at every width**, however narrow. Zoomed
  out most bars are a few dozen pixels wide — narrower than the rail itself — so
  on those the mark covers the bar and the fade swallows the whole label while
  the pointer is on it. That is the accepted trade: a mark hanging *outside* the
  bar is what the rail exists to get rid of, and a two-character label on a 29px
  bar carries little to lose. Only **milestones and boxes** keep vis's placement
  just outside their right edge — they size to their content, so there is no
  interior to put a mark in and no `.vis-item-overflow` to fade. Reserving room
  with `padding-right` would widen every milestone permanently for an affordance
  that only shows on hover.

Two vis-timeline collisions the rail has to defeat, both worth knowing before
touching it. The mark needs `z-index` above `.vis-drag-center` /
`.vis-drag-right` (vis appends those to the same item box *after* it, so they
would swallow the click). And the right-edge **resize handle** is moved inward by
`--rail-w` so „drag the right edge to resize" and „click × to delete" don't fight
over the same pixels — but **only on a bar wide enough for them to collide**. vis
caps that handle at `max-width: 20%`, so on a narrow bar it is a sliver sitting
*past* the bar's right edge and it clears the mark by itself; the two start to
overlap once the handle grows beyond 10px, i.e. above a 50px bar. Below that the
shift would be actively wrong (24px inward on a 29px bar lands the grab zone in
the bar's left third). Asking each bar about its own width is what a **container
query** is for: `.vis-item.vis-range` is a `container-type: inline-size` query
container — safe, because vis sets a range bar's width inline from its dates, so
inline-size containment has nothing to break (verified: it moves no bar by a
pixel). Milestones and boxes are deliberately excluded, since containment would
cut off content-sized items. The `56px` threshold is a literal (container queries
can't read custom properties) — keep it in step with the rail vars.

**Adding a data mark:** render it as an absolutely positioned child of the
`.vis-item`, position it with `right: calc(var(--bar-gutter) + var(--rail-inset)
+ var(--rail-delete) * var(--rail-slot))`, set `--rail-marks: 1` on the item so
the fade widens with the rail, and add it to the `:has()` selectors. Note that a
data mark has to come from JS on the item element (the pattern in
[`src/itemPresence.ts`](src/itemPresence.ts)), not from the vis `template`: the
template's output lands inside `.vis-item-content`, which is content-sized, so it
cannot anchor to the bar's right edge.

## Item context menu (right-click quick actions)

Right-clicking an item on the timeline opens a small menu of the actions worth
having without the detail form open: **Status**, every **custom field that opted
in**, **Duplizieren**, **Löschen**. It lives in
[`src/contextMenu.ts`](src/contextMenu.ts) with its styling in
[`src/styles/menu.css`](src/styles/menu.css).

**Value pickers are submenus, one per field; the root menu holds only nouns and
the two verbs.** Status alone was three flat rows, and one opted-in field turned
the root into a wall of values in which „Löschen" was just another line. Behind
submenus the root stays the same size however many fields opt in, and each panel
marks the item's current value(s):

```
Status       ▸        (● Open · Doing · Done)
Version      ▸        (kein Wert · 1.0 · 2.0 · …)      ← a field that opted in
Tier         ▸        (☑ Free · Starter · ☑ Scale · …)
──────────────
Duplizieren
Löschen
```

A root row's mark is the item's **current** value when the field has exactly one
(the status dot, a single-select's colour dot) and blank for a multi-select, where
there is no single value to show. Submenu rows are `menuitemradio` for a single
choice and `menuitemcheckbox` for a toggle, so the role itself says whether picking
replaces or adds.

**Which fields appear is per-definition opt-in:** `def.contextMenu` on a custom
field (see „Custom fields → Quick-editable from the context menu"). Off by
default — a menu of every field would defeat the point of a *quick* action.

**The trigger is vis-timeline's own `contextmenu` event**, not a DOM listener of
our own. vis hands the callback `getEventProperties()` — the display id under the
cursor plus the raw event — so nothing here walks the DOM looking for a
`.vis-item`. (itemRail.ts *has* to delegate a click listener, because a rail
*mark* is not a vis concept and vis cannot resolve one; an item is.) A right-click
that lands on the rail's own „×" still resolves to its item. vis does not suppress
the browser menu itself (its `oncontextmenu` only emits), so `preventDefault()` is
ours — and it is called **only once the click is known to have an actionable
item**: on empty space, on an axis, on a phase tint (no row in the source file) or
on a read-only view the browser's own menu is left intact rather than being
replaced with nothing.

- **The menu is built per open**, not created once and reused: which status row
  carries `aria-checked` is a property of the item that was right-clicked.
- **The mutations are not in this module.** They are passed in from render.ts the
  way the rail takes its `deleteItem`, so each lives beside its peers:
  `setItemStatus` / `setItemFieldValue` next to `deleteItem` in
  [`src/itemForm.ts`](src/itemForm.ts), `duplicateItem` next to `createItem` in
  [`src/render.ts`](src/render.ts). Delete routes through the *same* `deleteItem`
  the rail mark and the form button use — one delete flow, not three.
- **This module knows nothing about field types.** Which definitions qualify is
  `contextMenuFields()` in [`src/customFields.ts`](src/customFields.ts), beside the
  rest of the per-type field semantics — that is also where `text` is filtered out
  whatever it declares, since a menu can only offer fixed rows and free text needs
  a keyboard.
- **A single-select stores a scalar, a multi-select an array** — the same shapes
  the form's `<select>` / chip editor write, so a value set from the menu round-trips
  through `metadata[key]` identically. A single-select carries a „kein Wert" row
  (the empty choice its `<select>` has); a multi-select clears by untoggling.
- **A multi-select keeps its panel open between picks** and re-marks the clicked
  row from the values the mutation returns; everything else closes first. Picking
  three tiers shouldn't mean reopening the menu three times, while delete raises a
  `confirm()` the menu must not sit over.
- **An emptied field loses its key, and an item with none left loses `metadata`.**
  Same rule as `applyItemForm`, and load-bearing for the same reason: the persist
  diff sends a missing clearable field as an explicit `null` (`buildItemPatch`), or
  the old value comes back on reload.
- **A status or field change has to re-render an open form**, and that is
  correctness, not polish: the form's pickers keep their values in hidden inputs,
  so a form still open on that item would hold the *old* value in its `FormData`
  and the next `commitItemForm` would write it straight back over the change. Both
  mutations therefore call `showItemForm` when the form is on that item, exactly as
  `handleMove` does after a drag.
- **No `markSelfEditing()` on a status change.** Presence attributes activity to
  the item the open form / selection points at, and a right-click does not select
  — so on an unselected item it would flag the wrong item as being edited.
  Marking the right one needs the presence activity model to carry an explicit
  item, which is a separate change.
- **Duplicate** drops the server-managed fields (`version` + the audit stamps), so
  the persist diff sees an id it has never saved and POSTs a new row instead of
  PATCHing over the original, and deep-clones `metadata` (a shared object would
  make a later edit to either copy change the other). The copy is placed clear of
  its original — a bar starts where the original ended, anything without an extent
  shifts by a day, a date-less item stays date-less — at day granularity, like
  every drag. Its form opens with the title focused, which is why the content is
  copied verbatim rather than suffixed.
- **The status dot is the global `.status-dot`** from
  [`src/styles/forms.css`](src/styles/forms.css), deliberately un-scoped from
  `.detail-tools` when this menu arrived: two copies of the value→colour mapping
  is how one of them ends up stale after a change to `--status-*`.
- **Dismissal** is Escape, a pointerdown outside, a wheel, a window resize, and
  the timeline's own `rangechange` (panning would slide the bar out from under a
  menu anchored to viewport coordinates). Document-level listeners live only while
  the menu is open. Escape backs out **one level** when a submenu is open, and that
  check lives in the *document* handler rather than the menu's: the document one
  captures, so it runs first and would otherwise dismiss everything from inside a
  submenu.
- **Keyboard** navigation is per level — arrow keys move within the open panel when
  focus is inside it, the root otherwise. ArrowRight/Enter opens a submenu and
  focuses its first row, ArrowLeft closes it and returns to the parent row, Tab
  closes rather than trapping focus, and closing hands focus back where it came
  from.
- **Positioning** is viewport coordinates on `<body>`, so panels can overhang the
  timeline's scroll panes instead of being clipped by them. The arithmetic is
  DOM-free in [`src/menuPosition.ts`](src/menuPosition.ts) and unit-tested
  (contextMenu.ts imports `state`, which touches `document` at load, so nothing in
  it can be pulled into a test): the root menu is clamped horizontally and flipped
  *up* on bottom overflow; a submenu goes right of its parent, flips left when
  there is no room (never into negative x), and slides up rather than flipping,
  because its top edge is tied to the row it belongs to. Submenu panels are DOM
  children of the menu — which is what keeps `menuEl.contains()` true for clicks
  inside them, so they don't read as a dismissal, and removes them with the parent.

**Adding an action** is an entry in `menuHtml` plus a handler in
`ItemMenuActions`; put the mutation itself next to its peers rather than in this
module. **Adding a value picker** needs no menu change at all — flag the field
`contextMenu: true`. Scope is the timeline view; the list view has no context menu.

## Custom fields (per timeline)

Beyond the built-in item fields, each timeline can declare its own **custom
fields**. The *definitions* are timeline-level config (stored on the timeline
row in the `custom_fields` jsonb column, a peer of `phases`); a field's *value*
lives per item in `metadata[key]`. This keeps the field schema per-timeline
while reusing the existing `timeline_items.metadata` column for values.

A definition is:

```jsonc
{
  "key": "risk",                 // metadata key the value is stored under
  "label": "Risiko",             // shown in the editor
  "type": "multi-select",        // "text" | "select" | "multi-select"
  "options": [                   // choices for select / multi-select (ignored for text)
    { "value": "Technisch",   "color": "#64748B" },
    { "value": "Rechtlich",   "color": "#1D9E75" },
    { "value": "Kapazität",   "color": "#315DFF" }
  ],
  "group": "Risiken",            // optional: section heading in the item form
  "width": "full",               // optional: "half" (default) | "full" (spans both columns)
  "contextMenu": true            // optional: also settable from an item's right-click menu
}
```

**Values by type** (in `metadata[key]`): `text` / `select` → a string;
`multi-select` → a `string[]`. Definitions are read/written in
[`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts) (`getTimeline`,
`replaceTimeline`, `updateMeta`) and flow to the viewer as `file.customFields`.

**Configuration is backend-side for now** — there is no in-app editor for the
definitions themselves. Seed / change them via:

- the MCP tool `set_custom_fields(id, customFields)` (patches the definitions as
  a unit; items are untouched), or `replace_timeline`'s optional `customFields`;
- a direct `PATCH /api/source/<id>` with `{ "customFields": [...] }`;
- SQL on the `timelines.custom_fields` column.

**Editing values:** for a DB-backed (editable) timeline the item form renders one
control per custom field ([`src/customFields.ts`](src/customFields.ts), wired
into [`src/itemForm.ts`](src/itemForm.ts)) — a chip editor with a fixed-options
dropdown for `multi-select`, a `<select>` for `select`, a text input for `text`.
Custom-field keys are treated as managed metadata (like `tags` / `dependsOn`),
so they never leak into the free-form "Other metadata (JSON)" box.

### Quick-editable from the context menu (`contextMenu`)

A definition may set **`contextMenu: true`**, which adds the field to an item's
right-click menu as a submenu of its options (see „Item context menu"): a
`select` picks one value or „kein Wert", a `multi-select` toggles values and keeps
its panel open. Values are written to the same `metadata[key]` in the same shapes
the form writes, so the two ways in are interchangeable.

Off by default, per definition: the point is a *quick* action, and a menu listing
every field would not be one. `text` is never offered whatever it declares — a menu
can only present fixed rows, and free text needs a keyboard. The rule lives in
`contextMenuFields()` ([`src/customFields.ts`](src/customFields.ts)), so the menu
itself reasons about no field types.

Set it the same ways as any other part of a definition (`set_custom_fields`,
`replace_timeline`, `PATCH`, SQL). Note that the MCP `customFieldDef` schema is
**not** pass-through — Zod strips keys it doesn't declare, so a property missing
from it is silently dropped on that path. `contextMenu` is declared; `group` and
`width` are not yet, and have to go through `PATCH`/SQL until they are added.

**A plugin opts in through its own `fields()`** rather than through stored config,
since its definitions are derived. `product-roadmap` flags **Version** and
**Tier**: short, fixed lists that get retargeted often while planning. **Features**
deliberately stays off — a timeline carries dozens, and a submenu that long is a
worse way in than the form's searchable chip editor.

### Plugin-contributed fields

The stored definitions above are not the only source of custom fields: an enabled
**plugin** contributes its own, derived from the timeline's data rather than
declared by hand (see „Timeline kinds"). `getCustomFields()` concatenates the
timeline's stored defs with `pluginFieldDefs(file)`, and everything downstream —
the form control, the managed-metadata rule, grouping and filtering — works off
that one list, so a plugin field needs no parallel code path. Being derived, these
defs are never persisted back as definitions. `product-roadmap` contributes:

| Field        | Key                       | Options derived from                    | Width | Context menu |
| ------------ | ------------------------- | --------------------------------------- | ----- | ------------ |
| **Version**  | `metadata.featureVersion` | `pricing.versions`                      | half  | yes          |
| **Tier**     | `metadata.tier`           | `pricing.tiers` (value = tier id)       | half  | yes          |
| **Features** | `metadata.featureIds`     | `pricing.features` (value = feature id) | full  | no (too many) |

**The plugin lays out its own section.** The order of the array `fields(file)`
returns is the render order, and each def's `width` (`half`, the default, or
`full`) decides whether it shares its grid row — `full` reuses the form's existing
`.field.full` rule, the same seam the built-in fields use. So Version and Tier
pair up on one row as compact pickers, and Features spans both columns below them
because its chips carry long feature names. Changing that layout is a change to
`fields()`, not to the form.

**One definition per key** — a contributed field *supersedes* a stored one with
the same key (`mergeFieldDefs` in `kinds/registry.ts`). Two defs on one key would
render two controls writing the same `metadata[key]` and sharing one multi-select
state bucket (that state is keyed by the field key). So a stored definition a
plugin has taken over is inert, and dropping it is a tidy-up rather than a fix.

**Tier was such a definition.** It used to be a hand-seeded stored field whose
options were a copy of the tier *names*, so renaming a tier in the pricing model
left the field offering the old label. Derived, it cannot drift. Two consequences
of the switch: its values are tier **ids** (`"scale"`, like the feature field)
rather than names, so a rename doesn't orphan them — no migration was needed, as
no item carried a `tier` value; and the chip colour is derived from the tier id
(`tierColor`, an hsl hue from a hash) instead of hand-picked per tier, because
picking colours in the code would reintroduce exactly the duplication the derived
field removes. A tier colour that has to be chosen belongs in `pricing_tiers` as a
column, not in the field definition.

**Sections.** A def may carry a `group`, and the item form renders one titled
section per group in the Properties tab, after the ungrouped fields
(`.cf-group` fieldset, styled in [`src/styles/forms.css`](src/styles/forms.css)):
an open block behind a hairline, not a disclosure — these are ordinary item
properties, and hiding them behind a click would cost a lookup on every edit. The
caption is centred over the rule, because it titles the whole section; left-aligned
at 11px uppercase it read as a label for the field directly beneath it.
Plugin fields get their plugin's `label` stamped as the group (so product fields
land under „Produkt"); a **stored** def may declare a `group` too, to file itself
under the same heading. The sections are plain markup inside the same `<form>`, so
`FormData`, `applyCustomFields` and `isManagedMetaKey` are untouched by the
grouping.

Because two sources can name a field the same thing, a grouped field is listed as
„&lt;Gruppe&gt; · &lt;Label&gt;" in the Gruppieren / Filter dropdowns
(`dimensionLabel` in [`src/listGrouping.ts`](src/listGrouping.ts)); the stored key
stays untouched.

> Note: metadata-only edits (custom fields, tags, `dependsOn`, owner, JIRA) rely
> on the persist-diff seeing inside `metadata`. `canonicalItem`
> ([`src/persistence.ts`](src/persistence.ts)) therefore serialises with a
> recursive key-sort — **not** a `JSON.stringify` array replacer, which silently
> drops nested keys and made metadata-only edits look unchanged.

## Supabase als Datenquelle

Editierbare Timelines liegen in **Supabase (Postgres)**, nicht mehr in Google
Sheets. Geschrieben wird **item-genau mit optimistischem Locking** (`version`-
Spalte pro Item): parallele Edits an verschiedenen Items überschreiben sich nicht
mehr, und ein veralteter Schreibversuch bekommt `409` statt still zu verlieren.

Datei-basierte Timelines (`data/*.json`, z.B. die Beispiele) bleiben **read-only
statische Quellen** — sie sind *nicht* in der DB. Nur DB-Timelines sind editierbar.

Lokale Middleware (`vite.config.ts`) und Netlify-Edge-Function
(`netlify/edge-functions/timelines-api.ts`) teilen sich denselben Dispatcher
(`scripts/db/api.ts`, `handleTimelineApi(repo, req)`) und den `TimelineRepo`-Seam
(`scripts/db/repo.ts`) — eine Implementierung der Storage- und Locking-Semantik
für beide Runtimes, unabhängig vom gewählten Treiber (siehe „Treiber").

> **Treiber (seit Phase 3, #28): additiver Dual-Adapter — `supabase-js` (Default)
> ODER `postgres.js` (opt-in).** Beide Treiber implementieren denselben
> `TimelineRepo`-Seam ([`scripts/db/repo.ts`](scripts/db/repo.ts), jede
> Storage-Methode mit gebundenem Client, ohne führenden Client-Parameter):
> - **`supabase-js`** ([`scripts/db/timeline-repo-supabase.ts`](scripts/db/timeline-repo-supabase.ts),
>   Factory `makeSupabaseRepo(db)`) — spricht HTTP/PostgREST, läuft ohne rohes TCP
>   im Deno-Edge und ist **der Default, auf dem der Netlify-Deploy läuft**.
>   Node-Client `getServiceClient()` ([`scripts/db/client.ts`](scripts/db/client.ts)).
> - **`postgres.js`** ([`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts),
>   Factory `makePostgresRepo(sql)`) — **opt-in** für Self-Hoster mit eigenem
>   Postgres über einen Connection-String (`TIMELINES_DATABASE_URL`). Node-Factory
>   `getSql()` ([`scripts/db/sql.ts`](scripts/db/sql.ts), `prepare:false` für den
>   Supavisor-Transaction-Pooler); die Edge-Functions öffnen einen **modul-scoped,
>   über Invocations wiederverwendeten** Handle (nie `sql.end()` im Handler —
>   Deno-Teardown-Quirk).
>
> **Auswahl per Env** (identisch in jeder Runtime): ist `TIMELINES_DATABASE_URL`
> gesetzt → postgres.js, sonst `TIMELINES_SUPABASE_URL` + `TIMELINES_SUPABASE_SERVICE_KEY`
> → supabase-js. Die Glue baut beide möglichen Handles und übergibt sie als
> `{ sql, supabase }` an `resolveAdapter`/`resolveRepo`; postgres.js gewinnt, wenn
> ein `sql`-Handle da ist. **Netlify setzt nur die Supabase-Vars → dort läuft
> unverändert supabase-js**, null Verhaltens-/Risiko-Änderung. Optimistisches
> Locking (`update … where version=$` + 0-Rows→`ConflictError`), jsonb-Handling
> und der DB-Trigger-`version`-Bump sind in beiden Treibern identisch;
> **Schema/Trigger/Migrationen unverändert**. `@supabase/supabase-js` lebt zusätzlich
> client-seitig in [`src/realtime.ts`](src/realtime.ts) (Browser-Realtime) —
> davon unberührt.
>
> **Prod-Deploy (Netlify):** unverändert die Supabase-Vars setzen (`TIMELINES_SUPABASE_URL`
> + `TIMELINES_SUPABASE_SERVICE_KEY`) — kein `TIMELINES_DATABASE_URL` nötig. Nur wer
> bewusst nativen Postgres statt PostgREST fahren will, setzt `TIMELINES_DATABASE_URL`;
> der Deno-Deploy-Outbound-TCP zum Pooler ist dann der einzige erst live
> verifizierbare Punkt (lokal Node + Docker-Postgres bewiesen).

### Prinzip: keine Notfall-/Fallback-Daten — niemals

**Für DB-Timelines wird nirgends ein Inhalts-Snapshot vorgehalten. Lieber gar
keine Daten als falsche.** Ein committeter oder gecachter Abzug einer
Live-Timeline ist optisch nicht von echten Daten zu unterscheiden und wird
zuverlässig damit verwechselt (bei DB-Ausfall, id-Mismatch, veraltetem Stand).
Deshalb gilt hart:

- Der Viewer lädt DB-Timelines **ausschließlich** live aus der DB
  (`GET /api/source/<id>`). Schlägt das fehl (`404`, kein Netz), **failt er laut**
  mit einer Fehlermeldung — es wird *kein* statischer Inhalt angezeigt
  ([`src/editor.ts`](src/editor.ts), `loadSource`).
- DB-Timelines werden **nicht** über committete Dateien registriert. `build-data`
  fragt beim Bauen die DB ab (`collectDbSources` in
  [`scripts/build-data.ts`](scripts/build-data.ts)) und erzeugt pro Timeline einen
  **Registrierungs-Stub** (`name`, optional `description`/`groupBy`, `items: []`)
  ausschließlich im **gitignorierten Build-Output** (`public/data/sources/`), damit
  sie in der View-Liste auftaucht. Der Stub enthält **nie** items/groups/phases;
  Inhalte lädt der Viewer live. So trägt das Repo **keine** Mandanten-Dateien, und
  der Deploy listet seine DB-Timelines trotzdem (er hat DB-Zugriff und fragt sie
  beim Bauen ab). Scope über `TIMELINES_SOURCES_SUBDIR` als id-Namespace-Präfix.

Neue Sync-/Cache-/Fallback-Mechanismen für DB-Timelines, die Inhalte in Dateien,
CDN oder sonstwo spiegeln, sind **nicht** einzuführen. (Datei-basierte Quellen —
die Beispiele — sind kein Widerspruch: dort *ist* die Datei die Quelle, kein
Abzug von etwas anderem.)

### Schema

Drei Tabellen (Migrationen in `supabase/migrations/`):

- `timelines` — id, name, description, group_by, `phases` (jsonb),
  `custom_fields` (jsonb). **Keine plugin-spezifischen Spalten mehr:** die frühere
  `type`-Spalte (Gate `'product'`) und `pricing_versions` (geordnete Versions-
  Labels) sind seit Migration `0012`/`0013` in die generische
  `timeline_plugins`-Registry gewandert (siehe unten + „Plugin-Registry"). Das
  Preismodell selbst liegt seit Migration `0009` normalisiert in eigenen Tabellen.
- `timeline_plugins` — die **generische Plugin-Registry** (Migration `0012`):
  eine Zeile pro (timeline_id, plugin_id) plus `config` (jsonb). Ein Plugin (a.k.a.
  Timeline-Kind, z.B. `'product-roadmap'`) ist auf einer Timeline **aktiviert,
  sobald hier eine Zeile existiert** — reine Daten, kein `ALTER TABLE`, keine
  Core-Spalte. Für `product-roadmap` trägt `config` die Versionsliste
  (`{ versions: [...] }`, früher die `pricing_versions`-Spalte). FK-Cascade auf
  `timelines`, anon-SELECT + Realtime wie die pricing_*-Tabellen. Ein neues Plugin
  braucht (nur) seine eigenen Daten-/Tabellen, nie eine Spalte am Core. Siehe
  „Plugin-Registry".
- `timeline_items` — Spalten für start/end/duration/content/group/type/title/
  body/icon/status/class_name (`status` `NOT NULL DEFAULT 'Open'` + CHECK
  `Open|Doing|Done`, siehe „Item status"), `metadata` (jsonb: `dependsOn`, `owner`, `jira`, freie
  Extras), `version` (Trigger-Bump bei UPDATE), `sort`, `updated_by`. Nur
  `content` ist Pflicht; `start` ist seit Migration `0006_start_nullable` nullable (ein über die
  Liste angelegter Eintrag darf datumslos sein und erscheint dann nur in der
  Listenansicht, nicht auf der Timeline). `end` und
  `duration` schließen sich aus (Ausdehnung entweder/oder, `end` gewinnt) —
  erzwungen im Write-Layer für alle Pfade (`enforceExtentExclusivity` +
  patch-bewusstes Gegenstück-Löschen in [`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts),
  MCP `add_item`/`update_item`, Client-Form).
- `timeline_groups` — id, content, nested_groups, show_nested, sort.
- **Pricing-Tabellen** (Migration `0009`, nur relevant für product-roadmap-Timelines):
  `pricing_features`, `pricing_tiers`, `pricing_highlights` — je Zeile pro
  Entität mit eigener `version`-Spalte (Trigger-Bump, optimistisches Locking wie
  `timeline_items`; der Client sieht sie als `rowVersion`). Das Feature-Domänen-
  feld „ab Version" heißt in der DB `available_from` (nicht `version`, um die
  Kollision mit der Locking-Spalte zu vermeiden). `pricing_tier_values` — die
  Matrix, **eine Zeile pro (tier_id, feature_id)** mit `value` (jsonb: `true`
  oder String) und optionalem `available_from` (Migration `0011`, Text-Version-
  Label); FK-Cascade von Features/Tiers, kein Locking (eine Zelle ist atomar).
  Damit editieren zwei Leute verschiedene Matrix-Zellen kollisionsfrei.
  `available_from` macht die **Zell-Verfügbarkeit versionsabhängig** — dieselbe
  Semantik wie `pricing_features.available_from`, nur eine Ebene tiefer (pro
  Tarif×Feature): die Zelle zählt erst ab dieser Version als enthalten, davor
  rendert sie „–". `value` bleibt der Endzustand. So lässt sich „in Enterprise
  jetzt, in Scale erst ab v4" abbilden (siehe „Pricing → Zell-Versionierung").

RLS ist an; Server-Zugriff läuft über den Service-Key (bypassed RLS). Anon-
SELECT-Policies existieren nur für die Realtime-Subscription (siehe unten).

**Migrationen anwenden — portabler Runner (`npm run db:migrate`).** Gegen
*beliebiges* Postgres über `TIMELINES_DATABASE_URL`, kein Supabase-CLI nötig.
[`scripts/db/migrate.ts`](scripts/db/migrate.ts) (postgres.js) legt eine
`schema_migrations`-Tracking-Tabelle an und wendet die `supabase/migrations/*.sql`
in Dateinamen-Reihenfolge an, jede in **einer Transaktion**, mit Checksumme
(Drift-Warnung). Re-runs wenden nur Ausstehendes an.

```bash
npm run db:migrate               # ausstehende Migrationen anwenden
npm run db:migrate -- --status   # applied/pending auflisten
npm run db:migrate -- --baseline # ALLE aktuellen Files als "angewandt" eintragen,
                                 # OHNE sie auszuführen — für eine DB, die schon
                                 # von Hand migriert wurde (siehe unten)
```

`0000_prereq_roles.sql` legt die `anon`-Rolle + `supabase_realtime`-Publication
idempotent an, damit `0003`/`0009` auch auf einem **Vanilla-Postgres** laufen
(auf Supabase existieren sie schon → no-op). Ein frisches Postgres ist damit
ohne manuelle Vorbereitung schema-komplett.

> **Bestehende Supabase-DB adoptieren (einmalig):** die Live-DB wurde früher
> **manuell** migriert (kein Tracking). Der Runner würde dort sonst alles
> re-applyen und an `0001` scheitern. Deshalb dort **einmal**
> `npm run db:migrate -- --baseline` (mit den Supabase-Env-Vars bzw. dem
> Pooler-`TIMELINES_DATABASE_URL`) — trägt `0000–0011` als angewandt ein, ohne
> sie auszuführen. Danach laufen neue Migrationen normal über `db:migrate`.

Alternativ (nur Supabase, altes Verfahren) über die CLI:

```bash
supabase link --project-ref <ref>
supabase db query --linked -f supabase/migrations/<datei>.sql
```

### Plugin-Registry

Ein **Plugin** (a.k.a. Timeline-Kind) ist auf einer Timeline aktiviert, sobald in
`timeline_plugins` eine `(timeline_id, plugin_id, config)`-Zeile existiert — reine
Daten, kein `ALTER TABLE`. Die einzige Stelle, die Plugin-ids kennt, ist
[`src/plugins.ts`](src/plugins.ts) (`PRODUCT_ROADMAP_PLUGIN`, `hasPlugin`,
`pluginConfig`, `versionsFromConfig`, `resolveWritePlugins`).

**Was heute generisch ist:**

- **Speichern + Lesen.** `timeline_plugins` nimmt jede `plugin_id`/`config`;
  `getTimeline` liest **alle** Zeilen in `file.plugins` (`PluginRef[]`), unabhängig
  vom Plugin. Round-trippt durch beide Treiber.
- **Aktivieren (Bulk).** Über MCP `replace_timeline` mit `plugins: [{ id, config }]`
  oder direktes SQL/PATCH. Lokal identisch zu Prod (gleicher `api.ts`-Dispatcher,
  gleiche DB).

**Was (noch) NICHT generisch ist:**

- **Kein granularer Enable-Weg.** Die API-SubKinds enthalten kein `plugin`, MCP hat
  kein `enable_plugin`. Ein einzelnes Plugin an-/abschalten ohne den Rest der
  Timeline geht nur per SQL oder Bulk-`replace_timeline`. (Offener Follow-up:
  `PUT/DELETE /api/source/<id>/plugin/<pluginId>` + MCP `enable_/disable_plugin`.)
- **Verhalten ist code-gekoppelt.** `resolveWritePlugins` / `updateVersions` /
  `getPublicPricing` sind hart auf `product-roadmap` verdrahtet, und client-seitig
  listet `KINDS[]` ([`src/kinds/registry.ts`](src/kinds/registry.ts)) nur
  `product-roadmap`. Eine Zeile mit unbekanntem `plugin_id` wird gespeichert und
  ausgeliefert, aber **nichts konsumiert sie**, bis Code sie interpretiert.

**Ein neues Plugin hinzufügen:**

1. **Aktivieren = Datenzeile** (`replace_timeline`/SQL). Braucht kein Schema.
2. **Eigene Ansicht?** → neuer `KINDS[]`-Eintrag + `src/kinds/<name>/`-Ordner
   (lazy-geladen, siehe „Timeline kinds"). Kein Core-Datei-Change.
3. **Eigene Item-Felder?** → `fields(file)` am `KINDS[]`-Eintrag, Implementierung
   in `src/kinds/<name>/fields.ts` (nur `types` + `plugins` importieren, sonst
   zieht die Naht den View-Chunk in den generischen Build). Sie erscheinen
   automatisch als Abschnitt unter dem `label` des Plugins, plus als Gruppieren-/
   Filter-Dimension — siehe „Custom fields → Plugin-contributed fields". Kein
   Core-Datei-Change.
4. **Eigene persistierte Daten?** → eigene Tabellen + Write-Pfad (Vorbild:
   `pricing_*` + `assemblePricing`). Nie eine Spalte am Core.
5. Reads über `file.plugins` stehen schon; das product-spezifische
   Auto-Enable-Verhalten (`resolveWritePlugins`) ist Vorbild, kein Zwang.

### Setup (einmalig)

Credentials in `~/_AGENTS/.env` (oder `.env.local`), gelesen über die Kaskade in
[`scripts/db/env.ts`](scripts/db/env.ts) (`process.env` → `~/_AGENTS/.env` →
`.env.local`). Je nach gewähltem Treiber (siehe „Treiber"): supabase-js über
`getServiceClient()` ([`scripts/db/client.ts`](scripts/db/client.ts)), postgres.js
über `getSql()` ([`scripts/db/sql.ts`](scripts/db/sql.ts)):

| Var                              | Treiber      | Bedeutung                                                                 |
| -------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `TIMELINES_SUPABASE_URL`         | supabase-js  | `https://<ref>.supabase.co` (Default-Pfad)                                |
| `TIMELINES_SUPABASE_SERVICE_KEY` | supabase-js  | Service-Role-Key (Server-seitig, nie in den Client)                       |
| `TIMELINES_DATABASE_URL`         | postgres.js  | Postgres-Connection-String (`postgresql://…`); gesetzt → gewinnt vor supabase-js. Supabase: Supavisor-Transaction-Pooler (Port 6543). Beliebiges Postgres möglich. |

Ist `TIMELINES_DATABASE_URL` gesetzt, läuft alles über postgres.js; sonst über
supabase-js.

**Eigenes Postgres in 3 Schritten** (kein Supabase nötig):

```bash
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16   # 1. Postgres
export TIMELINES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres  # 2. Ziel
npm run db:migrate                                                     # 3. Schema
```

Danach den Server mit `TIMELINES_DATABASE_URL` fahren (Live-Updates via
`TIMELINES_DB_LIVE=poll`, ohne anon-Key/Realtime — siehe „Live-Update-Naht").
`0000_prereq_roles.sql` erledigt die früher manuelle `anon`/Publication-Anlage,
also ist kein Handanlegen mehr nötig.

#### Per-Source-Connections (Phase 4, #30)

Verschiedene Timelines können in **verschiedenen Postgres-Instanzen** liegen —
gewählt über den **Namespace** der Source-id (erstes Pfadsegment). Zusätzlich zur
Default-`TIMELINES_DATABASE_URL` benannte Connections setzen:

```bash
export TIMELINES_DATABASE_URL=postgresql://…/default        # Default für alles
export TIMELINES_DATABASE_URL_WAREHOUSE=postgresql://…/warehouse  # nur warehouse/*
```

`warehouse/plan` → `TIMELINES_DATABASE_URL_WAREHOUSE`; alles ohne passende
benannte Var → Default. Ableitung: Namespace uppercased, Nicht-Alphanumerisches
zu `_` (`getSqlForSource`/`connectionEnvKey` in [`scripts/db/sql.ts`](scripts/db/sql.ts)).
**Opt-in & backward-kompatibel:** ohne eine `TIMELINES_DATABASE_URL_<NS>` nutzt
jede Source den Default wie bisher. Connection-Strings bleiben in Env, nie in
committeter Config. Nur der **Node-Pfad** routet per Source (die Glue setzt
`DbConnections.sqlFor`); die Edge-Function (Supabase) bleibt Single-Connection.
Ein Default muss gesetzt sein (der `/api/sources`-Collection-Endpoint listet aus
der Default-Connection).

### Import / Migration

`scripts/db/import.ts` lädt die konfigurierten Timelines aus ihren
`data/<id>.json` in die DB (`replaceTimeline`). Wiederholbar.

```bash
npm run db:import                         # alle
npm run db:import -- acme/my-plan          # gezielt
```

### Sync-Verhalten

- **Read:** Client lädt `GET /api/source/<id>` → DB. Schlägt das fehl (`404`,
  kein Netz) → **lauter Fehler, kein statischer Fallback** (siehe „Prinzip: keine
  Notfall-/Fallback-Daten"). Echte datei-basierte Quellen (die Beispiele) liegen
  als Datei vor und sind read-only (`editable:false`).
- **Write:** UI-Edits (Drag, Form, Add, Delete) schicken **item-genaue** Calls:
  `POST/PATCH/DELETE /api/source/<id>/item[/<itemId>]`, `PUT …/phases`. `PATCH`
  trägt die bekannte `version` im `If-Match`-Header; passt sie nicht mehr → `409`
  → der Client lädt das Item neu. Ein `PATCH` rührt eine Spalte **nur an, wenn
  der Key im Body steht** (`updateItem`, [`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts)) —
  ein geleertes optionales Feld (z.B. die letzte `metadata.dependsOn` entfernt,
  wodurch `metadata` ganz vom Item verschwindet) muss daher als **explizites
  `null`** gesendet werden, sonst bleibt der alte DB-Wert stehen und taucht beim
  Reload wieder auf. Der Client baut den Patch deshalb über `buildItemPatch`
  ([`src/persistence.ts`](src/persistence.ts)), das jedes fehlende clearable Feld
  auf `null` setzt.
- **Registrierungs-Stubs:** `npm run build:data` (Teil von `dev`/`build`) fragt die
  DB ab und schreibt pro DB-Timeline einen Stub (`name` + `items: []`, kein Inhalt)
  in den **gitignorierten Build-Output** `public/data/sources/<id>.json` — nur um
  die Timeline in der View-Liste zu halten, **kein** Daten-Fallback und **nichts
  Committetes**. Nichts landet im getrackten `data/`.
- **Live-Kollaboration:** siehe „Realtime" — ersetzt das frühere 60-s-Polling.

### Production-Setup (Netlify)

Zusätzlich zu den Auth-Env-Vars:

| Var                              | Where              | Notes                                          |
| -------------------------------- | ------------------ | ---------------------------------------------- |
| `TIMELINES_SUPABASE_URL`         | dashboard          | **Default-Pfad (supabase-js).** Aktiviert die `timelines-api`/`pricing-api` Edge Functions über HTTP/PostgREST. |
| `TIMELINES_SUPABASE_SERVICE_KEY` | dashboard (secret) | Service-Role-Key für den serverseitigen Zugriff |
| `TIMELINES_DATABASE_URL`         | dashboard (secret) | **Optional/opt-in.** Nur setzen, um bewusst nativen Postgres (postgres.js/TCP, Supavisor-Transaction-Pooler Port 6543) statt supabase-js zu fahren — gewinnt dann vor den Supabase-Vars. |
| `VITE_SUPABASE_URL`              | dashboard          | build-time; **nur** für client-seitiges Realtime (siehe „Realtime"). Ohne beide erscheinen fremde Edits erst beim Reload |
| `VITE_SUPABASE_ANON_KEY`         | dashboard          | build-time, public im Bundle; **Redeploy nötig** (Vite backt sie beim Build ein) |

Die Edge Function gated per Session-Cookie (bzw. MCP-Token) und attribuiert
Edits über `updated_by` an die E-Mail des eingeloggten Users. Ist **weder** der
Supabase- **noch** der `TIMELINES_DATABASE_URL`-Zugriff konfiguriert, kann die
Edge Function nicht auf die DB zugreifen und die Source failt laut (kein
statischer Fallback).

> **Deploy-Hinweis (Phase 3, additiver Dual-Adapter):** Der Netlify-Deploy läuft
> **unverändert auf supabase-js** — es genügen `TIMELINES_SUPABASE_URL` +
> `TIMELINES_SUPABASE_SERVICE_KEY` (exakt wie vor Phase 3), null Verhaltens-/
> Risiko-Änderung. `TIMELINES_DATABASE_URL` ist ein **opt-in** für Self-Hoster mit
> eigenem Postgres; setzt man es, gewinnt der postgres.js-Pfad und der
> Deno-Deploy-Outbound-TCP zum Pooler ist der einzige erst live verifizierbare
> Punkt.

### Live-Update-Naht (Realtime **oder** Polling)

Wie fremde Änderungen in einen offenen Viewer kommen, ist eine **Naht** mit zwei
Implementierungen hinter einer Signatur — `watchTimeline(id, onChange, { live,
isBusy })` in [`src/realtime.ts`](src/realtime.ts). Welche Impl greift, sagt die
Quelle über `capabilities.live` (`SourceLive` in [`src/types.ts`](src/types.ts)):

- **`realtime`** — Supabase Realtime schiebt Zeilenänderungen per WebSocket
  (`subscribeTimeline`, feingranulare Item-Events mit Echo-Suppression). Braucht
  den anon-Key (`VITE_SUPABASE_*`); ohne ihn passiert nichts (Reload-only).
- **`poll`** — der Client pollt einen billigen **Watermark-Endpoint**
  (`GET /api/source/<id>/watermark` → `{ v, n, t }` = max Item-`version` /
  Item-Count / max `updated_at` über Items + `timelines`-Row) im Intervall
  (`src/poll.ts`: ~8 s sichtbar, ~60 s versteckt, `visibilitychange`-Backoff).
  Ändert sich die Watermark → **Full-Reload** über den bestehenden
  `loadSource`-Pfad (Timelines sind klein; Delta-Fetch ist eine spätere
  Optimierung). Braucht **keinen** anon-Key (Endpoint ist server-gated) — so wird
  ein Postgres **ohne** Realtime live. Der Poll pausiert, solange ein Edit-Form
  offen ist (`isBusy`); die erkannte Änderung wird nicht verworfen, sondern
  nachgeholt.
- **`none`** — keine Live-Updates (Datei-Quellen).

Der Server sagt dem Client den Modus über den **`X-Source-Live`-Response-Header**
auf `GET /api/source/<id>` (gesetzt von der Runtime-Glue aus
`adapter.capabilities.live`); `loadSource` liest ihn und legt ihn in
`state.activeSourceLive` ab. Der DB-Adapter meldet standardmäßig `realtime`; die
Env-Var **`TIMELINES_DB_LIVE=poll`** (lokal `process.env`, Netlify `Deno.env`)
schaltet DB-Quellen auf Polling — nützlich für ein Postgres ohne aktiviertes
Realtime und zum End-to-End-Test des Poll-Pfades.

> **Scope:** Die Watermark deckt Items + Timeline-Meta (inkl. Phasen) ab —
> **nicht** die Pricing-Tabellen. Kein Poll-Source ist heute eine
> Produkt-Timeline, und Realtime deckt Pricing weiter ab; Pricing in die
> Watermark zu falten ist ein Follow-up (`getWatermark` in
> [`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts)).

#### Presence unter Polling

Presence (siehe unten) ist **realtime-only** — sie hängt am Supabase-Presence-
Channel. Poll-Quellen zeigen kein Presence-Badge und keine Item-Marker (eine
Heartbeat-Tabelle wäre ein optionales, nicht umgesetztes Sub-Feature).

### Realtime (Live-Kollaboration)

Fremde Edits erscheinen live ohne Reload — Supabase Realtime schiebt Zeilen-
änderungen per WebSocket, der Client (`src/realtime.ts`) patcht die Ansicht.

**Opt-in pro Environment** über Client-Env-Vars (Vite, build-time):

| Var                       | Bedeutung                                            |
| ------------------------- | ---------------------------------------------------- |
| `VITE_SUPABASE_URL`       | Supabase-URL (in den Client-Bundle eingebettet)      |
| `VITE_SUPABASE_ANON_KEY`  | anon-Key — **public im Browser**                     |

Achtung: der anon-Key ist im ausgelieferten Bundle sichtbar; mit den
anon-SELECT-Policies sind Timeline-*Reads* damit für jeden lesbar, der den Key
hat. Daher bewusst opt-in — auf der gated Netlify-Site nur setzen, wenn das
akzeptabel ist. Writes bleiben serverseitig (Service-Key). Ohne diese Vars
funktioniert alles weiter, fremde Änderungen erscheinen dann erst beim Reload.

**Fremde Änderungen werden in-place angewendet, nie über den Vollaufbau.**
`scheduleRemoteRefresh` lädt die Quelle neu und gibt sie über
`refreshActiveSourceInPlace` ([`src/render.ts`](src/render.ts)) in die lebende
vis-Instanz (`rebuildAndApply` → DataSet-Diff). Der Weg über `renderTimeline`
zerstört Timeline plus Pfeil- und Phasen-Overlay und baut sie neu — der Container
ist dabei kurz leer, die Ansicht flackert also bei *jedem* Fremd-Edit; da ein
tippender Kollege alle `PERSIST_THROTTLE_MS` schreibt, ergab das ein
Dauerflackern. `renderTimeline` bleibt Fallback für das, was in-place nicht
darstellbar ist (View gewechselt, erstes/letztes Phase- oder Dependency-Overlay
kommt hinzu bzw. fällt weg).

#### Presence (wer ist online)

Der Header zeigt oben rechts Avatare aller, die dieselbe **editierbare
DB-Timeline** gerade offen haben. Umgesetzt über einen Supabase-**Presence**-
Channel (`presence:<timelineId>`, `joinPresence` in [`src/realtime.ts`](src/realtime.ts)) —
kein DB-Tabellen-Zugriff, keine RLS-Policy nötig. Gerendert von
[`src/presence.ts`](src/presence.ts) ins `#presence`-Element, per Farbe/Initialen
pro E-Mail; der eigene Avatar bekommt einen Ring. Mehrfach-Tabs derselben Person
werden per E-Mail dedupliziert, ab dem 6. User klappt der Rest zu „+N".

Lebenszyklus hängt an `setupRealtime` ([`src/persistence.ts`](src/persistence.ts)):
Beim View-Wechsel wird die alte Presence abgemeldet und der Badge geleert, für
editierbare Quellen neu beigetreten. Gleiche Opt-in-Bedingung wie Realtime
(`VITE_SUPABASE_*`) — ohne die Vars bleibt der Badge aus.

Die eigene Identität kommt vom `GET /api/me`-Endpoint (das Session-Cookie ist
HttpOnly, der Client kennt sich sonst nicht): Netlify-Edge-Function
[`netlify/edge-functions/me.ts`](netlify/edge-functions/me.ts) liest die Session
(`{ email, name }`) hinter dem Auth-Gate; die Vite-Middleware liefert lokal
`{ email: 'local' }`. Ist keine Identität bekannt (ungegatete Site), trackt der
Client anonym als „Gast".

**Lokal testen:** ein `dev_user`-Cookie überschreibt die Dev-Identität
(`/api/me` in [`vite.config.ts`](vite.config.ts)) — sonst ist jeder Tab derselbe
„local"-User und damit für sich selbst unsichtbar. Pro Tab in der Konsole:
`document.cookie = 'dev_user=alice'; location.reload()`. Cookies gelten pro
Origin, nicht pro Tab, also zwei Browser-Profile/Fenster oder ein zweiter Client
(z.B. ein Node-Skript, das dem Presence-Channel beitritt) für zwei Identitäten
gleichzeitig. Nur Dev-Server; der Deploy leitet die Identität aus dem Session-
Cookie ab.

#### Presence pro Item (wer ist woran)

Zusätzlich zum Header-Badge markiert die **Timeline** das Item, das ein anderer
Nutzer gerade ausgewählt hat oder editiert — damit ein Doppel-Edit auffällt,
*bevor* der `409`/„extern geändert"-Hinweis kommt. Getragen wird das vom
**gleichen** Presence-Channel (kein zweiter Kanal, keine Tabelle, keine
Migration): der Payload trägt neben der Identität eine `PresenceActivity`
(`itemId` + `editing`, [`src/presenceModel.ts`](src/presenceModel.ts)).

- **Senden:** `joinPresence` gibt ein `PresenceHandle` zurück; `publishSelfPresence`
  ([`src/persistence.ts`](src/persistence.ts)) trägt über `setActivity` nach, welches
  Item wir belegen (offenes Formular, sonst die Timeline-Auswahl). Unveränderte
  Aktivität geht nicht auf den Kanal.
- **`editing` vs. ausgewählt:** auf einer editierbaren Quelle öffnet ein Klick
  sofort das Formular, „angeklickt" und „editiert" wären also dasselbe. Deshalb
  meldet `markSelfEditing` `editing` erst bei einer echten Änderung (Formular-
  Keystroke via `scheduleLiveEdit`, Drag/Resize via `handleMove`) und lässt es
  nach `EDITING_LINGER_MS` Ruhe wieder auf „ausgewählt" zurückfallen.
- **Rendern:** [`src/itemPresence.ts`](src/itemPresence.ts) schreibt Ring
  (`.has-remote-presence` / `.is-remote-editing`, gepulst) plus Avatar-Cluster
  direkt auf das vis-Item-Element — ein Kind von `.vis-item` wandert, scrollt und
  zoomt mit seinem Item mit, anders als ein absolut positioniertes Overlay
  (arrows.ts / phaseBand.ts) braucht es also kein Nachrechnen pro Frame. Was es
  braucht, ist ein Re-Apply, wenn vis Item-DOM neu mountet → `'changed'`-Hook in
  `attachItemPresence`. Clone-Ids einer umgruppierten Ansicht laufen über
  `realIdOf`. Der Cluster hängt an der **linken** Kante: die rechte liegt bei
  langen Balken oft außerhalb des Fensters.
- **Eigene Aktivität** wird nie markiert (die eigene Auswahl ist schon die
  vis-Selektion). Mehrere Einträge pro E-Mail kollabieren in `dedupeRoster` auf
  den **jüngsten** (`at`-Stempel im Payload), nicht auf den „spezifischsten".
  Das ist kein Detail, sondern die Korrektheitsbedingung: ein Presence-Channel
  hält pro Key mehrere Metas — eine pro Tab, aber auch die *überholten* Metas
  desselben Tabs, weil ein erneutes `track()` eine Meta hinzufügt statt sie zu
  ersetzen. Nach Spezifität sortiert gewinnt dann die veraltete (`editing`
  schlägt das frische `ausgewählt`, das sie ersetzt hat) und der Marker klebt für
  immer auf „editiert gerade".
- **Repaints laufen über einen Timer, nicht über `requestAnimationFrame`.** Ein
  Tab im Hintergrund feuert kein rAF mehr; eine noch offene Frame-Callback lässt
  das „ist schon geplant"-Flag stehen, und danach verwirft jeder weitere Sync
  seinen Repaint — der Tab friert auf dem letzten Stand ein, den er im
  Vordergrund gesehen hat. Timer laufen im Hintergrund weiter (nur gedrosselt).
- **Scope:** nur der Timeline-View (die Listenansicht hat keine Marker) und
  gleiche Opt-in-Bedingung wie Presence generell — realtime-only, `VITE_SUPABASE_*`.
  Die reine Logik (Rang, Dedupe, Bucketing pro Item) liegt DOM-frei in
  `presenceModel.ts` und ist in
  [`src/presenceModel.test.ts`](src/presenceModel.test.ts) getestet.

## MCP server (Claude Code)

Ein stdio-MCP-Server (`scripts/mcp/server.ts`) erlaubt Claude Code, die
DB-basierten Timelines auszulesen und zu manipulieren. Er arbeitet **immer
gegen die Live-Site** (`TIMELINES_LIVE_URL`, **erforderlich** — kein Default;
der Server bricht mit klarer Fehlermeldung ab, wenn die Var fehlt): jeder
Read/Write geht durch `/api/source(s)` → `timelines-api` Edge Function →
Supabase. Damit bleibt die DB Single Source of Truth und Änderungen sind sofort
live.

**Nur DB-basierte Timelines** sind exponiert. Datei-basierte Sources sind
auf der Live-Site read-only und daher nicht manipulierbar.

### Tools

| Tool                | Wirkung                                                        |
| ------------------- | ------------------------------------------------------------- |
| `list_timelines`    | listet alle DB-Timelines (id, name, description)              |
| `get_timeline`      | komplette Timeline (items + groups) per id                    |
| `add_item`          | Item anhängen (Pflicht: `start`, `content`)                   |
| `update_item`       | Item patchen (nur übergebene Felder; `metadata` wird gemergt) |
| `delete_item`       | Item per id entfernen                                         |
| `add_group`         | Group hinzufügen                                              |
| `update_group`      | Group patchen                                                 |
| `delete_group`      | Group entfernen                                               |
| `replace_timeline`  | ganze Timeline ersetzen (Bulk)                               |
| `set_pricing`       | Preismodell komplett ersetzen (Bulk-Seed; aktiviert automatisch das `product-roadmap`-Plugin) |
| `add_/update_/delete_feature` | einzelnes Pricing-Feature (granular)               |
| `move_feature`      | Feature umsortieren (nach/vor einem anderen Feature)         |
| `add_/update_/delete_tier`    | einzelnen Tarif (granular)                         |
| `set_tier_value`    | eine Matrix-Zelle (tier × feature); `false`/`null` löscht; opt. `availableFrom` (Zell-Verfügbarkeit ab Version) |
| `add_/update_/delete_highlight` | eine Card-Kachel (granular)                      |
| `set_versions`      | geordnete Versionsliste ersetzen                             |

Die granularen Item-/Group-Tools laufen read-modify-write: der Server holt die
Timeline, mutiert im Speicher und schreibt sie per PUT (Bulk-Replace) zurück.
`dependsOn` und `owner` liegen unter `metadata`. Die granularen **Pricing**-Tools
dagegen treffen direkt den jeweiligen Zeilen-Endpoint (kein read-modify-write,
kein Komplett-Dump) — Details unter „Pricing".

### Auth: Service-Token-Bypass

Der Server hängt an jeden Request den Header `X-MCP-Token: <MCP_API_TOKEN>`.
Die `timelines-api`-Edge-Function lässt Requests mit gültigem Token ohne
Google-Login durch (konstant-zeit-Vergleich) und greift serverseitig mit dem
Supabase-Service-Key auf die DB zu. MCP-Edits werden über `updated_by` als
`mcp` attribuiert.

### Konfiguration

Server-seitig (lokal, gelesen aus `process.env` → `~/_AGENTS/.env` →
`.env.local`):

| Var                  | Bedeutung                                                    |
| -------------------- | ----------------------------------------------------------- |
| `MCP_API_TOKEN`      | Bypass-Token, muss der Netlify-Env-Var entsprechen          |
| `TIMELINES_LIVE_URL` | Ziel-Site (**erforderlich**, z.B. `https://<site>.netlify.app`; kein Default) |

Registrierung als user-global MCP (aus jedem Verzeichnis nutzbar):

```bash
claude mcp add -s user timelines -- \
  <repo>/node_modules/.bin/tsx <repo>/scripts/mcp/server.ts
```

(oder direkt als `mcpServers.timelines`-Eintrag in `~/.claude.json`.)

### Netlify-Env (zusätzlich zu den Supabase-Vars)

| Var             | Where              | Notes                                                        |
| --------------- | ------------------ | ------------------------------------------------------------ |
| `MCP_API_TOKEN` | dashboard (secret) | aktiviert den Bypass; identisch mit dem lokalen Server-Token |

Voraussetzung: `TIMELINES_SUPABASE_URL` / `TIMELINES_SUPABASE_SERVICE_KEY` **und**
`AUTH_REQUIRED=true` müssen gesetzt sein (sonst greift `timelines-api` nicht). Ist
`MCP_API_TOKEN` nicht gesetzt, ist der Bypass inaktiv und der Server bleibt für
Menschen per Google-Login gated.

## Editing JSON timelines

When the active view points to a **DB-backed** source (the timeline exists in Supabase, so `GET /api/source/<id>` returns it), the viewer is editable. File-only sources load read-only.

- **Drag** an item left/right to move start, drag the right edge to resize, drag vertically to switch group. Persists on drop. On a selected bar the resize handle sits just inside the rail (see „Item rail"), not right at the edge.
- **Delete** an item via the „×" mark at the bar's right edge, which appears on hover and while the item is selected — inside the bar on a bar wide enough for it, just outside on a narrow one. Clicking it neither selects the item nor opens its form. See „Item rail".
- **Right-click** an item for quick actions without opening the form: set the
  status, set any custom field that declared `contextMenu: true` (each a submenu of
  its options), duplicate the item, delete it. Read-only views keep the browser's
  own menu. See „Item context menu".
- **Double-click** on empty timeline space to add a new item (defaults: 1-week duration, current group, content "Neuer Eintrag"). Form opens for further edits. The **+ Eintrag** toolbar button (editable views only) does the same, placing the item at the centre of the visible window. In **list mode** a new item (toolbar or per-section button) is created **date-less** — empty start/end/duration — so it starts as a clean row to fill in via the form; it stays list-only until a start is set.
- **Click** an item to open the edit form in the side panel. The title is edited
  in the panel headline and the icon/type/status trio sits in the header row above
  it (both outside the tabs, see below); the remaining fields are split across
  three tabs ([`src/itemForm.ts`](src/itemForm.ts), `FORM_TABS`), with the Delete
  button + audit footer below the tabstrip so they stay reachable from any tab:
  - **Date & Time** — start, end, duration (a Meilenstein has no extent, so
    picking that type mutes end/duration).
  - **Properties** — group, owner, body (Markdown), tags, and the per-timeline
    custom fields. The free-form metadata JSON box sits behind an „Erweitert"
    `<details>` disclosure, collapsed unless the item actually carries extra
    metadata.
  - **Relationships** — dependencies (`dependsOn`) and JIRA links.

  All panels stay in the DOM (inactive ones just `hidden`), so `FormData` keeps
  seeing every field and `applyItemForm` / the persist diff need no knowledge of
  the tabs. The chosen tab is remembered across item switches (module-level
  `activeFormTab`, not persisted across reloads). Save writes back; Delete removes
  the item.

  **The panel headline IS the title editor.** The form used to repeat the title
  in a labelled input directly under the heading — the same string twice, one of
  them costing a row. The `<h2>` is now `contenteditable` for an editable item
  (`setDetailTitle` / `focusDetailTitle` in
  [`src/detailPanel.ts`](src/detailPanel.ts), the single entry point every panel
  uses for the headline, so a read-only note or a phase form resets the editable
  state). The form keeps a hidden `content` input, so `applyItemForm` and the
  persist diff read the title out of `FormData` unchanged; typing writes into it
  and dispatches a bubbling `input`. Enter and Escape blur (a title is one line),
  and because the headline sits outside the form its `blur` commits explicitly —
  the form's own `focusout` never fires for it.

  Two headline entry points, and the distinction matters: `setDetailTitle` is for
  **switching what the panel shows** (it also resets the editable state and
  clears the header tools row), `setDetailTitleText` is for **syncing the caption
  during an edit** (text only, and a no-op while the headline has focus — setting
  `textContent` under the caret would throw it back to the start of the line).
  Routing the in-edit sync through `setDetailTitle` wiped the picker row on every
  keystroke, and since the pickers own form-associated hidden inputs, `FormData`
  then lost `icon` / `type` / `status` and the next edit reset the status to its
  default. `applyItemForm` therefore also only touches those three when
  `fd.has(...)` — a missing key means "control not in the DOM", not "user cleared
  the field".

  **Icon, type and status share one control** (`PickerSpec` / `pickerHtml` /
  `wirePicker` in [`src/itemForm.ts`](src/itemForm.ts)): all three are "pick one
  value from a small fixed set", and as labelled `<select>`s they cost a full
  field row each while showing German words for something visual. Each is now a
  30px trigger button displaying the current value's **mark** — the icon glyph,
  the temporal shape (diamond = Meilenstein, bar = Zeitraum, dashed band =
  Phase), the status colour dot — that opens a popover with the choices (a
  mark-only grid for the 19 icons, mark + label rows for type and status).
  Adding a fourth such field is a new `PickerSpec` plus a `wirePicker` call.

  The trio lives in the **panel header** (`#detail-tools`, filled by
  `renderPickerTools`, laid out in [`src/styles/detail.css`](src/styles/detail.css)),
  on the close button's line and above the headline: it costs the form no row,
  sits outside the tabs, and the sticky header keeps it in place while the body
  scrolls. That puts it *outside* the `<form>`, which makes two details load-
  bearing: each hidden input carries `form="item-form"` (a form-attribute-
  associated control is still part of `FormData`, so `applyItemForm` keeps
  reading `status` / `icon` / `type` exactly as it did with the selects), and
  picking calls `scheduleLiveEdit()` directly — an event dispatched in the header
  bubbles up the header, never reaching the form's listener.

  **Panel height is the scarce resource** in this form, so it is spent on fewer
  rows rather than on tighter ones: the rows that remain are deliberately airy
  (16px between fields, 4px between a label and its own control — the air goes
  *between* fields, not inside them), and the height comes back by removing
  fields instead. Every chip field (tags, custom multi-selects,
  dependencies, JIRA) renders its chips and its search input inside **one**
  bordered `.chip-box` that reads as a single control
  ([`src/styles/chips.css`](src/styles/chips.css)) — that frees a row per field
  and lets a chip field sit at half width beside another one. **Tags spans the
  full width** (`.field.full`) even so: a chip row fills up fast, and at half
  width it wrapped into a second line after two or three tags, costing back the
  row the `.chip-box` had just saved. Custom multi-selects stay at half width.
  The Markdown body
  grows from a low floor instead of reserving a screenful
  ([`src/styles/wysiwyg.css`](src/styles/wysiwyg.css)), and the read-only item
  **id** lives in the audit footer (`auditBlockHtml`) instead of a labelled
  input, being metadata of the same category as the created/updated rows. Unlike
  those rows the id renders in every environment, not only on localhost.

  **Focus tints, it does not frame.** Focusing a field, a chip box, the body
  editor or the headline recolours its border (the headline: a background tint)
  instead of drawing the former 2px accent ring, which read as a heavy frame
  around everything you touched. Buttons — tabs, pickers — keep a real ring, but
  only on `:focus-visible`, where there is no border to recolour.
- **Depends on** is a title-autosuggest field: type to search the current timeline's items by title (or id), pick to link a dependency (rendered as a removable chip). Stored as `metadata.dependsOn` IDs — the chips just show the target's title.
- **Tags** is a chip editor with autosuggest: type to match tags already used in the timeline, or type a new label and press Enter to create one. Each chip carries its resolved colour and a remove button. Stored as `metadata.tags` (string[]); saving migrates any legacy singular `metadata.tag` into the array.
- **Phases** render as a ribbon along the top. Drag a segment to move it, drag either edge to resize (snaps to whole days, min. 1 day), and click it (without dragging) to open the phase form in the side panel: title, start/end, duration, icon, colour. Persists on drop / Save; Delete removes the phase.

Persistence path: viewer → item-level calls (`POST/PATCH/DELETE /api/source/<id>/item`, `PUT …/phases`) → middleware (`vite.config.ts`) → Supabase via `scripts/db/api.ts`. `PATCH` carries the item `version` in `If-Match`; a stale version returns `409` and the client reloads that item. Only DB-backed sources are editable; genuine file-based sources (the examples) load read-only from their static `/data/sources/<id>.json`. Builds (`npm run build`) and exported HTML have no edit endpoint. DB-backed timelines are discovered from the DB at build time (`collectDbSources`); the registration **stub** (`name` + `items: []`, no content) is written only to the gitignored build output `public/data/sources/<id>.json` — nothing DB-backed is committed, and there is deliberately no committed content cache (see „Prinzip: keine Notfall-/Fallback-Daten").

## JIRA linking

The edit form has a **JIRA** field for linking issues to an item. Type two or
more characters to get an autosuggest dropdown (live query against JIRA Cloud's
issue picker); pick a suggestion or paste a key like `PROJ-123` and press Enter.
Linked issues render as removable chips, and the detail panel (live, exported,
and read-only Netlify) shows them as clickable `…/browse/<KEY>` links.

Links are stored per item in `metadata.jira` as `[{ "key": "PROJ-123",
"summary": "…" }]` — the summary is cached so links stay readable without a live
JIRA call. Because it lives in `metadata`, it round-trips through the
`timeline_items.metadata` jsonb column unchanged.

**How the autosuggest is served:**

- **Locally:** Vite dev middleware `GET /api/jira/search?q=` (in `vite.config.ts`)
  proxies the issue picker. Credentials come from `process.env`, then
  `~/_AGENTS/.env`, then `.env.local` (all gitignored): `JIRA_BASE_URL`,
  `JIRA_EMAIL`, `JIRA_API_TOKEN` (Atlassian API token). Without them the field
  still works for pasting raw keys — only the live search is disabled.
- **Production (Netlify):** the `jira-api` Edge Function
  (`netlify/edge-functions/jira-api.ts`) proxies the same picker behind the
  auth gate, using a shared service-account token. Activated by
  `JIRA_ENABLED=true` plus `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`
  (runtime-only env vars in the dashboard — the token is a secret).

The picker-response parsing is shared by both runtimes in
`scripts/jira/picker.ts`. Browse-link rendering uses the public, build-time
`VITE_JIRA_BASE_URL` (empty by default → keys render as plain text).

## View modes: Timeline / Liste

The header **Ansicht** icon toggle (a segmented two-button control, styled in
[`src/styles/base.css`](src/styles/base.css) as `.mode-toggle` / `.mode-btn`,
active state driven by `aria-pressed`) switches between two renderings of the
*same* active build:

- **Timeline** — the vis-timeline (default).
- **Liste** — a scrollable, grouped table ([`src/listView.ts`](src/listView.ts)):
  sections along the active **grouping dimension** (items sorted by start),
  with columns Eintrag (icon + tag pills + content), Start, Ende, Typ, Status,
  Owner. Phase background items are omitted. The milestones-only filter applies
  here too.

### Shared toolbar: Gruppieren + Filter

A single toolbar (`#view-toolbar`, styled `.view-toolbar` in
[`src/styles/base.css`](src/styles/base.css)) sits above **both** the timeline
and the list (in the shared `.content-area` column, left of the detail panel)
and is identical in either mode — hidden only in the pricing view. It holds two
controls that drive both views from one shared state; the app-state-aware glue
lives in [`src/grouping.ts`](src/grouping.ts), the pure sectioning stays in
[`src/listGrouping.ts`](src/listGrouping.ts) (`computeSections`, unit-tested in
`src/listGrouping.test.ts`).

- **Gruppieren** (`#groupby`, `state.groupBy`, persisted as
  `timelines.listGroupBy`) chooses the dimension: **Gruppe** (default, the item
  group — build order preserved), **Tag** (offered when anything is tagged, from
  `metadata.tags`), and one entry per **custom field** (e.g. **Tier**, from
  `metadata.<key>`). Multi-valued dimensions (tags, `multi-select` fields) place
  an item under *every* value it carries; items without a value land in an
  "Ohne …" bucket. Custom-field order follows the declared `options` first, then
  first appearance. Falls back to Gruppe when the chosen dimension isn't
  available on the active build.

  In the **list** these are the table sections. In the **timeline** they are the
  vis lanes: for a non-Gruppe dimension the build is *regrouped*
  (`regroupForTimeline` in `grouping.ts`) into one lane per value, and a
  multi-valued item is **cloned into each lane** (the first clone keeps the real
  id; extras get a `<id>␟<n>` id). Display↔real id maps
  ([`src/render.ts`](src/render.ts)) map a clicked/dragged clone back to its real
  item and highlight all clones of a selection at once. While regrouped, the
  lanes are derived values, so vertical group-drag (`updateGroup`),
  double-click-add and dependency arrows are suppressed; horizontal move, resize,
  delete and click-to-edit keep working on the real item. Lane assignment
  (`assignLaneSubgroups`/`assignLanes`) and repacking run on this display set.

- **Filter** ([`src/filterControl.ts`](src/filterControl.ts)) narrows the visible
  items. It is **independent** of grouping: a dimension `<select>` (`#filter-dim`,
  same categories as Gruppieren, plus an "Aus" option) selects *what* to filter
  on, and a popover checklist (`#filter-menu`) of that dimension's values selects
  *which* to keep. An item passes if it carries a selected value (the "Ohne …"
  bucket, `NO_BUCKET`, is selectable to keep value-less items); an **empty
  selection means no restriction**. Persisted as `timelines.filterDim` /
  `timelines.filterValues`; a persisted dimension that no longer exists turns the
  filter off. The filtering itself lives in `filterBuildForDisplay`
  ([`src/render.ts`](src/render.ts)) via `passesFilter`, so every consumer
  (timeline, list, export, status line) honours it from one place, composed with
  the milestones-only toggle; empty lanes are pruned once by `pruneGroupsToItems`.

The per-section "+ Eintrag" button (list) shows only in the Gruppe dimension (it
pins the new item to that group).

Both modes share all state and machinery: the timeline instance stays alive
(just hidden) in list mode, so drags, the detail/edit form, and persistence keep
working. Clicking a row opens the same detail panel (or edit form on editable
sources), tracks the selection, and highlights the row — identical to selecting
a timeline item. Edits (form, add, delete) repaint the list live via
`applyBuildToDataSets`. The mode persists in `localStorage`
(`timelines.viewMode`) and in the URL hash (`mode=list`), so list views can be
deep-linked and survive reload.

## URL state

Selected view, opened item, visible time window, milestones-only filter, and the
view mode are encoded in the location hash so links can be shared and
back/forward navigation works. Format:

```
#view=<id>&item=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&m=1&mode=list
```

Only non-default values are written (`mode` only when `list`). Switching views
via the dropdown clears `item` and `from`/`to`. Hash changes from outside the
app (paste, back/forward) re-apply state without reload.

## Configuration: `timelines.config.json`

```jsonc
{
  "notesDir": "~/notes",
  "defaultView": "all",
  "dateFields": ["date", "scheduled", "created"],
  "filenameDatePatterns": ["^(\\d{4})-(\\d{2})-(\\d{2})", "^(\\d{4})(\\d{2})(\\d{2})"],
  "views": [
    {
      "id": "kurzbeitraege",
      "name": "Kurzbeiträge",
      "filter": { "filenameContains": "Kurzbeitrag" },
      "dateFields": ["scheduled", "date", "created"],
      "groupBy": "status"
    }
  ]
}
```

`notesDir` is the directory scanned for Markdown notes. The env var
**`TIMELINES_NOTES_DIR`** overrides the committed `notesDir` (same `~` expansion),
so a checkout can point at its own notes without editing the tracked config —
e.g. set `TIMELINES_NOTES_DIR=~/_NOTIZEN` in `~/_AGENTS/.env` / `.env.local`. If
the resolved directory does not exist, the build **warns and proceeds with zero
notes** (standalone/DB sources still build); it does not fail. In
`TIMELINES_STATIC_ONLY` mode the notes scan is skipped entirely.

### Filter clauses

| Key                 | Type                 | Effect                                            |
| ------------------- | -------------------- | ------------------------------------------------- |
| `filenameContains`  | string               | substring match on filename                       |
| `folder`            | string \| string[]   | folder path (or prefix) match                     |
| `status`            | string \| string[]   | match against `status` frontmatter                |
| `categories`        | string \| string[]   | intersect with `categories` frontmatter           |
| `tags`              | string \| string[]   | intersect with `tags` frontmatter                 |
| `draft`             | boolean              | match `draft: true/false`                         |
| `has`               | string \| string[]   | require frontmatter keys to be set                |
| `allOf` / `anyOf`   | FilterClause[]       | logical combinators                               |
| `not`               | FilterClause         | negation                                          |

### Grouping

`groupBy` is a frontmatter expression: `categories[0]`, `status`, `folder`, `topics[0]`, `tags[0]`. Notes without that field land in an `_ungrouped` bucket.

## Dev / Build

```bash
npm install
npm run dev     # build data + Vite + chokidar watcher on ~/_NOTIZEN
npm run build   # static dist
```

`npm run dev` rebuilds `notes.json` whenever a Markdown file changes.

## Theming

The viewer ships a single neutral theme defined as CSS custom properties in the
`:root` block of [`src/styles/theme.css`](src/styles/theme.css):

- colour tokens (bg, fg, accent, item-bg, item-border, lane colours, …)
- typography (`--font-body` / `--font-headline` / `--font-mono`)
- mark radius (`--mark-radius`)

To recolour or re-type the viewer, override any of these variables in your own
stylesheet loaded after `theme.css`. There is no runtime brand selector and no
build flag: the tokens in `theme.css` are the single styling seam.

## Deploy: Netlify

A stripped-down static deploy runs on Netlify. Config-as-code lives in
[`netlify.toml`](netlify.toml); instance-specific values and secrets go in the
Netlify dashboard (Site settings → Environment variables).

### What gets deployed

- **File sources:** committed `data/*.json`, scoped to `data/<subdir>/` when
  `TIMELINES_SOURCES_SUBDIR` is set (dashboard).
- **DB timelines:** discovered from the DB at build time (`collectDbSources`),
  scoped by the same `TIMELINES_SOURCES_SUBDIR` used as an **id namespace prefix**
  (e.g. subdir `acme` → all `acme/…` timelines). No committed stubs; if the build
  can reach the DB but the list query fails, the build fails loudly.
- Notes scan disabled (`TIMELINES_STATIC_ONLY=true`); no Markdown-driven views.
- **Editing** is live when the Supabase env vars are set (see „Supabase als
  Datenquelle → Production-Setup"): the `timelines-api` edge function serves
  DB-backed timelines editable. Without those vars, the DB read fails and the
  viewer surfaces an error — there is no static content fallback (see „Prinzip:
  keine Notfall-/Fallback-Daten").

To add a deploy-visible file source: drop the JSON into the scanned `data/`
folder, commit, push. DB timelines appear automatically once they exist in the DB
under the deploy's namespace.

### Auth gate (Netlify Edge Function)

[`netlify/edge-functions/auth.ts`](netlify/edge-functions/auth.ts) gates every
request with Google OAuth restricted to an allowed-domain whitelist, adapted to a
static Vite site:

1. `/auth/login` → redirect to Google with `hd=<allowed domain>`, signed state cookie.
2. `/auth/callback` → token exchange → `userinfo` → domain check → signed
   session cookie (HMAC-SHA256, `HttpOnly; Secure; SameSite=Lax`).
3. Any other page navigation without a valid session → 302 to
   `/auth/login?redirect=…`; an `/api/*` call without a valid session → `401`
   JSON (`{ "error": "session_expired" }`) so the SPA fails loud instead of the
   fetch chasing a cross-origin login redirect and the edit silently vanishing.
   The client (`apiJson` / `loadSource` in [`src/editor.ts`](src/editor.ts))
   catches the `401` and sends the top window to the login, preserving the view.

**Sliding session (no silent expiry).** The session cookie is **not** a fixed
one-shot token. Its base lifetime is 30 days (`SESSION_MAX_AGE` in
[`_shared/session.ts`](netlify/edge-functions/_shared/session.ts)), but the gate
re-issues the cookie with a fresh expiry whenever an authenticated request lands
in the **second half** of its life (`SESSION_RENEW_THRESHOLD`, via `ctx.next()`
on the way out). An actively used session is therefore continually topped up and
never expires from under the user; the 30-day base only bites after a genuine
stretch of inactivity. This replaced the old fixed 24 h token, which logged
active users out mid-edit exactly 24 h after login.

Set `AUTH_REQUIRED=true` in the Netlify dashboard to activate the gate; leave
unset/`false` for local previews. Required runtime env vars:

| Var                     | Where                  | Notes                                            |
| ----------------------- | ---------------------- | ------------------------------------------------ |
| `AUTH_REQUIRED`         | dashboard              | `true` to gate the site                          |
| `GOOGLE_CLIENT_ID`      | dashboard              | OAuth web client                                 |
| `GOOGLE_CLIENT_SECRET`  | dashboard (secret)     | OAuth client secret                              |
| `AUTH_SECRET`           | dashboard (secret)     | `openssl rand -base64 32`                        |
| `ALLOWED_EMAIL_DOMAINS` | dashboard              | comma-separated allowed sign-in domains; code default empty (fail-closed). Set your own; the auth edge function reads it at runtime, so it must be a runtime env var (not just build-time in `netlify.toml`) |

### Google OAuth setup (one-time)

1. Google Cloud Console → APIs & Services → Credentials → **Create credentials → OAuth client ID** → Web application.
2. Authorized redirect URIs: `https://<your-netlify-site>.netlify.app/auth/callback` (and any custom domain).
3. Authorized JavaScript origins: the same origins without the path.
4. Paste the client ID and secret into Netlify env vars.

If the site moves to a new domain, add the new redirect URI in the Google
Cloud Console — otherwise the callback returns `redirect_uri_mismatch`.

## Pricing

> Der **Client**-Code des Preismodells (Matrix, Cards, Feature-Formular) lebt als
> Timeline-Kind unter [`src/kinds/product-roadmap/`](src/kinds/product-roadmap/)
> und wird lazy geladen (siehe „Timeline kinds"). Der Server-Teil (Tabellen,
> `assemblePricing`, `pricing-api`, MCP-Tools) bleibt wie unten beschrieben.

Das Preismodell (Tarife + Features, nur product-roadmap-Timelines) ist die SSOT
für externe Preisseiten. Es liegt **normalisiert** in eigenen Tabellen (Migration
`0009`, siehe „Schema"): `pricing_features`, `pricing_tiers`,
`pricing_tier_values` (die Matrix, zell-granular), `pricing_highlights`, plus die
geordnete Versionsliste in `timeline_plugins.config.versions` des
`product-roadmap`-Eintrags (früher die `timelines.pricing_versions`-Spalte, seit
Migration `0012`/`0013`, siehe „Plugin-Registry"). Der Server assembliert daraus
die unten beschriebene `Pricing`-Shape
(`assemblePricing` in [`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts)) —
der Viewer und der Markdown-Export sehen sie unverändert.

Lesen: Viewer über `GET /api/source/<id>` (assembliert, inkl. `rowVersion` je
Entität), externe Seiten über `GET /api/pricing/<id>` (öffentlich, `rowVersion`
gestrippt). Markdown-Spiegel: `npm run export:pricing`.

**Schreiben — granular, kollisionsfrei** (die alte „ganzes Modell ersetzen"-
Semantik ist weg; genau sie führte zu Überschreibungen bei parallelen Edits):
- Endpoints unter `/api/source/<id>/`: `feature[/<id>]`, `tier[/<id>]`,
  `tier-value` (PUT `{tierId, featureId, value, availableFrom?}`; `value=false/null`
  löscht die Zelle; `availableFrom` = Version-Label ab dem die Zelle gilt, sonst
  ab Start), `highlight[/<id>]` (je POST/PATCH/DELETE), `pversion` (PUT der ganzen
  Versionsliste, wie `phases`), und `pricing` (PUT — Bulk-Ersatz zum Seeden).
  PATCH trägt die `rowVersion` im `If-Match`-Header → `409` bei Stale.
  **Wichtig:** die Lock-Version kommt bei Features **nur** aus `If-Match`, nie aus
  `body.version` (dort ist `version` das Domänenfeld „ab Version").
- MCP: granulare Tools `add_/update_/delete_feature`, `move_feature`, `…_tier`,
  `set_tier_value`, `…_highlight`, `set_versions` (je ein Call, kein
  read-modify-write, kein Komplett-Dump im Kontext). `set_pricing` bleibt als
  Bulk-Seed/Rewrite.
- **Feature-Reihenfolge** (`sort`-Spalte): `add_feature` hängt immer ans
  Gruppenende. Zum präzisen Platzieren `POST …/feature-move {featureId, after? |
  before?}` (MCP: `move_feature`) — genau ein Anker, `after` gewinnt bei beidem.
  Der Server lädt die aktuelle Reihenfolge, positioniert relativ zum Anker um
  (`reorderIds`, rein + getestet) und nummeriert `sort` neu (nur geänderte
  Zeilen). `sort` ist sonst über keinen anderen Schreibpfad exponiert; ein
  Feature behält dabei seine `group` (Gruppe wechseln → `update_feature`).
- Client: das Feature-Formular schreibt granular per `PATCH …/feature/<id>` mit
  `If-Match`; Tiers/Matrix/Highlights/Versionen/Reihenfolge werden aktuell über
  MCP gepflegt.

Shape (assembliert):
- `features[]`: `{ id, name, group, version?, description?, nameByVersion?, descriptionByVersion?, rowVersion? }`.
  `version` = ab welcher getrackten Version verfügbar (DB-Spalte `available_from`).
  **Kein `version` = pre-existing** (existierte vor der ersten Version) → immer
  sichtbar, nie „Neu", aber „Modified"-fähig. `feature.version` auf die Baseline
  (`versions[0]`) zu setzen bedeutet „in dieser Version eingeführt" — NICHT „schon
  immer da"; dafür `version` weglassen.
  - `nameByVersion` (`Record<version, string>`, DB-Spalte `name_by_version`):
    versionsabhängige Namens-*Überschreibung*, **kumulativ** aufgelöst (neuester
    Override ≤ gewählte Version gewinnt) — `resolveFeatureName`.
  - `descriptionByVersion` (`Record<version, string>`, DB-Spalte
    `description_by_version`): zusätzliche, versionsgebundene Beschreibungen **on
    top of** `description`. Im Gegensatz zu `nameByVersion` **additiv** (kein
    Override): die Basis-`description` bleibt, jede Notiz erscheint als eigene
    Zeile „ab \<version\>: …" in Versionsreihenfolge — `resolveFeatureDescription`
    ([`src/pricing.ts`](src/pricing.ts)). Matrix-Tooltip hinter einem **Info-Icon**,
    editierbar im Feature-Formular über „+ Versionsbeschreibung".
  - `rowVersion` = server-verwalteter Lock-Zähler (nicht editieren; im
    Public-Output gestrippt).
- `tiers[]`: `{ id, name, tagline?, useCase?, targetGroup?, price, values, valueVersions?, rowVersion? }`.
  `values[featureId]` = `true` (✓) / fehlt|false (–) / String (Wert je Tarif).
  Falsy/leere Zellen werden nicht gespeichert (rendern ohnehin als „–").
  `valueVersions[featureId]` (DB-Spalte `pricing_tier_values.available_from`) =
  optionale Zell-**Verfügbarkeit ab Version**: die Zelle zählt erst ab diesem
  Label als enthalten, davor „–" (kumulativ, `cellActiveForVersion` in
  [`src/pricing.ts`](src/pricing.ts)). `values` bleibt der Endzustand — die Map
  gated nur *wann* er erscheint (Geschwister von `values`, additiv). In „Alle"
  zeigt die Matrix den Endzustand + dezenten „ab \<version\>"-Chip in der Zelle;
  bei gepinnter Version trägt das Erscheinen/„–" selbst die Info. Kein Key =
  ab Start (unverändertes Verhalten). Siehe „Zell-Versionierung" unten.
- `highlights[]`: `{ id, label, section?, featureIds, rowVersion? }` — kuratierte
  Kacheln der Card-Ansicht (bündeln Features); nur was hier referenziert wird,
  erscheint auf den Karten. Matrix zeigt alle Features.
- `versions[]`: geordnete Labels; Switcher filtert Feature-Zeilen kumulativ.

Item↔Feature: `metadata.featureIds` (n:m) + `metadata.featureVersion` (die Version,
für die gearbeitet wird) + `status` (Open/Doing/Done) → speisen den Arbeits-Punkt
und die Zeilen-Badges:
- **„Neu"**: `feature.version` == gepinnte Version (nicht „Alle"). Gilt auch für
  die Baseline (`versions[0]`): ein dort eingeführtes Feature badged „Neu", wenn
  die Baseline gepinnt ist — pre-existing (kein `version`) badged nie.
- **„Modified"**: Feature ist älter als die gepinnte Version (inkl. pre-existing)
  UND diese Version brachte eine Änderung — entweder ein Item mit diesem Feature +
  `featureVersion` == gepinnte Version, ODER eine Versionsbeschreibung für die
  gepinnte Version (`descriptionByVersion[gepinnte Version]`). Letzteres badged
  auch ohne Work-Item. Schließt „Neu" aus; nur bei gepinnter Version.
- **„ab \<Version\>"**: nur in der „Alle"-Ansicht (keine Version gepinnt, wo „Neu"/
  „Modified" nie feuern). Neutrale Chip, die angibt, ab welcher Version das Feature
  bzw. Highlight dazukam. Matrix: pro Feature mit `version`. Kacheln: pro Highlight
  die früheste `version` seiner beitragenden Features (`introducedVersion` in
  `resolveHighlight`); ein pre-existing Feature im Bündel unterdrückt die Chip.
  Pre-existing Features (kein `version`) bekommen nie eine Chip.

### Zell-Versionierung (Tarif×Feature-Verfügbarkeit ab Version)

Während `feature.version` steuert, ab wann ein Feature (die ganze Zeile)
existiert, steuert `tier.valueVersions[featureId]` (DB:
`pricing_tier_values.available_from`), ab wann eine **einzelne Zelle** als
enthalten gilt. Damit lässt sich „Feature X ist in Enterprise sofort, in Scale
erst ab v4" abbilden, ohne die ganze Feature-Zeile zu gaten.

- **Auflösung** — `cellActiveForVersion(availableFrom, versions, selected)` in
  [`src/pricing.ts`](src/pricing.ts), kumulativ und formgleich zu
  `featureVisibleForVersion`: „Alle" → immer aktiv; kein `availableFrom` → ab
  Start aktiv; sonst aktiv sobald die gepinnte Version ≥ `availableFrom`. Vor der
  Version rendert die Zelle als „–", der gespeicherte `value` bleibt der
  Endzustand.
- **Matrix** ([`src/pricingMatrix.ts`](src/pricingMatrix.ts)): gepinnt → Zelle
  erscheint/„–" (das trägt die Info selbst); „Alle" → Endzustand + dezenter
  „ab \<version\>"-Chip (`.pm-cell-ver`) in der Zelle.
- **Kacheln** (`resolveHighlight`): eine noch nicht verfügbare Zelle zählt für
  den Tarif nicht als enthalten; die effektive Einführungsversion des Highlights
  je Tarif ist `valueVersions[fid] ?? feature.version` (die Zell-Gate gewinnt),
  speist `isNew` und die „ab"-Chip.
- **Schreiben** — `set_tier_value(..., availableFrom)` (MCP) bzw.
  `PUT …/tier-value {availableFrom}`; beim Löschen der Zelle verschwindet die
  Gate mit. Round-Trip getestet in
  [`src/pricingNormalize.test.ts`](src/pricingNormalize.test.ts), Gating-Logik in
  [`src/pricing.test.ts`](src/pricing.test.ts).

## Offene Ausbaustufen – Preismodell / Kacheln

Noch nicht im Datenmodell abgebildet (aus dem Original-Preismodell), als Backlog:

- Minutenpreis (€/Min) je Tarif als eigenes Feld — aktuell nur `Overage` als Feature-Wert.
- Enterprise-Minutenpakete (S/M/L/Custom mit Staffelpreisen).
- GTM-/Strategie-Daten (a competitor-Äquivalent, Ersparnis vs. a competitor, GTM Product-/Sales-Led, Upgrade-Trigger).
- `highlight.icon` ist im Schema vorhanden, aber ungenutzt (keine Icons je Kachel).

Bekanntes Verhalten: Wert-Highlights (z.B. „Charaktere") erscheinen auf jeder
Tarif-Karte (Wert variiert je Tarif) → der Arbeits-Punkt wiederholt sich dort.

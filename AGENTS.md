# Ganttry

Generic timeline viewer. Reads frontmatter dates from a notes directory of Markdown files (configurable via `notesDir` / `TIMELINES_NOTES_DIR`), builds timelines via [vis-timeline](https://visjs.github.io/vis-timeline/), and ships a single neutral theme themeable through CSS custom properties.

## The name covers the product, not its vocabulary or its instances

**Ganttry** is the product (`ganttry.dev`, which forwards here; dev domain
`ganttry.localhost`). Three families of `timeline(s)` are deliberately left
alone, and a sweep that "finishes the rename" breaks all three:

- **Domain vocabulary.** A timeline is still called a timeline: the tables
  `timelines` / `timeline_items`, types like `TimelineFile`, `vis-timeline`, the
  Timeline view. That is the noun the product operates on, so renaming it would
  cost a schema migration and buy nothing.
- **Deployment identity.** An instance carries its own name. Acme runs one at
  `timelines.example.com`, so the Netlify site, the `timelines-api` /
  `pricing-api` edge functions, the `TIMELINES_*` env vars and the MCP URL keep
  saying `timelines`. Renaming the env vars means editing the Netlify dashboard
  and every `.env` in lockstep; a half-applied rename takes DB access down (it
  fails loudly by design, see „Principle: no emergency or fallback data").
- **Applied migrations.** `supabase/migrations/*.sql` are checksummed by
  `db:migrate`; editing even a comment in one raises a drift warning.

`localStorage` keys (`timelines.viewMode` and its siblings) also still carry the
old prefix. Renaming them without a read-both migration silently resets every
user's saved view, grouping and filter state.

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
3120 — **never stop PM2** to free 3120 (that tears down `ganttry.localhost` for
every other session). Details: „Ports → Worktree live preview". Alternatively
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
own tracker (<https://github.com/dermellor/ganttry/issues>); reference them from
the closing commit with `Closes #NN`.

### 4. Guard against foreign in-flight work

At the start of a change-session, check `git status`. If it already contains
uncommitted changes you did not create, another session owns them — do not build on
top of or commit them blindly. Surface them and either work in a fresh worktree off
`origin/main` (per the base invariant — never off a possibly-stale local `HEAD`)
or coordinate before touching shared files.

## Ports

This project owns the 3120 block. The port convention itself is a local
development-environment concern, not a property of the project: it exists so
several projects can run side by side on one machine.

| Port          | Service                                                    |
| ------------- | ---------------------------------------------------------- |
| 3120          | Vite dev server (timeline UI) — main checkout, run by PM2   |
| 31200–31209   | Vite dev server for worktree live previews (pool)          |

URLs:

- `https://ganttry.localhost` — primary entry through Caddy (HTTPS, managed by PM2)
- `http://localhost:3120` — Vite directly (main checkout, run by PM2)
- `http://localhost:31200` … `31209` — worktree previews (see below)

Crashes on a port conflict (`strictPort: true`); there is no auto-fallback.

### Worktree live preview (pool 31200–31209): never stop PM2

The PM2-managed dev server on 3120 runs from the **main checkout** and does not
see worktree edits (see the „Live-preview caveat" above). To watch changes from a
worktree, **never stop PM2** — that tears down `ganttry.localhost` for every
other session. Start the worktree's own server on a five-digit preview port
instead, so PM2 keeps serving 3120 alongside it:

```bash
npm run dev:worktree                # default port 31200
WT_PORT=31201 npm run dev:worktree  # a second worktree in parallel, and so on
```

The preview ports live deliberately **outside** the narrow 3120 block, in a
five-digit pool **31200–31209** (derived: `3120` → `31200` + index), so any
number of worktrees can run at once without blocking each other or other
services. The default is 31200; count `WT_PORT` up for further parallel
previews. The script deliberately skips `dev-prep.sh`, so it does not kill the
process on 3120. In Claude Code the matching launch configs are `vite-worktree`
(31200), `vite-worktree-2` (31201) and `vite-worktree-3` (31202) in
`.claude/launch.json`. The rule: **worktree previews always on 31200+, PM2 on
3120, never the other way around.**

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
snapshot (see „Principle: no emergency or fallback data"). The kind is set at build
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
behind that one adapter, selected by env (see „Postgres as the data source →
Drivers"): supabase-js (the Netlify default) and native postgres.js (opt-in).
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
- **`product-roadmap`** — the pricing matrix/cards plus the matrix's own editors,
  living entirely under [`src/kinds/product-roadmap/`](src/kinds/product-roadmap/)
  (`pricing.ts`, `pricingCards.ts`, `pricingMatrix.ts`, `pricingWork.ts`,
  `featureForm.ts`, `tierForm.ts`, `cellEditor.ts`, `popover.ts`, `fields.ts`,
  `index.ts`).

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
- The pricing `api*` wrappers stay in [`src/editor.ts`](src/editor.ts) —
  `apiAddFeature`/`apiUpdateFeature`/`apiDeleteFeature`/`apiMoveFeature`,
  `apiAddTier`/`apiUpdateTier`/`apiDeleteTier`, `apiSetTierValue`: type-only-typed
  fetch wrappers, so the generic entry chunk carries their URL fragments
  (`/feature/`, `/tier/`, `/tier-value`) and nothing else. The acceptance check is
  about the pricing *view* code — `pm-cell-ver`, `pm-cell-editable`,
  `pricing-badge-new`, `pc-card` are all absent from the entry chunk.
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
      "end": "2026-02-28",               // optional; must be AFTER start; mutually exclusive with duration (end wins)
      "duration": "3w",                  // optional ("7d", "2w", "90m", number = ms) — only when no end
      "content": "Kickoff",
      "group": "Phase 1",                // optional
      "title": "Tooltip text",           // optional
      "type": "point",                   // optional: point | range | background | box
      "icon": "milestone",               // optional: semantic icon key (see "Item icons")
      "status": "Open",                  // optional: Open | Doing | Done (see "Item status"); defaults to Open
      "body": "Markdown shown in detail panel",  // optional
      "metadata": { "owner": "robin@example.com", "tags": ["Qualität & Daten"] }  // optional
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

**An item's `end` must lie after its `start`** — a reversed or zero-length extent
is rejected, not rendered. vis-timeline derives a bar's width from `end - start`,
so a non-positive result collapses the bar to its minimum width and the item shows
as a hairline stripe that reads as a rendering glitch rather than as bad data.
Every write path used to accept it silently.

The rule lives once in [`src/itemExtent.ts`](src/itemExtent.ts) and is enforced on
both sides, the same shape as the phase-overlap rule above: the server write path
(`addItem` / `updateItem` / `replaceTimeline`, in **both** DB drivers) rejects it
with `400` from any source (UI, MCP, direct API), and the client prevents it
proactively — the two date inputs carry native `min`/`max` bounds so the pickers
can't offer a crossing date, and `applyItemForm` refuses to write a reversed pair
into the model, keeping the last valid dates. It rejects the extent as a whole
rather than guessing which date the user meant to move: to shift an item past its
own end, change the end first.

The reason is shown **in the form**, under the date fields (`showExtentError` /
`.field-error`), not in the status line where the sibling „Metadata JSON ungültig"
notice goes. That distinction is load-bearing rather than cosmetic: leaving a
field's edit out of the model still schedules a commit, and the persist that
follows reports „Gespeichert" milliseconds later — so a status-line message
flashed and vanished, leaving the user looking at „Gespeichert" while the date
they typed had in fact been refused. That reads as a successful save of bad data,
which is worse than saying nothing. An item already stored reversed (from before
this rule) shows the message the moment its form opens, since that is what
explains its hairline bar.

Strict on purpose — `end == start` is a zero-day range and produces the identical
hairline, and `resolvePhaseExtentMs` demands `end > start` for phases too. A single
point in time is a Meilenstein (`type: "point"`), a single day carries
`duration: "1d"`. `duration` needs no counterpart rule: `durationToMs` rejects
non-positive values and its pattern accepts no sign, so an extent expressed that
way can never run backwards.

`updateItem` is the one non-obvious spot: a *partial* patch can reverse the extent
while carrying only one of the two dates (`PATCH {end}` alone against a later
stored `start`), so the counterpart is read off the stored row — only when the
patch actually leaves one side open. The viewer always sends a full patch
(`buildItemPatch`), so that extra read is the direct-API/MCP-shaped case, never
the interactive one. There is deliberately **no** DB `CHECK` constraint: `start` /
`end` are `text` columns, so the check would be a lexicographic comparison that
silently stops holding for any other date format, and it would surface as a `500`
instead of the `400` with a readable message.

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

On the **timeline** the status is drawn on the bar as **one mark** in the item rail
(see „Item rail → The status mark"), plus, where the status contradicts the dates,
a line that quantifies the contradiction:

- **`Done`** — the item is painted **lighter** and carries a **check**, so a glance
  separates what is behind from what is still ahead.
- **overdue** — the timeline shows the item as finished (its `end`, or its `start`
  when it has no extent, is in the past) while its status still says `Open`/`Doing`.
  It carries a **warning triangle**, and a range bar also grows a dashed
  **overrun line** from its own end to „now" — the mark says *that* it is late,
  the line *by how much* (see „Item rail → The overrun line").
- **`Open` / `Doing` on time** — no bar treatment at all. Three states each with
  their own paint would make every bar a legend lookup, and being in progress on
  schedule is the normal case; the Status column in the Liste view carries the
  full three-way split.

The rule is `isOverdue(item, now)` in [`src/status.ts`](src/status.ts) (pure,
tested in [`src/status.test.ts`](src/status.test.ts)), and it deliberately treats an
item with **no status at all** as never overdue: a file-based source has no status
concept, so „not Done" there would be a complaint about something nobody can act
on. Day strings are read as *local* midnight (`parseLocalDay`), the same boundary
vis places the item at, so the mark appears exactly when the bar's right edge
crosses „now".

## Item owner (links a user, not a name)

An item's **owner** links a person: `metadata.owner` holds that person's
**e-mail**, and the display resolves it to a name + avatar. It used to be a free
text input, which meant „Robin", „robin" and „R. Fischer" were three different
owners, a typo was invisible, and the value had no relation to the identities the
app already knows from auth and presence.

**Where the candidates come from.** A user directory in its own table,
`app_users` (migration `0015`, see „Schema"): `email` PK, optional `name`,
`first_seen_at` / `last_seen_at`. Deliberately **not** timeline-scoped and not a
membership list — the deploy is gated to an allowed sign-in domain, so „everyone
who has used this instance" already *is* the candidate set. It **fills itself**:
serving `GET /api/users` upserts its caller (`handleUsersApi` in
[`scripts/db/api.ts`](scripts/db/api.ts)), and the client asks once per load, so
anyone who opens the app is assignable from then on. Migration `0015` seeds it
from the existing `created_by` / `updated_by` attribution, so it is not empty on
day one. There is no seeding step and no list to maintain by hand.

Only an **address-shaped** identity registers. `updated_by` also carries
non-person actors (`mcp`) and the dev server's placeholder `local`, and a local
`npm run dev` points at the live DB — an unfiltered upsert would put „local" in
the real directory. Same filter as the backfill, one rule for both.

- **Endpoint:** `GET /api/users` → `{ users: [{ email, name? }] }`, ordered for a
  picker (named users first, then by name). Served by the Vite middleware locally
  and by the **`timelines-api` edge function** on the deploy — the directory rides
  along in that function rather than getting its own, because it needs exactly the
  same driver setup and the same auth gate. Storage sits behind the usual
  `TimelineRepo` seam (`listUsers` / `touchUser`, both drivers).
- **Client:** the pure rules (what a stored value means, which users a query
  matches) are DOM-free in [`src/ownerModel.ts`](src/ownerModel.ts) and tested in
  [`src/ownerModel.test.ts`](src/ownerModel.test.ts); the cache, the fetch and the
  rendering sit on top in [`src/users.ts`](src/users.ts) — the same split
  `presenceModel.ts`/`presence.ts` has. The directory is loaded **once per page
  load**: it changes only when someone new signs in, and it is read on every list
  repaint and every form open.
- **Editing:** the item form renders a single-value combobox
  (`wireOwnerPicker` in [`src/itemForm.ts`](src/itemForm.ts)) — type to search name
  or address, pick to link. The picked value lives in a **hidden `owner` input**, so
  `FormData` still carries `owner` and `applyItemForm` is unchanged from when this
  was a text field. Chip and search box are two states of one slot, never both:
  one owner per item, so leaving the search box beside a filled chip would invite a
  pick that silently replaces it. Unlike Tags there is **no free-form fallback** —
  typed text that matches nobody must not become the value.
- **MCP:** `list_users` lists the assignable people; `metadata.owner` takes one of
  their addresses (`add_item` / `update_item`).

**A value that matches no user stays visible, marked as unlinked** — italic and
muted, no avatar (`resolveOwner().known === false`; `.is-unlinked`). Owner was free
text before this, so real data carries values like „Strategy Team", and
**file-based sources have no directory at all** — inventing a monogram and a colour
for a string the directory never knew would present it as a person. Rendering it as
what it is keeps someone's deliberate note legible instead of dropping it. The
committed example `data/launch-roadmap.json` keeps its role-shaped owners („UX
Lead", „Tech Lead") for exactly this reason: they are not people, and they
demonstrate the unlinked case.

**One person, one look.** The initials avatar is shared: `.user-avatar` in
[`src/styles/base.css`](src/styles/base.css) carries the look, and
`.presence-avatar` adds only what is presence-specific (the stacking overlap, the
self ring). So the same colleague is the same monogram in the same colour as a
presence avatar, as a per-item presence mark, as an owner chip and in the list's
Owner column. Hue and initials come from `hueFor()` / `initials()`
([`src/presenceModel.ts`](src/presenceModel.ts)). The avatar markup has **two forms
from one definition** (`userAvatarHtml` string / `userAvatar` element), because the
list builds html and the form assembles nodes.

Owner is not (yet) a Gruppieren/Filter dimension, and the read-only detail panel
does not show it — it surfaces in the item form and the Liste view's Owner column.

## Item rail (marks inside the bar's right edge)

A range bar reserves a strip at its inner right edge for small marks, and the
label fades into the bar's own fill under it instead of being hard clipped. Two
marks live there: the **delete affordance**, which appears on **hover as well as
on selection**, and the **status mark**, a permanent data mark carrying the item's
status (see „The status mark" below). They share one slot — hovering a marked bar
swaps the status glyph for the „×" instead of putting the two side by side.

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
  box), `--rail-glyph` (the glyph inside it, shared so every mark draws at one
  size), `--rail-gap`, `--rail-inset`, `--rail-fade` (the gradient ramp),
  `--rail-slot` (mark + gap), and `--rail-w` (the space the occupied rail
  claims). `--rail-mark-dim` is a visible mark's resting opacity, a var because a
  faded item (status „Done") has to raise it to land at the same effective
  strength. `--bar-gutter` names the 2px gutter a range bar reserves so
  back-to-back bars don't touch — a mark sits inside the *visible* bar, so the
  rail has to offset by it.
- **Occupancy** is read off the DOM (`:has(> .rail-delete)`) for the delete, not
  off a state class, so a read-only timeline neither reserves that slot nor fades
  its labels for it. The slot is claimed only while the mark is actually visible,
  so an unhovered, unselected bar keeps its full width for the label. The status
  mark is data rather than an affordance, so it claims its slot off the item's own
  class (`--rail-marks: 1` on `.status-mark`) and holds it until the delete takes
  over. `--rail-delete` + `--rail-marks` add up to `--rail-slots`.
- **Marks fill the strip from the edge inward**, and the delete takes the
  outermost slot. The status mark shares that slot rather than sitting beside it,
  so the rail is one slot wide in every state — see „The status mark".
- **The fade** is an `::after` on `.vis-item-overflow` painted in
  `background-color: inherit` (whatever lane colour the wrapper carries) and
  masked into a ramp. Masking the wrapper itself would fade its border and fill
  along with the text. It stays in the DOM at `opacity: 0` so it fades in with
  the mark rather than snapping on. On a marked bar it is shown unconditionally:
  a status mark is always there, including on a read-only timeline where no
  `.rail-delete` exists. Its width never changes there either, since the delete
  replaces the status glyph in the same slot instead of adding one.
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
can't read custom properties) — keep it in step with the rail vars. One threshold
covers a marked bar too, because its rail is no wider (the marks share a slot).

### The status mark

The rail's one **data** mark, as opposed to the delete affordance: it draws the
item's status on the bar (see „Item status" for which states earn one and why).
Two do, and they are mutually exclusive, so an item never carries two — `Done`
(a check, item painted lighter) or overdue (a warning triangle).

- **It is a pseudo-element off the item's own class** (`.status-mark::after`),
  not something `itemRail` paints. The rail's JS runs for the delete only, which
  is editable-only; a status mark is data and has to show on a read-only
  timeline and in the exported HTML too, so it comes from the class alone with no
  JS (the export inlines `timeline.css`, so the CSS is already there).
  It shares one declaration block with `.rail-delete` for the mark box and the
  glyph, so both sit in the same slot geometry and draw at the same weight.
- **`status-mark` carries the shared behaviour, a state class only its glyph.**
  Everything in this section keys on `.status-mark`; `.status-done` /
  `.status-overdue` set `--rail-mark-glyph` (plus, for done, its own paint). So a
  third state mark is a rule with a glyph plus a branch in `statusMarkClass`, not a
  round of selector surgery.
- **The delete replaces it, it does not join it.** Both sit in the rail's
  outermost slot; while the delete shows, the status glyph fades out and gives up
  its slot (`--rail-marks: 0`), so the rail — and the label's fade under it — is
  one slot wide in every state. Two marks side by side would eat twice the label
  for a state that lasts as long as the pointer rests there, and the status has
  nothing to add while you are reaching for the „×". The hand-over is gated on
  `:has(> .rail-delete)`: on a read-only timeline nothing replaces the mark, so
  hovering there must not drop it. The mark also needs `pointer-events: none` —
  a pseudo-element paints after the item's real children, so it would otherwise
  swallow the delete's click.
- **The class comes from `withStatusMarks(items, now)`**
  ([`src/buildItems.ts`](src/buildItems.ts)), called by `timelineItems()`
  ([`src/render.ts`](src/render.ts)) — the one seam every populate of the item
  DataSet passes through — and by the HTML export, which serialises its own payload
  and would otherwise ship unmarked bars. It cannot be stamped *during* the build:
  `assignLanes` owns `className` there and overwrites it on every regroup. A marked
  item therefore gets a **shallow copy** rather than a mutation, so the build's own
  items stay untouched and the persist diff never sees a display concern. „Now" is
  read once per populate, so every item in one repaint is judged against the same
  instant.
- **Done's „lighter" is `opacity` on the whole item**, ring and marks included,
  rather than a lightened fill — that would mean re-deriving all six lane colours,
  and a faded fill under a full-strength label reads as a rendering glitch. The
  delete's resting opacity is raised on a done item (`--rail-mark-dim`) so it lands
  at the same effective strength as on any other bar.
- **The overdue glyph is the only mark not in the item's text colour**: a warning
  that blends into the bar it is warning about is no warning, so it takes
  `--overdue` at full opacity. That token exists because `--warning` cannot serve
  here — the theme spends the same amber on `--lane-1-border`, which put the
  triangle at ~1.4 contrast on that lane's own bars. `--overdue` aliases
  `--danger`; no lane uses red, and the delete's red never shows at the same time
  (it replaces the mark).
- **vis copies an item's `className` onto its satellite elements**, so every rule
  here matches them too: the dot of a point/box item and a box's connector line are
  each their own `.vis-item.vis-dot` / `.vis-item.vis-line` carrying the same
  classes. A milestone therefore grew a **second** mark, on its dot — i.e. left of
  its label, since the dot sits at the item's left edge. One reset block kills both
  pseudo-elements on the satellites (and un-does the done fade there, which would
  otherwise multiply with the box's). Custom properties inherit, so a satellite
  would even pick up its box's `--overrun`.
- **Its glyph is `--ui-icon-warning`, a *filled* triangle of its own** — not an
  alias of the item icon `warning`, which is an outline. An item may carry that
  icon itself, and two identical glyphs on one bar read as a rendering bug; solid
  also suits a mark that is chrome rather than a label.
- **It is hidden on a bar narrower than its own box** (a container query, max
  `23px` = `--rail-mark` + `--rail-inset` + `--bar-gutter`). The delete may
  overhang a narrow bar because it shows while the pointer is on that bar, so it
  is obviously about it; a permanent mark on a sliver hangs past the bar's left
  edge and reads as a glyph floating in empty space next to it. Below that width a
  done bar's lighter paint carries the status, and an overdue bar's overrun line
  does. `.vis-item.vis-range` is the query container and a pseudo-element queries
  its originating element, so this needs no extra element.

### The overrun line

A range bar whose status is overdue grows a dashed run-on from its own end to
„now" ([`src/overrun.ts`](src/overrun.ts) + the overrun block in
`styles/timeline.css`). The mark says *that* an item is late; this says *by how
much*, which is the part you plan around.

- **JS supplies only the length.** end→now is a duration, and how many pixels that
  is depends on the zoom — so the module sets one custom property per overdue item
  (`--overrun`) and CSS owns height, dash pattern, colour and opacity
  (`--overrun-h` / `--overrun-dash` / `--overrun-gap` / `--overrun-dim`). Length
  comes from vis's own `body.util.toScreen`, so the line ends on the same pixel as
  vis's current-time marker (the phaseBand note about re-deriving the mapping
  yourself applies here too). It re-measures on `changed` / `rangechange` /
  `rangechanged` — the same set as the phase ribbon, since every one of those
  changes px-per-ms — coalesced through a timer, not `requestAnimationFrame`
  (hidden tabs stop firing rAF; see itemPresence.ts).
- **It continues at the bar's mid-height**, so it reads as that bar running on past
  its end. Hanging it below the bar — in the gutter vis leaves between sub-lanes,
  where no bar paints — dodges the overlap problem for free, and was tried:
  detached from the bar's own line of sight it reads as a stray rule under the whole
  row, belonging to no bar in particular. The line's one job is to say „this bar is
  still running", so it stays on the bar's axis.
- **It is part of the item's footprint, so nothing can cover it.** If the line
  behaves like a bar, then bars and lines must not overlap — and that is a layout
  question, answered in the layout: `endMs` in `assignLaneSubgroups`
  ([`src/buildItems.ts`](src/buildItems.ts)) reserves an overdue range's room out
  to „now", exactly as it already reserves a point item's label width. A following
  bar is then packed into the next sub-lane instead of landing on the line. The cost
  is honest and visible: a group with late items gains sub-lanes and gets taller.
  Items starting *after* „now" don't collide with the reservation, so they stay put
  and lanes aren't inflated needlessly.
  A `z-index` lift was the first attempt and cannot work: vis puts every item at
  `z-index: 1`, so two overdue neighbours simply tie and the later one still wins.
- **It is deliberately quiet besides**: 2px tall, fine dashes, half opacity, and
  no pointer events. It is context for a mark that already carries the state, not
  a second alarm.
- **Colour is `--overdue`, not `--warning`.** Same reason as the mark: the theme
  spends that amber on `--lane-1-border`, so an amber line disappeared wherever it
  ran past one of that lane's bars. `--overdue` aliases `--danger`, which no lane
  uses.
- **Ranges only.** A milestone has no extent to overrun, and vis sizes a point
  item's box to its label, so `left: 100%` there would start the line a
  label-width right of the date it belongs to. Those items keep the mark alone.
- **Shorter than one dash, no line** (`MIN_OVERRUN_PX`): a 2px stub at the bar's
  edge reads as a rendering artefact, not as a signal.
- **Not in the exported HTML.** The export ships its own small inline script, not
  this module, so `--overrun` is never set there and the line's width stays `0`.
  The status mark carries the state in an export; wiring the line in would mean
  re-implementing the time→pixel measurement inside the export bundle.

**Adding a mark.** Another *status* state needs no new selector: a class setting
`--rail-mark-glyph`, plus its line in `statusMarkClass`. A mark of a different
kind, sitting *beside* the status one, is more work: render it as an absolutely
positioned child of the `.vis-item` (or a pseudo-element of it), position it with
`right: calc(var(--bar-gutter) + var(--rail-inset) + <marks already inside> *
var(--rail-slot))`, raise `--rail-marks` on the item so the fade widens with the
rail, and add it to the occupancy/fade selectors — deciding whether it stacks
beside the delete or hands its slot over the way the status mark does. A data mark
cannot come from the vis `template`: that output lands inside `.vis-item-content`,
which is content-sized, so it cannot anchor to the bar's right edge. If it needs
behaviour (a click), it needs a real element from JS — the pattern in
[`src/itemPresence.ts`](src/itemPresence.ts) / [`src/itemRail.ts`](src/itemRail.ts).

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

## Postgres as the data source

Editable timelines live in **Postgres** (hosted Supabase, or any Postgres of your
own). Writes are **per-item with optimistic locking** (a `version` column on each
item): concurrent edits to different items no longer overwrite each other, and a
stale write gets a `409` instead of silently winning.

File-based timelines (`data/*.json`, e.g. the examples) stay **read-only static
sources** — they are *not* in the DB. Only DB timelines are editable.

The local middleware (`vite.config.ts`) and the Netlify edge function
(`netlify/edge-functions/timelines-api.ts`) share one dispatcher
(`scripts/db/api.ts`, `handleTimelineApi(repo, req)`) and the `TimelineRepo` seam
(`scripts/db/repo.ts`): a single implementation of the storage and locking
semantics for both runtimes, independent of the chosen driver (see „Drivers").

> **Drivers: an additive dual adapter — `supabase-js` (default) OR `postgres.js`
> (opt-in).** Both implement the same `TimelineRepo` seam
> ([`scripts/db/repo.ts`](scripts/db/repo.ts); every storage method takes a bound
> client rather than a leading client parameter):
> - **`supabase-js`** ([`scripts/db/timeline-repo-supabase.ts`](scripts/db/timeline-repo-supabase.ts),
>   factory `makeSupabaseRepo(db)`) speaks HTTP/PostgREST, runs in the Deno edge
>   without raw TCP, and is **the default the Netlify deploy runs on**. Node
>   client: `getServiceClient()` ([`scripts/db/client.ts`](scripts/db/client.ts)).
> - **`postgres.js`** ([`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts),
>   factory `makePostgresRepo(sql)`) is **opt-in** for self-hosters with their own
>   Postgres, reached through a connection string (`TIMELINES_DATABASE_URL`). Node
>   factory: `getSql()` ([`scripts/db/sql.ts`](scripts/db/sql.ts), with
>   `prepare:false` for the Supavisor transaction pooler). The edge functions open
>   a **module-scoped handle reused across invocations** — never call `sql.end()`
>   in a handler, a Deno teardown quirk.
>
> **Selected by env** (identically in every runtime): if `TIMELINES_DATABASE_URL`
> is set → postgres.js, otherwise `TIMELINES_SUPABASE_URL` +
> `TIMELINES_SUPABASE_SERVICE_KEY` → supabase-js. The glue builds both possible
> handles and passes them as `{ sql, supabase }` to `resolveAdapter`/`resolveRepo`;
> postgres.js wins whenever an `sql` handle is present. **Netlify sets only the
> Supabase vars, so it keeps running supabase-js** unchanged. Optimistic locking
> (`update … where version=$` plus 0-rows→`ConflictError`), jsonb handling and the
> DB trigger's `version` bump are identical in both drivers, and
> **schema, triggers and migrations are untouched** by the choice.
> `@supabase/supabase-js` additionally lives client-side in
> [`src/realtime.ts`](src/realtime.ts) for browser realtime, which is unaffected.
>
> **Production deploy (Netlify):** set the Supabase vars
> (`TIMELINES_SUPABASE_URL` + `TIMELINES_SUPABASE_SERVICE_KEY`); no
> `TIMELINES_DATABASE_URL` is needed. Only someone who deliberately wants native
> Postgres instead of PostgREST sets it, and then the Deno deploy's outbound TCP
> to the pooler is the one thing verifiable only live (proven locally with Node
> plus a Docker Postgres).

### Principle: no emergency or fallback data, ever

**No content snapshot of a DB timeline is kept anywhere. No data beats wrong
data.** A committed or cached dump of a live timeline is visually
indistinguishable from real data and reliably gets mistaken for it — during a DB
outage, on an id mismatch, or when it is simply stale. So this holds strictly:

- The viewer loads DB timelines **exclusively** live from the DB
  (`GET /api/source/<id>`). If that fails (`404`, no network) it **fails loudly**
  with an error message and shows *no* static content
  ([`src/editor.ts`](src/editor.ts), `loadSource`).
- DB timelines are **not** registered through committed files. `build-data`
  queries the DB at build time (`collectDbSources` in
  [`scripts/build-data.ts`](scripts/build-data.ts)) and writes one
  **registration stub** per timeline (`name`, optionally `description`/`groupBy`,
  `items: []`) exclusively into the **gitignored build output**
  (`public/data/sources/`), so the timeline appears in the view list. The stub
  **never** contains items, groups or phases; the viewer loads content live. That
  way the repo carries **no** tenant files, and a deploy still lists its DB
  timelines because it has DB access and asks at build time. Scope it with
  `TIMELINES_SOURCES_SUBDIR` as an id namespace prefix.

Do **not** introduce new sync, cache or fallback mechanisms that mirror DB
timeline content into files, a CDN, or anywhere else. (File-based sources — the
examples — are not a contradiction: there the file *is* the source, not a dump of
something else.)

### Schema

Migrations live in `supabase/migrations/` (the directory name is historical; the
runner works against any Postgres).

- `timelines` — id, name, description, group_by, `phases` (jsonb),
  `custom_fields` (jsonb). **No plugin-specific columns any more:** the former
  `type` column (gating on `'product'`) and `pricing_versions` (ordered version
  labels) moved into the generic `timeline_plugins` registry in migrations
  `0012`/`0013` (see below and „Plugin registry"). The pricing model itself has
  been normalised into its own tables since migration `0009`.
- `timeline_plugins` — the **generic plugin registry** (migration `0012`): one
  row per (timeline_id, plugin_id) plus a `config` (jsonb). A plugin (a.k.a. a
  timeline kind, e.g. `'product-roadmap'`) is **enabled on a timeline as soon as
  a row exists here** — pure data, no `ALTER TABLE`, no core column. For
  `product-roadmap` the `config` carries the version list
  (`{ versions: [...] }`, formerly the `pricing_versions` column). FK cascade on
  `timelines`, anon SELECT plus realtime like the `pricing_*` tables. A new
  plugin needs (at most) its own data and tables, never a column on the core.
  See „Plugin registry".
- `timeline_items` — columns for start/end/duration/content/group/type/title/
  body/icon/status/class_name (`status` is `NOT NULL DEFAULT 'Open'` with a CHECK
  for `Open|Doing|Done`, see „Item status"), `metadata` (jsonb: `dependsOn`,
  `owner` — the linked user's e-mail, see „Item owner" — `jira`, and free-form
  extras), `version` (bumped by trigger on UPDATE), `sort`, `updated_by`. Only
  `content` is required; `start` is nullable since migration
  `0006_start_nullable` (an entry created through the list may be date-less and
  then appears only in the list view, not on the timeline). `end` and `duration`
  are mutually exclusive (extent is either/or, `end` wins), enforced in the write
  layer for every path (`enforceExtentExclusivity` plus patch-aware clearing of
  the counterpart in [`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts),
  the MCP `add_item`/`update_item`, and the client form). When `end` is set it
  must lie **after** `start`; reversed or zero-length extents are rejected with
  `400` (the rule lives in [`src/itemExtent.ts`](src/itemExtent.ts), see
  „Standalone JSON timelines"). There is no DB CHECK for it, because `start` and
  `end` are `text` columns.
- `timeline_groups` — id, content, nested_groups, show_nested, sort.
- `app_users` — the **user directory** an item owner points at (migration
  `0015`): `email` as PK, optional `name`, `first_seen_at`, `last_seen_at`. Not
  timeline-scoped (a collection-level concept, like `listTimelines`), with no
  `version` column and no optimistic locking: a row carries no user-written
  content, only the identity the auth provider asserts anyway. No anon SELECT —
  it is read through the server-gated `/api/users` endpoint (service key) and
  never subscribed to. It fills itself (see „Item owner").
- **Pricing tables** (migration `0009`, only relevant to product-roadmap
  timelines): `pricing_features`, `pricing_tiers`, `pricing_highlights`, one row
  per entity with its own `version` column (trigger bump, optimistic locking like
  `timeline_items`; the client sees it as `rowVersion`). The feature's domain
  field „ab Version" is called `available_from` in the DB, not `version`, to
  avoid colliding with the locking column. `pricing_tier_values` is the matrix:
  **one row per (tier_id, feature_id)** with a `value` (jsonb: `true` or a
  string) and an optional `available_from` (migration `0011`, a text version
  label); FK cascade from features and tiers, and no locking, since a cell is
  atomic. Two people therefore edit different matrix cells without colliding.
  `available_from` makes **cell availability version-dependent** — the same
  semantics as `pricing_features.available_from`, one level deeper (per
  tier×feature): the cell only counts as included from that version on and
  renders „–" before it, while `value` stays the end state. That is what lets you
  express „in Enterprise now, in Scale only from v4" (see „Pricing → Cell
  versioning").

RLS is on; server access uses the service key, which bypasses it. The anon SELECT
policies exist only for the realtime subscription (see below).

**Applying migrations: a portable runner (`npm run db:migrate`).** It works
against *any* Postgres through `TIMELINES_DATABASE_URL`, with no Supabase CLI
needed. [`scripts/db/migrate.ts`](scripts/db/migrate.ts) (postgres.js) creates a
`schema_migrations` tracking table and applies `supabase/migrations/*.sql` in
filename order, each in **one transaction**, with a checksum (which warns on
drift). Re-runs apply only what is pending.

```bash
npm run db:migrate               # apply pending migrations
npm run db:migrate -- --status   # list applied / pending
npm run db:migrate -- --baseline # record ALL current files as "applied" WITHOUT
                                 # running them — for a DB already migrated by
                                 # hand (see below)
```

`0000_prereq_roles.sql` creates the `anon` role and the `supabase_realtime`
publication idempotently, so `0003`/`0009` also run on a **vanilla Postgres** (on
Supabase they already exist, so it is a no-op). A fresh Postgres is therefore
schema-complete without manual preparation.

> **Adopting an existing, hand-migrated DB (one-time):** a database that was
> migrated **manually** carries no tracking table, so the runner would try to
> re-apply everything and fail on `0001`. Run
> `npm run db:migrate -- --baseline` **once** there (with that database's env
> vars) to record the existing migrations as applied without executing them.
> New migrations then run normally through `db:migrate`.

Alternatively, on Supabase only, through its CLI:

```bash
supabase link --project-ref <ref>
supabase db query --linked -f supabase/migrations/<file>.sql
```

### Plugin registry

A **plugin** (a.k.a. a timeline kind) is enabled on a timeline as soon as a
`(timeline_id, plugin_id, config)` row exists in `timeline_plugins` — pure data,
no `ALTER TABLE`. The only place that knows plugin ids is
[`src/plugins.ts`](src/plugins.ts) (`PRODUCT_ROADMAP_PLUGIN`, `hasPlugin`,
`pluginConfig`, `versionsFromConfig`, `resolveWritePlugins`).

**What is generic today:**

- **Storing and reading.** `timeline_plugins` accepts any `plugin_id`/`config`;
  `getTimeline` reads **every** row into `file.plugins` (`PluginRef[]`),
  regardless of plugin. It round-trips through both drivers.
- **Enabling (bulk).** Through the MCP `replace_timeline` with
  `plugins: [{ id, config }]`, or direct SQL/PATCH. Identical locally and in
  production (same `api.ts` dispatcher, same DB).

**What is NOT generic (yet):**

- **No granular enable path.** The API sub-kinds carry no `plugin`, and the MCP
  has no `enable_plugin`. Turning a single plugin on or off without the rest of
  the timeline only works via SQL or a bulk `replace_timeline`. (Open follow-up:
  `PUT/DELETE /api/source/<id>/plugin/<pluginId>` plus MCP
  `enable_/disable_plugin`.)
- **Behaviour is code-coupled.** `resolveWritePlugins` / `updateVersions` /
  `getPublicPricing` are hard-wired to `product-roadmap`, and client-side
  `KINDS[]` ([`src/kinds/registry.ts`](src/kinds/registry.ts)) lists only
  `product-roadmap`. A row with an unknown `plugin_id` is stored and served, but
  **nothing consumes it** until code interprets it.

**Adding a new plugin:**

1. **Enabling is a data row** (`replace_timeline`/SQL). Needs no schema change.
2. **Its own view?** → a new `KINDS[]` entry plus a `src/kinds/<name>/` folder
   (lazily loaded, see „Timeline kinds"). No core file changes.
3. **Its own item fields?** → `fields(file)` on the `KINDS[]` entry, implemented
   in `src/kinds/<name>/fields.ts` (import only `types` and `plugins`, or the
   seam pulls the view chunk into the generic build). They appear automatically as
   a section under the plugin's `label`, and as a grouping/filter dimension — see
   „Custom fields → Plugin-contributed fields". No core file changes.
4. **Its own persisted data?** → its own tables plus a write path (model:
   `pricing_*` and `assemblePricing`). Never a column on the core.
5. Reads through `file.plugins` already work. The product-specific auto-enable
   behaviour (`resolveWritePlugins`) is a model to copy, not an obligation.

### Setup (one-time)

Credentials go in `.env.local`, read through the cascade in
[`scripts/db/env.ts`](scripts/db/env.ts) (`process.env` → `.env.local` → the files
named by `TIMELINES_ENV_FILE`, see „Credential cascade" below). Depending on the
chosen driver (see „Drivers"): supabase-js through `getServiceClient()`
([`scripts/db/client.ts`](scripts/db/client.ts)), postgres.js through `getSql()`
([`scripts/db/sql.ts`](scripts/db/sql.ts)):

| Var                              | Driver       | Meaning                                                                   |
| -------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `TIMELINES_SUPABASE_URL`         | supabase-js  | `https://<ref>.supabase.co` (the default path)                            |
| `TIMELINES_SUPABASE_SERVICE_KEY` | supabase-js  | Service-role key (server-side only, never in the client)                  |
| `TIMELINES_DATABASE_URL`         | postgres.js  | Postgres connection string (`postgresql://…`); when set, it wins over supabase-js. On Supabase use the Supavisor transaction pooler (port 6543). Any Postgres works. |

Ist `TIMELINES_DATABASE_URL` gesetzt, läuft alles über postgres.js; sonst über
supabase-js.

**Your own Postgres in 3 steps** (no Supabase needed):

```bash
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16   # 1. Postgres
export TIMELINES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres  # 2. target
npm run db:migrate                                                     # 3. schema
```

Then run the server with `TIMELINES_DATABASE_URL` (live updates via
`TIMELINES_DB_LIVE=poll`, without an anon key or realtime — see „Live-update
seam"). `0000_prereq_roles.sql` handles the previously manual `anon`/publication
setup, so nothing has to be prepared by hand.

#### Credential cascade (`TIMELINES_ENV_FILE`)

Every Node entry point reads configuration through **one** implementation:
`envValue()` in [`scripts/db/env.ts`](scripts/db/env.ts). The order is
`process.env` → `<repo>/.env.local` → the files named by `TIMELINES_ENV_FILE`,
and precedence runs in exactly that direction: `process.env` wins over
`.env.local`, which wins over the external files. The edge functions use
`Deno.env` instead.

`TIMELINES_ENV_FILE` is the **opt-in seam for credentials kept outside the repo**
(e.g. a file holding keys shared across projects): one or more paths separated by
`:`, each optionally starting with `~/`. Missing files are ignored, so setting it
is always safe. **Without the variable a checkout reads nothing outside the
repo**, which is precisely why no fixed path appears in the code any more. A
hard-wired `~/_AGENTS/.env` used to sit in four files; it does not exist on anyone
else's machine, and its error messages sent contributors into a directory only the
author has.

The repo root is derived from `import.meta.url`, **not** from `process.cwd()`:
the MCP server is registered user-global and runs from arbitrary directories, so
it would otherwise fail to find `.env.local`. The spec's splitting rules live as
the pure, DOM- and FS-free function `envFilePaths` and are tested in
[`scripts/db/env.test.ts`](scripts/db/env.test.ts). `envSourcesHint()` phrases the
hint for error messages out of the active configuration, so no message names a
path that does not exist for its reader.

#### Per-source connections (phase 4, #30)

Different timelines can live in **different Postgres instances**, chosen by the
**namespace** of the source id (its first path segment). Set named connections
alongside the default `TIMELINES_DATABASE_URL`:

```bash
export TIMELINES_DATABASE_URL=postgresql://…/default              # default for everything
export TIMELINES_DATABASE_URL_WAREHOUSE=postgresql://…/warehouse  # only warehouse/*
```

`warehouse/plan` resolves to `TIMELINES_DATABASE_URL_WAREHOUSE`; anything without
a matching named variable uses the default. The name is derived by uppercasing
the namespace and replacing non-alphanumerics with `_`
(`getSqlForSource`/`connectionEnvKey` in [`scripts/db/sql.ts`](scripts/db/sql.ts)).
**Opt-in and backward-compatible:** without a `TIMELINES_DATABASE_URL_<NS>` every
source uses the default as before. Connection strings stay in the environment,
never in committed config. Only the **Node path** routes per source (the glue sets
`DbConnections.sqlFor`); the edge function stays single-connection. A default must
be set, because the `/api/sources` collection endpoint lists from it.

### Import / migration

`scripts/db/import.ts` loads the configured timelines from their `data/<id>.json`
into the DB (`replaceTimeline`). Repeatable.

```bash
npm run db:import                # all
npm run db:import -- acme/my-plan # one, by id
```

### Sync behaviour

- **Read:** the client loads `GET /api/source/<id>` from the DB. If that fails
  (`404`, no network) it is a **loud error with no static fallback** (see
  „Principle: no emergency or fallback data"). Genuine file-based sources (the
  examples) exist as files and are read-only (`editable:false`).
- **Write:** UI edits (drag, form, add, delete) send **per-item** calls:
  `POST/PATCH/DELETE /api/source/<id>/item[/<itemId>]`, `PUT …/phases`. A `PATCH`
  carries the known `version` in the `If-Match` header; if it no longer matches
  the response is `409` and the client reloads that item. A `PATCH` touches a
  column **only when the key is present in the body** (`updateItem`,
  [`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts)), so a cleared
  optional field — for instance the last `metadata.dependsOn` being removed, which
  makes `metadata` disappear from the item entirely — has to be sent as an
  **explicit `null`**, or the old DB value survives and reappears on reload. The
  client therefore builds the patch through `buildItemPatch`
  ([`src/persistence.ts`](src/persistence.ts)), which sets every missing clearable
  field to `null`.
- **Registration stubs:** `npm run build:data` (part of `dev`/`build`) queries the
  DB and writes one stub per DB timeline (`name` plus `items: []`, no content) into
  the **gitignored build output** `public/data/sources/<id>.json`. Its only job is
  to keep the timeline in the view list; it is **not** a data fallback and
  **nothing is committed**. Nothing lands in the tracked `data/`.
- **Live collaboration:** see „Realtime", which replaced an earlier 60-second poll.

### Production setup (Netlify)

In addition to the auth env vars:

| Var                              | Where              | Notes                                          |
| -------------------------------- | ------------------ | ---------------------------------------------- |
| `TIMELINES_SUPABASE_URL`         | dashboard          | **The default path (supabase-js).** Activates the `timelines-api`/`pricing-api` edge functions over HTTP/PostgREST. |
| `TIMELINES_SUPABASE_SERVICE_KEY` | dashboard (secret) | Service-role key for server-side access        |
| `TIMELINES_DATABASE_URL`         | dashboard (secret) | **Optional, opt-in.** Set it only to deliberately run native Postgres (postgres.js over TCP, Supavisor transaction pooler on port 6543) instead of supabase-js; it then wins over the Supabase vars. |
| `VITE_SUPABASE_URL`              | dashboard          | Build-time; **only** for client-side realtime (see „Realtime"). Without both, other people's edits appear on reload only. |
| `VITE_SUPABASE_ANON_KEY`         | dashboard          | Build-time and public in the bundle; **needs a redeploy**, since Vite bakes it in at build time. |

The edge function gates on the session cookie (or the MCP token) and attributes
edits through `updated_by` to the signed-in user's e-mail. If **neither** the
Supabase access **nor** `TIMELINES_DATABASE_URL` is configured, the edge function
cannot reach the DB and the source fails loudly (no static fallback).

> **Deploy note:** the Netlify deploy runs on supabase-js, for which
> `TIMELINES_SUPABASE_URL` + `TIMELINES_SUPABASE_SERVICE_KEY` are enough.
> `TIMELINES_DATABASE_URL` is an **opt-in** for self-hosters with their own
> Postgres; setting it makes the postgres.js path win, and the Deno deploy's
> outbound TCP to the pooler is then the one thing only verifiable live.

### Live-update seam (realtime **or** polling)

How other people's changes reach an open viewer is a **seam** with two
implementations behind one signature: `watchTimeline(id, onChange, { live,
isBusy })` in [`src/realtime.ts`](src/realtime.ts). Which one applies is declared
by the source through `capabilities.live` (`SourceLive` in
[`src/types.ts`](src/types.ts)):

- **`realtime`** — Supabase Realtime pushes row changes over a WebSocket
  (`subscribeTimeline`, fine-grained item events with echo suppression). Needs the
  anon key (`VITE_SUPABASE_*`); without it nothing happens and updates are
  reload-only.
- **`poll`** — the client polls a cheap **watermark endpoint**
  (`GET /api/source/<id>/watermark` → `{ v, n, t }`: max item `version`, item
  count, and max `updated_at` across items plus the `timelines` row) on an
  interval (`src/poll.ts`: ~8 s while visible, ~60 s while hidden, backing off on
  `visibilitychange`). When the watermark changes it triggers a **full reload**
  through the existing `loadSource` path; timelines are small, and a delta fetch is
  a later optimisation. This needs **no** anon key, because the endpoint is
  server-gated, which is what makes a Postgres **without** realtime live. The poll
  pauses while an edit form is open (`isBusy`), and a change detected meanwhile is
  not discarded but applied afterwards.
- **`none`** — no live updates (file sources).

The server tells the client which mode applies through the **`X-Source-Live`
response header** on `GET /api/source/<id>`, set by the runtime glue from
`adapter.capabilities.live`; `loadSource` reads it and stores it in
`state.activeSourceLive`. The DB adapter reports `realtime` by default, and the env
var **`TIMELINES_DB_LIVE=poll`** (`process.env` locally, `Deno.env` on Netlify)
switches DB sources to polling — useful for a Postgres without realtime enabled,
and for testing the poll path end to end.

> **Scope:** the watermark covers items plus timeline metadata (including
> phases), but **not** the pricing tables. No poll source is a product timeline
> today, and realtime still covers pricing; folding pricing into the watermark is a
> follow-up (`getWatermark` in
> [`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts)).

#### Presence under polling

Presence (see below) is **realtime-only**, because it hangs off the Supabase
presence channel. Poll sources show no presence badge and no per-item markers; a
heartbeat table would be an optional sub-feature and is not implemented.

### Realtime (live collaboration)

Other people's edits appear live without a reload: Supabase Realtime pushes row
changes over a WebSocket and the client (`src/realtime.ts`) patches the view.

**Opt-in per environment** through client env vars (Vite, build-time):

| Var                       | Meaning                                              |
| ------------------------- | ---------------------------------------------------- |
| `VITE_SUPABASE_URL`       | Supabase URL (embedded in the client bundle)         |
| `VITE_SUPABASE_ANON_KEY`  | Anon key — **public in the browser**                 |

Note that the anon key is visible in the shipped bundle, and together with the
anon SELECT policies that makes timeline *reads* available to anyone holding it.
Hence it is deliberately opt-in: set it on a gated site only if that is
acceptable. Writes stay server-side (service key). Without these vars everything
still works, and other people's changes simply appear on reload.

**Remote changes are applied in place, never through a full rebuild.**
`scheduleRemoteRefresh` reloads the source and feeds it into the live vis instance
via `refreshActiveSourceInPlace` ([`src/render.ts`](src/render.ts), through
`rebuildAndApply` and a DataSet diff). Going through `renderTimeline` destroys the
timeline along with the arrow and phase overlays and rebuilds them, leaving the
container briefly empty, so the view flickers on *every* remote edit. Since a
colleague who is typing writes every `PERSIST_THROTTLE_MS`, that added up to
constant flicker. `renderTimeline` remains the fallback for what cannot be
expressed in place: a changed view, or the first/last phase or dependency overlay
appearing or disappearing.

#### Presence (who is online)

The header shows avatars, top right, of everyone who currently has the same
**editable DB timeline** open. It runs over a Supabase **presence** channel
(`presence:<timelineId>`, `joinPresence` in
[`src/realtime.ts`](src/realtime.ts)), so it needs no DB table access and no RLS
policy. [`src/presence.ts`](src/presence.ts) renders it into the `#presence`
element, with a colour and initials per e-mail; your own avatar gets a ring.
Multiple tabs belonging to one person are deduplicated by e-mail, and from the
sixth user on the rest collapses into „+N".

Its lifecycle hangs off `setupRealtime`
([`src/persistence.ts`](src/persistence.ts)): switching views unsubscribes the old
presence and clears the badge, then joins again for editable sources. Same opt-in
condition as realtime (`VITE_SUPABASE_*`); without those vars the badge stays
empty.

Your own identity comes from the `GET /api/me` endpoint, because the session
cookie is HttpOnly and the client otherwise does not know who it is: the Netlify
edge function [`netlify/edge-functions/me.ts`](netlify/edge-functions/me.ts) reads
the session (`{ email, name }`) behind the auth gate, while the Vite middleware
serves `{ email: 'local' }` locally. When no identity is known (an ungated site)
the client tracks anonymously as „Gast".

**Testing it locally:** a `dev_user` cookie overrides the dev identity (`/api/me`
in [`vite.config.ts`](vite.config.ts)); without it every tab is the same „local"
user and therefore invisible to itself. Per tab, in the console:
`document.cookie = 'dev_user=alice'; location.reload()`. Cookies are per origin,
not per tab, so two identities at once need two browser profiles or windows, or a
second client such as a Node script that joins the presence channel. Dev server
only; the deploy derives the identity from the session cookie.

#### Per-item presence (who is on what)

Beyond the header badge, the **timeline** marks the item another user currently
has selected or is editing, so a double edit becomes visible *before* the
`409`/„extern geändert" notice arrives. It rides on the **same** presence channel
(no second channel, no table, no migration): alongside the identity, the payload
carries a `PresenceActivity` (`itemId` plus `editing`,
[`src/presenceModel.ts`](src/presenceModel.ts)).

- **Sending:** `joinPresence` returns a `PresenceHandle`, and
  `publishSelfPresence` ([`src/persistence.ts`](src/persistence.ts)) reports through
  `setActivity` which item we occupy (the open form, otherwise the timeline
  selection). Unchanged activity is not put on the channel.
- **`editing` vs. selected:** on an editable source a click opens the form
  immediately, so „clicked" and „editing" would mean the same thing. Therefore
  `markSelfEditing` only reports `editing` on an actual change (a form keystroke
  via `scheduleLiveEdit`, a drag or resize via `handleMove`) and lets it fall back
  to „selected" after `EDITING_LINGER_MS` of quiet.
- **Rendering:** [`src/itemPresence.ts`](src/itemPresence.ts) writes the ring
  (`.has-remote-presence` / `.is-remote-editing`, pulsed) plus an avatar cluster
  directly onto the vis item element. A child of `.vis-item` moves, scrolls and
  zooms with its item, so unlike an absolutely positioned overlay (arrows.ts /
  phaseBand.ts) it needs no recomputation per frame. What it does need is a
  re-apply whenever vis mounts item DOM afresh, hence the `'changed'` hook in
  `attachItemPresence`. Clone ids of a regrouped view resolve through `realIdOf`.
  The cluster hangs off the **left** edge, because on long bars the right one is
  often outside the window.
- **Your own activity** is never marked (your selection already *is* the vis
  selection). Multiple entries per e-mail collapse in `dedupeRoster` to the
  **most recent** one (the `at` stamp in the payload), not to the „most specific"
  one. That is not a detail but the correctness condition: a presence channel holds
  several metas per key — one per tab, but also the *superseded* metas of the same
  tab, because calling `track()` again adds a meta instead of replacing it. Sorted
  by specificity the stale one then wins (`editing` beats the fresh „selected" that
  replaced it) and the marker sticks on „currently editing" forever.
- **Repaints run on a timer, not on `requestAnimationFrame`.** A backgrounded tab
  stops firing rAF; an outstanding frame callback leaves the „already scheduled"
  flag set, and every later sync then discards its repaint, so the tab freezes on
  the last state it saw in the foreground. Timers keep running in the background,
  merely throttled.
- **Scope:** the timeline view only (the list view has no markers), under the same
  opt-in condition as presence generally: realtime-only, `VITE_SUPABASE_*`. The
  pure logic (ranking, dedupe, per-item bucketing) sits DOM-free in
  `presenceModel.ts` and is tested in
  [`src/presenceModel.test.ts`](src/presenceModel.test.ts).

## MCP server (Claude Code)

A stdio MCP server (`scripts/mcp/server.ts`) lets Claude Code read and
manipulate DB-backed timelines. It **always works against the live site**
(`TIMELINES_LIVE_URL`, **required**, with no default; the server aborts with a
clear message if the variable is missing): every read and write goes through
`/api/source(s)` → the `timelines-api` edge function → the DB. That keeps the DB
the single source of truth and makes changes immediately live.

**Only DB-backed timelines** are exposed. File-based sources are read-only on the
live site and therefore not manipulable here.

### Tools

| Tool                | Effect                                                        |
| ------------------- | ------------------------------------------------------------- |
| `list_timelines`    | Lists all DB timelines (id, name, description)                |
| `list_users`        | Lists the linkable users (email, name) for `metadata.owner`   |
| `get_timeline`      | A complete timeline (items + groups) by id                    |
| `add_item`          | Appends an item (required: `start`, `content`)                 |
| `update_item`       | Patches an item (only the given fields; `metadata` is merged) |
| `delete_item`       | Removes an item by id                                         |
| `add_group`         | Adds a group                                                  |
| `update_group`      | Patches a group                                               |
| `delete_group`      | Removes a group                                               |
| `replace_timeline`  | Replaces a whole timeline (bulk)                              |
| `set_pricing`       | Replaces the pricing model wholesale (bulk seed; automatically enables the `product-roadmap` plugin) |
| `add_/update_/delete_feature` | A single pricing feature (granular)                  |
| `move_feature`      | Reorders a feature (after/before another one)                 |
| `add_/update_/delete_tier`    | A single tier (granular)                            |
| `set_tier_value`    | One matrix cell (tier × feature); `false`/`null` deletes it; optional `availableFrom` (cell availability from a version) |
| `add_/update_/delete_highlight` | One card tile (granular)                          |
| `set_versions`      | Replaces the ordered version list                             |

The granular item and group tools run read-modify-write: the server fetches the
timeline, mutates it in memory and writes it back with a PUT (bulk replace).
`dependsOn` and `owner` live under `metadata`; `owner` carries the e-mail of a
user from `list_users` (see „Item owner"), and a free-text name is stored but
renders as unlinked. The granular **pricing** tools instead hit their row's
endpoint directly, with no read-modify-write and no full dump — details under
„Pricing".

### Auth: service-token bypass

The server attaches an `X-MCP-Token: <MCP_API_TOKEN>` header to every request.
The `timelines-api` edge function lets requests carrying a valid token through
without a Google login (comparing in constant time) and reaches the DB
server-side with the service key. MCP edits are attributed as `mcp` through
`updated_by`.

### Configuration

Server-side (locally, read through the cascade `process.env` → `.env.local` →
`TIMELINES_ENV_FILE`, see „Credential cascade"):

| Var                  | Meaning                                                      |
| -------------------- | ------------------------------------------------------------ |
| `MCP_API_TOKEN`      | Bypass token; must match the env var of the same name on the deploy |
| `TIMELINES_LIVE_URL` | Target site (**required**, e.g. `https://<site>.netlify.app`; no default) |

Registering it as a user-global MCP server (usable from any directory):

```bash
claude mcp add -s user timelines -- \
  <repo>/node_modules/.bin/tsx <repo>/scripts/mcp/server.ts
```

(Or directly as an `mcpServers.timelines` entry in `~/.claude.json`.)

### Netlify env (in addition to the Supabase vars)

| Var             | Where              | Notes                                                        |
| --------------- | ------------------ | ------------------------------------------------------------ |
| `MCP_API_TOKEN` | dashboard (secret) | Activates the bypass; identical to the local server's token   |

Prerequisites: `TIMELINES_SUPABASE_URL` / `TIMELINES_SUPABASE_SERVICE_KEY` **and**
`AUTH_REQUIRED=true` must be set, or `timelines-api` does not take effect. If
`MCP_API_TOKEN` is unset the bypass is inactive and the site stays gated behind
the Google login for everyone.

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
    picking that type mutes end/duration). The two date pickers are bounded
    against each other so they can't cross, and a reversed pair typed in anyway is
    refused with a status-line message — see „An item's `end` must lie after its
    `start`".
  - **Properties** — group, owner (a user picker, see „Item owner"), body
    (Markdown), tags, and the per-timeline
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

Persistence path: viewer → item-level calls (`POST/PATCH/DELETE /api/source/<id>/item`, `PUT …/phases`) → middleware (`vite.config.ts`) → Supabase via `scripts/db/api.ts`. `PATCH` carries the item `version` in `If-Match`; a stale version returns `409` and the client reloads that item. Only DB-backed sources are editable; genuine file-based sources (the examples) load read-only from their static `/data/sources/<id>.json`. Builds (`npm run build`) and exported HTML have no edit endpoint. DB-backed timelines are discovered from the DB at build time (`collectDbSources`); the registration **stub** (`name` + `items: []`, no content) is written only to the gitignored build output `public/data/sources/<id>.json` — nothing DB-backed is committed, and there is deliberately no committed content cache (see „Principle: no emergency or fallback data").

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
  proxies the issue picker. Credentials come from the shared cascade
  (`process.env` → `.env.local` → `TIMELINES_ENV_FILE`, see „Credential cascade"):
  `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (Atlassian API token). Without them the field
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
e.g. set `TIMELINES_NOTES_DIR=~/my-notes` in `.env.local`. If
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
npm run dev       # build data + Vite + chokidar watcher on the notes dir
npm run build     # static dist
npm test          # unit tests (node --test, TZ-pinned to Europe/Berlin)
npm run typecheck # tsc --noEmit
```

`npm run dev` rebuilds `notes.json` whenever a Markdown file changes.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to
`main` and on every pull request, over a Node 22 + 24 matrix: `npm ci`,
`npm test`, `npm run build`, then the bundle-split check below.

**Node 22 is the floor** (`engines.node` in `package.json`), and that is a real
constraint rather than a preference: the test script hands a glob
(`'{src,scripts}/**/*.test.ts'`) to `node --test`, and Node 20 does not expand it
— it fails with „Could not find …" before running a single test. The first CI run
proved it, which is what the matrix is for. Node 20 has also been EOL since
April 2026. Lowering the floor again means resolving the glob in the script
instead of leaving it to the runtime.

**The build step runs with no credentials on purpose** — that is the path a
contributor takes after a plain `git clone`. It has to stay non-fatal: the build
discovers no DB timelines and warns about the missing notes directory rather
than failing (see „Configuration" and „Principle: no emergency or fallback data").
A change that makes a missing DB or notes dir fatal breaks CI for everyone
without a deploy's env vars.

**`npm run typecheck` is deliberately non-blocking** (`continue-on-error`): the
repo carries 7 pre-existing errors (`Dirent` typing in `build-data.ts`, missing
`@types/ws`, two library signature mismatches). They are unrelated to any
current change, so gating PRs on them would block contributions on a debt that
predates them. The step still reports the count, which is what catches a
regression — dropping `continue-on-error` is the one-line change once the count
reaches zero.

**Bundle-split acceptance check**
([`scripts/ci/check-bundle-split.sh`](scripts/ci/check-bundle-split.sh)) enforces
the promise from „Timeline kinds": a generic build downloads no pricing *view*
code. It asserts the pricing markers are absent from the entry chunk **and
present in some lazy chunk** — the second half is what keeps it honest, since
testing only absence turns the check into a silent pass the day those CSS class
names are renamed. Runnable locally after `npm run build`.

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
- **Editing** is live when the Supabase env vars are set (see „Postgres as the
  data source → Production setup"): the `timelines-api` edge function serves
  DB-backed timelines editable. Without those vars, the DB read fails and the
  viewer surfaces an error — there is no static content fallback (see „Principle:
  no emergency or fallback data").

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

> The pricing model's **client** code (matrix, cards, matrix editors) lives as a
> timeline kind under [`src/kinds/product-roadmap/`](src/kinds/product-roadmap/)
> and is lazily loaded (see „Timeline kinds"). The server side (tables,
> `assemblePricing`, `pricing-api`, MCP tools) is as described below.

The pricing model (tiers + features, product-roadmap timelines only) is the single
source of truth for external pricing pages. It is stored **normalised** in its own
tables (migration `0009`, see „Schema"): `pricing_features`, `pricing_tiers`,
`pricing_tier_values` (the matrix, per cell), `pricing_highlights`, plus the
ordered version list in `timeline_plugins.config.versions` of the
`product-roadmap` entry (formerly the `timelines.pricing_versions` column, moved
in migrations `0012`/`0013`, see „Plugin registry"). The server assembles the
`Pricing` shape described below out of those (`assemblePricing` in
[`scripts/db/timeline-repo.ts`](scripts/db/timeline-repo.ts)), and the viewer and
the Markdown export see it unchanged.

Reading: the viewer uses `GET /api/source/<id>` (assembled, including a
`rowVersion` per entity), external pages use `GET /api/pricing/<id>` (public, with
`rowVersion` stripped). Markdown mirror: `npm run export:pricing`.

**Writing is granular and collision-free.** The old „replace the whole model"
semantics are gone, because they were exactly what caused overwrites on concurrent
edits:
- Endpoints under `/api/source/<id>/`: `feature[/<id>]`, `tier[/<id>]`,
  `tier-value` (PUT `{tierId, featureId, value, availableFrom?}`, where
  `value=false/null` deletes the cell and `availableFrom` is the version label from
  which the cell applies, otherwise from the start), `highlight[/<id>]` (each with
  POST/PATCH/DELETE), `pversion` (PUT of the whole version list, like `phases`),
  and `pricing` (PUT, a bulk replace for seeding). A PATCH carries the `rowVersion`
  in the `If-Match` header and returns `409` when stale. **Important:** for
  features the lock version comes **only** from `If-Match`, never from
  `body.version`, where `version` is the domain field „ab Version".
- MCP: the granular tools `add_/update_/delete_feature`, `move_feature`,
  `…_tier`, `set_tier_value`, `…_highlight`, `set_versions` (one call each, no
  read-modify-write, no full dump in the context). `set_pricing` remains as the
  bulk seed/rewrite.
- **Feature order** (the `sort` column): `add_feature` always appends to the end
  of its group. To place one precisely, `POST …/feature-move {featureId, after? |
  before?}` (MCP: `move_feature`) — exactly one anchor, and `after` wins if both
  are given. The server loads the current order, repositions relative to the anchor
  (`reorderIds`, pure and tested) and renumbers `sort`, writing only changed rows.
  `sort` is exposed through no other write path, and a moved feature keeps its
  `group` (to change groups, use `update_feature`).
- Client: the **matrix view is editable in the interface** (see „Editing the
  matrix in the interface"), through those same granular endpoints — per cell, per
  tier, per feature. **Highlights** (the card tiles) and the **version list** are
  still maintained through the MCP.

### Editing the matrix in the interface

On an editable (DB-backed) product timeline the matrix carries its own write
paths. Each one writes exactly the row or cell that was edited, with no model
dump, so concurrent edits in different places do not collide.

| What | Affordance | Endpoint | Locking |
| --- | --- | --- | --- |
| **Cell** (tier × feature) | Click (or Enter) on the cell → popover | `PUT …/tier-value` | none; a cell is atomic |
| **Tier** (column) | Click the column header → drawer form | `PATCH/DELETE …/tier/<id>` | `If-Match` on `rowVersion` |
| **Add a tier** | „+ Tarif" in the header row | `POST …/tier` | — |
| **Feature** (row) | Click the row header → drawer form | `PATCH/DELETE …/feature/<id>` | `If-Match` on `rowVersion` |
| **Add a feature** | „+ Feature" (header row = no group, per section = in that group) | `POST …/feature` | — |
| **Reorder a row** | ↑/↓ on the row (on hover) | `POST …/feature-move` | — |

A few decisions that are not obvious:

- **A cell gets a popover, not a click cycle**
  ([`src/kinds/product-roadmap/cellEditor.ts`](src/kinds/product-roadmap/cellEditor.ts)).
  A cell carries two dimensions (`value` and availability from a version) and the
  value itself has three shapes (`true` / free text / empty). Cycling through
  clicks cannot express that. „Wert" with empty text deliberately saves as *empty*:
  both render as „–" and the server deletes on a falsy value, so separating the two
  states would be a distinction without a difference.
- **An empty cell is clickable too.** Switching a feature on for a tier is exactly
  the edit that starts at the dash.
- **Reordering anchors on the *visible* neighbour within the section.**
  `moveFeature` sorts globally across all features, and the version switcher can
  hide rows; anchored on the visible neighbour, the row moves exactly one step in
  the direction the user sees. The client then adopts the order the server returns
  rather than replaying the move locally, because the `sort` column belongs to the
  server.
- **The tier form touches no cells.** `updateTier` re-reads the cell rows and
  returns them in full, so the client adopts the response unchanged and the column's
  values survive.
- **Popover layers are `fixed` on `<body>`** (`popover.ts`, shared with the feature
  tooltip): the table wrapper carries `overflow-x`, which clips `overflow-y` as
  well, so an embedded layer would be cut off at the row's edge.
- **New ids are slugs of the name** (`slugId` in
  [`pricing.ts`](src/kinds/product-roadmap/pricing.ts), transliterating umlauts and
  adding a counter suffix on collision), which keeps the model readable in SQL and
  in MCP output.

**Not in the interface yet:** highlights (the card tiles) and a version editor. For
versions that is no accident: `updateVersions` writes only the plugin config and
migrates **no** references. Since the gates implement „an unknown version never
hides" (`featureVisibleForVersion`), renaming `3.0` would make every 3.0-gated
feature visible in *every* pinned version, silently and wrongly. A version editor
has to migrate `feature.version`, `tier.valueVersions`, `descriptionByVersion`,
`nameByVersion` and `labelByVersion` along with it.

Shape (assembled):
- `features[]`: `{ id, name, group, version?, description?, nameByVersion?, descriptionByVersion?, rowVersion? }`.
  `version` is the tracked version a feature is available from (DB column
  `available_from`). **No `version` means pre-existing** (it existed before the
  first tracked version), so it is always visible, never badged „Neu", but still
  eligible for „Modified". Setting `feature.version` to the baseline
  (`versions[0]`) means „introduced in this version", NOT „always been there" —
  for that, leave `version` out.
  - `nameByVersion` (`Record<version, string>`, DB column `name_by_version`): a
    version-dependent name *override*, resolved **cumulatively** (the newest
    override ≤ the selected version wins) — `resolveFeatureName`.
  - `descriptionByVersion` (`Record<version, string>`, DB column
    `description_by_version`): additional version-bound descriptions **on top of**
    `description`. Unlike `nameByVersion` these are **additive**, not overrides: the
    base `description` stays and each note appears as its own line, „ab
    \<version\>: …", in version order — `resolveFeatureDescription`
    ([`src/pricing.ts`](src/kinds/product-roadmap/pricing.ts)). It shows as a matrix tooltip behind an
    **info icon**, and is editable in the feature form via „+ Versionsbeschreibung".
  - `rowVersion` is the server-managed lock counter: do not edit it, and it is
    stripped from the public output.
- `tiers[]`: `{ id, name, tagline?, useCase?, targetGroup?, price, values, valueVersions?, rowVersion? }`.
  `values[featureId]` is `true` (✓), missing or `false` (–), or a string (a
  per-tier value). Falsy and empty cells are not stored, since they render as „–"
  anyway. `valueVersions[featureId]` (DB column
  `pricing_tier_values.available_from`) is the optional **cell availability from a
  version**: the cell only counts as included from that label on and shows „–"
  before it (cumulative, `cellActiveForVersion` in
  [`src/pricing.ts`](src/kinds/product-roadmap/pricing.ts)). `values` remains the end state and the map
  only gates *when* it appears (a sibling of `values`, additive). Under „Alle" the
  matrix shows the end state plus a subtle „ab \<version\>" chip in the cell; with a
  pinned version, the cell appearing or showing „–" carries that information by
  itself. No key means available from the start. See „Cell versioning" below.
- `highlights[]`: `{ id, label, section?, featureIds, rowVersion? }` — the curated
  tiles of the card view, bundling features. Only what is referenced here appears
  on the cards; the matrix shows every feature.
- `versions[]`: ordered labels; the switcher filters feature rows cumulatively.

Item↔feature: `metadata.featureIds` (n:m) plus `metadata.featureVersion` (the
version being worked on) plus `status` (Open/Doing/Done) feed the work dot and the
row badges:
- **„Neu"**: `feature.version` equals the pinned version (not „Alle"). This
  includes the baseline (`versions[0]`): a feature introduced there badges „Neu"
  when the baseline is pinned, while pre-existing features (no `version`) never do.
- **„Modified"**: the feature is older than the pinned version (including
  pre-existing) AND that version brought a change — either an item carrying this
  feature with `featureVersion` equal to the pinned version, OR a version
  description for the pinned version (`descriptionByVersion[pinned]`). The latter
  badges even without a work item. It excludes „Neu", and only applies with a
  pinned version.
- **„ab \<Version\>"**: only in the „Alle" view, where „Neu"/„Modified" never
  fire. A neutral chip stating which version the feature or highlight arrived in.
  In the matrix: per feature that has a `version`. On the cards: per highlight, the
  earliest `version` among its contributing features (`introducedVersion` in
  `resolveHighlight`); a single pre-existing feature in the bundle suppresses the
  chip. Pre-existing features (no `version`) never get one.

### Cell versioning (tier×feature availability from a version)

Where `feature.version` controls when a feature (the whole row) starts to exist,
`tier.valueVersions[featureId]` (DB: `pricing_tier_values.available_from`)
controls when an **individual cell** counts as included. That is what lets you
express „feature X is in Enterprise right away, in Scale only from v4" without
gating the entire feature row.

- **Resolution** — `cellActiveForVersion(availableFrom, versions, selected)` in
  [`src/pricing.ts`](src/kinds/product-roadmap/pricing.ts), cumulative and shaped like
  `featureVisibleForVersion`: under „Alle" it is always active; with no
  `availableFrom` it is active from the start; otherwise it becomes active as soon
  as the pinned version is ≥ `availableFrom`. Before that version the cell renders
  as „–", while the stored `value` stays the end state.
- **Matrix** ([`src/kinds/product-roadmap/pricingMatrix.ts`](src/kinds/product-roadmap/pricingMatrix.ts)):
  pinned → the cell either appears or shows „–", which carries the information
  itself; „Alle" → the end state plus a subtle „ab \<version\>" chip
  (`.pm-cell-ver`) in the cell.
- **Cards** (`resolveHighlight`): a cell that is not yet available does not count
  as included for that tier. The highlight's effective introduction version per
  tier is `valueVersions[fid] ?? feature.version` (the cell gate wins), which feeds
  `isNew` and the „ab" chip.
- **Writing** — `set_tier_value(..., availableFrom)` via MCP, or
  `PUT …/tier-value {availableFrom}`. Deleting the cell removes the gate with it.
  The round-trip is tested in
  [`src/pricingNormalize.test.ts`](src/kinds/product-roadmap/pricingNormalize.test.ts) and the gating
  logic in [`src/pricing.test.ts`](src/kinds/product-roadmap/pricing.test.ts).

## Open extensions: pricing model / cards

Not yet represented in the data model, as a backlog:

- A dedicated per-tier unit-price field. Today such a value can only be expressed
  as an ordinary feature value.
- Tiered volume packages per tier (e.g. S/M/L/custom with graduated prices).
- `highlight.icon` exists in the schema but is unused (no per-tile icons).

Bekanntes Verhalten: Wert-Highlights (z.B. „Charaktere") erscheinen auf jeder
Tarif-Karte (Wert variiert je Tarif) → der Arbeits-Punkt wiederholt sich dort.

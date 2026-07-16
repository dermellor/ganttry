# Timelines

Generic timeline viewer for `~/_NOTIZEN`. Reads frontmatter dates from Markdown notes, builds timelines via [vis-timeline](https://visjs.github.io/vis-timeline/), and ships with a brand switcher (marcel-mellor / Acme).

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

1. **Build script** (`scripts/build-data.ts`) walks `~/_NOTIZEN`, parses YAML frontmatter (`gray-matter`), extracts dates, writes `public/data/notes.json` + a copy of the config.
2. **Static viewer** (Vite + TypeScript, `src/`) loads the JSON, applies the active view's filter, renders a vis-timeline, swaps brand tokens via CSS custom properties.

Electron wrapper can later embed the same `dist/` build.

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
pinned to the top plus a faint full-height tint behind the items.

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
SVG), so the same data works across every brand: each brand resolves the key to
its own icon set via a `--icon-<key>` CSS custom property. The stored `content`
stays clean (the glyph is prepended at render time via the vis-timeline
`template`), so it round-trips through the editor, the DB, and exports unchanged.

Curated key set (defined once in [`src/icons.ts`](src/icons.ts)):

`milestone` · `launch` · `done` · `warning` · `blocked` · `review` ·
`deadline` · `meeting` · `idea` · `research` · `design` · `build` · `bug` ·
`release` · `decision` · `goal` · `info` · `note`

Unknown values are dropped (validated by `normalizeIcon`). The base glyphs are
Acme neo-icons, defined in the `:root` block of
[`src/styles/brands.css`](src/styles/brands.css) and inherited by every brand.

**How to render / extend:**

- **Render:** the glyph is a CSS `mask` on `.item-icon` (see
  [`src/styles/timeline.css`](src/styles/timeline.css)), coloured with
  `currentColor` — it adapts to the item/brand text colour automatically.
- **Give a brand its own look:** override any key inside that brand's block,
  e.g. `[data-brand='marcel-mellor'] { --icon-milestone: url("…"); }`.
- **Add a new semantic key:** add it to `IconKey` + `TIMELINE_ICONS` in
  `src/icons.ts` (label shown in the editor dropdown) and add a matching
  `--icon-<key>` to the `:root` set in `brands.css`. It then appears in the edit
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
> field-only for now (stored + editable). List-grouping-by-status could follow.

## Custom fields (per timeline)

Beyond the built-in item fields, each timeline can declare its own **custom
fields**. The *definitions* are timeline-level config (stored on the timeline
row in the `custom_fields` jsonb column, a peer of `phases`); a field's *value*
lives per item in `metadata[key]`. This keeps the field schema per-timeline
while reusing the existing `timeline_items.metadata` column for values.

A definition is:

```jsonc
{
  "key": "tier",                 // metadata key the value is stored under
  "label": "Tier",               // shown in the editor
  "type": "multi-select",        // "text" | "select" | "multi-select"
  "options": [                   // choices for select / multi-select (ignored for text)
    { "value": "Free",       "color": "#64748B" },
    { "value": "Starter",    "color": "#1D9E75" },
    { "value": "Scale",      "color": "#315DFF" },
    { "value": "Enterprise", "color": "#8642FE" }
  ]
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

The **Example Timeline (v1)** timeline carries a seeded `tier` multi-select
(Free / Starter / Scale / Enterprise).

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
(`scripts/db/api.ts`) und Data-Access-Layer (`scripts/db/timeline-repo.ts`) —
eine Implementierung der Storage- und Locking-Semantik für beide Runtimes.

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
- Die committeten `data/<db-id>.json` sind **reine Registrierungs-Stubs**
  (`name`, optional `description`/`groupBy`, `items: []`) — nur damit die Timeline
  in der View-Liste auftaucht (build-data scannt diese Dateien für das Dropdown).
  Sie enthalten **nie** items/groups/phases. `syncTimelinesOnce`
  ([`scripts/build-data.ts`](scripts/build-data.ts)) schreibt genau diesen Stub.

Neue Sync-/Cache-/Fallback-Mechanismen für DB-Timelines, die Inhalte in Dateien,
CDN oder sonstwo spiegeln, sind **nicht** einzuführen. (Datei-basierte Quellen —
die Beispiele — sind kein Widerspruch: dort *ist* die Datei die Quelle, kein
Abzug von etwas anderem.)

### Schema

Drei Tabellen (Migrationen in `supabase/migrations/`):

- `timelines` — id, name, description, group_by, `type`, `phases` (jsonb),
  `custom_fields` (jsonb), `pricing` (jsonb; Tarife + Features für
  `type='product'`, siehe „Pricing").
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

RLS ist an; Server-Zugriff läuft über den Service-Key (bypassed RLS). Anon-
SELECT-Policies existieren nur für die Realtime-Subscription (siehe unten).

Migrationen anwenden (nutzt den gespeicherten `supabase login`, kein DB-Passwort):

```bash
supabase link --project-ref <ref>
supabase db query --linked -f supabase/migrations/<datei>.sql
```

### Setup (einmalig)

Credentials in `~/_AGENTS/.env` (oder `.env.local`), gelesen via
`scripts/db/client.ts`:

| Var                             | Bedeutung                                              |
| ------------------------------- | ------------------------------------------------------ |
| `TIMELINES_SUPABASE_URL`        | `https://<ref>.supabase.co`                            |
| `TIMELINES_SUPABASE_SERVICE_KEY`| Service-Role-Key (Server-seitig, nie in den Client)    |

### Import / Migration

`scripts/db/import.ts` lädt die konfigurierten Timelines aus ihren
`data/<id>.json` in die DB (`replaceTimeline`). Wiederholbar.

```bash
npm run db:import                         # alle
npm run db:import -- acme/mein-plan     # gezielt
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
- **Registrierungs-Stubs:** `npm run build:data` (Teil von `dev`/`build`) schreibt
  für jede DB-Timeline nur einen Stub nach `data/<id>.json` (`name` + `items: []`,
  kein Inhalt). Diese Stubs committen — sie halten die Timeline nur in der
  View-Liste sichtbar, sind aber **kein** Daten-Fallback.
- **Live-Kollaboration:** siehe „Realtime" — ersetzt das frühere 60-s-Polling.

### Production-Setup (Netlify)

Zusätzlich zu den Auth-Env-Vars:

| Var                              | Where              | Notes                                          |
| -------------------------------- | ------------------ | ---------------------------------------------- |
| `TIMELINES_SUPABASE_URL`         | dashboard          | aktiviert die `timelines-api` Edge Function     |
| `TIMELINES_SUPABASE_SERVICE_KEY` | dashboard (secret) | Service-Role-Key für den serverseitigen Zugriff |
| `VITE_SUPABASE_URL`              | dashboard          | build-time; ohne beide erscheinen fremde Edits erst beim Reload (siehe „Realtime") |
| `VITE_SUPABASE_ANON_KEY`         | dashboard          | build-time, public im Bundle; **Redeploy nötig** (Vite backt sie beim Build ein) |

Die Edge Function gated per Session-Cookie (bzw. MCP-Token) und attribuiert
Edits über `updated_by` an die E-Mail des eingeloggten Users. Sind die Vars
nicht gesetzt, fällt jede Source auf die statische Datei zurück (read-only).

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

## MCP server (Claude Code)

Ein stdio-MCP-Server (`scripts/mcp/server.ts`) erlaubt Claude Code, die
DB-basierten Timelines auszulesen und zu manipulieren. Er arbeitet **immer
gegen die Live-Site** (`TIMELINES_LIVE_URL`, Default
`https://example-timelines.netlify.app`): jeder Read/Write geht durch
`/api/source(s)` → `timelines-api` Edge Function → Supabase. Damit bleibt die
DB Single Source of Truth und Änderungen sind sofort live.

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

Die granularen Item-/Group-Tools laufen read-modify-write: der Server holt die
Timeline, mutiert im Speicher und schreibt sie per PUT (Bulk-Replace) zurück.
`dependsOn` und `owner` liegen unter `metadata`.

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
| `TIMELINES_LIVE_URL` | Ziel-Site (Default `https://example-timelines.netlify.app`) |

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

- **Drag** an item left/right to move start, drag the right edge to resize, drag vertically to switch group. Persists on drop.
- **Double-click** on empty timeline space to add a new item (defaults: 1-week duration, current group, content "Neuer Eintrag"). Form opens for further edits. The **+ Eintrag** toolbar button (editable views only) does the same, placing the item at the centre of the visible window. In **list mode** a new item (toolbar or per-section button) is created **date-less** — empty start/end/duration — so it starts as a clean row to fill in via the form; it stays list-only until a start is set.
- **Click** an item to open the edit form in the side panel: title, start/end, duration, group, type, body (Markdown), dependencies, tags, owner, plus a free-form metadata JSON box. Save writes back; Delete removes the item.
- **Depends on** is a title-autosuggest field: type to search the current timeline's items by title (or id), pick to link a dependency (rendered as a removable chip). Stored as `metadata.dependsOn` IDs — the chips just show the target's title.
- **Tags** is a chip editor with autosuggest: type to match tags already used in the timeline, or type a new label and press Enter to create one. Each chip carries its resolved colour and a remove button. Stored as `metadata.tags` (string[]); saving migrates any legacy singular `metadata.tag` into the array.
- **Phases** render as a ribbon along the top. Drag a segment to move it, drag either edge to resize (snaps to whole days, min. 1 day), and click it (without dragging) to open the phase form in the side panel: title, start/end, duration, icon, colour. Persists on drop / Save; Delete removes the phase.

Persistence path: viewer → item-level calls (`POST/PATCH/DELETE /api/source/<id>/item`, `PUT …/phases`) → middleware (`vite.config.ts`) → Supabase via `scripts/db/api.ts`. `PATCH` carries the item `version` in `If-Match`; a stale version returns `409` and the client reloads that item. Only DB-backed sources are editable; genuine file-based sources (the examples) load read-only from their static `/data/sources/<id>.json`. Builds (`npm run build`) and exported HTML have no edit endpoint. For DB-backed timelines, `npm run build:data` writes only a registration **stub** to `data/<id>.json` (`name` + `items: []`, no content) — there is deliberately no committed content cache (see „Prinzip: keine Notfall-/Fallback-Daten").

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
`VITE_JIRA_BASE_URL` (default `https://your-org.atlassian.net`).

## View modes: Timeline / Liste

The header **Ansicht** icon toggle (a segmented two-button control, styled in
[`src/styles/base.css`](src/styles/base.css) as `.mode-toggle` / `.mode-btn`,
active state driven by `aria-pressed`) switches between two renderings of the
*same* active build:

- **Timeline** — the vis-timeline (default).
- **Liste** — a scrollable, grouped table ([`src/listView.ts`](src/listView.ts)):
  sections along a selectable **grouping dimension** (items sorted by start),
  with columns Eintrag (icon + tag pills + content), Start, Ende, Typ, Status,
  Owner. Phase background items are omitted. The milestones-only filter applies
  here too.

  A **Gruppieren** dropdown in the list toolbar (a bar pinned above the
  scrollable body — not in the global app header, since it only applies to the
  list) chooses the dimension: **Gruppe** (default, the item group — build order
  preserved), **Tag** (offered when anything is tagged, from `metadata.tags`),
  and one entry per **custom field** the timeline declares (e.g. **Tier**, from
  `metadata.<key>`). The sectioning is a pure, DOM-free function
  (`computeSections` in [`src/listGrouping.ts`](src/listGrouping.ts), unit-tested
  in `src/listGrouping.test.ts`): multi-valued dimensions (tags, `multi-select`
  fields) list an item under *every* value it carries; items without a value
  land in an "Ohne …" bucket. Custom-field sections order by the field's declared
  `options` first, then by first appearance. The per-section "+ Eintrag" button
  shows only in the Gruppe dimension (it pins the new item to that group). The
  choice persists in `localStorage` (`timelines.listGroupBy`) and falls back to
  Gruppe when the chosen dimension isn't available on the active build.

Both modes share all state and machinery: the timeline instance stays alive
(just hidden) in list mode, so drags, the detail/edit form, and persistence keep
working. Clicking a row opens the same detail panel (or edit form on editable
sources), tracks the selection, and highlights the row — identical to selecting
a timeline item. Edits (form, add, delete) repaint the list live via
`applyBuildToDataSets`. The mode persists in `localStorage`
(`timelines.viewMode`) and in the URL hash (`mode=list`), so list views can be
deep-linked and survive reload.

## URL state

Selected view, opened item, visible time window, milestones-only filter, the
view mode, and (in `select` brand mode) the brand are encoded in the location
hash so links can be shared and back/forward navigation works. Format:

```
#view=<id>&item=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&m=1&brand=<name>&mode=list
```

Only non-default values are written (`mode` only when `list`). Switching views
via the dropdown clears `item` and `from`/`to`. Hash changes from outside the
app (paste, back/forward) re-apply state without reload.

## Configuration: `timelines.config.json`

```jsonc
{
  "notesDir": "~/_NOTIZEN",
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

## Brand switching

CSS custom properties in `src/styles/brands.css`. Body attribute `data-brand="marcel-mellor"` or `data-brand="Acme"` swaps:

- color tokens (bg, fg, accent, item-bg, item-border, …)
- typography (`ABCFavorit` vs. `PX Grotesk` + `Tiempos Headline`)
- mark radius (round vs. square)

Brand persists in `localStorage`. Acme fonts must be present at `public/fonts/acme/` (copy from `~/.claude/skills/graphics/fonts/acme/`).

Two build-time env vars control how the brand selector behaves:

| Var                  | Values                          | Effect                                              |
| -------------------- | ------------------------------- | --------------------------------------------------- |
| `VITE_BRAND_MODE`    | `select` (default) \| `fixed`   | `fixed` hides the dropdown and disables persistence |
| `VITE_DEFAULT_BRAND` | `marcel-mellor` \| `Acme`    | brand applied on first load (and locked in `fixed`) |

## Deploy: Netlify (Acme-internal instance)

A stripped-down deploy lives on Netlify for Acme colleagues. All
config-as-code lives in [`netlify.toml`](netlify.toml); secrets go into the
Netlify dashboard.

### What gets deployed

- Sources: `data/acme/*.json` only (`TIMELINES_SOURCES_SUBDIR=Acme`).
- Notes scan disabled (`TIMELINES_STATIC_ONLY=true`); no Markdown-driven views.
- Brand locked to Acme (`VITE_BRAND_MODE=fixed`, `VITE_DEFAULT_BRAND=Acme`).
- **Editing** is live when the Supabase env vars are set (see „Supabase als
  Datenquelle → Production-Setup"): the `timelines-api` edge function serves
  DB-backed Acme timelines editable. Without those vars, the DB read fails and
  the viewer surfaces an error — there is no static content fallback (see
  „Prinzip: keine Notfall-/Fallback-Daten").

To add a Acme-visible timeline locally: drop the JSON into `data/acme/`,
commit, push.

### Auth gate (Netlify Edge Function)

[`netlify/edge-functions/auth.ts`](netlify/edge-functions/auth.ts) gates every
request. Pattern mirrors `~/Development/sales-cockpit` (Google OAuth +
Acme-domain whitelist), but adapted to a static Vite site:

1. `/auth/login` → redirect to Google with `hd=Acme.de`, signed state cookie.
2. `/auth/callback` → token exchange → `userinfo` → domain check → signed
   session cookie (HMAC-SHA256, 24 h, `HttpOnly; Secure; SameSite=Lax`).
3. Any other path without a valid session → 302 to `/auth/login?redirect=…`.

Set `AUTH_REQUIRED=true` in the Netlify dashboard to activate the gate; leave
unset/`false` for local previews. Required runtime env vars:

| Var                     | Where                  | Notes                                            |
| ----------------------- | ---------------------- | ------------------------------------------------ |
| `AUTH_REQUIRED`         | dashboard              | `true` to gate the site                          |
| `GOOGLE_CLIENT_ID`      | dashboard              | OAuth web client                                 |
| `GOOGLE_CLIENT_SECRET`  | dashboard (secret)     | OAuth client secret                              |
| `AUTH_SECRET`           | dashboard (secret)     | `openssl rand -base64 32`                        |
| `ALLOWED_EMAIL_DOMAINS` | dashboard              | comma-separated, default `Acme.de,Acme.com` |

### Google OAuth setup (one-time)

1. Google Cloud Console → APIs & Services → Credentials → **Create credentials → OAuth client ID** → Web application.
2. Authorized redirect URIs: `https://<your-netlify-site>.netlify.app/auth/callback` (and any custom domain).
3. Authorized JavaScript origins: the same origins without the path.
4. Paste the client ID and secret into Netlify env vars.

If the site moves to a new domain, add the new redirect URI in the Google
Cloud Console — otherwise the callback returns `redirect_uri_mismatch`.

## Pricing

`pricing` (jsonb auf der `timelines`-Zeile, nur `type='product'`) ist die SSOT für
Tarife + Features. Externe Seiten konsumieren es über `GET /api/pricing/<id>`
(öffentlich). Schreiben: MCP `set_pricing` (ersetzt das ganze Modell) bzw.
`PATCH /api/source/<id>` mit `{pricing}`; Markdown-Spiegel: `npm run export:pricing`.

Shape:
- `features[]`: `{ id, name, group, version? }`. `version` = ab welcher getrackten
  Version verfügbar. **Kein `version` = pre-existing** (existierte vor der ersten
  Version) → immer sichtbar, nie „Neu", aber „Modified"-fähig. `feature.version`
  auf die Baseline (`versions[0]`) zu setzen bedeutet „in dieser Version eingeführt"
  — NICHT „schon immer da"; dafür `version` weglassen.
- `tiers[]`: `{ id, name, tagline?, useCase?, targetGroup?, price, values }`.
  `values[featureId]` = `true` (✓) / fehlt|false (–) / String (Wert je Tarif).
- `highlights[]`: `{ id, label, section?, featureIds }` — kuratierte Kacheln der
  Card-Ansicht (bündeln Features); nur was hier referenziert wird, erscheint auf
  den Karten. Matrix zeigt alle Features.
- `versions[]`: geordnete Labels; Switcher filtert Feature-Zeilen kumulativ.

Item↔Feature: `metadata.featureIds` (n:m) + `metadata.featureVersion` (die Version,
für die gearbeitet wird) + `status` (Open/Doing/Done) → speisen den Arbeits-Punkt
und die Zeilen-Badges:
- **„Neu"**: `feature.version` == gepinnte Version (nicht „Alle"). Gilt auch für
  die Baseline (`versions[0]`): ein dort eingeführtes Feature badged „Neu", wenn
  die Baseline gepinnt ist — pre-existing (kein `version`) badged nie.
- **„Modified"**: Feature ist älter als die gepinnte Version (inkl. pre-existing)
  UND es gibt ein Item mit diesem Feature + `featureVersion` == gepinnte Version.
  Schließt „Neu" aus; nur bei gepinnter Version.
- **„ab \<Version\>"**: nur in der „Alle"-Ansicht (keine Version gepinnt, wo „Neu"/
  „Modified" nie feuern). Neutrale Chip, die angibt, ab welcher Version das Feature
  bzw. Highlight dazukam. Matrix: pro Feature mit `version`. Kacheln: pro Highlight
  die früheste `version` seiner beitragenden Features (`introducedVersion` in
  `resolveHighlight`); ein pre-existing Feature im Bündel unterdrückt die Chip.
  Pre-existing Features (kein `version`) bekommen nie eine Chip.

## Offene Ausbaustufen – Preismodell / Kacheln

Noch nicht im Datenmodell abgebildet (aus dem Original-Preismodell), als Backlog:

- Minutenpreis (€/Min) je Tarif als eigenes Feld — aktuell nur `Overage` als Feature-Wert.
- Enterprise-Minutenpakete (S/M/L/Custom mit Staffelpreisen).
- GTM-/Strategie-Daten (a competitor-Äquivalent, Ersparnis vs. a competitor, GTM Product-/Sales-Led, Upgrade-Trigger).
- `highlight.icon` ist im Schema vorhanden, aber ungenutzt (keine Icons je Kachel).

Bekanntes Verhalten: Wert-Highlights (z.B. „Charaktere") erscheinen auf jeder
Tarif-Karte (Wert variiert je Tarif) → der Arbeits-Punkt wiederholt sich dort.

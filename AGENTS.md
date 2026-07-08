# Timelines

Generic timeline viewer for `~/_NOTIZEN`. Reads frontmatter dates from Markdown notes, builds timelines via [vis-timeline](https://visjs.github.io/vis-timeline/), and ships with a brand switcher (marcel-mellor / Acme).

## Git workflow

**No feature branches, ever.** Commit straight to `main` and push. Do not
create, use, or leave behind `feat/*`, `refactor/*`, or any other topic branch —
even when a change feels large. This overrides any default "branch first before
committing on the default branch" behaviour: on this project, `main` is the only
branch.

## Ports

Belegt im 3120er-Block (siehe [`~/Development/PORTS.md`](../PORTS.md)).

| Port | Service                       |
| ---- | ----------------------------- |
| 3120 | Vite dev server (Timeline UI) |

URLs:

- `https://timelines.localhost` — primärer Zugang über Caddy (HTTPS, von PM2 verwaltet)
- `http://localhost:3120` — direkt auf Vite

Crasht bei Port-Konflikt (`strictPort: true`), kein Auto-Fallback.

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
      "start": "2026-01-15",
      "end": "2026-02-28",               // optional; mutually exclusive with duration (end wins)
      "duration": "3w",                  // optional ("7d", "2w", "90m", number = ms) — only when no end
      "content": "Kickoff",
      "group": "Phase 1",                // optional
      "title": "Tooltip text",           // optional
      "type": "point",                   // optional: point | range | background | box
      "icon": "milestone",               // optional: semantic icon key (see "Item icons")
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

Items without `start` or `content` are skipped. Two reference files live in `data/`:

- `example-projektplan.json` — minimal 4-phase plan, single track per phase.
- `launch-roadmap.json` — 5 parallel tracks with `dependsOn` cross-references in `metadata`.

### Roadmap conventions

When generating a roadmap (whether for this project or invoked from elsewhere — see the global pointer in `~/.claude/CLAUDE.md`), follow these conventions so files stay consistent and easy to scan:

- **One file per roadmap.** Filename in kebab-case, no umlauts: `q3-roadmap-2026.json`, `feature-x-launch.json`. Becomes `src:<filename>` in the view list automatically.
- **Group IDs with sort prefix.** `1-strategy`, `2-design`, `3-engineering` — vis-timeline sorts groups alphanumerically; the prefix locks the row order.
- **Item IDs use track prefix + counter.** `S-1`, `D-2`, `E-3`, `M-4`, `O-5`. Short, easy to reference from `metadata.dependsOn`.
- **Milestones as `type: "point"`** with no `duration`/`end`. Phase backgrounds as `type: "background"` in their own group.
- **Dependencies live in `metadata.dependsOn: ["id1", "id2"]`.** The viewer renders subtle right-angle "Gantt" arrows (SVG overlay in [`src/arrows.ts`](src/arrows.ts)) from each predecessor's finish edge to the successor's start edge. When the successor starts before the predecessor finishes (overlapping bars / same row) the connector routes through a vertical corridor instead of doubling back through an item. Off-screen sources/targets simply hide the arrow until they scroll into view. Make sure dependency target items have explicit `id`s so they can be referenced.
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

- `timelines` — id, name, description, group_by, `phases` (jsonb).
- `timeline_items` — Spalten für start/end/duration/content/group/type/title/
  body/icon/class_name, `metadata` (jsonb: `dependsOn`, `owner`, `jira`, freie
  Extras), `version` (Trigger-Bump bei UPDATE), `sort`, `updated_by`. `end` und
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
  → der Client lädt das Item neu.
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
- **Double-click** on empty timeline space to add a new item (defaults: 1-week duration, current group, content "Neuer Eintrag"). Form opens for further edits. The **+ Eintrag** toolbar button (editable views only) does the same, placing the item at the centre of the visible window.
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

## URL state

Selected view, opened item, visible time window, milestones-only filter, and (in `select` brand mode) the brand are encoded in the location hash so links can be shared and back/forward navigation works. Format:

```
#view=<id>&item=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&m=1&brand=<name>
```

Only non-default values are written. Switching views via the dropdown clears `item` and `from`/`to`. Hash changes from outside the app (paste, back/forward) re-apply state without reload.

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

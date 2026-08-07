# Ganttry

A generic, self-hostable timeline and roadmap viewer built on
[vis-timeline](https://visjs.github.io/vis-timeline/). It renders items, groups,
phases and dependency arrows from either static JSON files or a live Postgres
database, and shows the same data as an interactive Timeline or a grouped List.

Two orthogonal extension axes keep it flexible:

- **Source adapters** decide *where* a timeline's data comes from: a static JSON
  file, or Postgres (via either supabase-js or native postgres.js, with optional
  per-source connections).
- **Timeline kinds** decide *what* extra rendering a timeline carries: the
  default `generic` kind is just timeline + list; the `product-roadmap` kind adds
  a pricing matrix and cards, loaded lazily so a generic build ships no pricing
  code.

## Features

- **Timeline + List views** over one build, toggled in the header, sharing all
  state (selection, grouping, filter, edits).
- **Rich items:** phases as a labeled ribbon, right-angle dependency arrows,
  semantic icons, a built-in status field, colour-coded tags, and per-timeline
  custom fields.
- **Editable when DB-backed:** drag to move/resize, double-click to add, edit in
  a side form. Writes are item-level with optimistic locking, so concurrent edits
  do not clobber each other.
- **File sources need no database:** drop a `*.json` into `data/`, it registers
  itself as a read-only view.
- **Two DB drivers, one seam:** supabase-js (HTTP/PostgREST, the Netlify default)
  or native postgres.js (any Postgres via a connection string), selected by env.
- **Live collaboration:** other people's edits appear without reload, via
  Supabase Realtime or a cheap watermark-polling fallback, plus presence avatars.
- **Markdown notes views (optional):** build timelines from frontmatter dates in
  a notes directory.
- **Static HTML export** of any view, and an **MCP server** so Claude Code can
  read and edit DB-backed timelines.
- **Deployable behind auth:** a Netlify edge auth gate (Google OAuth + an
  allowed-domain whitelist), JIRA issue linking, and public pricing endpoints.
- **Single neutral theme,** themeable through CSS custom properties.

## Quickstart

### Self-host with your own Postgres (no Supabase)

```bash
npm install
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16   # 1. Postgres
export TIMELINES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres  # 2. target
npm run db:migrate                                                     # 3. schema
npm run dev                                                            # start the viewer
```

`db:migrate` is a portable runner (no Supabase CLI needed): it applies
`supabase/migrations/*.sql` in order and tracks what has run. To get live updates
without Supabase Realtime, run the server with `TIMELINES_DB_LIVE=poll` (the
client then polls a cheap watermark endpoint). Import example data with
`npm run db:import`.

### Static / file sources only (no database)

Drop a `*.json` timeline into `data/` and run the viewer. The build copies it to
`public/data/sources/<name>.json` and registers it automatically as a read-only
view (`src:<name>`); no database and no config edit required.

```bash
npm install
npm run dev
```

The file shape (items, groups, phases, dependencies, custom fields) is documented
in [`AGENTS.md`](AGENTS.md); `data/example-projektplan.json` and
`data/launch-roadmap.json` are reference files.

### Notes-driven views (optional)

`npm run dev` also scans a Markdown notes directory (`notesDir` in
`timelines.config.json`, overridable with `TIMELINES_NOTES_DIR`) and builds
timelines from frontmatter dates. If that directory does not exist the build
warns and continues with zero notes, so a fresh clone still builds.

## Architecture

Two steps: a build script (`scripts/build-data.ts`) prepares JSON + config, and a
static Vite + TypeScript viewer (`src/`) renders it. The extension seams:

- **Source adapters** (`SourceKind` in `src/types.ts`, `resolveAdapter` in
  `scripts/db/api.ts`): `file` sources load read-only from static JSON; `db`
  sources load live from `GET /api/source/<id>` and are editable. DB access goes
  through one `TimelineRepo` seam (`scripts/db/repo.ts`) with two interchangeable
  drivers, supabase-js (HTTP/PostgREST) or postgres.js (native TCP), selected by
  env. The same dispatcher backs both the local Vite middleware and the Netlify
  edge function.
- **Timeline kinds** (`src/kinds/registry.ts`): `generic` (timeline + list) and
  `product-roadmap` (pricing). A kind is lazily `import()`-ed, so a generic build
  ships no pricing code.
- **Live-update seam** (`watchTimeline` in `src/realtime.ts`): `realtime`
  (Supabase WebSocket) or `poll` (watermark endpoint), chosen per source; file
  sources are static.

For the full data model, schema, MCP server, pricing model, auth gate and deploy
details, see [`AGENTS.md`](AGENTS.md).

## Theming

The viewer ships a single neutral theme defined as CSS custom properties in the
`:root` block of [`src/styles/theme.css`](src/styles/theme.css): colour tokens,
typography (`--font-body` / `--font-headline`), lane colours and mark radius. To
recolour or re-type the viewer, override any of these variables in your own
stylesheet loaded after `theme.css`. There is no runtime brand selector: the
tokens in `theme.css` are the single styling seam.

## Configuration

Environment variables (build-time `VITE_*` are baked into the bundle; server vars
are read from `process.env`, then `~/_AGENTS/.env`, then `.env.local`):

| Var | Purpose |
| --- | --- |
| `TIMELINES_DATABASE_URL` | Postgres connection string. Set to use the native postgres.js driver. Also enables per-source connections via `TIMELINES_DATABASE_URL_<NAMESPACE>`. |
| `TIMELINES_SUPABASE_URL` / `TIMELINES_SUPABASE_SERVICE_KEY` | Supabase project URL + service-role key. Used when `TIMELINES_DATABASE_URL` is unset. |
| `TIMELINES_DB_LIVE` | Set to `poll` to serve DB sources in polling mode (live updates without Supabase Realtime). |
| `TIMELINES_NOTES_DIR` | Overrides `notesDir` for the Markdown notes scan. Missing directory is non-fatal. |
| `TIMELINES_STATIC_ONLY` | `true` skips the notes scan and drops notes-driven views. |
| `TIMELINES_SOURCES_SUBDIR` | Scope the file-source scan to `data/<subdir>/`. |
| `VITE_JIRA_BASE_URL` | Public base URL for JIRA browse links. Empty renders keys as plain text. |
| `AUTH_REQUIRED` / `ALLOWED_EMAIL_DOMAINS` | Netlify edge auth gate: `true` enables it; comma-separated allowed sign-in domains (empty = nobody passes). |

## Deploy (Netlify)

Config-as-code lives in [`netlify.toml`](netlify.toml); instance-specific values
and secrets go in the Netlify dashboard. `netlify build` produces the static site
plus the edge functions (auth gate, timelines API, pricing API). See
[`AGENTS.md`](AGENTS.md) for the auth gate, Supabase/Postgres setup, and the MCP
server.

## Contributing

Issues and pull requests are welcome at
<https://github.com/dermellor/ganttry/issues>.

- Run the test suite with `npm test` (Node's built-in test runner over
  `{src,scripts}/**/*.test.ts`).
- [`AGENTS.md`](AGENTS.md) is the single source of truth for the data model,
  schema, extension seams and conventions. Read it before larger changes and keep
  it in sync when behaviour changes.

## License

MIT. See [`LICENSE`](LICENSE).

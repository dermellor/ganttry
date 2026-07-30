# Timelines

A generic timeline and roadmap viewer built on [vis-timeline](https://visjs.github.io/vis-timeline/). It renders items, groups, phases and dependency arrows from either static JSON files or a live Postgres database, and offers a Timeline view and a grouped List view over the same data. Two orthogonal extension axes keep it flexible: **source adapters** decide where a timeline's data comes from (a static JSON file, or Postgres via either supabase-js or native postgres.js, with optional per-source connections), and **timeline kinds** decide what extra rendering a timeline carries (the default `generic` kind is just timeline + list; the `product-roadmap` kind adds a pricing matrix and cards, loaded lazily).

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
| `VITE_BRAND_MODE` / `VITE_DEFAULT_BRAND` | `select` (default, dropdown) or `fixed`; the brand applied on load (`default` or `Acme`). |
| `VITE_JIRA_BASE_URL` | Public base URL for JIRA browse links. Empty renders keys as plain text. |
| `AUTH_REQUIRED` / `ALLOWED_EMAIL_DOMAINS` | Netlify edge auth gate: `true` enables it; comma-separated allowed sign-in domains (empty = nobody passes). |

## Deploy (Netlify)

Config-as-code lives in [`netlify.toml`](netlify.toml); secrets go in the Netlify
dashboard. `netlify build` produces the static site plus the edge functions (auth
gate, timelines API, pricing API). See [`AGENTS.md`](AGENTS.md) for the auth gate,
Supabase/Postgres setup, and the MCP server.

## License

MIT. See [`LICENSE`](LICENSE).

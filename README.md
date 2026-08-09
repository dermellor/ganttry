# Zeitlines

A generic, self-hostable timeline and roadmap viewer built on
[vis-timeline](https://visjs.github.io/vis-timeline/). It renders items, groups,
phases and dependency arrows from either local files or a live Postgres
database, and shows the same data as an interactive Timeline or a grouped List.

Two orthogonal extension axes keep it flexible:

- **Source adapters** decide *where* a timeline's data comes from: local files (a
  JSON file, or a directory with one Markdown file per item), or Postgres (via
  either supabase-js or native postgres.js, with optional per-source
  connections).
- **Plugins** decide *what* a timeline carries beyond items and groups: a timeline
  with no plugin is just timeline + list; the `product-roadmap` plugin adds a
  pricing matrix and cards plus its own item fields, loaded lazily so a build
  without it ships neither its code nor its stylesheet.

## Features

- **Timeline + List views** over one build, toggled in the header, sharing all
  state (selection, grouping, filter, edits).
- **Rich items:** phases as a labeled ribbon, right-angle dependency arrows,
  semantic icons, a built-in status field, colour-coded tags, and per-timeline
  custom fields.
- **Editable wherever a writable runtime serves the source:** drag to
  move/resize, double-click to add, edit in a side form. Writes are item-level
  with optimistic locking, so concurrent edits do not clobber each other. DB
  sources are editable anywhere; local sources are editable while the dev server
  serves them, because that process has a filesystem to write to.
- **Local sources need no database:** drop a `*.json` into `data/` and it
  registers itself as a view.
- **Two DB drivers, one seam:** supabase-js (HTTP/PostgREST, the Netlify default)
  or native postgres.js (any Postgres via a connection string), selected by env.
- **Live collaboration:** other people's edits appear without reload, via
  Supabase Realtime or a cheap watermark-polling fallback, plus presence avatars.
- **Markdown directories as a source:** a folder with a `timeline.json` and one
  `*.md` per item is a timeline, with item dates taken from frontmatter or from
  the filename.
- **Static HTML export** of any view, and an **MCP server** so Claude Code can
  read and edit DB-backed timelines.
- **Deployable behind auth:** a Netlify edge auth gate (Google OAuth + an
  allowed-domain whitelist), JIRA issue linking, and public pricing endpoints.
- **Single neutral theme,** themeable through CSS custom properties.

## Quickstart

### Self-host with your own Postgres (no Supabase)

One command, if you have Docker: `docker compose up --build` starts a Postgres,
applies the migrations and serves on <http://localhost:3120>. The full picture —
the three deployment shapes and the access gate — is in
[`docs/self-hosting.md`](docs/self-hosting.md). By hand:

```bash
npm install
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16   # 1. Postgres
export TIMELINES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres  # 2. target
npm run db:migrate                                                     # 3. schema
npm run build && npm start                                             # 4. serve it
```

`npm start` runs the built site and the API from one Node process
([`scripts/serve.ts`](scripts/serve.ts)) — that is the supported way to self-host
an **editable** deployment. `npm run dev` is for development; it serves the same
API but through Vite, with a file watcher and no build step.

**It brings no login of its own.** Put an authenticating reverse proxy in front
(oauth2-proxy, Authelia, an SSO ingress) and tell the server which header carries
the identity:

```bash
TIMELINES_TRUSTED_IDENTITY_HEADER=X-Forwarded-Email \
TIMELINES_ALLOWED_EMAIL_DOMAINS=example.com \
npm start
```

That switches the gate on: the header's value becomes the edit's `updated_by`,
and an `/api/*` request arriving **without** it is refused with `401` — so an
origin reached directly, bypassing the proxy, is not editable. Leave the variable
unset and the API is open to anyone who can reach the port; the server says which
of the two modes it is in on every start.

The header is only trustworthy if the proxy strips it from incoming client
requests. The server cannot verify that, which is why naming it is an explicit
decision rather than a sniff for a well-known name.

Static files stay ungated either way. The bundle carries no timeline data, so an
unauthenticated visitor gets an empty shell whose every request the API just
refused.

`db:migrate` is a portable runner (no Supabase CLI needed): it applies
`supabase/migrations/*.sql` in order and tracks what has run. `npm run dev` checks
first and refuses to start with migrations pending, so the app never quietly talks
to an older schema. Live updates need no extra setting: a Postgres without
Supabase Realtime serves its timelines in polling mode automatically (the client
polls a cheap watermark endpoint), and `TIMELINES_DB_LIVE` overrides that either
way. Import example data with `npm run db:import`.

### Local sources only (no database)

Drop a `*.json` timeline into `data/` and run the viewer. The build copies it to
`public/data/sources/<name>.json` and registers it automatically as a view
(`src:<name>`); no database and no config edit required. Under `npm run dev` that
view is editable and edits land back in your file; a static deploy serves the
same file read-only, because there is no process behind it to write with.

```bash
npm install
npm run dev
```

Add `"$schema": "../schema/timeline.schema.json"` at the top and your editor
completes and validates the file. That schema is generated from the TypeScript
types, so it cannot drift from what the app actually reads.
`data/example-projektplan.json` and `data/launch-roadmap.json` are reference files;
[`AGENTS.md`](AGENTS.md) explains the constraints a schema cannot express, such as
why `end` and `duration` are mutually exclusive.

### Directory sources: one Markdown file per item

A directory under `data/` is a timeline as well, as soon as it holds a
`timeline.json`. That container file carries what no single item owns (`groups`
including `nestedGroups`, `phases`, `groupBy`, `customFields`, `plugins`, `name`,
`description`) and has no `items` array, because the items are the Markdown files
next to it. The view id is the directory path relative to `data/`, so
`data/notes/roadmap/` becomes `src:notes/roadmap`.

An item's dates come from its frontmatter, falling back to a date at the start of
the filename. Which frontmatter keys count and which filename patterns are tried
is set in `timelines.config.json` (`dateFields`, `filenameDatePatterns`); the
first match in that order wins. Editing such an item patches the one frontmatter
key that changed and leaves the rest of the file untouched, down to key order,
comments and blank lines, so a folder you also edit by hand does not come back as
a diff over every file. Deleting moves the file to `.trash/` rather than
unlinking it.

A `"$schema"` key in `timeline.json` pointing at `schema/container.schema.json`
gets you editor completion for it, the same way a JSON timeline points at
`schema/timeline.schema.json`. The design, the write path and what is deliberately
still missing are in [`docs/local-sources.md`](docs/local-sources.md).

## Architecture

Two steps: a build script (`scripts/build-data.ts`) prepares JSON + config, and a
static Vite + TypeScript viewer (`src/`) renders it. The extension seams:

- **Source adapters** (`SourceKind` in `src/types.ts`, `resolveAdapter` in
  `scripts/db/api.ts`): `local` sources are files the user owns, a JSON file or a
  directory of Markdown; `db` sources live in Postgres. Whether a local source is
  editable is decided by the runtime rather than by the format, stamped per source
  into `view.source.editable` at build time and corrected upwards by the dev
  server, so the client routes on one given value instead of probing. An editable
  source loads from `GET /api/source/<id>`, a read-only one from the static copy
  the build wrote. DB access goes through one `TimelineRepo` seam
  (`scripts/db/repo.ts`) with two interchangeable drivers, supabase-js
  (HTTP/PostgREST) or postgres.js (native TCP), selected by env. The same
  dispatcher backs both the local Vite middleware and the Netlify edge function.
- **Plugins** (`src/pluginHost/registry.ts`, plugins under `src/plugins/<id>/`):
  a plugin declares item fields and optionally views, which the host renders into
  chrome it creates itself. Lazily `import()`-ed, so a generic build ships no
  plugin code and no plugin CSS.
- **Live-update seam** (`watchTimeline` in `src/realtime.ts`): `realtime`
  (Supabase WebSocket) or `poll` (watermark endpoint), chosen per source. A local
  source polls a filesystem watermark while the dev server serves it, and is
  static on a deploy, where nothing can change under it.

The HTTP API is described in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1, generated
from the TypeScript types), including the public, unauthenticated pricing endpoint
and the optimistic-locking contract.

[`docs/overview.md`](docs/overview.md) maps the layers onto each other: the path a
request takes from the viewer down to a store, and how one timeline type is laid
out as Postgres rows, as a single JSON file, or as a directory of Markdown. Each
subsystem is then documented with its reasoning in [`docs/`](docs/): data model,
items, editing, database, local sources, MCP, deploy, pricing. [`AGENTS.md`](AGENTS.md)
is the index plus the conventions that apply everywhere.

## Plugins

A plugin contributes item fields, and optionally a view, to any timeline. It is
enabled per timeline as data, and its code is loaded lazily, so a build carries only
what the timelines in front of you actually use.

| Plugin | What it adds |
| --- | --- |
| [`product-roadmap`](src/plugins/product-roadmap/) | A pricing matrix and pricing cards, plus Version, Tier and Features fields derived from the pricing model. See [`docs/pricing.md`](docs/pricing.md). |

Building one: [`docs/plugin-playbook.md`](docs/plugin-playbook.md), starting from
[`src/plugins/_template/`](src/plugins/_template/).

## Theming

The viewer ships a single neutral theme defined as CSS custom properties in the
`:root` block of [`src/styles/theme.css`](src/styles/theme.css): colour tokens,
typography (`--font-body` / `--font-headline`), lane colours and mark radius. To
recolour or re-type the viewer, override any of these variables in your own
stylesheet loaded after `theme.css`. There is no runtime brand selector: the
tokens in `theme.css` are the single styling seam.

## Configuration

Environment variables (build-time `VITE_*` are baked into the bundle; server vars
are read from `process.env`, then `.env.local`, then any file named by
`TIMELINES_ENV_FILE`):

| Var | Purpose |
| --- | --- |
| `TIMELINES_ENV_FILE` | Optional. Extra `.env` file(s) to read, `:`-separated, `~/` allowed. Off by default, so a fresh checkout reads nothing outside the repo. Use it when your credentials live elsewhere. |
| `TIMELINES_DATABASE_URL` | Postgres connection string. Set to use the native postgres.js driver. Also enables per-source connections via `TIMELINES_DATABASE_URL_<NAMESPACE>`. |
| `TIMELINES_MIGRATE_DATABASE_URL` | Connection used **only** for schema work (`db:migrate`, `db:check`). Needed on a Supabase-backed instance, because migrations are DDL and cannot run over PostgREST. Setting it does not change which driver serves the app. |
| `TIMELINES_SUPABASE_URL` / `TIMELINES_SUPABASE_SERVICE_KEY` | Supabase project URL + service-role key. Used when `TIMELINES_DATABASE_URL` is unset. |
| `TIMELINES_DB_LIVE` | Overrides the live-update mode of DB sources: `poll` (watermark polling, works against any Postgres) or `realtime` (Supabase Realtime). Unset derives it from the configured backend, so a plain Postgres already polls. |
| `TIMELINES_SERVE_PORT` / `TIMELINES_SERVE_HOST` | `npm start` only. Where the self-hosted server listens; defaults to `TIMELINES_PORT` (3120) on `127.0.0.1`. Bind to `0.0.0.0` only behind a proxy — the server has no auth of its own. |
| `TIMELINES_DIST_DIR` | `npm start` only. The built site to serve, default `dist/`. |
| `TIMELINES_TRUSTED_IDENTITY_HEADER` | `npm start` only. Name of the request header an authenticating proxy sets (e.g. `X-Forwarded-Email`). Setting it **switches the gate on**: its value becomes the edit's `updated_by` and registers in the user directory, and an `/api/*` request arriving without it is refused (`401`). Unset leaves the API open to anyone who reaches the port. Only set this when the proxy strips the header from client requests. |
| `TIMELINES_ALLOWED_EMAIL_DOMAINS` | `npm start` only, and only with the above. Comma-separated e-mail domains allowed through the gate, matched exactly (`example.com` does not admit `evil-example.com` or `mail.example.com`). Empty means any identity the proxy vouches for. |
| `TIMELINES_SOURCES_SUBDIR` | Scope the local-source scan to `data/<subdir>/`. |
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
<https://github.com/dermellor/zeitlines/issues>. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the checks CI runs, and the
conventions worth knowing. Contributing needs **no database**: local sources run
on a plain `npm install && npm run dev`. Requires Node 22 or newer.

[`AGENTS.md`](AGENTS.md) is the single source of truth for the data model, schema,
extension seams and conventions. Read it before larger changes and keep it in
sync when behaviour changes.

Security reports go through a private advisory, not a public issue: see
[`SECURITY.md`](SECURITY.md). Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT. See [`LICENSE`](LICENSE).

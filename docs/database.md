# Database

Postgres as the data source: schema, drivers, locking, realtime, presence.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

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
> ([`scripts/db/repo.ts`](../scripts/db/repo.ts); every storage method takes a bound
> client rather than a leading client parameter):
> - **`supabase-js`** ([`scripts/db/timeline-repo-supabase.ts`](../scripts/db/timeline-repo-supabase.ts),
>   factory `makeSupabaseRepo(db)`) speaks HTTP/PostgREST, runs in the Deno edge
>   without raw TCP, and is **the default the Netlify deploy runs on**. Node
>   client: `getServiceClient()` ([`scripts/db/client.ts`](../scripts/db/client.ts)).
> - **`postgres.js`** ([`scripts/db/timeline-repo.ts`](../scripts/db/timeline-repo.ts),
>   factory `makePostgresRepo(sql)`) is **opt-in** for self-hosters with their own
>   Postgres, reached through a connection string (`TIMELINES_DATABASE_URL`). Node
>   factory: `getSql()` ([`scripts/db/sql.ts`](../scripts/db/sql.ts), with
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
> [`src/realtime.ts`](../src/realtime.ts) for browser realtime, which is unaffected.
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
  ([`src/editor.ts`](../src/editor.ts), `loadSource`).
- DB timelines are **not** registered through committed files. `build-data`
  queries the DB at build time (`collectDbSources` in
  [`scripts/build-data.ts`](../scripts/build-data.ts)) and writes one
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
  for `Open|Doing|Done`, see „Item status" (docs/items.md)), `metadata` (jsonb: `dependsOn`,
  `owner` — the linked user's e-mail, see „Item owner" (docs/items.md) — `jira`, and free-form
  extras), `version` (bumped by trigger on UPDATE), `sort`, `updated_by`. Only
  `content` is required; `start` is nullable since migration
  `0006_start_nullable` (an entry created through the list may be date-less and
  then appears only in the list view, not on the timeline). `end` and `duration`
  are mutually exclusive (extent is either/or, `end` wins), enforced in the write
  layer for every path (`enforceExtentExclusivity` plus patch-aware clearing of
  the counterpart in [`scripts/db/timeline-repo.ts`](../scripts/db/timeline-repo.ts),
  the MCP `add_item`/`update_item`, and the client form). When `end` is set it
  must lie **after** `start`; reversed or zero-length extents are rejected with
  `400` (the rule lives in [`src/itemExtent.ts`](../src/itemExtent.ts), see
  „Standalone JSON timelines" (docs/data-model.md)). There is no DB CHECK for it, because `start` and
  `end` are `text` columns.
- `timeline_groups` — id, content, nested_groups, show_nested, sort.
- `app_users` — the **user directory** an item owner points at (migration
  `0015`): `email` as PK, optional `name`, `first_seen_at`, `last_seen_at`. Not
  timeline-scoped (a collection-level concept, like `listTimelines`), with no
  `version` column and no optimistic locking: a row carries no user-written
  content, only the identity the auth provider asserts anyway. No anon SELECT —
  it is read through the server-gated `/api/users` endpoint (service key) and
  never subscribed to. It fills itself (see „Item owner" (docs/items.md)).
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
against *any* Postgres, with no Supabase CLI needed.
[`scripts/db/migrate.ts`](../scripts/db/migrate.ts) (postgres.js) creates a
`schema_migrations` tracking table and applies `supabase/migrations/*.sql` in
filename order, each in **one transaction**, with a checksum (which warns on
drift). Re-runs apply only what is pending.

**Orchestration is [umzug](https://github.com/sequelize/umzug), the semantics are
ours.** umzug contributes the ordering, the pending loop and a storage seam; it has
no database knowledge, so the three things that actually matter are explicitly
*not* delegated: the **checksums** ([`pending.ts`](../scripts/db/pending.ts)), the
**one transaction per file**, and the **guardrails** below. The reason to use a
framework at all is shape rather than features: the same three hooks (context /
resolve / storage) fit a SQLite store and, later, a writable notes directory, so
those get this same process without a second runner to maintain. For Postgres
alone it is a lateral move, and worth knowing as such before someone "simplifies"
it back out.

One trap it costs, documented because it wastes an afternoon otherwise: umzug
accepts a context *or* a factory and decides with `typeof context === 'function'`.
A postgres.js handle **is** callable (`sql(…)` interpolates an identifier), so
passing it directly makes umzug invoke it and postgres.js answers
`NOT_TAGGED_CALL` before a single migration runs. Hence `context: () => sql`.

#### Guardrails on the set itself

Pure rules over filenames in
[`migration-rules.ts`](../scripts/db/migration-rules.ts), applied before anything
runs and unit-tested directly. Each one exists because the failure is cheap to
prevent at the name and expensive to untangle afterwards.

| Rule | Why | On violation |
| --- | --- | --- |
| `NNNN_lower_snake_case.sql` | filename order *is* apply order; three digits or mixed case sort unpredictably | exit 2 |
| Numbers unique | two branches each grabbing `0016_` merge cleanly, then apply in alphabetical order of their slugs — which neither author intended | exit 2 |
| Migration files committed | applying an uncommitted file gives this database a schema nobody can reproduce, and amending it afterwards leaves a checksum drift that never clears | exit 2, or `--allow-dirty` |
| `*_breaking.sql` applied alone | it removes a shape the *running* code may still read, so it is sequenced by hand: additive files first, deploy, then the breaking one | applies up to it, then stops with the command |

Gaps in the numbering are deliberately fine: a reverted migration leaves one, and
renumbering to close it renames a file other databases already record as applied,
which then reads as pending to them forever.

The breaking rule has one exception, and it is the reason `db:reset` works: a
database with **nothing** applied yet has no running code to protect, so a fresh
setup applies the whole set in one go.

Pure data cleanups are **not** migrations — a one-off script belongs in
`scripts/`, because a migration is a schema change every database must replay
forever, while a cleanup is a thing that happened once to one dataset.

### The pending check (`npm run db:check`)

`npm run dev` runs this first, and refuses to start when migrations are pending.
The failure it prevents: pull a branch that adds a migration, start the server, and
the app talks to the old schema. It surfaces as
`Could not find the table 'public.X' in the schema cache`, which reads like a code
bug — so the search starts in the wrong file.

It **verifies, it never applies.** Applying stays a deliberate `npm run db:migrate`,
because a schema change should not happen as a side effect of starting a server.

What each state does, all nine verified against a throwaway Postgres:

| State | Result |
| --- | --- |
| Migrations pending | **exit 1**, names the files and the command |
| No `schema_migrations` table | **exit 1**, offers `db:migrate` or `--baseline` |
| Applied file edited afterwards (checksum drift) | warns, exit 0 — the schema *is* current, but the committed SQL no longer matches what ran |
| Everything applied | exit 0 |
| No database configured at all | silent, exit 0 |
| Database unreachable | warns, exit 0 |
| Only supabase-js configured | warns, exit 0 — see below |

The last two never fail on purpose. A checkout serving only Markdown notes or
`data/*.json` has no Postgres, and CI builds without credentials by design, so a
hard gate there would block people on a database they never use. An unreachable
database is an environment problem the developer notices through the app itself; a
pending migration is a code/schema mismatch they cannot see.

**Schema work needs its own connection: `TIMELINES_MIGRATE_DATABASE_URL`.**
Migrations are DDL and the tracking table is deliberately not exposed through
PostgREST, so neither the runner nor the check can work over supabase-js — a
service key is not enough. That used to force `TIMELINES_DATABASE_URL`, which also
**switches the app's driver** from supabase-js to postgres.js: a behaviour change
nobody wants when all they need is to apply a migration. The separate variable
decouples the two, and falls back to `TIMELINES_DATABASE_URL` so a setup already
running postgres.js needs nothing new. On Supabase, the Supavisor pooler string
works.

Until it is set, an instance on supabase-js gets a warning rather than a check: the
question cannot be answered from that connection, and pretending otherwise would be
worse than saying so.

```bash
npm run db:migrate                  # apply pending migrations
npm run db:migrate -- --status      # list applied / pending
npm run db:migrate -- --baseline    # record ALL current files as "applied" WITHOUT
                                    # running them — for a DB already migrated by
                                    # hand (see below)
npm run db:migrate -- --breaking    # also apply the next *_breaking.sql
npm run db:migrate -- --allow-dirty # apply with uncommitted migration files
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
[`src/pluginHost/plugins.ts`](../src/pluginHost/plugins.ts) (`PRODUCT_ROADMAP_PLUGIN`, `hasPlugin`,
`pluginConfig`, `versionsFromConfig`, `resolveWritePlugins`).

**What is generic today:**

- **Storing and reading.** `timeline_plugins` accepts any `plugin_id`/`config`;
  `getTimeline` reads **every** row into `file.plugins` (`PluginRef[]`),
  regardless of plugin. It round-trips through both drivers.
- **Enabling (bulk).** Through the MCP `replace_timeline` with
  `plugins: [{ id, config }]`, or direct SQL/PATCH. Identical locally and in
  production (same `api.ts` dispatcher, same DB).

- **Enabling (granular).** `PUT` / `DELETE /api/source/<id>/plugin/<pluginId>`,
  plus the MCP `enable_plugin` / `disable_plugin`. Turning one plugin on or off no
  longer means rewriting the whole timeline — which was the path that lost a
  concurrent edit. The config is validated against the plugin's declared
  `configSchema` on write. See [`plugin-lifecycle.md`](plugin-lifecycle.md).
- **Installed (instance level).** `installed_plugins` (migration 0017) plus
  `/api/plugins`, which is what makes „install a plugin" a row rather than a new
  build.

**What is NOT generic (yet):**

- **Behaviour is code-coupled.** `resolveWritePlugins` / `updateVersions` /
  `getPublicPricing` are hard-wired to `product-roadmap`, and client-side
  the plugin registry ([`src/pluginHost/registry.ts`](../src/pluginHost/registry.ts)) lists only
  `product-roadmap`. A row with an unknown `plugin_id` is stored and served, but
  **nothing consumes it** until code interprets it.

**Adding a new plugin:**

1. **Enabling is a data row** (`replace_timeline`/SQL). Needs no schema change.
2. **Its own view?** → a new the plugin registry entry plus a `src/plugins/<name>/` folder
   (lazily loaded, see „Plugins" (docs/architecture.md)). No core file changes.
3. **Its own item fields?** → `fields(file)` on the the plugin registry entry, implemented
   in `src/plugins/<name>/fields.ts` (import only `types` and `plugins`, or the
   seam pulls the view chunk into the generic build). They appear automatically as
   a section under the plugin's `label`, and as a grouping/filter dimension — see
   „Custom fields → Plugin-contributed fields" (docs/items.md). No core file changes.
4. **Its own persisted data?** → its own tables plus a write path (model:
   `pricing_*` and `assemblePricing`). Never a column on the core.
5. Reads through `file.plugins` already work. The product-specific auto-enable
   behaviour (`resolveWritePlugins`) is a model to copy, not an obligation.

### Setup (one-time)

Credentials go in `.env.local`, read through the cascade in
[`scripts/db/env.ts`](../scripts/db/env.ts) (`process.env` → `.env.local` → the files
named by `TIMELINES_ENV_FILE`, see „Credential cascade" below). Depending on the
chosen driver (see „Drivers"): supabase-js through `getServiceClient()`
([`scripts/db/client.ts`](../scripts/db/client.ts)), postgres.js through `getSql()`
([`scripts/db/sql.ts`](../scripts/db/sql.ts)):

| Var                              | Driver       | Meaning                                                                   |
| -------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `TIMELINES_SUPABASE_URL`         | supabase-js  | `https://<ref>.supabase.co` (the default path)                            |
| `TIMELINES_SUPABASE_SERVICE_KEY` | supabase-js  | Service-role key (server-side only, never in the client)                  |
| `TIMELINES_DATABASE_URL`         | postgres.js  | Postgres connection string (`postgresql://…`); when set, it wins over supabase-js. On Supabase use the Supavisor transaction pooler (port 6543). Any Postgres works. |

Ist `TIMELINES_DATABASE_URL` gesetzt, läuft alles über postgres.js; sonst über
supabase-js.

#### A local database as the safe default (`dev:local`)

Without this, whatever the credentials point at *is* your development target, and
for a hosted instance that means `npm run dev` edits production data. Trying a
migration out then has no safe place to happen, which is the friction the local
tier removes. Three commands, no env setup and no Supabase:

```bash
npm run db:local:up   # throwaway Postgres in Docker (port 55432)
npm run db:reset      # drop schema → migrate → seed from data/*.json
npm run dev:local     # dev server against that database
```

`db:local:down` stops it again; the container runs with `--rm`, so there is nothing
to clean up. Port **55432** rather than 5432 on purpose, so it cannot collide with
a Postgres already installed on the machine.

`db:reset` is the destructive one, so it carries two safety properties worth
knowing:

- **It refuses any host that is not local, with no override flag.** A flag that
  unlocks dropping a remote schema is a flag someone eventually passes from muscle
  memory against production. Wiping a hosted database is a job for the provider's
  own tooling, where the blast radius is on screen.
- **The chain sets both connection variables.** The seed step
  ([`import.ts`](../scripts/db/import.ts)) uses the *app* connection, not the
  migration one, so setting only `TIMELINES_MIGRATE_DATABASE_URL` would let it fall
  back to supabase-js and seed **the live database**. `db:reset` therefore sets
  `TIMELINES_DATABASE_URL` as well; keep them together if you rewrite that chain.

`dev:local` sets `TIMELINES_DB_LIVE=poll` explicitly, and still needs to even
though `defaultLive` now derives polling for a bare Postgres: a `.env.local` that
also carries the hosted Supabase vars makes the derived answer `realtime`, and
the client would then try that instance's anon key against a local database (see
„Live-update seam").

The migrate step inside `db:reset` passes `--allow-dirty`, since a throwaway target
is exactly where iterating on an uncommitted migration is correct. The guardrail it
waives protects *shared* databases, and `db:reset` cannot reach one.

`0000_prereq_roles.sql` handles the `anon` role and the publication idempotently,
so a vanilla Postgres needs no manual preparation. Verified: all 16 migrations
apply to an empty `postgres:16`, and the seed lands two timelines.

#### Credential cascade (`TIMELINES_ENV_FILE`)

Every Node entry point reads configuration through **one** implementation:
`envValue()` in [`scripts/db/env.ts`](../scripts/db/env.ts). The order is
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
[`scripts/db/env.test.ts`](../scripts/db/env.test.ts). `envSourcesHint()` phrases the
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
(`getSqlForSource`/`connectionEnvKey` in [`scripts/db/sql.ts`](../scripts/db/sql.ts)).
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
  [`scripts/db/timeline-repo.ts`](../scripts/db/timeline-repo.ts)), so a cleared
  optional field — for instance the last `metadata.dependsOn` being removed, which
  makes `metadata` disappear from the item entirely — has to be sent as an
  **explicit `null`**, or the old DB value survives and reappears on reload. The
  client therefore builds the patch through `buildItemPatch`
  ([`src/persistence.ts`](../src/persistence.ts)), which sets every missing clearable
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
isBusy })` in [`src/realtime.ts`](../src/realtime.ts). Which one applies is declared
by the source through `capabilities.live` (`SourceLive` in
[`src/types.ts`](../src/types.ts)):

- **`realtime`** — Supabase Realtime pushes row changes over a WebSocket
  (`subscribeTimeline`, fine-grained item events with echo suppression). Needs the
  anon key (`VITE_SUPABASE_*`); without it nothing happens and updates are
  reload-only.
- **`poll`** — the client polls a cheap **watermark endpoint**
  (`GET /api/source/<id>/watermark` → `{ v, n, t, pv?, pn? }`: max item `version`,
  item count, max `updated_at` across items plus the `timelines` row, and the same
  version/count pair over the plugin-owned rows) on an
  interval (`src/poll.ts`: ~8 s while visible, ~60 s while hidden, backing off on
  `visibilitychange`). When the watermark changes it triggers a **full reload**
  through the existing `loadSource` path; timelines are small, and a delta fetch is
  a later optimisation. This needs **no** anon key, because the endpoint is
  server-gated, which is what makes a Postgres **without** realtime live. The poll
  pauses while an edit form is open (`isBusy`), and a change detected meanwhile is
  not discarded but applied afterwards.
- **`none`** — no live updates: a local source read from its static copy, where
  no process is serving it and nothing can change under it.

The server tells the client which mode applies through the **`X-Source-Live`
response header** on `GET /api/source/<id>`, set by the runtime glue from
`adapter.capabilities.live`; `loadSource` reads it and stores it in
`state.activeSourceLive`.

**Which mode a DB source reports is derived, not configured.** `defaultLive`
([`scripts/db/api.ts`](../scripts/db/api.ts)) answers `realtime` when a Supabase
project is configured and `poll` otherwise, because Realtime needs such a project
while the watermark endpoint works against any Postgres. The check is „are the
Supabase vars set", not „which driver won": a deployment may deliberately run
postgres.js *against* a Supabase database (see „Drivers"), and that setup keeps
realtime.

The env var **`TIMELINES_DB_LIVE`** (`process.env` locally, `Deno.env` on
Netlify) overrides the derived value in either direction, `poll` or `realtime`.
Both runtimes parse it through the shared `liveOverride`, so an unrecognised
value defers to the default instead of being coerced into a mode.

> This used to default to `realtime` unconditionally, which broke the plain
> self-hosted Postgres case silently: the server claimed realtime, the client
> found no `VITE_SUPABASE_ANON_KEY`, and did nothing — edits appeared on reload
> only, with nothing saying why. The client now falls back to polling when it is
> told `realtime` without an anon key (`watchTimeline` in
> [`src/realtime.ts`](../src/realtime.ts)), so both halves of that mismatch are
> covered.

> **Scope:** the watermark covers items, timeline metadata (including phases) and
> the plugin-owned rows in `plugin_data` (`pv`/`pn`), but **not** the `pricing_*`
> tables. Those move onto the generic store in
> <https://github.com/dermellor/ganttry/issues/17>, at which point product-roadmap
> is covered by `pv`/`pn` like any other plugin — adding a third pair for tables
> with a scheduled removal date would be work with a shelf life. `pv`/`pn` are kept
> apart from `v`/`n` because `v` is the item row version and doubles as the
> own-echo hint; see [`plugin-storage.md`](plugin-storage.md).

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
via `refreshActiveSourceInPlace` ([`src/render.ts`](../src/render.ts), through
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
[`src/realtime.ts`](../src/realtime.ts)), so it needs no DB table access and no RLS
policy. [`src/presence.ts`](../src/presence.ts) renders it into the `#presence`
element, with a colour and initials per e-mail; your own avatar gets a ring.
Multiple tabs belonging to one person are deduplicated by e-mail, and from the
sixth user on the rest collapses into „+N".

Its lifecycle hangs off `setupRealtime`
([`src/persistence.ts`](../src/persistence.ts)): switching views unsubscribes the old
presence and clears the badge, then joins again for editable sources. Same opt-in
condition as realtime (`VITE_SUPABASE_*`); without those vars the badge stays
empty.

Your own identity comes from the `GET /api/me` endpoint, because the session
cookie is HttpOnly and the client otherwise does not know who it is: the Netlify
edge function [`netlify/edge-functions/me.ts`](../netlify/edge-functions/me.ts) reads
the session (`{ email, name }`) behind the auth gate, while the Vite middleware
serves `{ email: 'local' }` locally. When no identity is known (an ungated site)
the client tracks anonymously as „Gast".

**Testing it locally:** a `dev_user` cookie overrides the dev identity (`/api/me`
in [`vite.config.ts`](../vite.config.ts)); without it every tab is the same „local"
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
[`src/presenceModel.ts`](../src/presenceModel.ts)).

- **Sending:** `joinPresence` returns a `PresenceHandle`, and
  `publishSelfPresence` ([`src/persistence.ts`](../src/persistence.ts)) reports through
  `setActivity` which item we occupy (the open form, otherwise the timeline
  selection). Unchanged activity is not put on the channel.
- **`editing` vs. selected:** on an editable source a click opens the form
  immediately, so „clicked" and „editing" would mean the same thing. Therefore
  `markSelfEditing` only reports `editing` on an actual change (a form keystroke
  via `scheduleLiveEdit`, a drag or resize via `handleMove`) and lets it fall back
  to „selected" after `EDITING_LINGER_MS` of quiet.
- **Rendering:** [`src/itemPresence.ts`](../src/itemPresence.ts) writes the ring
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
  [`src/presenceModel.test.ts`](../src/presenceModel.test.ts).

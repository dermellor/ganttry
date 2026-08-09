# Self-hosting

Running Zeitlines on your own machine: the three deployment shapes, what each one
can do, and what you have to decide.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Three shapes, one question

Everything follows from one decision: **should people edit timelines in the
browser?** Editing needs a process that can write, which is the only reason the
second and third shapes exist.

| | Files only | Self-hosted with Postgres | Netlify |
| --- | --- | --- | --- |
| Runs on | any static host | one Node process | the host's edge |
| Data in | `data/*.json`, committed | your Postgres | Supabase or your Postgres |
| Editable | no | yes | yes |
| Login | whatever fronts it | a proxy you put in front | built-in (Google OAuth) |
| Start with | `npm run build` | `npm start` | `netlify build` |

Read-only is not a lesser shape. A roadmap that a team reads and one person
maintains in Git is a legitimate setup, and it is the one with nothing to
operate.

## Files only

```bash
npm install
npm run build
```

Drop a `*.json` into `data/`, and the build registers it as a view and copies it
into `dist/`. Upload `dist/` anywhere. No database, no server, no configuration.

The shape of those files is described in [`docs/data-model.md`](data-model.md);
adding `"$schema": "../schema/timeline.schema.json"` at the top gets you
completion and validation in an editor.

## Self-hosted with your own Postgres

### One command

```bash
docker compose up --build
```

[`docker-compose.yml`](../docker-compose.yml) starts a Postgres and the app,
waits for the database to be *ready* rather than merely running, applies the
migrations and serves on <http://localhost:3120>. `TIMELINES_PUBLISH_PORT`
moves the published port, which matters on a machine that also runs the dev
server — both default to 3120.

It is a starting point, not a production template: the password is the obvious
placeholder and nothing authenticates. See „Access" below before it faces anyone
else.

### Or by hand

```bash
npm install
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export TIMELINES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres
npm run db:migrate     # portable runner, no Supabase CLI needed
npm run build
npm start
```

`npm start` ([`scripts/serve.ts`](../scripts/serve.ts)) serves the built `dist/`
and the API from one process. It listens on `127.0.0.1:3120` by default —
`TIMELINES_SERVE_HOST` / `TIMELINES_SERVE_PORT` move it, and binding to
`0.0.0.0` is a decision to make after reading „Access".

**`npm run dev` is not this.** It serves the same API, but through Vite with a
file watcher and no build step. It is for development, and it is also the only
runtime that serves *local* sources editable, because it is the one with a
filesystem behind the request (see [`docs/local-sources.md`](local-sources.md)).

### Migrations are not optional

`npm run dev` refuses to start with migrations pending. `npm start` has no such
check — it is a server, not a workflow — so the container applies them in its
entrypoint before serving, and a failure stops the container rather than serving
against a schema older than the code.

Running by hand, `npm run db:migrate` is yours to remember. `npm run db:check`
answers whether anything is pending.

### Live updates need no setting

A Postgres without Supabase Realtime serves its timelines in polling mode
automatically: the server derives the mode from the configured backend and tells
the client in the `X-Source-Live` header. `TIMELINES_DB_LIVE` overrides it in
either direction. The reasoning is in
[`docs/database.md`](database.md) → „Live-update seam".

## Access

**The server brings no login.** With nothing configured, anyone who reaches the
port can edit, and every write is attributed to `self-hosted`. That is a
legitimate choice for a port only you can reach, and the server states which mode
it is in on every start rather than leaving you to find out.

For anything else, put an authenticating proxy in front — oauth2-proxy,
Authelia, an SSO ingress — and name the header it sets:

```bash
TIMELINES_TRUSTED_IDENTITY_HEADER=X-Forwarded-Email \
TIMELINES_ALLOWED_EMAIL_DOMAINS=example.com \
npm start
```

Naming the header switches a **gate** on, and this is the part worth
understanding: an `/api/*` request that arrives *without* it is refused with
`401`. Without that, putting SSO in front would protect nothing from anyone who
reaches the origin directly, which is precisely the risk that "we have SSO in
front" hides.

Two carve-outs, both deliberate:

- **`GET /api/pricing/<id>` stays public.** It is public by contract
  (`security: []` in [`openapi.yaml`](../openapi.yaml)) and fetched by external
  pages that have no session.
- **Static files stay ungated.** The bundle carries no timeline data, so an
  unauthenticated visitor gets a shell whose every request the API refuses, and
  gating assets breaks the redirect dance of some proxies.

The header is only trustworthy if the proxy **strips it from incoming client
requests**. The server cannot verify that, which is why naming it is an explicit
decision rather than a sniff for a well-known name. The policy itself is a pure
function in [`scripts/access.ts`](../scripts/access.ts), covered by tests.

There is no TLS option. A reverse proxy terminates it better than a bespoke
implementation would, and one is already in the picture for the gate.

## What the three runtimes share

The API is served by the Vite dev middleware, the Netlify edge functions and
`npm start`. Routing, optimistic locking, the live-mode header and the error
mapping are **one module**
([`scripts/db/http.ts`](../scripts/db/http.ts)), so the three cannot answer
differently; what each runtime keeps is only what genuinely differs — its
credentials, who the caller is, and whether a filesystem is behind the request.
See „Three runtimes, one HTTP layer" (docs/architecture.md).

That matters when self-hosting because it is what makes the behaviour you read
about in the other chapters — optimistic locking, the `409` on a stale write, the
public pricing endpoint — true here too, rather than approximately true.

## Instances

Nothing about a deployment needs to become a tracked file. An instance is a named
set of values in `~/.config/zeitlines/instances/<name>.env`, selected by one line
in `.env.local`. Data files for an instance live in `data/<name>/`, and every
subdirectory of `data/` is gitignored, so a stray `git add data` cannot pull your
roadmap into the history. The full cascade is in „Instances" (AGENTS.md).

## Netlify

Covered in [`docs/deploy.md`](deploy.md): the edge functions, the built-in Google
OAuth gate, and the environment variables the dashboard carries.

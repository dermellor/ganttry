# Zeitlines

Working notes for whoever changes this code, human or agent. It carries the
conventions that apply to every change, the commands, and an index into the
chapters. The reasoning behind a subsystem lives with that subsystem, in `docs/`.

For what Zeitlines *is* and how to run it, see [`README.md`](README.md); for how to
get a change reviewed, [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Documentation map

| Where | What |
| --- | --- |
| [`docs/overview.md`](docs/overview.md) | The map between the subsystems: the request path through the layers, and how one timeline type is laid out across three stores. Start here. |
| [`docs/architecture.md`](docs/architecture.md) | The two extension seams: source adapters (where data comes from) and plugins (what a timeline carries beyond items). |
| [`docs/data-model.md`](docs/data-model.md) | The timeline file format, date extraction, and `timelines.config.json`. |
| [`docs/items.md`](docs/items.md) | What an item carries beyond dates: icons, status, owner, custom fields. |
| [`docs/editing.md`](docs/editing.md) | Editing in the interface: the item rail, the context menu, drag and form behaviour, the two view modes, URL state. |
| [`docs/database.md`](docs/database.md) | Postgres as the data source: schema, the two drivers, optimistic locking, live updates, presence. |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Running it yourself: the three deployment shapes, the one-command container, and the access gate. |
| [`docs/local-sources.md`](docs/local-sources.md) | Files the user owns as a source: a JSON file or a directory of Markdown. Editability is decided by the runtime, not by the format. |
| [`docs/plugin-storage.md`](docs/plugin-storage.md) | The generic store for the rows a plugin owns, on every source kind, and the rules the host enforces in place of columns and foreign keys. |
| [`docs/plugin-lifecycle.md`](docs/plugin-lifecycle.md) | Installed (instance) versus enabled (timeline), who may install, version pinning, and what an uninstall does to the data. |
| [`docs/plugin-public-read.md`](docs/plugin-public-read.md) | Publishing a plugin's data without an endpoint of its own: the three gates, what is stripped, and why a local source inverts the question. |
| [`docs/plugin-authoring.md`](docs/plugin-authoring.md) | Writing a plugin outside this repository: what it exports, the host API it is handed, how to declare data, and how an instance installs it. |
| [`docs/plugin-isolation.md`](docs/plugin-isolation.md) | Where plugin code runs, why the sandbox was rejected, what protects an instance instead, and what would bring the decision back. |
| [`docs/mcp.md`](docs/mcp.md) | The MCP server and its tools. |
| [`docs/deploy.md`](docs/deploy.md) | The Netlify deploy, the auth gate, JIRA linking. |
| [`src/plugins/*/README.md`](src/plugins/) | Each plugin documents itself: what it does, its fields, its model, and an `AGENTS.md` with the conventions for changing it. No core chapter is the home of a plugin fact. |
| [`docs/plugin-playbook.md`](docs/plugin-playbook.md) | How a new plugin gets built: the gate, the reach research, implementation, verification, publication. |
| [`openapi.yaml`](openapi.yaml) | The HTTP API, generated. Read this before writing a client. |
| [`schema/`](schema/) | JSON Schemas for the data files, generated from `src/types.ts`. |

## Conventions

Five rules that hold across the whole codebase. Everything else is local to a
subsystem and documented there.

- **Comments explain *why*, not *what*.** Most non-obvious rules here carry the
  failure mode they prevent, because that is the part which cannot be recovered
  from reading the code. When you change such a rule, change its reasoning with it.
  A comment that only restates the line below it is noise; one that names the bug
  it prevents is why the next person leaves the code alone.
- **A rule lives in exactly one place.** Validation both client and server need
  goes into a shared, DOM-free module and is imported by both — see
  [`src/itemExtent.ts`](src/itemExtent.ts),
  [`src/phaseOverlap.ts`](src/phaseOverlap.ts), [`src/status.ts`](src/status.ts).
  Restating it is how one copy ends up fixed and the other does not.
- **No fallback data, ever.** A DB-backed timeline loads live and fails loudly;
  there is deliberately no cached or committed snapshot of live content, because a
  stale copy is indistinguishable from real data and reliably gets mistaken for it.
  The full reasoning is in
  [`docs/database.md`](docs/database.md) → „Principle: no emergency or fallback
  data". This one is not negotiable.
- **Generated artefacts are not edited by hand.** `schema/*.json` and
  `openapi.yaml` come from `src/types.ts`; change the type and regenerate. CI fails
  when a committed copy no longer matches, which is what keeps documentation from
  drifting away from the code.
- **Diagrams are Mermaid, and they draw seams.** A figure in `docs/` goes in a
  mermaid fence rather than a committed SVG or PNG: it renders on GitHub, stays
  reviewable in a diff, and cannot become a binary that no longer matches the
  code. Draw the boundaries between the parts, never inventories of what sits
  behind them, because a figure that lists functions or counts is wrong within a
  month. See [`docs/overview.md`](docs/overview.md) for both.

## The name covers the product, not its vocabulary or its instances

**Zeitlines** is the product name. Three families of `timeline(s)` are deliberately
left alone, and a sweep that "finishes the rename" breaks all three:

- **Domain vocabulary.** A timeline is still called a timeline: the tables
  `timelines` / `timeline_items`, types like `TimelineFile`, `vis-timeline`, the
  Timeline view. That is the noun the product operates on, so renaming it would
  cost a schema migration and buy nothing.
- **Deployment identity.** A deployment carries the name it was set up under: the
  host's site name, the `timelines-api` / `pricing-api` edge functions, the
  `TIMELINES_*` env vars and the MCP URL all keep saying `timelines`. Renaming the
  env vars means editing the host's dashboard and every `.env` in lockstep, and a
  half-applied rename takes DB access down (loudly, by design — see „Principle: no
  emergency or fallback data").
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
- **Re-sync the serving checkout after every merge.** Merging a PR on GitHub does
  **not** update any local checkout, including the one a dev server is running
  from. After a merge run `git fetch origin && git merge --ff-only origin/main`
  there, and restart the server if it caches build output. Skip this and the live
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

**Live-preview caveat:** a dev server started from the main checkout does **not**
see edits made in a worktree. When a task needs live visual verification, start a
second server from the worktree itself (`npm run dev:worktree`, which listens on
`WT_PORT` and leaves an already-running server alone), or merge to `main` and
verify there. Never assume the running app reflects worktree edits — that mismatch
is a known trap, and it looks like a data or filter problem rather than what it
is. See „Dev server and ports".

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
own tracker (<https://github.com/dermellor/zeitlines/issues>); reference them from
the closing commit with `Closes #NN`.

### 4. Everything written into the history is English

Commit subjects and bodies, branch names, PR titles and descriptions, issue text:
English, like the code and the documentation. The interface stays German
(see [`CONTRIBUTING.md`](CONTRIBUTING.md) → „Conventions worth knowing"), and a
quoted UI string stays German inside an English message. Conventional-commit
prefixes are unaffected (`feat(sources): …`).

The failure mode this prevents is imitation. Most of the history before this rule
is German, and a tool told to „match the style of the last commits" reproduces
that language forever, one commit at a time. What the repo documents outranks what
`git log` happens to show. The existing German commits stay as they are: rewriting
published history over a language choice costs every open branch and every
existing link a rebase.

### 5. Guard against foreign in-flight work

At the start of a change-session, check `git status`. If it already contains
uncommitted changes you did not create, another session owns them — do not build on
top of or commit them blindly. Surface them and either work in a fresh worktree off
`origin/main` (per the base invariant — never off a possibly-stale local `HEAD`)
or coordinate before touching shared files.

### 6. Issues are public: never file instance-specific ones

There is **one** tracker, and it is the public one. GitHub has no such thing as a
private issue: everything in a public repo's tracker is world-readable, including
its whole edit history, and closing an issue does not hide it. Moving it to
another repo afterwards does not help either, since anything already public stays
mirrored, cached and indexed.

So an issue must never carry **instance-specific content**: a customer or tenant
name, a deployment's configuration or credentials, internal strategy, a named
competitor, or the contents of a private timeline. That kind of material is not
tracker material in the first place. A deployment's configuration belongs in the
operator's own notes and its host's dashboard, tenant data belongs in the
database, and a migration for one instance is a script.

What is left is product work — adapters, bugs, rendering behaviour, extension
seams — and that is unproblematic in the open. The test when filing: would this
still make sense to somebody who has never seen our deployment? If it only makes
sense with context that nobody outside has, it does not belong in an issue at all.

The same rule governs a **second repository**: do not keep one around as a private
tracker. Two trackers in parallel is overhead that goes stale within weeks, and a
stale tracker misleads.

## Instances

A checkout is not bound to one deployment. An **instance** is a named set of
values pointing at one: its database, the `data/` subfolder it builds, the notes
directory it scans, its JIRA account, its host site. Development against a
production instance, a staging instance and a throwaway test database is the
normal case, so switching between them has to be one line rather than an edit
pass over several files.

Instance values live **outside the repo**, one file per instance:

```
~/.config/zeitlines/instances/<name>.env
```

`.env.local` then carries only the name:

```bash
TIMELINES_INSTANCE=staging
```

Nothing about a deployment becomes a tracked file this way, and no `.env.local`
in the repo has to be rewritten to move between instances. `TIMELINES_INSTANCE_DIR`
moves the profile directory. A name is a single path segment of `[A-Za-z0-9._-]`;
anything else resolves to no profile rather than to a file elsewhere on disk.

The full cascade is `process.env` → `.env.local` → the instance profile → the
files named by `TIMELINES_ENV_FILE`, earlier winning. The profile outranks
`TIMELINES_ENV_FILE` because that seam is for keys shared across *projects*,
which is the coarser statement. All of it is implemented once in
[`scripts/db/env.ts`](scripts/db/env.ts); entry points call `envValue()` rather
than reading `process.env` directly. `hydrateProcessEnv()` exists for the two
consumers that cannot: Vite's own `loadEnv`, which fills `import.meta.env` from
repo-local files and prefixed `process.env` keys only, and any child process.

**Instance data files** go in `data/<name>/`, selected by
`TIMELINES_SOURCES_SUBDIR`. Every subdirectory of `data/` is gitignored; the
top-level `data/*.json` are the shipped examples. That way a stray `git add data`
cannot pull a deployment's roadmap into the public history. See „Issues are
public" above for the same rule applied to the tracker.

### Two instances from one checkout

Running two instances side by side (a test one and one pointing at production)
is the normal local setup, so nothing about an instance may live in shared repo
state. Two values make that work, both belonging in the profile:

| Variable             | Default | Why it has to be per-instance                        |
| -------------------- | ------- | ---------------------------------------------------- |
| `TIMELINES_DATA_DIR` | `data`  | build output under `public/`; a shared directory means the two builds overwrite each other |
| `TIMELINES_PORT`     | `3120`  | `vite.config.ts` and `scripts/dev-prep.sh` both read it, so starting one instance never kills the other |

`build:data` writes to `public/<TIMELINES_DATA_DIR>/`; `vite.config.ts` derives
the client's fetch prefix from the same value and passes it as `VITE_DATA_BASE`,
so the two cannot drift apart. The client reads it through
[`src/data-base.ts`](src/data-base.ts) rather than hardcoding `/data`.
`public/data-*/` is gitignored.

One consequence worth knowing: `vite build` copies all of `public/`, so a local
build carries every instance's data directory into `dist/`. Host builds run from
a fresh clone where those directories do not exist, so this only matters if you
deploy a locally produced `dist/`.

## Dev server and ports

The port comes from `TIMELINES_PORT` through the env cascade (3120 if unset), so
an instance profile carries its own and two instances never collide.
[`vite.config.ts`](vite.config.ts) reads it and sets `strictPort: true`, so a
conflict is a hard failure rather than a silent move to another port.
[`scripts/dev-prep.sh`](scripts/dev-prep.sh) reads the same variable, which is
what keeps it from killing the other instance's server. Which port an instance
gets, and how the server is supervised, is your environment's business and not a
property of the project.

A second server for a worktree runs through `npm run dev:worktree`, which listens
on `WT_PORT` and skips the pre-flight script, so it does not disturb a server
already running from the main checkout. Several worktrees can run at once by
counting `WT_PORT` up.

**A dev server started from one checkout does not see another checkout's edits.**
That includes a worktree: the running app keeps serving the code it was started
from. Either start a second server from the worktree, or merge first and verify
there. Never assume the running app reflects worktree edits, and re-check after a
merge that the serving checkout was actually updated: a merge on GitHub does not
touch a local checkout.

## Dev / Build

```bash
npm install
npm run dev          # build data + Vite + chokidar watcher on data/
npm run build        # static dist
npm start            # serve that dist + the API from one Node process (self-hosting)
npm test             # unit tests (node --test, TZ-pinned to Europe/Berlin)
npm run typecheck    # tsc --noEmit
npm run db:check     # migrations pending? (runs before `dev`; no-op without a DB)
npm run db:local:up  # throwaway Postgres in Docker (port 55432)
npm run db:reset     # drop schema → migrate → seed; refuses non-local databases
npm run dev:local    # dev server against that local database, not a hosted one
npm run schema       # regenerate the JSON Schemas from src/types.ts
npm run schema:check # verify they match the types + the examples validate (CI)
npm run openapi      # regenerate openapi.yaml
npm run openapi:check # verify the committed spec matches routes + types (CI)
```

### Generated schemas (`schema/`)

The shape of the committed data files is **derived, not documented twice**:
[`scripts/schema/build.ts`](scripts/schema/build.ts) generates
`schema/timeline.schema.json` (from `TimelineFile`), `schema/container.schema.json`
(from `TimelineContainer`, the `timeline.json` of a directory source) and
`schema/config.schema.json` (from `Config`) out of [`src/types.ts`](src/types.ts), which stays authoritative.

The output **is committed**, and that is the point rather than an oversight: it is
what lets a data file carry `"$schema": "../schema/timeline.schema.json"` and get
completion and validation in an editor. `npm run schema:check` therefore
regenerates into memory and compares, so a type change without a regenerated
schema fails in CI instead of shipping a schema that describes yesterday's types.

The generator runs with `additionalProperties: false`, which makes an unknown key
an error rather than something silently accepted. That is what surfaced a stale
`title` field: the DB column behind it was dropped in migration `0014`, but the
examples and the prose kept carrying it, invisible because both were maintained by
hand.

The same step validates the committed examples, which turns
`data/example-projektplan.json` and `data/launch-roadmap.json` into tests: a
change to the item shape that forgets them fails loudly.

### The HTTP API: `openapi.yaml`

[`openapi.yaml`](openapi.yaml) describes the API in OpenAPI 3.1 — 21 paths, 27
operations — and is generated by
[`scripts/schema/openapi.ts`](scripts/schema/openapi.ts) (`npm run openapi`). It
exists because the API had real consumers reverse-engineering it from prose: the
**public, unauthenticated** `GET /api/pricing/{id}` used by external pages, the
MCP server, and anyone self-hosting who wants their own integration.

**Split by what changes.** The payload schemas are generated from
[`src/types.ts`](src/types.ts), so an added field appears without anyone editing
YAML. The routes — paths, methods, headers, status codes — are declared by hand in
[`scripts/schema/openapi-routes.ts`](scripts/schema/openapi-routes.ts), because the
dispatcher in [`scripts/db/api.ts`](scripts/db/api.ts) is an if-chain with no
per-route types to generate from. Typing those routes first would be a refactor of
the core write path and was deliberately left out.

**What keeps the hand-written half honest is a test, not discipline.**
[`scripts/schema/openapi.test.ts`](scripts/schema/openapi.test.ts) asserts drift in
**both** directions against `SUB_KINDS`: a sub-resource in the dispatcher that no
path documents, and a documented path naming a sub-resource the dispatcher does not
know. Both were verified by deliberately introducing each. Further tests demand a
2xx per operation, a `401` on everything behind the auth gate, a `409` on every
write that sends `If-Match`, and that path placeholders match their declared
parameters.

`SUB_KINDS` is now exported from `api.ts` and is the single list: the type and the
runtime matcher in `parseSourcePath` used to be two hand-kept copies of the same
names.

The spec carries what prose kept implicit: `securitySchemes` for the session
cookie and the `X-MCP-Token` bypass, with `security: []` on the pricing endpoint —
so „this one is public" is machine-readable rather than a sentence. Validated with
`npx @redocly/cli lint openapi.yaml`, which is not wired into CI (it would pull a
large dependency for a file that already has unit tests plus a regeneration
check).

`npm run dev` rebuilds the discovered config and the materialized local sources whenever a file under `data/` changes, Markdown included.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to
`main` and on every pull request, over a Node 22 + 24 matrix: `npm ci`,
`npm test`, `npm run schema:check`, `npm run openapi:check`, the env-var check,
`npm run build`, then the bundle-split check below.

**Documented env vars are actually read**
([`scripts/ci/check-env-docs.sh`](scripts/ci/check-env-docs.sh)): every variable
named in README's Configuration table has to appear in some tracked file that is
not documentation. A knob nothing reads is invisible to every other check here,
and `TIMELINES_NOTES_DIR` plus `TIMELINES_STATIC_ONLY` survived the removal of the
Markdown notes pipeline by several releases because of it, in the README table and
in `.env.example` both. Only that table is parsed: `docs/` names retired variables
on purpose in its „what used to be here" sections, and a checker that cannot tell
a historical note from a live claim needs an ignore list that goes stale by itself.
`.env.example` and the script's own comments are excluded from the search side for
the same reason, which is what makes it fail on the bug it was written for.

**Node 22 is the floor** (`engines.node` in `package.json`), and that is a real
constraint rather than a preference: the test script hands a glob
(`'{src,scripts}/**/*.test.ts'`) to `node --test`, and Node 20 does not expand it
— it fails with „Could not find …" before running a single test. The first CI run
proved it, which is what the matrix is for. Node 20 has also been EOL since
April 2026. Lowering the floor again means resolving the glob in the script
instead of leaving it to the runtime.

**The build step runs with no credentials on purpose** — that is the path a
contributor takes after a plain `git clone`. It has to stay non-fatal: the build
discovers no DB timelines and registers only the local sources rather than
failing (see „Configuration" (docs/mcp.md) and „Principle: no emergency or fallback data").
A change that makes a missing DB fatal breaks CI for everyone without a
deploy's env vars.

**`npm run typecheck` is deliberately non-blocking** (`continue-on-error`): the
repo carries 3 pre-existing errors (missing `@types/ws`, two library signature
mismatches). It was 7 until the notes pipeline went: the four `Dirent` ones lived
in its directory walk. They are unrelated to any
current change, so gating PRs on them would block contributions on a debt that
predates them. The step still reports the count, which is what catches a
regression — dropping `continue-on-error` is the one-line change once the count
reaches zero.

**Bundle-split acceptance check**
([`scripts/ci/check-bundle-split.sh`](scripts/ci/check-bundle-split.sh)) enforces
the promise from „Plugins" (docs/architecture.md): a generic build downloads no
plugin *view* code and no plugin CSS. It asserts each marker is absent from the
entry chunk **and present in some lazy chunk** — the second half is what keeps it
honest, since testing only absence turns the check into a silent pass the moment
a marker goes stale. The markers are read out of each plugin's own stylesheet
rather than listed in the script, so a new plugin is covered as soon as it ships
one and a renamed class updates the check by itself. Runnable locally after
`npm run build`.

**Plugin-isolation check**
([`scripts/ci/check-plugin-isolation.mjs`](scripts/ci/check-plugin-isolation.mjs))
is the other half of the same promise, and needs no build: no core file imports
from a plugin folder, no plugin id appears as a literal outside its own folder,
`TimelineRepo` carries only methods on a known-generic list, and `index.html`
links no plugin's markup. Each was verified against a deliberately introduced
violation. Its allowlists are short and each entry carries its reason; a new one
is the thing to argue about in review.

## Theming

The viewer ships a single neutral theme defined as CSS custom properties in the
`:root` block of [`src/styles/theme.css`](src/styles/theme.css):

- colour tokens (bg, fg, accent, item-bg, item-border, lane colours, …)
- typography (`--font-body` / `--font-headline` / `--font-mono`)
- mark radius (`--mark-radius`)

To recolour or re-type the viewer, override any of these variables in your own
stylesheet loaded after `theme.css`. There is no runtime brand selector and no
build flag: the tokens in `theme.css` are the single styling seam.

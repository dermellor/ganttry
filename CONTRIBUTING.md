# Contributing to Ganttry

Thanks for considering a contribution. This file covers what you need to get a
change running and reviewed. [`AGENTS.md`](AGENTS.md) is the single source of
truth for the data model, schema and extension seams; read the relevant section
before a larger change, and keep it in sync when behaviour changes.

## You do not need a database

The quickest way in: file sources need no Postgres, no Supabase and no
credentials.

```bash
npm install
npm run dev
```

Drop a `*.json` into `data/` and it registers itself as a read-only view
(`src:<name>`). The file shape is documented in AGENTS.md → „Standalone JSON
timelines"; `data/example-projektplan.json` and `data/launch-roadmap.json` are
reference files.

Only DB-backed timelines are editable, so changes to the editing paths (drag,
item form, optimistic locking, presence) need a Postgres. The README's
Quickstart brings one up in three commands via Docker and the portable
`db:migrate` runner.

## Requirements

**Node 22 or newer** (`engines.node`). This is a real constraint, not a
preference: `npm test` hands a glob to `node --test`, and Node 20 fails to expand
it before running a single test. Node 20 has also been EOL since April 2026.

## Before you open a pull request

```bash
npm test             # unit tests (Node's test runner, TZ-pinned to Europe/Berlin)
npm run schema:check # schemas match src/types.ts, examples still validate
npm run openapi:check # openapi.yaml matches the routes and types
npm run build        # must succeed with no credentials configured
npm run typecheck    # see the caveat below
```

CI runs these on every pull request over a Node 22 + 24 matrix, plus a
bundle-split check (below). What the checks expect:

- **`npm test` must be green.** Tests live next to their subject as
  `*.test.ts`. Prefer extracting pure logic into a DOM-free module and testing
  that, which is why files like `src/itemExtent.ts`, `src/phaseOverlap.ts` and
  `src/menuPosition.ts` exist separately from their DOM callers.
- **`npm run build` must succeed without any credentials.** That is the path
  anyone takes after a plain `git clone`: no DB timelines are discovered and a
  missing notes directory only warns. Please do not make either of those fatal.
- **`npm run typecheck` currently reports 7 pre-existing errors** (`Dirent`
  typing in `build-data.ts`, a missing `@types/ws`, two library signature
  mismatches). The step is non-blocking in CI for that reason. Do not add new
  ones: check that the count has not grown. Fixing the remaining seven so the
  step can be made blocking is a welcome standalone contribution.
- **If you change a type in `src/types.ts`, run `npm run schema && npm run
  openapi`** and commit the regenerated `schema/*.json` and `openapi.yaml`. Both
  are derived from those types, and CI fails when a committed copy no longer
  matches. Do not hand-edit them, and do not document a field list in prose: add it
  to the type and it appears in both.
- **If you add an endpoint**, add it to `scripts/schema/openapi-routes.ts` as well.
  Unit tests assert that every sub-resource in `SUB_KINDS` is documented and that no
  documented path names an unknown one, so an undocumented endpoint fails the
  build.
- **The generic bundle must carry no pricing view code**
  (`bash scripts/ci/check-bundle-split.sh` after a build). A timeline kind is
  loaded via dynamic `import()`; a static import from core code into a kind's
  view modules silently pulls the whole chunk into the entry bundle. The script
  explains what broke when it fails.

## Conventions worth knowing

- **Comments explain *why*, not *what*.** The codebase leans on this heavily:
  most non-obvious rules carry the failure mode they prevent. When you change
  such a rule, update the reasoning with it.
- **A rule lives in exactly one place.** Validation that both client and server
  need goes in a shared module (`src/itemExtent.ts`, `src/phaseOverlap.ts`,
  `src/status.ts`) and is imported by both, rather than being restated.
- **No fallback data.** DB-backed timelines load live and fail loudly; there is
  deliberately no cached or committed snapshot of live content. AGENTS.md →
  „Principle: no emergency or fallback data" explains why, and it is a hard rule.
- **Never commit credentials.** `.env.local` is gitignored; `TIMELINES_ENV_FILE`
  points at files outside the repo if your keys live elsewhere. Do not commit
  timeline data that is not yours to publish.
- **Documentation is English, the UI is German.** That split is deliberate, so
  quoted UI strings stay German in the docs („Neu", „kein Wert", „Gespeichert")
  even in otherwise English prose. Some `data/` examples and a few identifiers
  also carry German words; that is history, not a convention to extend.

## Pull requests

Fork, branch, and open a PR against `main`. Small, focused changes are easiest
to review. Please describe what breaks without the change, not only what the
change does, and mention how you verified it. Screenshots help for anything
visual, since much of this project is rendering behaviour that tests cannot
capture.

Issues and questions: <https://github.com/dermellor/ganttry/issues>.

# Local sources (design proposal)

**Status: stages 1 and 2 are built; stage 3 is not.** A single `local` source
adapter replaces the former `file` kind and makes editability a property of the
runtime rather than of the file format. What exists today: a `data/*.json` timeline is
editable under `npm run dev` and read-only on a static deploy, and a directory of
Markdown files with a `timeline.json` in it is served as a source, read-only.
Everything that writes back into a note is still a proposal, and so is retiring
the old notes pipeline. Each section below says which it is.

Part of the Ganttry documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## The problem

There are three places data comes from today, and they sit on two and a half
axes rather than one:

| | Markdown notes | `file` | `db` |
| --- | --- | --- | --- |
| Registered as | a view in `timelines.config.json` | automatically from `data/*.json` | automatically from a build-time DB query |
| Carries `view.source` | **no** | yes (`kind: "file"`) | yes (`kind: "db"`) |
| Loaded by | `buildFromNotes` off a prebuilt `notes.json` | `fetch` of a static JSON | `GET /api/source/<id>` |
| Editable | no | no | yes |

Two things are wrong with that picture.

**Notes sit outside the adapter seam.** They are the only origin without a
`source`, which is why [`src/render.ts`](../src/render.ts) has to branch on
`if (view.source) … else buildFromNotes(…)`, and why the client loads a bespoke
`notes.json` payload (`NotesData`) alongside the `TimelineFile` payload every
other source speaks. Every feature that reads a source has to be taught about the
second shape, or silently skips notes.

**`editable` is decided by file format, and it should be decided by deployment.**
A JSON file and a Markdown file are both local files. Whether either can be
written depends on whether a process with filesystem access is serving the
request. Under `npm run dev` that process exists. On a static Netlify deploy it
does not, and no format changes that. Tying the capability to the format instead
produces the current oddity: a JSON document that the user owns, that lives in
their repository, and that they cannot edit in the tool built to edit it.

The existing seam already models the right thing. `SourceCapabilities` is
`{ editable, live }` on the adapter, and the DB adapter already derives its `live`
value from the environment (`TIMELINES_DB_LIVE`) and ships it to the client in the
`X-Source-Live` header. A local adapter deriving `editable` from "is there a
writable data directory behind this request" is the same move.

## The proposal

**One `local` source kind.** Format and cardinality become implementation details
inside it:

| | `local` | `db` |
| --- | --- | --- |
| Editable under `npm run dev` | yes | yes |
| Editable on a static deploy | no | yes |
| Live | `poll` (filesystem watermark) | `realtime` / `poll` |
| Backing store | files the user owns | Postgres |

### Decision: one file per timeline, optionally plus one file per item

This is the open question from the discussion that preceded this document, and
the answer that makes the rest fall into place.

A **local source is a `TimelineFile`, plus zero or more item files.** That single
sentence covers both shapes that exist:

- **A JSON file** (`data/launch-roadmap.json`) is a `TimelineFile` with its items
  inline and no item files. Exactly today's `file` source.
- **A directory** is a `TimelineFile` in `timeline.json` at its root, plus one
  Markdown file per item. The container file carries what has no home in an
  individual note: `groups` (including `nestedGroups`), `phases`, `groupBy`,
  `customFields`, `plugins`, `name`, `description`. Its `items` array is absent,
  because the items are the Markdown files.
- **A directory with no `timeline.json`** is the degenerate case and stays legal:
  every field defaults, groups are derived from the items, and there are no
  phases. That is what a plain notes folder is today.

The two alternatives were considered and rejected:

- **`index.md` with the container data in its frontmatter.** It keeps one format,
  but `nestedGroups` and `phases` are structured records, and expressing them in
  hand-written YAML is worse than JSON at exactly the point where the data is
  least forgiving. It also puts a file into the user's vault that Obsidian renders
  as a note and that the scan then has to exclude by name.
- **Keeping the container data in `timelines.config.json`.** It adds nothing new,
  but that file is *viewer* configuration and there is one of it. Structural data
  about a timeline would then live apart from the timeline, so a folder could not
  be moved, copied or shared without also editing a global config elsewhere.

The chosen shape has a property the other two lack: `timeline.json` is a
generated-schema file like every other data file here, so it gets editor
completion and CI validation for free (see „Generated schemas" (AGENTS.md)).

It gets its **own** type and schema (`TimelineContainer` →
`schema/container.schema.json`) rather than reusing `TimelineFile` with an
optional `items`. That was the plan and it was wrong: `items` optional weakens
the type at the dozen call sites that iterate it, and not one of them ever sees a
container file — they all work on the *scanned* result, which always has items.
One extra generated schema is the cheaper price.

### How a local source is served

The scan and the parse must produce a `TimelineFile` from a directory. Two callers
need that, so it lives in one module (`scripts/local/scan.ts`) and neither
reimplements it, per „Conventions → A rule lives in exactly one place" (AGENTS.md):

- **Under `npm run dev`,** the local adapter reads the filesystem per request and
  serves `GET /api/source/<id>`, editable. Edits take effect without a rebuild,
  which is the whole point.
- **For a static build,** `build-data.ts` materializes the same `TimelineFile`
  into `public/data/sources/<id>.json` and the client fetches it, read-only.
  That is what `file` sources already do.

**Capabilities are stamped at build time, and there is no probing.** The build
knows which of the two runtimes it is producing for, so it writes the answer into
the view's source descriptor and the client routes on it deterministically.
Guessing at runtime ("try the API, fall back to the static file") is the exact
pattern „Principle: no emergency or fallback data" (docs/database.md) forbids, and
it is forbidden here for the same reason: a read-only stale copy and a live
source would become indistinguishable.

This is a documented asymmetry with `db`, whose capabilities arrive at runtime in
a response header. `db` needs that because its `live` mode depends on the server's
env; `local` does not, because the deciding fact (is there a writable filesystem
behind this) is fixed when the bundle is built.

### Live updates

`live: 'poll'`, via the existing watermark sub-resource: the adapter answers with
the newest mtime across the source's files, and the client polls it exactly as it
does for a Postgres without Realtime. The dev server already runs a chokidar
watcher over the notes directory, so pushing instead of polling is available later
as an optimization rather than as a prerequisite.

## The write path

A local adapter implements the same `SourceAdapter` interface, so it registers in
`resolveAdapter` and neither the Vite middleware nor the edge function changes.
The sub-resources in `SUB_KINDS` split cleanly:

- **`item`** maps to one Markdown file in the directory case, and to one array
  entry in the single-file case.
- **`group`, `phases`** map to `timeline.json` in the directory case, and to the
  same document in the single-file case.
- **`pricing`, `feature`, `tier`, `tier-value`, `highlight`, `pversion`** are the
  `product-roadmap` plugin's. For a single-file source they are ordinary mutations
  of one JSON document and cost nothing extra. For a directory source they belong
  in `timeline.json` and can be deferred; until then the adapter answers `501` for
  them, which is a truthful answer rather than a silent no-op.

### Optimistic locking without a version column

The write path is built on a numeric per-item `version` carried in `If-Match`,
with `409` on a mismatch (`ApiRequest.ifMatch?: number`). A file has no version
counter, but it has an mtime, and **mtime in milliseconds is a number that
increases on every write**, so it fits the existing type without widening it.

The failure this has to catch is real and frequent: Obsidian, an editor, or a
`git checkout` wrote the file while the timeline had it open. mtime catches all
three. Its weakness is two writes inside the same millisecond, where the result
is a missed conflict rather than corruption. If that proves too coarse,
`ifMatch` widens to `number | string` and the value becomes a content hash; the
adapter interface does not otherwise change.

### Patching frontmatter surgically

This is the one piece of genuinely non-obvious work.

Updating an item rewrites a single frontmatter key in a file whose remaining
content belongs to the user. `gray-matter` can stringify a parsed document, but
it normalizes the YAML on the way out: key order, quoting style, comments and
blank lines are all at its discretion. Round-tripping an untouched vault through
it produces a diff over every file that was opened, which is unacceptable for a
directory the user also edits by hand and probably has in version control.

So `scripts/local/frontmatter.ts` locates the frontmatter block by its delimiters
and replaces only the lines belonging to the changed key, rewriting the block
wholesale only when a key has to be added and no anchor exists. It gets its own
unit tests, covering: key present, key absent, no frontmatter block at all, CRLF
line endings, a body containing a `---` line, and a key whose value spans lines.

### Two implicit values get promoted on first write

Both cases look like blockers at first and both have the same clean resolution:
writing makes an implicit value explicit.

**The date.** An item's start comes from a cascade (`date` → `scheduled` →
`created` → filename pattern), so "which field did the user just drag" seems
ambiguous. It is not: the build already records the answer.
[`scripts/build-data.ts`](../scripts/build-data.ts) sets `Note.dateSource` to the
frontmatter key it resolved, or to the sentinel `__filename__`. A write patches
that key. For `__filename__` it writes an explicit `date:` instead of renaming the
file, and because the cascade tries frontmatter before the filename, the explicit
value wins from then on.

**The id.** `Note.id` is the path relative to the notes directory, which is stable
until someone renames the file, at which point `metadata.dependsOn` references
break. So an explicit `id:` in frontmatter wins when present, the relative path is
the fallback, and the first write that makes an item the target of a reference
promotes it to an explicit `id:`.

### Creating and deleting items

Creating an item creates a file, which needs a target directory and a name. Both
come from the view, and that is the one problem with no equivalent in the
single-file case:

**A directory view is a filter over the scanned files.** An item created without
regard to the filter matches no clause and vanishes on the next reload, which
reads as a failed save. So creation derives its defaults from the active view's
filter clause: `folder` picks the target directory, `tags` / `status` /
`categories` seed the frontmatter, `filenameContains` seeds the filename. When the
clause cannot be satisfied deterministically (`not`, or an `anyOf` with several
viable branches), creation is refused **in the form**, with the reason, rather
than accepted and lost. That is the same choice and the same reasoning as the
extent error in „Standalone JSON timelines" (docs/data-model.md): a message in the
status line is overwritten by the „Gespeichert" that follows milliseconds later.

Deleting an item deletes one of the user's files, so it moves the file to
`<root>/.trash/` (Obsidian's own convention, and a directory Obsidian already
ignores) instead of unlinking it. An `unlink` here is unrecoverable data loss on
data the tool did not create.

## What this removes

Worth stating, because it is the argument for the change beyond consistency:

- `buildFromNotes` and the `if (view.source) … else` branch in `render.ts`.
- The `NotesData` / `notes.json` payload and its type, as a second thing the
  client knows how to load.
- The `TIMELINES_STATIC_ONLY` special case that hides Markdown views entirely
  (`baseViews = []`). Under this design a static build materializes them read-only
  like any other local source, which is a behaviour change and needs a deliberate
  decision: **materialize them**, since „a deploy shows no notes at all" is
  surprising, and read-only is the accurate representation of a static deploy.

## Constraints that must hold

- **View ids may not change.** `localStorage['timelines.view']` persists the
  active view id, and `timelines.viewMode` persists the mode. Markdown views keep
  the ids from `timelines.config.json` (`kurzbeitraege`), JSON sources keep
  `src:<basename>`. Changing either silently resets every user's saved view, the
  same trap „The name covers the product" (AGENTS.md) records for the
  `timelines.*` key prefix.
- **The source *kind* is not persisted anywhere** (verified: `localStorage` holds
  view, view mode, filter, groupBy and milestones-only, and no kind), and views
  are regenerated on every build. So renaming `file` to `local` needs no migration
  and no legacy alias.
- **A missing notes directory stays non-fatal.** CI builds with no credentials and
  no notes directory, and that path has to keep working (see „CI" (AGENTS.md)).
- **Nothing instance-specific becomes a tracked file.** `data/<name>/` stays
  gitignored, and a notes directory outside the repo stays outside it.

## Staging

Three stages, each shippable on its own, in increasing order of risk:

1. ~~**`local` adapter for single-file JSON, editable in dev.**~~ **Done.**
   [`scripts/local/file-repo.ts`](../scripts/local/file-repo.ts) implements
   `TimelineRepo` over one JSON file, injected through `DbConnections.local` so
   `api.ts` stays free of `node:fs`. Two things came out differently than
   written here:
   - **The version has to be forced forward.** Plain mtime was not enough: the
     repo's own tests hit a millisecond collision on the first run, and two
     writes sharing a version means a client passes an `If-Match` it should have
     failed. `save()` now bumps the mtime explicitly whenever the new value
     would not exceed the old one, which keeps the numeric contract intact and
     made the widening to a content hash unnecessary.
   - **The pricing sub-resources needed a status code of their own.** They
     answer `501` via a new `NotSupportedError`, because a 500 reads as „we are
     broken" and a silent success would report „Gespeichert" for a write that
     never happened.
2. ~~**Directory sources on the read path.**~~ **Done, except the deletion.**
   [`scripts/local/scan.ts`](../scripts/local/scan.ts) turns a directory into a
   `TimelineFile`; the local adapter serves it live, `build-data.ts` materializes
   it for a static build, and it is read-only throughout (every write answers
   `501`, refused *before* the item lookup so the reason does not depend on
   whether the item happened to exist). **`buildFromNotes` and `notes.json` are
   still in place** — removing them takes the config-declared filter views with
   them, which is a separate decision. Four things came out differently:
   - **A separate `TimelineContainer` type, not `items` made optional.**
     Optional `items` would weaken the type at the dozen call sites that iterate
     it, none of which a container file ever reaches: they all work on the
     *scanned* result, which always has items. The cost is one more generated
     schema (`schema/container.schema.json`), and `file.items` stays usable
     without a guard.
   - **A day stays a day.** The old pipeline turned `date: 2026-04-15` into
     `2026-04-14T22:00:00.000Z` — the same moment, but it reads as the wrong day
     wherever it is shown as text, and a write path would put that timestamp
     back into a file that said `2026-04-15`. Date-only values now stay
     date-only, which also makes a Markdown item and a JSON item carry the same
     shape.
   - **The id check had to allow dots.** An item in a directory source is
     identified by its file path, and the dispatcher's `ID_SEGMENT` rejected
     every one of them. It now allows dots and excludes `.` and `..` by name.
     The real containment guard was never that check — it is the resolved-path
     test in the repo, which is what catches the encodings a character rule
     misses.
   - **`editable` is stamped per source, not per kind.** The dev server flipping
     every local source to editable offered „+ Eintrag" and drag handles on a
     Markdown timeline, each ending in a `501`. An edit that looks available and
     then is not is worse than one that was never offered.
3. **The Markdown write path.** The frontmatter patcher, promotion of date and id,
   filter-derived creation defaults, trash-on-delete.

Stage 1 is worth doing whether or not stages 2 and 3 follow. Stage 3 is the only
one that writes to files the tool does not own, and it should not start until
stage 2 has been used against a real vault for a while.

## Non-goals

- **Editing on a static deploy.** There is no process to write with, and this
  design does not invent one.
- **Making a notes directory behave like a database.** No transactions, no
  multi-user presence, no server-side conflict resolution beyond the mtime check.
  Concurrent editing of a shared vault is what the `db` source is for.
- **Changing anything about the `db` adapter,** the plugin axis, or the payload
  shape a source returns. `TimelineFile` stays the one contract, which is what
  makes a local source substitutable for a DB one at all.

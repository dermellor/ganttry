# Local sources (design proposal)

**Status: all three stages are built.** A single `local` source
adapter replaced the former `file` kind and the separate Markdown notes pipeline,
and made editability a property of the runtime rather than of the file format.
What exists: a `data/*.json` timeline and a directory of Markdown files with a
`timeline.json` in it are both editable under `npm run dev` and read-only on a
static deploy. Item writes go back into the note, one frontmatter key at a time;
what is deliberately still missing is listed with each stage below, and id
promotion („Staging" → stage 3) is the one design decision that was dropped.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## The problem

There used to be three places data came from, sitting on two and a half axes
rather than one. This is the picture the change started from:

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
value from the configured backend (`defaultLive`, overridable with
`TIMELINES_DB_LIVE`) and ships it to the client in the
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
watcher over `data/`, so pushing instead of polling is available later as an
optimization rather than as a prerequisite.

## The write path

A local adapter implements the same `SourceAdapter` interface, so it registers in
`resolveAdapter` and neither the Vite middleware nor the edge function changes.
The sub-resources in `SUB_KINDS` split cleanly:

- **`item`** maps to one Markdown file in the directory case, and to one array
  entry in the single-file case.
- **`group`, `phases`** map to `timeline.json` in the directory case, and to the
  same document in the single-file case.
- **`plugin/<pluginId>/<collection>`** is the generic store for a plugin's own
  rows, and it works on both shapes: the rows go into the JSON document, or into
  the directory's `timeline.json`. See
  [`plugin-storage.md`](plugin-storage.md) — including the one real difference,
  that the lock there is the file rather than the row.
  There used to be six more sub-resources here — one plugin's entities, each
  answering `501`, which is what made a pricing model in a JSON file readable and
  not editable. They went with the repo methods behind them
  (<https://github.com/dermellor/zeitlines/issues/17>), so a local source is now
  writable for a plugin without a line of plugin-specific code.

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

**The version is per document, so the client has to carry it forward across its
own writes.** One version covers every item in the file, and each write bumps it;
the second item written in one pass therefore held an `If-Match` that our *own*
first write had just invalidated, and the `409` sent the client into its
reload-authoritative-state branch, discarding the rest of the pass. Nothing wrote
two items at once until moving an item took its children along (see „Parent and
children" (docs/items.md)), which made it happen every time. `adoptDocumentVersion`
in [`src/persistence.ts`](../src/persistence.ts) hands the returned version to
every item of a `local` source; a DB source keeps its per-row versions, which are
unrelated to each other and must not be overwritten.

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

## What this removed

Done, and the argument for the change beyond consistency:

- `buildFromNotes` and the `if (view.source) … else` branch in `render.ts`. Every
  view now names a source, so `View.source` is required rather than optional.
- The `NotesData` / `notes.json` payload and its type, as a second thing the
  client knows how to load — **and its second copy in
  [`scripts/export-view.ts`](../scripts/export-view.ts)**, which carried its own
  `buildFromNotes`. That duplicate is the clearest argument of the lot: it is
  exactly what „A rule lives in exactly one place" (AGENTS.md) exists to prevent.
- `src/filter.ts`, `FilterClause`, and the committed `views` array with a filter
  clause per view. A directory is one timeline now, not a pool that several views
  slice up; narrowing what you see is the interface's own Filter control, which
  works on every source instead of only on notes.
- `TIMELINES_STATIC_ONLY`, whose only job was hiding the notes-driven views.
- Four of the repo's seven pre-existing typecheck errors, which lived in the
  notes directory walk.

**What it cost:** config-declared filter views. Nothing replaces them one-for-one.
If a saved, named slice of one timeline turns out to be wanted, it is a feature
on top of sources rather than a reason to keep a second data path alive.

## Constraints that must hold

- **View ids may not change.** `localStorage['timelines.view']` persists the
  active view id, and the mode is persisted per timeline (see „Where the display
  state lives" (docs/editing.md)). Markdown views keep
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
   - **A route this repo cannot serve needed a status code of its own.** It
     answers `501` via `NotSupportedError`, because a 500 reads as „we are
     broken" and a silent success would report „Gespeichert" for a write that
     never happened. One plugin's sub-resources were the first users of it and
     are gone; the install registry and a wholesale replace of a Markdown
     directory still use it.
2. ~~**Directory sources on the read path.**~~ **Done.**
   [`scripts/local/scan.ts`](../scripts/local/scan.ts) turns a directory into a
   `TimelineFile`; the local adapter serves it live and `build-data.ts`
   materializes it for a static build. As this stage shipped it was read-only
   throughout, every write answering `501` refused *before* the item lookup so
   the reason did not depend on whether the item happened to exist; stage 3
   replaced that with the real write path. `buildFromNotes`, `notes.json` and
   `src/filter.ts` went in this stage's own commit after all, rather than in the
   separate decision anticipated here (see „What this removed" above). Five
   things came out differently:
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
   - **`timeline.json` is what makes a directory a source.** The degenerate case
     above („a directory with no `timeline.json` … stays legal") was not built:
     `isTimelineDirectory` tests for the container file, and a folder without one
     is descended into rather than registered. Registering every folder under
     `data/` would turn each intermediate directory on the way to a timeline into
     an empty timeline of its own, and there is no id or name to give those. A
     plain notes folder therefore needs one `timeline.json`, which may be `{}`.
3. ~~**The Markdown write path.**~~ **Done.**
   [`scripts/local/frontmatter.ts`](../scripts/local/frontmatter.ts) patches one
   key at a time; everything else in the file — comments, key order, quoting, the
   blank line under the block, the body — is left byte-for-byte alone. Four
   things worth knowing:
   - **A full patch does not rewrite the body.** The viewer sends `body` on every
     edit whether or not it changed, and running it through the writer costs the
     file its exact spacing. Only an actual change touches it. This surfaced in
     the interface, not in the API tests: the first UI edit ate the blank line
     under the frontmatter.
   - **A filename date is promoted on first write.** The scanner recorded that
     the date came from the filename, so the write puts an explicit key in the
     frontmatter instead of renaming the file. From then on the note states its
     own date. That promotion is the reason the read path records the provenance
     at all.
   - **Delete moves the note to `.trash/`,** never `unlink`. This is a file the
     tool did not create and cannot recreate, and the scan already skips
     dot-directories, so a trashed note leaves the timeline without leaving the
     disk. `.trash` is Obsidian's own convention.
   - **`replaceTimeline` is refused for a directory** (`501`). Replacing one
     wholesale means rewriting or deleting every note from a single request, and
     no interaction asks for that: the viewer edits item by item.

   **Not done, deliberately: id promotion.** The design called for writing an
   explicit `id:` when an item becomes the target of a reference. Doing it on
   every write would add a line to every note the user touches, which is the
   diff-over-the-whole-vault problem the patcher exists to prevent. Until there
   is a narrower trigger, a rename still breaks a `dependsOn` pointing at the old
   path.

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

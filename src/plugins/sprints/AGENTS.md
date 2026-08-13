# Sprints

Conventions for changing **this plugin**. Rules that apply to the whole codebase stay
in the root [`AGENTS.md`](../../../AGENTS.md), and what a reader needs in order to
*use* the plugin is [`README.md`](README.md), which is also the public page. Neither is
restated here: a copy is how one of them ends up fixed and the other does not.

## Invariants

- **A sprint is a row, and membership is assigned.** `metadata.sprint` holds a
  `sprints` row id and IS in `metadataKeys`, so an uninstall purges it. The first cut of
  this plugin computed membership from the item's start date; that is wrong in the domain
  (canon makes the Sprint Backlog a selection, and no product derives it), and the
  correction is the plugin's shape. `docs/model.md` carries the sourcing.
- **The cadence survives as a suggestion, in a second field.** `sprintByDate` is the
  `derived: true` one and is deliberately absent from `metadataKeys`, because nothing
  stores it. Two fields for one question is the point: „what did we commit this to" and
  „where do its dates fall" are different questions, and the disagreement between them is
  reported rather than resolved. Resolving it either way edits something a human decided.
- **At most one `active` sprint.** Canon has a new Sprint begin as the previous one ends.
  The host enforces no cross-row rule, so the plugin refuses the second activation itself
  and `sprint_status` reports a violation it finds in existing data.
- **A closed sprint's numbers and curve come from its frozen `reports` row.** Never a
  recomputation: the items keep moving after a close, and a recomputed chart rewrites
  history on every later edit.
- **Calendar and duration arithmetic comes from the contract, not from here.** Host API
  1.6 exports `durationToMs`, `endFromDuration`, `parseLocalDay`, `shiftDays` and
  `isoDateOnly` through `pluginHost/api` precisely because this plugin restated them and
  got one wrong: a `duration`-only item burned on the day it started. A rule the viewer
  uses to place a bar has to be the rule a plugin uses to count it.
- **`raster.ts` is the only place that decides which sprint a date is in, and
  `sprints.ts` the only place that reads the rows.** `fields.ts` (the lanes a user sees),
  `tools.ts` (the sums an agent gets), `burndown.ts` (the curve) and `index.ts` (the
  page) all import them rather than restating a rule. Two
  copies of that arithmetic would let the capacity sum be taken over a different
  bucketing than the lanes, which is wrong in a way nobody can see, because each half
  looks right on its own.
- **Day arithmetic counts calendar days, not 24-hour blocks, and agrees with the core.**
  A bare `YYYY-MM-DD` is a LOCAL day (the way vis-timeline reads one), so `raster.ts`
  keeps its written components; a value carrying a time goes through `new Date(value)`
  and is read back in *local* components, which is exactly what `parseLocalDay`
  (`src/date.ts`) does. Diverging there put `2026-02-15T23:00:00Z` in a different sprint
  than the day the viewer draws it on. Then the days are counted on the DST-free UTC
  axis. Local midnight to local midnight is 23 or
  25 hours across a clock change, so a millisecond subtraction divided by 86_400_000
  puts every item after 2026-03-29 one sprint off, silently. The example timeline has
  an item on exactly that day, and `raster.test.ts` pins both directions.
- **A day before the anchor has no sprint, and there is no „Sprint 0".** Numbering
  backwards would invent sprints that were never run. The same holds for an item with
  no start: no value, so the host drops the key and the item lands in the „Ohne …"
  bucket.
- **An item spanning several sprints belongs to the one it starts in.** That keeps one
  item in one lane and lets a capacity sum count it exactly once. The cost, that a long
  item is absent from the sprints it runs through, is stated in the README as question 1
  and is the thing to change if a practitioner says so, in `sprintOfItem` and nowhere
  else.
- **`lengthDays` is never guessed.** Absent takes the default of 14; present but
  unusable (0, negative, fractional, a word) yields no raster at all. Falling back to 14
  there would bucket every item against a cadence the user did not configure and cannot
  see.
- **No capacity, no capacity verdict.** Absent, zero, negative and unparseable are one
  case, because the answer owed to the caller is the same for all four and „capacity: 0"
  is not something a rule may divide by. `sprint_status` reports the sums and says the
  verdict is missing rather than inventing one. Zero and negative are refused a layer
  earlier by the schema (`minimum: 0.01`), so a write is rejected instead of storing a
  sprint that looks configured and is not.
- **An item with no usable estimate is named, never counted as zero.** A sum that
  quietly omits three items reads as a capacity statement and is not one. „Usable" is
  literal: a `select` value is a **string**, and only a plain decimal counts
  (`/^[+-]?\d+(?:\.\d+)?$/`). So `"8"` and `"8.5"` count, while `""`, `"XL"`, `0`, a
  stray array, `"0x10"` and `"1e3"` do not. `Number()` would have read those last two as
  16 and 1000, which turns a typo into a capacity figure.
- **No verb writes a date.** Assigning work and moving work between sprints are
  assignment changes, and every plan is asserted against that in the tests. The predecessor
  rule that used to guard against a date shift is therefore retired: what remains is that
  `roll_over` names the dependents it leaves behind rather than dragging them along.
- **`roll_over` has no default target.** Canon returns unfinished work to the Product
  Backlog, the common products default to the next sprint, and a default would pick a
  philosophy for the caller. A call with neither target is refused, and so is one with
  both, a target that is closed or cancelled, and a target equal to the source.
- **Finished work is never moved and never re-dated**, and its points stay in the
  sprint's sum: it consumed that capacity. `roll_over` and `sprint_status` read „done"
  through one helper in `sprints.ts`, so the two cannot disagree about what is unfinished.
- **A close is not atomic, and the interface admits it.** `passes` → `reports` → `state`,
  in that order, so an interrupted close leaves a sprint that still says „aktiv" rather
  than a closed one with no record. `keyFields` on both collections makes a retry safe.
  The gap is the host's: a tool returns item changes, so no verb can close a sprint, and
  `docs/model.md` names it rather than hiding it.

## Data

- `metadata.storyPoints`: the estimate, a **string** from the `scale` options.
- `metadata.estimateConfidence`: `hoch` / `mittel` / `niedrig`.
- `metadata.sprint`: **the assignment**, a `sprints` row id. Stored, written by
  `plan_sprint` and `roll_over` and by the item form, and declared in `metadataKeys` so an
  uninstall purges it. An id rather than a name, so renaming a sprint orphans nothing.
- `metadata.sprintByDate`: **nothing writes this key.** The suggestion is computed per
  build and merged over the item's metadata by the host (`src/pluginHost/derived.ts`),
  where the computed half wins. The generic write path is not a gate, so a `PATCH` or an
  MCP write can still put a value there; it then changes nothing and is a tidy-up rather
  than a wrong bucket. That is why the key is absent from `metadataKeys`: there is nothing
  the plugin put on an item for an uninstall to purge.
- The three collections (`sprints`, `passes`, `reports`) live in the host's generic row
  store and are read only through `sprints.ts`. Their shapes are in `manifest.ts` and the
  reasoning is in [`docs/model.md`](docs/model.md).
- The cadence behind the suggestion lives in the plugin's config bag (`start`,
  `lengthDays`, `scale`, `estimateUnit`), written by `configure_plugin` on a database
  timeline or by the `plugins` entry in a local file. **It is never written as phases or
  as items:** that would store the same windows twice, and the second copy is the one that
  goes stale.

### What must not be renamed

- **`storyPoints` and `estimateConfidence`.** Both are stored on items, so a rename
  silently drops every existing value: the old key stays in the raw metadata box and no
  field reads it any more.
- **The three confidence values** (`hoch`, `mittel`, `niedrig`). They are stored values
  that happen to equal their German labels, which is the exception to „store ids, never
  labels" and is only safe because these three words are fixed. Rewording a label means
  a data migration, not an edit in `fields.ts`.
- **The three tool names.** They are what an agent calls, in a namespace shared by every
  installed plugin; renaming one breaks every prompt and every saved instruction that
  used it, with no error to see.
- **The plugin id `dev.zeitlines.sprints`.** It keys the `timeline_plugins` row, the
  plugin's own rows in the store, and the metadata it writes on items.
- **The collection ids and their field names** (`sprints`, `passes`, `reports`). They are
  the addresses of stored rows; renaming one orphans every row a timeline holds, and the
  host has no migration for a plugin.
- **The field label `Sprint`, together with the manifest `name`.** The core qualifies a
  plugin's field with the plugin name, so the interface shows the dimension as „Sprints ·
  Sprint" and the empty bucket as „Ohne Sprints · Sprint" (`dimensionLabel` in
  `src/listGrouping.ts`). Renaming either half renames both, and the README, this file
  and every saved view whose `groupBy` names the field key would have to follow.

## Domain rules

| Rule | Where | Grounded in | Confidence |
| --- | --- | --- | --- |
| Membership is assigned, not derived | `sprints.ts` (`assignedSprintId`) | canon makes the Sprint Backlog a selection; six products checked, none derives it | verified |
| A sprint's window is its own dates, else the cadence | `sprints.ts` (`sprintWindow`) | fixed-length sprints are canon; a row that carries dates is what every product stores | verified |
| The capacity sum against the sprint's `capacity` | `tools.ts`, `burndown.ts` | a sum against a number | verified |
| A closed sprint reads from its frozen report | `index.ts`, `burndown.ts` | the divergence it prevents is documented product behaviour | verified |
| The ideal line is working-day aware and anchored at the scope | `burndown.ts` | two products compute the flattening that way; the anchor is what every guideline does | verified |
| A closed sprint's figures are read in the unit its report froze | `sprints.ts` (`reportUnitOf`) | editing `capacityUnit` after a close would otherwise relabel a frozen curve | verified |
| An item's burn day is its resolved end, duration included | `burndown.ts` (`itemEndDay`) | the core's own `endFromDuration`, exported for this in host API 1.6 | verified |
| The active line is reconstructed from status and end date | `burndown.ts` | structurally what Taiga does, but from a planned date rather than a completion timestamp | plausible |
| The assignment wins and the disagreement is reported | `sprints.ts` (`sprintWarnings`) | nothing. No product needed the rule, because none draws items on a date axis like this | guessed |
| `cancelled` as a state of its own | `manifest.ts` | canon separates cancellation; no product models it separately | plausible |

A rule nobody can trace to a source gets „improved" into a different wrong rule by the
next reader, which is why the last row says „guessed" rather than describing itself as
sensible.

## Verification

```bash
npm test                        # raster, sprints, fields, tools, burndown, manifest: no DOM
npm run build && bash scripts/ci/check-bundle-split.sh   # the view's chunk and CSS
bash scripts/ci/check-design-system.sh                   # tokens and components in the view
npm run typecheck
node scripts/ci/check-plugin-isolation.mjs
npm run schema:check            # validates data/example-sprint-planung.json
npm run plugins:catalogue:check  # the catalogue entry, the README and preview.png
```

**`preview.png` is the view now.** `plugins:preview` puts the plugin's first declared
view into the hash by itself, so the plain command renders a sprint's page:

```bash
npm run dev                                            # or a worktree server
npm run plugins:preview -- sprints --size 1280x1000
```

**The size is not optional here.** The default 1280x720 cuts the burndown off below the
fold, and a cropped chart is exactly the „renders correctly and still looks like nothing"
the catalogue image exists to catch. Which sprint it shows follows the view's own default
(the active one). Nothing in CI catches a stale or wrong picture: the check requires the
file to exist, not to be the right one.

- `raster.test.ts` covers the boundaries: no start, a start before the anchor, an item
  spanning sprints, a day exactly on a boundary, a boundary across both clock changes, a
  start carrying an explicit zone (asserted timezone-independently), a value that merely
  begins like a day, a shift out of the four-digit year range, „is this a date at all"
  as its own question, an empty and a malformed config, and a `lengthDays` of 0 or
  below.
- `sprints.test.ts` covers the rows: tolerant reading of malformed `pluginData`, a
  duplicate row id, a pass pointing at no sprint, the window falling back to the cadence,
  and every warning including „two active" and „nothing to warn about".
- `tools.test.ts` covers each verb at its boundary: no sprint rows at all, a sprint id
  that names no row, an item id that names no item, `roll_over` with neither target and
  with both, a closed or cancelled target, source equal to target, finished work left
  untouched, dependents named rather than moved, an item with no usable estimate (missing,
  empty, a word, a hex or exponent string, an array, zero), `now` before, inside, after
  and unparseable, and the assertion that no plan ever carries a date. Every plan goes
  through `validateToolPlan`, so a plan the host would refuse fails here rather than at
  call time.
- `burndown.test.ts` covers the curve: a window containing a weekend, a one-day sprint,
  scope zero, an item done before the start (clamped) and one after the end, a frozen
  series with gaps and with days outside the window, and the working-day ideal line.
- By hand, in the **Sprint** presentation of `data/example-sprint-planung.json`: switch
  between „Sprint 1 (abgeschlossen)" and „Sprint 3 (aktiv)". The closed one draws its
  frozen curve and says so; the active one draws a reconstruction, carries the „no
  goal" warning where its goal would be, and names the item with no estimate. „Sprint
  bearbeiten" edits goal, window, state, capacity and note; activating a second sprint
  has to be refused by name. On the timeline, the two dimensions „Sprints · Sprint"
  (the assignment) and „Sprints · Sprint nach Datum" (the suggestion) must disagree for
  exactly the one item the example plants for it.

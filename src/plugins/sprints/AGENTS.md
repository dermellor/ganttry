# Sprints

Conventions for changing **this plugin**. Rules that apply to the whole codebase stay
in the root [`AGENTS.md`](../../../AGENTS.md), and what a reader needs in order to
*use* the plugin is [`README.md`](README.md), which is also the public page. Neither is
restated here: a copy is how one of them ends up fixed and the other does not.

## Invariants

- **The sprint is computed, never stored.** `sprint` is a `derived: true` field
  (`fields.ts`) filled by `sprintsDerive`, and it is deliberately absent from the
  manifest's `metadataKeys`. Storing it would mean an item that moves keeps the sprint
  it was in, and nothing in the interface would say so: a stale bucket is
  indistinguishable from a chosen one. It is also why `metadataKeys` names only the two
  chosen keys, since an uninstall has nothing else to purge.
- **`raster.ts` is the only place that decides which sprint a date is in.** `fields.ts`
  (the lanes a user sees) and `tools.ts` (the sums an agent gets) both import it. Two
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
- **No velocity, no capacity answer.** Absent, zero, negative and unparseable are one
  case in `readSprintConfig` (`velocity: null`), because the answer owed to the caller is
  the same for all four and „velocity: 0" is not something a rule may divide by. The two
  reading verbs say they cannot answer; `rebalance_sprint` throws, because it writes and
  „what fits" is undefined without a yardstick. Zero and negative are refused one layer
  earlier as well, by `configSchema` (`minimum: 0.01`), so an operator gets a rejected
  `configure_plugin` call instead of a plugin that looks configured and is not.
- **An item with no usable estimate is named, never counted as zero.** A sum that
  quietly omits three items reads as a capacity statement and is not one. „Usable" is
  literal: a `select` value is a **string**, and only a plain decimal counts
  (`/^[+-]?\d+(?:\.\d+)?$/`). So `"8"` and `"8.5"` count, while `""`, `"XL"`, `0`, a
  stray array, `"0x10"` and `"1e3"` do not. `Number()` would have read those last two as
  16 and 1000, which turns a typo into a capacity figure.
- **`rebalance_sprint` relieves one sprint and stops.** If the receiving sprint is
  overcommitted afterwards it says so. A cascade would rewrite the rest of the roadmap
  out of a single call, and an agent that wants the next sprint relieved can ask again.
- **Four kinds of item never move, and each is named rather than skipped.** An item
  whose own estimate exceeds the velocity (it fits in no sprint, so each call would push
  it one further down the roadmap and leave the receiving sprint over by the same item);
  an item that is `Done` (finished work is not a capacity lever, and re-dating it
  rewrites history — its points still count in the sum, which is why the verdict does
  not change); an item another item depends on (moving it would start a successor before
  its predecessor ends, which the relation graph then draws as a backward arrow); and one
  whose id or dates cannot be written (a whitespace id, or an end that would have to
  stretch). `forecast_completion` and `rebalance_sprint` read „done" through the same
  helper, so the two verbs cannot disagree about what work is in a sprint.
- **When the immovable part alone exceeds the velocity, nothing is written.** Not one
  move, and the reason is said. A date rewrite that cannot relieve the sprint looks
  exactly like a tool that worked.
- **There is no view and no `load()`.** Grouping by „Sprints · Sprint" is the raster
  rendering. A `load()` would be a dynamic import, which is a build chunk that renders
  nothing. `PluginDescriptor.load` is optional for exactly this case: this plugin was
  what made it so, and a descriptor here needs no cast.

## Data

- `metadata.storyPoints`: the estimate, a **string** from the `scale` options.
- `metadata.estimateConfidence`: `hoch` / `mittel` / `niedrig`.
- `metadata.sprint`: **the plugin never writes it, and no answer reads it.** The value
  is computed per build and merged over the item's metadata by the host
  (`src/pluginHost/derived.ts`), where the computed half wins. The generic write path is
  not a gate, so a `PATCH`, an MCP `update_item` or a hand-edited file can still put a
  value there; it then changes nothing and is a tidy-up rather than a wrong bucket. That
  is also why the key is deliberately absent from `metadataKeys`: there is nothing the
  plugin put on an item for an uninstall to purge.
- The raster itself lives in the plugin's config bag (`start`, `lengthDays`, `velocity`,
  `scale`), written by `configure_plugin` on a database timeline or by the `plugins`
  entry in a local file. **It is never written as phases or as items:** that would store
  the same raster twice, once as config and once as data, and the second copy is the one
  that goes stale.

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
- **The plugin id `dev.zeitlines.sprints`.** It keys the `timeline_plugins` row that
  carries the raster.
- **The field label `Sprint`, together with the manifest `name`.** The core qualifies a
  plugin's field with the plugin name, so the interface shows the dimension as „Sprints ·
  Sprint" and the empty bucket as „Ohne Sprints · Sprint" (`dimensionLabel` in
  `src/listGrouping.ts`). Renaming either half renames both, and the README, this file
  and every saved view whose `groupBy` names the field key would have to follow.

## Domain rules

| Rule | Where | Grounded in | Confidence |
| --- | --- | --- | --- |
| Sprint membership from the start date against anchor plus fixed length | `raster.ts` | mechanical; fixed-length sprints are the [2020 Scrum Guide](https://scrumguides.org/scrum-guide.html)'s own constraint | verified |
| The capacity sum against `velocity` | `tools.ts` (`check_sprint_capacity`) | a sum against a number | verified |
| An item spanning sprints counts in the one it starts in | `raster.ts` (`sprintOfItem`) | our decision, so one item sits in one lane and is counted once | plausible |
| Velocity as the basis of a forecast, counted from the later of today's sprint and the earliest sprint holding open scheduled work | `tools.ts` (`forecast_completion`) | complementary practice, not in the Scrum Guide. The notes say so on every answer, no date is presented as a commitment, and open work scheduled past the computed finish is named | a convention, not a rule |
| The overflow order: latest start, larger estimate, item id, applied to what may move at all | `tools.ts` (`rebalance_sprint`) | nothing. The core has no priority field, so „lowest priority first" cannot be written; this is a deterministic stand-in | guessed |

A rule nobody can trace to a source gets „improved" into a different wrong rule by the
next reader, which is why the last row says „guessed" rather than describing itself as
sensible.

## Verification

```bash
npm test                        # raster, fields, tools, manifest: 75 cases, no DOM
npm run typecheck
node scripts/ci/check-plugin-isolation.mjs
npm run schema:check            # validates data/example-sprint-planung.json
npm run plugins:catalogue:check  # the catalogue entry, the README and preview.png
```

**Regenerating `preview.png` needs the saved view, or the picture shows nothing of this
plugin.** The grouping dimension is not in the hash on purpose (it is per-timeline
display state), so a bare preview URL renders the example grouped by group: an ordinary
timeline that says nothing about sprints. The example therefore ships the saved view
`nach-sprints`, and the preview is taken through it:

```bash
npm run dev                                                   # or a worktree server
npm run plugins:preview -- sprints --param sv=nach-sprints
```

Leaving out `--param` produces a valid image of the wrong thing, and nothing in CI
catches that: the check requires the file to exist, not to be the right picture.

- `raster.test.ts` covers the boundaries: no start, a start before the anchor, an item
  spanning sprints, a day exactly on a boundary, a boundary across both clock changes, a
  start carrying an explicit zone (asserted timezone-independently), a value that merely
  begins like a day, a shift out of the four-digit year range, „is this a date at all"
  as its own question, an empty and a malformed config, and a `lengthDays` of 0 or
  below.
- `tools.test.ts` covers each verb at its boundary: no velocity and a velocity of 0, an
  item with no usable estimate (missing, empty, a word, a hex or exponent string, an
  array, zero), an empty sprint, and the four kinds of item that never move (oversized
  estimate, `Done`, depended-on, an unwritable id or date) plus the refusal to write
  anything when the immovable part alone exceeds the velocity. Also: items the raster
  does not place at all, a forecast the plan contradicts, an unusable `now`, a float sum
  whose verdict must not contradict the printed figures, a sum that is no longer a
  representable number, a rejected sprint argument quoted so it cannot look valid, and
  the tie-break as a total order. Every plan is asserted against `validateToolPlan`, so
  a plan the host would refuse fails here rather than at call time.
- By hand: `data/example-sprint-planung.json` is the example, and its saved view „Nach
  Sprints" is the one click that groups it. Expect lanes for sprints 1, 2, 3, 4, 5 and 7
  plus the „Ohne Sprints · Sprint" bucket
  (sprint 6 holds nothing, so it has no lane), with sprint 3 overcommitted against a
  velocity of 20. Dragging an item across a sprint boundary has to change its lane
  without anything being saved to the item.

# The sprint model

The reference for this plugin's data. The README is the page a user reads; this is
what a contributor changes the code against.

Grounded in three tiers, kept apart on purpose: **canon** is the
[2020 Scrum Guide](https://scrumguides.org/scrum-guide.html) and its
[revision log](https://scrumguides.org/revisions.html); **practice** is what teams do
without the Guide saying so; **observed** is what named products store, from their own
documentation. A decision that follows practice against canon says so, and why.

## Why the sprint is an entity and not a date range

The first cut of this plugin derived the sprint from an item's start date. That is
wrong in the domain, and the reason is not cosmetic: canon makes the Sprint Backlog
*a selection* („the set of Product Backlog items selected for the Sprint", „a plan by
and for the Developers"), so membership is an act, not a date test. Of six products
checked — Jira, Azure DevOps, Linear, GitHub Projects, YouTrack, OpenProject — **none**
derives membership from dates; all carry an assignment on the item.

A date-derived label also has no room for the thing canon cares about most. The
**Sprint Goal** is not a caption: it is the change-control criterion during the Sprint
(„No changes are made that would endanger the Sprint Goal"), what the Daily Scrum
inspects, the only cancellation trigger, and one of the framework's three commitments.
A label computed from a date cannot hold it.

So: sprints are rows, membership is assigned, and the raster survives as a *suggestion*
rather than as the truth.

## Collections

Three, in the host's generic row store (`collections` in the manifest, no migration).

### `sprints` (ordered)

| Field | Type | Required | Why |
| --- | --- | --- | --- |
| `name` | string | yes | Every product requires one. Numbering is the default („Sprint 7") |
| `goal` | string | no | **Canon requires it, no product enforces it.** Nullable in storage, warned about while the sprint is active: that is the only way to be true to both |
| `start` | date | no | Required before the sprint may become `active`. **Never discarded:** a row with a start and no end runs from that start for the cadence length, and every statement of such a window says the end was computed |
| `end` | date | no | Same. Canon: fixed length, one month or less, never extended |
| `state` | `planned` \| `active` \| `closed` \| `cancelled` | yes | Practice, near-universal in the products. `cancelled` is separate because canon gives it its own cause (an obsolete Sprint Goal) and its own authority (the Product Owner) |
| `closedOn` | date | no | The actual close, distinct from `end`: a sprint can be closed early, and one date cannot answer both „when was it meant to end" and „when did it" |
| `capacity` | number | no | Per sprint, never one team constant: what a team can take varies with absences and with a shortened sprint |
| `capacityUnit` | `points` \| `hours` \| `items` | no | Defaults to the config's `estimateUnit` |
| `note` | string | no | Review and retro outcome, or the cancellation reason. One field rather than three, because nothing computes on it |

**At most one `active` sprint per timeline.** Canon: „A new Sprint starts immediately
after the conclusion of the previous Sprint". The host enforces no cross-row rule, so
the plugin refuses the second activation itself and `sprint_status` reports a violation
it finds.

### `passes` (keyed on `itemId` + `sprintId`)

The per-item sprint history, which one assignment key cannot hold: Jira keeps
`closedSprints` on the issue, YouTrack an issue-to-sprints relation.

| Field | Type | Why |
| --- | --- | --- |
| `itemId` | string | the item that passed through |
| `sprintId` | string | reference into `sprints`, `onDelete: cascade` |
| `outcome` | `done` \| `carried` \| `removed` \| `cancelled` | what became of it at close |
| `recordedOn` | date | when the close happened |
| `estimateAtClose` | number, optional | the estimate as it stood, so a later re-estimate does not rewrite the record |

`keyFields` makes a repeated close idempotent rather than duplicating rows, which
matters because closing is several writes and may be retried.

### `reports` (keyed on `sprintId`)

The frozen result of a closed sprint: scope at start and at close, completed, carried,
and `series` — the burndown curve as it was.

Freezing is a decision with a documented failure behind it: Linear preserves a
completed cycle's graph as a snapshot precisely because the issue list keeps moving
afterwards, and the two then diverge. Recomputing a past chart from live items means
every edit silently rewrites history.

## Membership, and the two clocks

- `metadata.sprint` holds the **assigned** sprint's row id. Stored, and the options of
  its field are the `sprints` rows. Ids, never labels, so renaming a sprint orphans
  nothing.
- `sprintByDate` stays a **derived** field: the sprint whose window contains the item's
  start. It is the suggestion the raster gives, and it is what makes the timeline's own
  axis useful for planning.
- **The assignment wins, and a disagreement is shown rather than resolved.** Both
  silent fixes are wrong: moving the item's dates edits a plan the user made, moving it
  out of the sprint edits a commitment the team made. No product needed this rule,
  because no product draws items on a date axis the way this one does.

## What „done" means here

The core's item status (`Done`) is the mapping, and that *is* the Definition of Done as
far as any number in this plugin goes. Jira resolves the same question through board
columns, OpenProject through a configured set of closed statuses. The Definition of Done
itself belongs to the product rather than to a sprint (canon puts it on the Increment),
so it lives in the plugin config, not on a sprint row.

## The burndown

- **x-axis** the sprint's days, **y-axis** remaining work in the unit the figures are
  counted in. Both match every product that draws one. `capacityUnit: 'items'` counts
  entries rather than summing their estimates, and a closed sprint's report **freezes the
  unit with the figures**: editing the row's `capacityUnit` afterwards would otherwise
  relabel a curve that was counted in something else, which is the opposite of what
  freezing is for.
- **The ideal line is anchored at the full scope on the first day.** It burns only over
  the days after it, which is what every product's guideline does, and the reason is
  readability rather than arithmetic: without the anchor the plan line opens below the
  actual one and day one draws the team behind before anything could have happened.
- **The ideal line is working-day aware.** Azure DevOps computes it from working days,
  Linear flattens it over weekends; OpenProject's plain-linear line is the counterexample
  and it is the one that visibly disagrees with what a team expects.
- **For the active sprint the actual line is a reconstruction**, from each item's status
  and its **resolved** end (`end`, else `start` plus `duration`, through the core's own
  `endFromDuration`), and the view says so. Resolving the duration is not optional: the
  repo's own examples date items by duration, and burning them on their start day made a
  burndown describe when work began. This repo keeps no revision history for items, so
  there is no record of when something became done; moving an item's end date changes
  yesterday's curve. Taiga computes its chart the same way, from completion dates.
- **For a closed sprint the frozen `series` is the truth**, never a recomputation.

Canon names burndowns and refuses to require them („Various practices exist to forecast
progress, like burn-downs, burn-ups, or cumulative flows. While proven useful, these do
not replace the importance of empiricism"), and the 2011 revision dropped even the
daily-summing requirement. So the chart is an aid, and the plugin never presents it as a
measurement of a team.

## Velocity: computed, never displayed as a metric

The plugin uses the completed points of the last three closed sprints to **suggest** a
capacity for a sprint that has none, which is what Linear does with its capacity dial.
It does not show a velocity figure, and it draws no „committed versus completed" bar.
The reasoning is sourced rather than stylistic: the framework moved away from
„commitment" for a Sprint's scope in 2011 („The Development Team creates a forecast of
work it believes will be done"), the person most associated with story points regrets
their use for prediction and warns specifically against comparing teams by velocity
([Ron Jeffries, 2019](https://ronjeffries.com/articles/019-01ff/story-points/Index.html)),
and the general form of the objection is that output cannot be measured
([Martin Fowler, 2003](https://martinfowler.com/bliki/CannotMeasureProductivity.html)).
A velocity number on a page invites exactly the use those warn about.

## Agent verbs

| Verb | Writes | What it does |
| --- | --- | --- |
| `plan_sprint` | items | assigns the named items to a sprint; names anything whose dates fall outside its window |
| `roll_over` | items | moves the unfinished work of one sprint to an explicit target: another sprint, or the backlog (clearing the assignment). **The target has no default**, because canon says unfinished work „returns to the Product Backlog" while the common products default to the next sprint, and a silent default would pick a philosophy on the caller's behalf |
| `sprint_status` | nothing | remaining, scope, days left, and every warning it can see: an active sprint without a goal, a second active sprint, items whose dates disagree with their assignment, items with no usable estimate |

## What this model cannot do, and why the gap is the host's

1. **A close is not atomic.** A tool returns item changes, so `roll_over` can move items
   but cannot flip the sprint's `state`, write `passes` or freeze `reports` in the same
   operation. Those are `host.data` calls from the view. An interrupted close leaves
   items moved with no record of the move.
2. **Nothing fires at a sprint boundary.** No scheduler, no lifecycle hook. A sprint that
   ended last Tuesday stays `active` until a person or an agent says otherwise.
3. **No people, so no real capacity.** One number per sprint, not person times day minus
   days off. It cannot answer „who is over-committed".
4. **No item revision log**, which is why the active burndown is a reconstruction.
5. **A sprint cannot span timelines**, because plugin rows are scoped to one.

## Open questions

Settled here by decision, not by evidence, and therefore the first things to change if a
practitioner says otherwise:

1. `roll_over` demanding an explicit target rather than defaulting to the next sprint.
2. `cancelled` as a state of its own rather than a closed sprint with a reason.
3. One `note` field for review, retro and cancellation instead of three.
4. A missing estimate is named, never counted as zero and never replaced by a team
   average.
5. One active sprint per timeline, refused rather than warned about.

# Sprints

## What does it do?

It gives a timeline a sprint raster, and the raster is a rule rather than data: which
sprint an item falls into follows from that item's start date plus the cadence the
timeline was configured with. Nothing is stored per item, so an item that moves
changes sprint by itself. On top of that it can say whether a sprint is
overcommitted, move what does not fit into the next one, and report the sprint a
remaining scope is expected to finish in.

## Who is it for?

A team that keeps a roadmap and a sprint cadence at the same time and has to answer
"which sprint is this in" and "does this sprint still fit" from the same picture,
without maintaining a sprint field on every item by hand.

## Where can you see it?

The committed example is [`data/example-sprint-planung.json`](../../../data/example-sprint-planung.json):
sixteen items across four tracks, a fortnightly raster from 2026-01-05 and a velocity of
20. It ships the saved view **„Nach Sprints"**, which is the one click that turns the
plan into its raster.

![The example timeline, grouped by the derived sprint](preview.png)

## How do you switch it on?

There is no interface for enabling a plugin yet
([#85](https://github.com/zeitlines/zeitlines/issues/85)), so it is an MCP call or a
line in the file. On a database timeline the verb is `configure_plugin` on the local
stdio server (`npm run mcp`) and `enable_plugin` on a deployed instance, which is the
same operation under two names. In a local file it is an entry in `plugins`:

```json
{
  "plugins": [
    {
      "id": "dev.zeitlines.sprints",
      "config": { "start": "2026-01-05", "lengthDays": 14, "velocity": 20 }
    }
  ]
}
```

| Config key | Meaning | Default |
| --- | --- | --- |
| `start` | anchor date of sprint 1, `YYYY-MM-DD` | required; without it the plugin contributes nothing |
| `lengthDays` | sprint length in days, fixed for every sprint | `14` |
| `velocity` | story points a sprint is expected to hold | absent = the capacity and forecast verbs answer that they cannot answer. A value below `0.01` is refused by the config schema rather than stored, because it rounds to zero at the resolution every verdict compares at |
| `scale` | the estimate options offered | `["1","2","3","5","8","13","21"]` |

## What fields does it add?

| Key | Label | Type | Where the value comes from |
| --- | --- | --- | --- |
| `sprint` | Sprint | select, **derived** | computed from the item's start against the raster; read-only, never stored |
| `storyPoints` | Story Points | select | chosen; options from `scale` |
| `estimateConfidence` | Confidence | select (hoch, mittel, niedrig) | chosen |

The sprint field's **options are the sprints the timeline's items actually occupy**,
in chronological order. A sprint that holds nothing therefore offers no option and
gets no lane — grouping by sprint shows the sprints in play rather than a run of
empty ones out to the end of the raster.

Three boundaries the rule has to hold, and each is a test:

- an item **without a start** has no sprint and lands in the empty bucket, which the
  interface names „Ohne Sprints · Sprint" (the core qualifies a plugin's dimension with
  the plugin name, so „Sprints · Sprint" is the dimension and this is its „Ohne …");
- an item starting **before the anchor** has no sprint either, rather than a
  „Sprint 0";
- an item **spanning several sprints** belongs to the one its start falls into. That
  keeps one item in one lane and lets the capacity sum count it exactly once. It also
  means a long item is absent from the sprints it runs through, which is the trade
  and is question 1 below.

## What can your agent do with it?

| Tool | Writes | The rule it applies |
| --- | --- | --- |
| `check_sprint_capacity` | nothing | the sum of story points per sprint against `velocity`. It also names what it could not count: the items with no usable estimate, and the ones the raster does not place at all (no start, or a start before the anchor) with their points and ids. A sum that quietly omits either is not a capacity statement |
| `rebalance_sprint` | items | moves items out of one overcommitted sprint until the sum fits: latest start first, tie-break larger estimate, then item id. A move shifts the start by one sprint length and keeps the duration |
| `forecast_completion` | nothing | open story points against `velocity` → the sprint the scope is expected to finish in, counted from the later of today's sprint and the earliest sprint that still holds open scheduled work. Optionally narrowed to one group |

**Four kinds of item never move**, and each is named in the answer rather than quietly
skipped: work that is already `Done` (finished work is not a capacity lever, though its
points still count in the sum), an item another item depends on (moving it would put a
successor before its predecessor and draw a backward arrow in the relation graph), an
item whose own estimate exceeds the whole velocity, and one whose id or dates cannot be
written. When what cannot move already exceeds the velocity on its own, the call
changes **nothing** and says why: a date rewrite with no possible benefit is worse than
a refusal, because it looks like the tool worked.

`rebalance_sprint` relieves **one** sprint and stops. If the receiving sprint is
overcommitted afterwards it says so instead of cascading: a cascade rewrites the rest
of the roadmap from a single call, and an agent that wants that can ask again for the
next sprint.

`forecast_completion` says two things a bare division cannot. When the plan itself
contradicts the extrapolation, because open work is scheduled after the computed finish
sprint, it names that work. And when the date it was handed is not a date, it says the
count started at sprint 1 for that reason rather than presenting the number as if the
clock had been read.

There is no `plan_sprints`. A tool returns item changes and notes, not configuration
([`docs/plugin-authoring.md`](../../../docs/plugin-authoring.md)), and the raster is
configuration — `configure_plugin` already writes it.

## How well is this domain modelled?

| Part | Standing |
| --- | --- |
| The raster and sprint membership | **verified** — mechanical: the start date against anchor plus length |
| The capacity arithmetic | **verified** — a sum against a number |
| Velocity as a basis for forecasting | **a convention, not a rule.** Velocity and story points are not in the Scrum Guide; they are complementary practice. A date computed from an average velocity is an extrapolation, and this page will not present one as a commitment |
| The overflow order | **guessed.** The core has no priority field, so the rule cannot be „lowest priority first", which is what a team would expect. „Latest start first" is defensible and deterministic, and it is a stand-in. It orders only what may move at all: the four exclusions above come first |

Fixed-length sprints are the Scrum Guide's own constraint ([2020 Scrum
Guide](https://scrumguides.org/scrum-guide.html): sprints are fixed-length events of
one month or less), which is why the raster has one length and no exceptions. A team
with a varying cadence is described wrongly by it, and the plugin says so rather than
smoothing it over.

## Improve this plugin

Five questions decide how good this is, and none of them can be answered from the
code:

1. Should an item spanning two sprints count in both, or does it belong to the sprint
   it starts in?
2. What should leave an overcommitted sprint first, when there is no priority?
3. Is an average over *n* sprints the usable velocity, or the minimum of the last
   three?
4. Should a sprint holding nothing appear as an empty lane?
5. Are sprint names worth it („Sprint 14" against „Herbst-Härtung"), or is numbering
   enough?

Corrections from anyone who runs sprints for a living are the contribution this
plugin most needs. See [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## How does it compare?

Category: sprint planning on a self-hosted roadmap. The terminology it deliberately
adopts rather than inventing:

| Our word | The common word | Used where |
| --- | --- | --- |
| Schätzung, Aufwand | **Story Points** | field label, this page |
| Raster, Kadenz | **Sprintlänge** | config, this page |
| Durchsatz | **Velocity** | config, this page |

Core vocabulary stays as it is: a sprint is **not** a group and **not** a phase, it is
the value of a derived field. Which is also why this plugin writes no phases for the
raster — that would store the same raster twice, once as config and once as data, and
the second copy is the one that goes stale.

## What it deliberately does not do

- **Capacity per person, and absence conflicts.** A separate plugin's job. A sprint
  plugin asking it for an answer would need a plugin-to-plugin call the contract does
  not have; if this plugin wants one, that is a finding rather than a reason to
  duplicate the rule here.
- **Variable sprint lengths.** One anchor, one length. See the confidence section.
- **A view of its own.** Grouping by „Sprints · Sprint" gives the raster rendering,
  and a burndown chart is a second product rather than a second view.
- **Sprint names, and a commitment record.** Numbering is the model; what a team
  committed to in Sprint Planning is not in Zeitlines, so this plugin knows the
  planning clock only.

## Catalogue entry

What the manifest will carry, so the generated catalogue and this page cannot
disagree:

- **Name:** Sprints
- **Summary:** A sprint raster that follows from the dates: which sprint an item is in
  is computed, not stored, with capacity checks and a forecast on top.
- **Domain:** `delivery-planning` (a slug: the manifest validator refuses a space, and
  an invalid manifest is refused at load rather than at install)
- **Keywords:** sprint, sprint planning, story points, velocity, capacity, forecast,
  scrum, self-hosted roadmap
- **Example:** `src:example-sprint-planung`

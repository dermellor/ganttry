# Data model

The shape of a timeline file, how dates are extracted, and the viewer's config.

Part of the Ganttry documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Data extraction

- **Date sources** (default order, configurable per view): `date` → `scheduled` → `created` → filename pattern.
- **Filename patterns**: `2026-01-09…`, `20210917…` (regex list in `timelines.config.json`).
- **Range items**: `duration` field (`7d`, `2w`, `90m`, ISO `P7D`) on top of start, OR explicit `end` / `until` field.
- **Skipped**: notes without any resolvable date are omitted.

## Standalone JSON timelines

Drop a `*.json` file into the project's `data/` folder. The build script copies it to `public/data/sources/<basename>.json` and adds it as an automatic view (`id: "src:<basename>"`). No config edit needed.

**The field list is not maintained here.** It is generated from
[`src/types.ts`](../src/types.ts) into
[`schema/timeline.schema.json`](../schema/timeline.schema.json) (`npm run schema`), so
add `"$schema": "../schema/timeline.schema.json"` to your file and the editor
completes and validates it. CI checks that the committed schema still matches the
types and that the examples still validate, which is what keeps this section from
drifting: a stale `title` field survived here for a while after the DB column
backing it was dropped, precisely because it was a hand-maintained copy.

What the schema cannot express is below: the constraints between fields, and why
they exist. Shape at a glance:

```jsonc
{
  "$schema": "../schema/timeline.schema.json",
  "name": "Projektplan 2026",            // optional, falls back to filename
  "description": "...",                  // optional
  "items": [
    {
      "id": "kickoff",                   // optional
      "start": "2026-01-15",             // optional; a date-less item shows only in the list view (see below)
      "end": "2026-02-28",               // optional; must be AFTER start; mutually exclusive with duration (end wins)
      "duration": "3w",                  // optional ("7d", "2w", "90m", number = ms) — only when no end
      "content": "Kickoff",
      "group": "Phase 1",                // optional
      "type": "point",                   // optional: point | range | background | box
      "icon": "milestone",               // optional: semantic icon key (see "Item icons")
      "status": "Open",                  // optional: Open | Doing | Done (see "Item status"); defaults to Open
      "body": "Markdown shown in detail panel",  // optional
      "metadata": { "owner": "someone@example.com", "tags": ["Qualität & Daten"] }  // optional
    }
  ],
  "groups": [
    { "id": "Phase 1", "content": "Phase 1: Discovery" },
    {
      "id": "comm",
      "content": "Kommunikation",
      "nestedGroups": ["comm-product", "comm-tech"],  // optional: children rendered indented under parent, collapse-/expandierbar
      "showNested": true                              // optional, default true
    }
  ],                                     // optional, derived from items if missing
  "phases": [                            // optional: labeled ribbon across the top
    {
      "id": "ph-pre",                    // optional, but needed to edit reliably
      "label": "Pre-Launch",
      "start": "2026-06-28",
      "end": "2026-09-15",               // optional, OR
      "duration": "6w",                  // optional (same format as items)
      "color": "#64748B",                // optional
      "icon": "launch"                   // optional: semantic icon key (see "Item icons")
    }
  ]
}
```

A phase needs a `label`, a `start`, and an extent (`end` or `duration`) to
render; phases missing any of these are skipped. They show as a labeled ribbon
pinned to the top plus a faint full-height tint behind the items. The ribbon
segment is positioned through vis-timeline's own time→pixel conversion
(`body.util.toScreen` over the content width, with day strings parsed as *local*
midnight — see [`src/phaseBand.ts`](../src/phaseBand.ts) / [`src/date.ts`](../src/date.ts)),
so the bar stays pixel-aligned with its tint regardless of zoom or a reserved
scrollbar. Adjacent bars keep a small fixed gap (the tints stay flush).

**Phases must not overlap in time** — touching boundaries (one phase's `end` ==
the next's `start`) and gaps are both fine, but real overlaps are forbidden. The
rule lives once in [`src/phaseOverlap.ts`](../src/phaseOverlap.ts) and is enforced on
both sides: the server write path (`updatePhases` / `replaceTimeline`) rejects an
overlapping write with `400` from any source (UI, MCP, direct API), and the
client prevents it proactively (ribbon drag/resize clamps to the neighbour edge,
the phase form blocks a save that would overlap). Without this, an underlying
phase used to show through the gap between overlapping bars.

**An item's `end` must lie after its `start`** — a reversed or zero-length extent
is rejected, not rendered. vis-timeline derives a bar's width from `end - start`,
so a non-positive result collapses the bar to its minimum width and the item shows
as a hairline stripe that reads as a rendering glitch rather than as bad data.
Every write path used to accept it silently.

The rule lives once in [`src/itemExtent.ts`](../src/itemExtent.ts) and is enforced on
both sides, the same shape as the phase-overlap rule above: the server write path
(`addItem` / `updateItem` / `replaceTimeline`, in **both** DB drivers) rejects it
with `400` from any source (UI, MCP, direct API), and the client prevents it
proactively — the two date inputs carry native `min`/`max` bounds so the pickers
can't offer a crossing date, and `applyItemForm` refuses to write a reversed pair
into the model, keeping the last valid dates. It rejects the extent as a whole
rather than guessing which date the user meant to move: to shift an item past its
own end, change the end first.

The reason is shown **in the form**, under the date fields (`showExtentError` /
`.field-error`), not in the status line where the sibling „Metadata JSON ungültig"
notice goes. That distinction is load-bearing rather than cosmetic: leaving a
field's edit out of the model still schedules a commit, and the persist that
follows reports „Gespeichert" milliseconds later — so a status-line message
flashed and vanished, leaving the user looking at „Gespeichert" while the date
they typed had in fact been refused. That reads as a successful save of bad data,
which is worse than saying nothing. An item already stored reversed (from before
this rule) shows the message the moment its form opens, since that is what
explains its hairline bar.

Strict on purpose — `end == start` is a zero-day range and produces the identical
hairline, and `resolvePhaseExtentMs` demands `end > start` for phases too. A single
point in time is a Meilenstein (`type: "point"`), a single day carries
`duration: "1d"`. `duration` needs no counterpart rule: `durationToMs` rejects
non-positive values and its pattern accepts no sign, so an extent expressed that
way can never run backwards.

`updateItem` is the one non-obvious spot: a *partial* patch can reverse the extent
while carrying only one of the two dates (`PATCH {end}` alone against a later
stored `start`), so the counterpart is read off the stored row — only when the
patch actually leaves one side open. The viewer always sends a full patch
(`buildItemPatch`), so that extra read is the direct-API/MCP-shaped case, never
the interactive one. There is deliberately **no** DB `CHECK` constraint: `start` /
`end` are `text` columns, so the check would be a lexicographic comparison that
silently stops holding for any other date format, and it would surface as a `500`
instead of the `400` with a readable message.

A group with `nestedGroups` is a **parent/container only** — items are assignable
solely to its leaf children, never to the parent itself. The editor enforces this
everywhere (form dropdown renders parents as non-selectable `<optgroup>` headings,
a drag onto a parent lane snaps into its first leaf, new items default to the
first leaf group). The rule lives once in [`src/groupHierarchy.ts`](../src/groupHierarchy.ts).

Items without `content` are skipped. `start` is optional: a date-less item is
kept and shown in the **list view** (dates render as „—"), but the **timeline
view** filters it out (vis-timeline needs a start to place an item) and the
status line notes how many are hidden. Two reference files live in `data/`:

- `example-projektplan.json` — minimal 4-phase plan, single track per phase.
- `launch-roadmap.json` — 5 parallel tracks with `dependsOn` cross-references in `metadata`.

### Roadmap conventions

When generating a roadmap (whether for this project or invoked from elsewhere — see the global pointer in `~/.claude/CLAUDE.md`), follow these conventions so files stay consistent and easy to scan:

- **One file per roadmap.** Filename in kebab-case, no umlauts: `q3-roadmap-2026.json`, `feature-x-launch.json`. Becomes `src:<filename>` in the view list automatically.
- **Group IDs with sort prefix.** `1-strategy`, `2-design`, `3-engineering` — vis-timeline sorts groups alphanumerically; the prefix locks the row order.
- **Item IDs use track prefix + counter.** `S-1`, `D-2`, `E-3`, `M-4`, `O-5`. Short, easy to reference from `metadata.dependsOn`.
- **Milestones as `type: "point"`** with no `duration`/`end`. Phase backgrounds as `type: "background"` in their own group.
- **Dependencies live in `metadata.dependsOn: ["id1", "id2"]`.** The viewer renders subtle right-angle "Gantt" connectors (SVG overlay in [`src/arrows.ts`](../src/arrows.ts)) from each predecessor's finish to the successor's start (its left edge). Back-to-back/overlapping items are routed to stay readable, and several predecessors on one target enter at vertically staggered points so they don't stack into one arrow. Off-screen sources/targets simply hide the arrow until they scroll into view. Make sure dependency target items have explicit `id`s so they can be referenced.
- **Bodies are Markdown.** Use them for owner notes, success criteria, links — they show up as the side panel content when the item is clicked.
- **Tags live in `metadata.tags: ["Label", …]`.** Lightweight coloured theme markers rendered as pills before the item's title (a legacy singular `metadata.tag` string is still read for backwards compatibility). Colours are resolved centrally in [`src/buildItems.ts`](../src/buildItems.ts) (`TAG_COLORS`, with a grey fallback for unknown labels). Responsive: the label text collapses to just a coloured dot once the view is zoomed out below `TAG_TEXT_MIN_PX_PER_DAY` px/day ([`src/main.ts`](../src/main.ts), `updateTagDensity`), and reappears when you zoom back in.
- **Dates as `YYYY-MM-DD`** without time component unless precision matters. `duration` accepts `Nh|d|w|mo|y` or raw milliseconds.

## Configuration: `timelines.config.json`

```jsonc
{
  "notesDir": "~/notes",
  "defaultView": "all",
  "dateFields": ["date", "scheduled", "created"],
  "filenameDatePatterns": ["^(\\d{4})-(\\d{2})-(\\d{2})", "^(\\d{4})(\\d{2})(\\d{2})"],
  "views": [
    {
      "id": "kurzbeitraege",
      "name": "Kurzbeiträge",
      "filter": { "filenameContains": "Kurzbeitrag" },
      "dateFields": ["scheduled", "date", "created"],
      "groupBy": "status"
    }
  ]
}
```

`notesDir` is the directory scanned for Markdown notes. The env var
**`TIMELINES_NOTES_DIR`** overrides the committed `notesDir` (same `~` expansion),
so a checkout can point at its own notes without editing the tracked config —
e.g. set `TIMELINES_NOTES_DIR=~/my-notes` in `.env.local`. If
the resolved directory does not exist, the build **warns and proceeds with zero
notes** (standalone/DB sources still build); it does not fail. In
`TIMELINES_STATIC_ONLY` mode the notes scan is skipped entirely.

### Filter clauses

| Key                 | Type                 | Effect                                            |
| ------------------- | -------------------- | ------------------------------------------------- |
| `filenameContains`  | string               | substring match on filename                       |
| `folder`            | string \| string[]   | folder path (or prefix) match                     |
| `status`            | string \| string[]   | match against `status` frontmatter                |
| `categories`        | string \| string[]   | intersect with `categories` frontmatter           |
| `tags`              | string \| string[]   | intersect with `tags` frontmatter                 |
| `draft`             | boolean              | match `draft: true/false`                         |
| `has`               | string \| string[]   | require frontmatter keys to be set                |
| `allOf` / `anyOf`   | FilterClause[]       | logical combinators                               |
| `not`               | FilterClause         | negation                                          |

### Grouping

`groupBy` is a frontmatter expression: `categories[0]`, `status`, `folder`, `topics[0]`, `tags[0]`. Notes without that field land in an `_ungrouped` bucket.

# The pricing model

The reference for what a `product-roadmap` timeline carries beyond items: the
shape of the model, how versions gate what is shown, and how the matrix is
edited.

This file belongs to the plugin, not to the core documentation, and that is the
rule rather than a filing preference: uninstall the plugin and every sentence
here becomes orphaned, which is what makes it plugin documentation
([#18](https://github.com/zeitlines/zeitlines/issues/18)). What the plugin *is*
and how to switch it on is [`../README.md`](../README.md); how to change it is
[`../AGENTS.md`](../AGENTS.md). The seams it sits on are core chapters: „The
generic store" (docs/plugin-storage.md), „Publishing a plugin's data"
(docs/plugin-public-read.md), „Plugins" (docs/architecture.md).

> **Everything about this plugin is in this folder:** the views, the manifest,
> the model types, the composition, the write calls, the Markdown export and this
> documentation. Nothing about it is in the core any more, and two CI checks
> assert it — [`check-plugin-isolation.mjs`](../../../../scripts/ci/check-plugin-isolation.mjs)
> for the code, the uninstall test in the playbook for the prose.

The pricing model (tiers + features) is the single source of truth for external
pricing pages. It is stored the way **every** plugin's data is stored: four
declared collections of undistinguished rows in `plugin_data` — `features`,
`tiers`, `tier-values` (the matrix, one row per cell) and `highlights` — plus the
ordered version list in the plugin's config. [`compose.ts`](../compose.ts)
turns those rows into the `Pricing` shape described below and back, and it is the
only place that knows a matrix cell belongs inside its tier under `values`.

That knowledge staying in the plugin is what makes the rest generic, and it is
also why the old public endpoint could not survive as an alias: no generic route
can perform that folding. See „What happened to `/api/pricing/<id>`"
(docs/plugin-public-read.md).

**What this used to be**, because the shape of the model still carries traces of
it: four `pricing_*` tables of its own, fifteen methods on `TimelineRepo` across
two drivers, seven API sub-resources, thirteen MCP tools, a `pricing` field on
the core `TimelineFile`, and an edge function at `/api/pricing/<id>`. All of that
was a privilege no third-party plugin could have had, and issue #17 removed it.
The tables are still there, unread, until a later migration drops them;
`npm run migrate:pricing` is what moved the rows.

Reading: the viewer gets the rows with `GET /api/source/<id>` (in `pluginData`,
each row carrying its lock counter) and composes locally. External pages use
`GET /api/public/plugin/product-roadmap/<id>`. Markdown mirror:
`npm run export:pricing`.

**Writing is granular and collision-free.** The old „replace the whole model"
semantics are gone, because they were exactly what caused overwrites on
concurrent edits. Every write goes through the generic plugin-data routes:

```
POST   /api/source/<id>/plugin/product-roadmap/<collection>
PATCH  /api/source/<id>/plugin/product-roadmap/<collection>/<rowId>
DELETE /api/source/<id>/plugin/product-roadmap/<collection>/<rowId>
POST   /api/source/<id>/plugin/product-roadmap/<collection>/move
```

- A PATCH carries the row's lock counter in `If-Match` and answers `409` when
  stale. **Important:** the counter comes **only** from the header, never from
  `body.version` — on a feature, `version` is the domain field „ab Version".
- A key sent as `null` in a PATCH is removed, which is how the forms clear an
  emptied field instead of leaving the old value to reappear on reload.
- **Deleting cascades by declaration, not by hand.** The manifest says a cell
  belongs to its tier and its feature (`onDelete: cascade`) and that a highlight
  merely lists feature ids (`onDelete: unlink`), and the host applies both.
- **Feature order:** a create appends. To place one precisely, POST to
  `…/features/move` with `{id, after? | before?}` — exactly one anchor, and
  `after` wins if both are given. The host renumbers and returns the resulting
  full order, which the client adopts rather than replaying the move locally.
- **A matrix cell is atomic**, so it carries no lock counter: two people editing
  different cells never collide. Clearing one deletes its row — „not included" is
  the absence of a cell.
- MCP: `read_plugin_data`, `write_plugin_data` and `configure_plugin`. Three
  generic tools where there used to be thirteen for this plugin alone; the
  version list is config, so it needs none of its own. See „Tools" (docs/mcp.md).
- Client: the **matrix view is editable in the interface** (see „Editing the
  matrix in the interface"), through those same routes. Since the routes are
  implemented on the repo seam, that now includes a pricing model in a plain
  `data/*.json` timeline, which used to answer `501`.

## Editing the matrix in the interface

On an editable (DB-backed) product timeline the matrix carries its own write
paths. Each one writes exactly the row or cell that was edited, with no model
dump, so concurrent edits in different places do not collide.

| What | Affordance | Endpoint | Locking |
| --- | --- | --- | --- |
| **Cell** (tier × feature) | Click (or Enter) on the cell → popover | `POST …/tier-values` (clearing: `DELETE …/tier-values/<tierId>:<featureId>`) | none; a cell is atomic |
| **Tier** (column) | Click the column header → drawer form | `PATCH/DELETE …/tiers/<id>` | `If-Match` on `rowVersion` |
| **Add a tier** | „+ Tarif" in the header row | `POST …/tiers` | — |
| **Feature** (row) | Click the row header → drawer form | `PATCH/DELETE …/features/<id>` | `If-Match` on `rowVersion` |
| **Add a feature** | „+ Feature" (header row = no group, per section = in that group) | `POST …/features` | — |
| **Reorder a row** | ↑/↓ on the row (on hover) | `POST …/features/move` | — |

All of them are the generic plugin-data routes under
`/api/source/<id>/plugin/product-roadmap/`, which is what makes the matrix
editable on a `data/*.json` timeline as well as on a database one. The calls
themselves are [`../api.ts`](../api.ts).

A few decisions that are not obvious:

- **A cell gets a popover, not a click cycle**
  ([`cellEditor.ts`](../cellEditor.ts)).
  A cell carries two dimensions (`value` and availability from a version) and the
  value itself has three shapes (`true` / free text / empty). Cycling through
  clicks cannot express that. „Wert" with empty text deliberately saves as *empty*:
  both render as „–" and the server deletes on a falsy value, so separating the two
  states would be a distinction without a difference.
- **An empty cell is clickable too.** Switching a feature on for a tier is exactly
  the edit that starts at the dash.
- **Reordering anchors on the *visible* neighbour within the section.**
  `moveFeature` sorts globally across all features, and the version switcher can
  hide rows; anchored on the visible neighbour, the row moves exactly one step in
  the direction the user sees. The client then adopts the order the server returns
  rather than replaying the move locally, because the `sort` column belongs to the
  server.
- **The tier form touches no cells,** because it cannot: a cell is a row in
  another collection. The response carries the tier's own data, and the column's
  values are composed from the cell rows that were never in the request.
- **Popover layers are `fixed` on `<body>`** (`popover.ts`, shared with the feature
  tooltip): the table wrapper carries `overflow-x`, which clips `overflow-y` as
  well, so an embedded layer would be cut off at the row's edge.
- **New ids are slugs of the name** (`slugId` in
  [`pricing.ts`](../pricing.ts), transliterating umlauts and
  adding a counter suffix on collision), which keeps the model readable in SQL and
  in MCP output.

**Not in the interface yet:** highlights (the card tiles) and a version editor.
Adding, reordering or removing a version is a config write (`enable_plugin`).
Renaming is safe and needs no migration: a version is a stable **id** plus a
renamable **label**, and everything references the id — so changing a label in
`versionLabels` disturbs nothing.

This split (issue #110) is what makes that true. Before it a version was only its
label, `config.versions` held the labels, and every gate named a version by that
string (`feature.version`, `tier.valueVersions`, `descriptionByVersion`,
`nameByVersion`, `labelByVersion`, an item's `featureVersion`). Renaming `3.0`
then left all of them pointing at the dead string `3.0`; because the gates
implement „an unknown version never hides" (`featureVisibleForVersion`), those
features silently became visible in *every* pinned version rather than failing
loudly. `scripts/db/migrate-version-ids.ts` re-keyed existing timelines from
labels to ids.

## The shape of the model

- `features[]`: `{ id, name, group, version?, description?, nameByVersion?, descriptionByVersion?, rowVersion? }`.
  `version` is the tracked version a feature is available from. **No `version` means pre-existing** (it existed before the
  first tracked version), so it is always visible, never badged „Neu", but still
  eligible for „Modified". Setting `feature.version` to the baseline
  (`versions[0]`) means „introduced in this version", NOT „always been there" —
  for that, leave `version` out.
  - `nameByVersion` (`Record<version, string>`): a
    version-dependent name *override*, resolved **cumulatively** (the newest
    override ≤ the selected version wins) — `resolveFeatureName`.
  - `descriptionByVersion` (`Record<version, string>`): additional version-bound
    descriptions **on top of**
    `description`. Unlike `nameByVersion` these are **additive**, not overrides: the
    base `description` stays and each note appears as its own line, „ab
    \<version\>: …", in version order — `resolveFeatureDescription`
    ([`pricing.ts`](../pricing.ts)). It shows as a matrix tooltip behind an
    **info icon**, and is editable in the feature form via „+ Versionsbeschreibung".
  - `rowVersion` is the server-managed lock counter: do not edit it, and it is
    stripped from the public output.
- `tiers[]`: `{ id, name, tagline?, useCase?, targetGroup?, price, values, valueVersions?, rowVersion? }`.
  `values[featureId]` is `true` (✓), missing or `false` (–), or a string (a
  per-tier value). Falsy and empty cells are not stored, since they render as „–"
  anyway. `valueVersions[featureId]` (`availableFrom` on the cell's row) is the
  optional **cell availability from a version**: the cell only counts as included from that label on and shows „–"
  before it (cumulative, `cellActiveForVersion` in
  [`pricing.ts`](../pricing.ts)). `values` remains the end state and the map
  only gates *when* it appears (a sibling of `values`, additive). Under „Alle" the
  matrix shows the end state plus a subtle „ab \<version\>" chip in the cell; with a
  pinned version, the cell appearing or showing „–" carries that information by
  itself. No key means available from the start. See „Cell versioning" below.
- `highlights[]`: `{ id, label, section?, featureIds, rowVersion? }` — the curated
  tiles of the card view, bundling features. Only what is referenced here appears
  on the cards; the matrix shows every feature.
- `versions[]`: ordered version **ids**; the switcher filters feature rows
  cumulatively by position in this list. `versionLabels` (`Record<id, string>`,
  also in `config`) gives each id its display label. Every `Record<version, …>`
  above (`nameByVersion`, `descriptionByVersion`, `valueVersions`, `labelByVersion`)
  and an item's `featureVersion` are keyed by these ids, never by the label — that
  is what lets a label be renamed without touching them (issue #110).

Item↔feature: `metadata.featureIds` (n:m) plus `metadata.featureVersion` (the
version being worked on) plus `status` (Open/Doing/Done) feed the work dot and the
row badges:
- **„Neu"**: `feature.version` equals the pinned version (not „Alle"). This
  includes the baseline (`versions[0]`): a feature introduced there badges „Neu"
  when the baseline is pinned, while pre-existing features (no `version`) never do.
- **„Modified"**: the feature is older than the pinned version (including
  pre-existing) AND that version brought a change — either an item carrying this
  feature with `featureVersion` equal to the pinned version, OR a version
  description for the pinned version (`descriptionByVersion[pinned]`). The latter
  badges even without a work item. It excludes „Neu", and only applies with a
  pinned version.
- **„ab \<Version\>"**: only in the „Alle" view, where „Neu"/„Modified" never
  fire. A neutral chip stating which version the feature or highlight arrived in.
  In the matrix: per feature that has a `version`. On the cards: per highlight, the
  earliest `version` among its contributing features (`introducedVersion` in
  `resolveHighlight`); a single pre-existing feature in the bundle suppresses the
  chip. Pre-existing features (no `version`) never get one.

## Cell versioning (tier × feature availability from a version)

Where `feature.version` controls when a feature (the whole row) starts to exist,
`tier.valueVersions[featureId]` (`availableFrom` on the cell's own row)
controls when an **individual cell** counts as included. That is what lets you
express „feature X is in Enterprise right away, in Scale only from v4" without
gating the entire feature row.

- **Resolution** — `cellActiveForVersion(availableFrom, versions, selected)` in
  [`pricing.ts`](../pricing.ts), cumulative and shaped like
  `featureVisibleForVersion`: under „Alle" it is always active; with no
  `availableFrom` it is active from the start; otherwise it becomes active as soon
  as the pinned version is ≥ `availableFrom`. Before that version the cell renders
  as „–", while the stored `value` stays the end state.
- **Matrix** ([`pricingMatrix.ts`](../pricingMatrix.ts)):
  pinned → the cell either appears or shows „–", which carries the information
  itself; „Alle" → the end state plus a subtle „ab \<version\>" chip
  (`.pm-cell-ver`) in the cell.
- **Cards** (`resolveHighlight`): a cell that is not yet available does not count
  as included for that tier. The highlight's effective introduction version per
  tier is `valueVersions[fid] ?? feature.version` (the cell gate wins), which feeds
  `isNew` and the „ab" chip.
- **Writing** — the gate is a field of the cell's row, so it travels with the
  value: `POST …/plugin/product-roadmap/tier-values` with
  `{tierId, featureId, value, availableFrom}`. Deleting the cell removes the gate
  with it, which is why clearing a cell deletes the row rather than blanking it.
  The rows ↔ model round trip is tested in
  [`compose.test.ts`](../compose.test.ts) and the
  gating logic in
  [`pricing.test.ts`](../pricing.test.ts).

## Open extensions

Not yet represented in the data model, as a backlog:

- A dedicated per-tier unit-price field. Today such a value can only be expressed
  as an ordinary feature value.
- Tiered volume packages per tier (e.g. S/M/L/custom with graduated prices).
- `highlight.icon` exists in the schema but is unused (no per-tile icons).

Known behaviour: a value highlight appears on every tier card (its value differs
per tier), so the work dot repeats there.

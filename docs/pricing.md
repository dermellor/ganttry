# Pricing

The pricing model of a product-roadmap timeline.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Pricing

> The pricing model's **client** code (matrix, cards, matrix editors) lives as a
> timeline kind under [`src/plugins/product-roadmap/`](../src/plugins/product-roadmap/)
> and is lazily loaded (see „Plugins" (docs/architecture.md)). The server side (tables,
> `assemblePricing`, `pricing-api`, MCP tools) is as described below.

The pricing model (tiers + features, product-roadmap timelines only) is the single
source of truth for external pricing pages. It is stored **normalised** in its own
tables (migration `0009`, see „Schema" (docs/database.md)): `pricing_features`, `pricing_tiers`,
`pricing_tier_values` (the matrix, per cell), `pricing_highlights`, plus the
ordered version list in `timeline_plugins.config.versions` of the
`product-roadmap` entry (formerly the `timelines.pricing_versions` column, moved
in migrations `0012`/`0013`, see „Plugin registry" (docs/database.md)). The server assembles the
`Pricing` shape described below out of those (`assemblePricing` in
[`scripts/db/timeline-repo.ts`](../scripts/db/timeline-repo.ts)), and the viewer and
the Markdown export see it unchanged.

Reading: the viewer uses `GET /api/source/<id>` (assembled, including a
`rowVersion` per entity), external pages use `GET /api/pricing/<id>` (public, with
`rowVersion` stripped). Markdown mirror: `npm run export:pricing`.

**Writing is granular and collision-free.** The old „replace the whole model"
semantics are gone, because they were exactly what caused overwrites on concurrent
edits:
- Endpoints under `/api/source/<id>/`: `feature[/<id>]`, `tier[/<id>]`,
  `tier-value` (PUT `{tierId, featureId, value, availableFrom?}`, where
  `value=false/null` deletes the cell and `availableFrom` is the version label from
  which the cell applies, otherwise from the start), `highlight[/<id>]` (each with
  POST/PATCH/DELETE), `pversion` (PUT of the whole version list, like `phases`),
  and `pricing` (PUT, a bulk replace for seeding). A PATCH carries the `rowVersion`
  in the `If-Match` header and returns `409` when stale. **Important:** for
  features the lock version comes **only** from `If-Match`, never from
  `body.version`, where `version` is the domain field „ab Version".
- MCP: the granular tools `add_/update_/delete_feature`, `move_feature`,
  `…_tier`, `set_tier_value`, `…_highlight`, `set_versions` (one call each, no
  read-modify-write, no full dump in the context). `set_pricing` remains as the
  bulk seed/rewrite.
- **Feature order** (the `sort` column): `add_feature` always appends to the end
  of its group. To place one precisely, `POST …/feature-move {featureId, after? |
  before?}` (MCP: `move_feature`) — exactly one anchor, and `after` wins if both
  are given. The server loads the current order, repositions relative to the anchor
  (`reorderIds`, pure and tested) and renumbers `sort`, writing only changed rows.
  `sort` is exposed through no other write path, and a moved feature keeps its
  `group` (to change groups, use `update_feature`).
- Client: the **matrix view is editable in the interface** (see „Editing the
  matrix in the interface"), through those same granular endpoints — per cell, per
  tier, per feature. **Highlights** (the card tiles) and the **version list** are
  still maintained through the MCP.

### Editing the matrix in the interface

On an editable (DB-backed) product timeline the matrix carries its own write
paths. Each one writes exactly the row or cell that was edited, with no model
dump, so concurrent edits in different places do not collide.

| What | Affordance | Endpoint | Locking |
| --- | --- | --- | --- |
| **Cell** (tier × feature) | Click (or Enter) on the cell → popover | `PUT …/tier-value` | none; a cell is atomic |
| **Tier** (column) | Click the column header → drawer form | `PATCH/DELETE …/tier/<id>` | `If-Match` on `rowVersion` |
| **Add a tier** | „+ Tarif" in the header row | `POST …/tier` | — |
| **Feature** (row) | Click the row header → drawer form | `PATCH/DELETE …/feature/<id>` | `If-Match` on `rowVersion` |
| **Add a feature** | „+ Feature" (header row = no group, per section = in that group) | `POST …/feature` | — |
| **Reorder a row** | ↑/↓ on the row (on hover) | `POST …/feature-move` | — |

A few decisions that are not obvious:

- **A cell gets a popover, not a click cycle**
  ([`src/plugins/product-roadmap/cellEditor.ts`](../src/plugins/product-roadmap/cellEditor.ts)).
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
- **The tier form touches no cells.** `updateTier` re-reads the cell rows and
  returns them in full, so the client adopts the response unchanged and the column's
  values survive.
- **Popover layers are `fixed` on `<body>`** (`popover.ts`, shared with the feature
  tooltip): the table wrapper carries `overflow-x`, which clips `overflow-y` as
  well, so an embedded layer would be cut off at the row's edge.
- **New ids are slugs of the name** (`slugId` in
  [`pricing.ts`](../src/plugins/product-roadmap/pricing.ts), transliterating umlauts and
  adding a counter suffix on collision), which keeps the model readable in SQL and
  in MCP output.

**Not in the interface yet:** highlights (the card tiles) and a version editor. For
versions that is no accident: `updateVersions` writes only the plugin config and
migrates **no** references. Since the gates implement „an unknown version never
hides" (`featureVisibleForVersion`), renaming `3.0` would make every 3.0-gated
feature visible in *every* pinned version, silently and wrongly. A version editor
has to migrate `feature.version`, `tier.valueVersions`, `descriptionByVersion`,
`nameByVersion` and `labelByVersion` along with it.

Shape (assembled):
- `features[]`: `{ id, name, group, version?, description?, nameByVersion?, descriptionByVersion?, rowVersion? }`.
  `version` is the tracked version a feature is available from (DB column
  `available_from`). **No `version` means pre-existing** (it existed before the
  first tracked version), so it is always visible, never badged „Neu", but still
  eligible for „Modified". Setting `feature.version` to the baseline
  (`versions[0]`) means „introduced in this version", NOT „always been there" —
  for that, leave `version` out.
  - `nameByVersion` (`Record<version, string>`, DB column `name_by_version`): a
    version-dependent name *override*, resolved **cumulatively** (the newest
    override ≤ the selected version wins) — `resolveFeatureName`.
  - `descriptionByVersion` (`Record<version, string>`, DB column
    `description_by_version`): additional version-bound descriptions **on top of**
    `description`. Unlike `nameByVersion` these are **additive**, not overrides: the
    base `description` stays and each note appears as its own line, „ab
    \<version\>: …", in version order — `resolveFeatureDescription`
    ([`src/pricing.ts`](../src/plugins/product-roadmap/pricing.ts)). It shows as a matrix tooltip behind an
    **info icon**, and is editable in the feature form via „+ Versionsbeschreibung".
  - `rowVersion` is the server-managed lock counter: do not edit it, and it is
    stripped from the public output.
- `tiers[]`: `{ id, name, tagline?, useCase?, targetGroup?, price, values, valueVersions?, rowVersion? }`.
  `values[featureId]` is `true` (✓), missing or `false` (–), or a string (a
  per-tier value). Falsy and empty cells are not stored, since they render as „–"
  anyway. `valueVersions[featureId]` (DB column
  `pricing_tier_values.available_from`) is the optional **cell availability from a
  version**: the cell only counts as included from that label on and shows „–"
  before it (cumulative, `cellActiveForVersion` in
  [`src/pricing.ts`](../src/plugins/product-roadmap/pricing.ts)). `values` remains the end state and the map
  only gates *when* it appears (a sibling of `values`, additive). Under „Alle" the
  matrix shows the end state plus a subtle „ab \<version\>" chip in the cell; with a
  pinned version, the cell appearing or showing „–" carries that information by
  itself. No key means available from the start. See „Cell versioning" below.
- `highlights[]`: `{ id, label, section?, featureIds, rowVersion? }` — the curated
  tiles of the card view, bundling features. Only what is referenced here appears
  on the cards; the matrix shows every feature.
- `versions[]`: ordered labels; the switcher filters feature rows cumulatively.

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

### Cell versioning (tier×feature availability from a version)

Where `feature.version` controls when a feature (the whole row) starts to exist,
`tier.valueVersions[featureId]` (DB: `pricing_tier_values.available_from`)
controls when an **individual cell** counts as included. That is what lets you
express „feature X is in Enterprise right away, in Scale only from v4" without
gating the entire feature row.

- **Resolution** — `cellActiveForVersion(availableFrom, versions, selected)` in
  [`src/pricing.ts`](../src/plugins/product-roadmap/pricing.ts), cumulative and shaped like
  `featureVisibleForVersion`: under „Alle" it is always active; with no
  `availableFrom` it is active from the start; otherwise it becomes active as soon
  as the pinned version is ≥ `availableFrom`. Before that version the cell renders
  as „–", while the stored `value` stays the end state.
- **Matrix** ([`src/plugins/product-roadmap/pricingMatrix.ts`](../src/plugins/product-roadmap/pricingMatrix.ts)):
  pinned → the cell either appears or shows „–", which carries the information
  itself; „Alle" → the end state plus a subtle „ab \<version\>" chip
  (`.pm-cell-ver`) in the cell.
- **Cards** (`resolveHighlight`): a cell that is not yet available does not count
  as included for that tier. The highlight's effective introduction version per
  tier is `valueVersions[fid] ?? feature.version` (the cell gate wins), which feeds
  `isNew` and the „ab" chip.
- **Writing** — `set_tier_value(..., availableFrom)` via MCP, or
  `PUT …/tier-value {availableFrom}`. Deleting the cell removes the gate with it.
  The round-trip is tested in
  [`src/pricingNormalize.test.ts`](../src/plugins/product-roadmap/pricingNormalize.test.ts) and the gating
  logic in [`src/pricing.test.ts`](../src/plugins/product-roadmap/pricing.test.ts).

## Open extensions: pricing model / cards

Not yet represented in the data model, as a backlog:

- A dedicated per-tier unit-price field. Today such a value can only be expressed
  as an ordinary feature value.
- Tiered volume packages per tier (e.g. S/M/L/custom with graduated prices).
- `highlight.icon` exists in the schema but is unused (no per-tile icons).

Bekanntes Verhalten: Wert-Highlights (z.B. „Charaktere") erscheinen auf jeder
Tarif-Karte (Wert variiert je Tarif) → der Arbeits-Punkt wiederholt sich dort.

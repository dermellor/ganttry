# Product roadmap

A pricing matrix and pricing cards for a Zeitlines timeline, plus the item fields
that link roadmap work to the features it ships.

## What does product-roadmap do?

It gives a timeline a second thing to be about. Alongside the items — the work,
on dates — it carries a **pricing model**: the features a product ships and the
tiers that bundle them, as an editable matrix and as customer-facing cards. Items
link to features, so „what are we building in 3.0" and „what does 3.0 change for
a Scale customer" are two views of one dataset instead of two documents that
disagree by Thursday.

## Who is it for?

Teams that maintain a public pricing page and a roadmap at the same time, and
have watched the two drift: the roadmap says a feature shipped, the pricing page
still says „coming soon", and nobody owns the gap. It is most useful where the
pricing page is generated rather than hand-written, because the model is then the
source both read from.

## How do you enable it?

One row on the timeline, with the ordered version list as its config. A version
has two parts: a stable **id** everything references, and a display **label** the
switcher shows. `versions` is the ordered id list; `versionLabels` maps id →
label:

```json
{
  "id": "product-roadmap",
  "config": {
    "versions": ["1-0", "2-0", "3-0"],
    "versionLabels": { "1-0": "1.0", "2-0": "2.0", "3-0": "3.0" }
  }
}
```

Through MCP that is `enable_plugin` (it validates the config against the manifest's
`configSchema`). **Renaming a version is a config write that changes only its
`versionLabels` entry** — the id stays, so every feature, roadmap item and matrix
cell that references it keeps its link. A bulk seed of the model itself goes
through `replace_timeline` with `pluginData`, or row by row with
`write_plugin_data` — see „Tools" (docs/mcp.md). `versionConfigFromEntries` in
[`pricing.ts`](pricing.ts) builds both structures from `{label, id?}` entries,
minting ids for new versions and keeping ids for existing ones.

Publishing the model to external pages is a second, separate decision: set
`public` on the same row, and the rows become readable at
`GET /api/public/plugin/product-roadmap/<timelineId>`. Off by default, and the
reasoning is in „Publishing a plugin's data" (docs/plugin-public-read.md).

## Which fields does it add?

| Field | `metadata` key | Options come from | Context menu |
| --- | --- | --- | --- |
| Version | `featureVersion` | the plugin's `config.versions` (ids; labels via `versionLabels`) | yes |
| Tier | `tier` | the tier rows | yes |
| Features | `featureIds` | the feature rows | no |

The options are derived from the model rather than stored, which is the point: a
renamed tier cannot leave a field offering the old label. Values are **ids**, not
names, so a rename orphans nothing. Features has no context menu on purpose — a
timeline carries dozens of them, and a submenu that long is a worse way in than
the form's searchable chip editor.

## What does it store?

Four collections of rows in the generic plugin store, declared in
[`manifest.ts`](manifest.ts): `features`, `tiers`, `tier-values` (one row per
matrix cell, keyed by the pair) and `highlights`. Nothing in the core database is
specific to this plugin, which is what makes it the same kind of thing a
third-party plugin is. The full reference is [`docs/model.md`](docs/model.md).

## What does it look like?

`data/example-projektplan.json` and `data/launch-roadmap.json` are the committed
examples, validated by `npm run schema:check` so they cannot rot. Neither carries
a pricing model yet.

## What does it deliberately not do?

- **No currency or tax handling.** `price` is a free-text string, because a
  pricing page says „ab 449,95 €/Monat" and „auf Anfrage" in the same column, and
  a typed money field would model neither.
- **No per-tier unit prices or volume tiers.** A graduated package can only be
  expressed as an ordinary feature value today.
- **No version editor in the interface.** Adding, reordering or removing a version
  is a config write (`enable_plugin`), not an in-app action yet. Renaming, though,
  is safe by construction: a version is a stable id plus a renamable label
  (`versionLabels`), so changing a label touches no reference. This was not always
  true — before issue #110 a version was only its label, and renaming silently
  orphaned every gate that named it (`feature.version`, `valueVersions`,
  `descriptionByVersion`, `nameByVersion`, `labelByVersion`, an item's
  `featureVersion`). `scripts/db/migrate-version-ids.ts` moved existing timelines
  onto the id model.
- **No highlight editor in the interface.** The card tiles are authored through
  MCP.
- **It is not a billing system.** It describes what a tier contains, never what a
  customer owes.

## Where its documentation lives

| File | What |
| --- | --- |
| [`docs/model.md`](docs/model.md) | The model reference: shape, version gating, cell versioning, editing the matrix. |
| [`AGENTS.md`](AGENTS.md) | Conventions for changing this plugin. |

Everything here is in the plugin folder rather than in the core documentation,
and the test for that is mechanical: uninstall the plugin in your head, then
re-read the sentence. If it becomes false or orphaned, it was plugin
documentation.

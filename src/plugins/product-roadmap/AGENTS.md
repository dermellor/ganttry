# Product roadmap

Conventions for changing **this plugin**. Rules that apply to the whole codebase
stay in the root [`AGENTS.md`](../../../AGENTS.md); they are not restated here,
because a copy is how one of them ends up fixed and the other does not.

What the plugin is and how to switch it on: [`README.md`](README.md). The model
reference: [`docs/model.md`](docs/model.md).

## Invariants

- **`version` and `rowVersion` are different things, and one word.** On a
  feature, `version` is the domain label „ab Version" that a user typed;
  `rowVersion` is the host's optimistic-lock counter, which lives in the row
  envelope and never in `data`. Sending the wrong one silently overwrites a
  concurrent edit instead of answering `409`. Every write puts the counter in the
  `If-Match` header and nothing else.

- **The model is derived, so never mutate it.** `currentPricing(file)` composes a
  fresh object out of the stored rows on every call. Writing to what it returns
  updates a copy that is discarded on the next line — the server has the change,
  the file has it, and the matrix keeps showing the old value until a reload,
  with nothing thrown and nothing logged. That bug is why [`store.ts`](store.ts)
  exists: mirror a write onto `file.pluginData` in row space, and let the views
  compose from it.

- **One place knows the shape.** [`compose.ts`](compose.ts) is the only module
  that knows a matrix cell belongs inside its tier under `values`, in both
  directions, and the round trip `rows → model → rows` is a fixed point with a
  test to prove it. That is what made the storage migration a change to one
  function rather than to twenty call sites, and it is why a read and a write
  cannot disagree about what a row looks like.

- **A cell has no lock counter, deliberately.** It is a single atomic value, so
  two people editing two cells of one tier never collide. Clearing a cell
  **deletes** its row rather than storing a falsy value: „not included" is the
  absence of a cell, and that is also what drops its version gate, since the gate
  is a field of the row.

- **Nothing outside this folder may name this plugin.** Not an import, not the id
  as a literal, not a method on `TimelineRepo`, not a line in `index.html`.
  `scripts/ci/check-plugin-isolation.mjs` asserts all four. If a change here
  seems to need a core edit, that is a finding about the seam rather than a
  reason to make an exception.

- **Everything data-only stays out of the view graph.** `descriptor.ts` and
  `fields.ts` are imported STATICALLY by the registry, so anything they reach
  pulls into the generic entry bundle and the lazy split is gone
  (`scripts/ci/check-bundle-split.sh`). Import `types`, `plugins` and `compose`
  there; never a view or the stylesheet.

## Data

- **Four collections**, declared in [`manifest.ts`](manifest.ts): `features`,
  `tiers` (both ordered), `tier-values` (keyed by `tierId` + `featureId`, so a
  cell's identity *is* its coordinates) and `highlights` (ordered). They are
  stored by the host in the generic plugin store — see „The generic store"
  (docs/plugin-storage.md).

- **Three references**, also declared: a cell cascades from its tier and from its
  feature, and a highlight *unlinks* a deleted feature id out of its list rather
  than being deleted with it. `unlink` is the deliberate one: the tile is the
  point, so losing one of five features must not remove it.

- **The version list is config**, not a collection: a short ordered list that is
  always replaced wholesale, which is what config is for.

- **Three metadata keys on items**, and they must not be renamed:
  `featureIds`, `featureVersion`, `tier`. They are declared in the manifest so an
  uninstall can strip them; renaming one silently drops every value already
  stored on every item, with no error anywhere.

- **Writes go through [`api.ts`](api.ts)**, which speaks the generic plugin-data
  routes. Nothing here may call a route that names this plugin's entities — those
  no longer exist, and re-adding one would be the privilege that #17 removed.

## Verification

- `npm test` — [`compose.test.ts`](compose.test.ts) (the round trip and the
  fixed point), [`store.test.ts`](store.test.ts) (the in-memory mirror, including
  a test that asserts the derived-model bug itself), [`pricing.test.ts`](pricing.test.ts)
  (version gating, badges, Markdown), and
  `scripts/db/plugin-store-product-roadmap.test.ts`, which drives the real
  manifest through the store on both source kinds.
- `node scripts/ci/check-plugin-isolation.mjs` and, after `npm run build`,
  `bash scripts/ci/check-bundle-split.sh`.
- **By hand**, and this is the part no test covers: a pricing model on a local
  `data/*.json` timeline, in the interface. Write a cell, clear it, rename a
  tier, delete a feature that has cells, and check each one landed in the file.
  The matrix has to update without a reload — that is the derived-model
  invariant, and it fails silently.
- `npm run export:pricing -- <id>` renders the model to Markdown against a live
  deployment; it is the one path that exercises the composition outside the
  browser.

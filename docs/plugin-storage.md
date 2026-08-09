# Plugin storage

Where the rows a plugin owns are kept, and why the rules that used to be columns
and foreign keys are now declarations the host enforces.

This chapter covers the generic store from
[issue #12](https://github.com/dermellor/ganttry/issues/12). For the two extension
seams it sits inside, read [`architecture.md`](architecture.md) first; for the
manifest that declares a plugin's collections,
[`src/pluginHost/manifest.ts`](../src/pluginHost/manifest.ts).

## The constraint that shapes everything

**A plugin installed at runtime can never ship a migration.** It would have to run
DDL on somebody else's database at install time, and uninstalling it cleanly would
be impossible: dropping a table a plugin created means trusting a plugin's own
teardown, on data the operator may still want.

So storage a plugin needs has to exist *before* the plugin does. Uninstalling is
then a `DELETE`, not a `DROP`.

The second constraint is that **a plugin must not depend on the instance's source
kind.** There are three `TimelineRepo` implementations — two Postgres drivers and
[`scripts/local/file-repo.ts`](../scripts/local/file-repo.ts) — and a design that
put plugin rows in one table would have made `data:own` a Postgres capability: such
a plugin would run on a DB timeline and answer `501` on a JSON or Markdown one.
What may differ between source kinds is whether the **runtime** permits writes,
exactly as it already does for items. Never which plugins are possible.

## Where the rows live

The store is eight generic methods on the `TimelineRepo` seam
([`scripts/db/repo.ts`](../scripts/db/repo.ts)), with one implementation per
backing store:

| Source | Where a plugin's rows live |
| --- | --- |
| `db` | the `plugin_data` table (migration `0016`) |
| `local`, JSON file | a `pluginData` section in the very file the user owns |
| `local`, directory | the same section in its `timeline.json` |

The local half is not a consolation prize. It keeps a local timeline
**self-contained**: copying the file copies the plugin's data with it, no database
and no export step. And it removes a real limitation — before this, a pricing model
on a local JSON source was readable but answered `501` on write.

### The `db` implementation

```sql
plugin_data (
  timeline_id, plugin_id, collection, row_id,   -- composite primary key
  data        jsonb,                            -- the plugin's own object
  sort        integer,                          -- reproduces array order
  version     integer,                          -- bump_row_version trigger
  updated_at, updated_by
)
```

`If-Match` and the 0-rows-updated conflict check are the item rule reused verbatim.
Cascade delete on `timelines` comes free, and uninstalling is
`delete … where plugin_id = $1`.

**Indexing.** The primary key already serves every read, which is always a prefix
of it. One further index exists, for the one query that is not: the cascade asks
„which rows reference this id", expressed as a containment test
(`data @> '{"tierId": "…"}'`), and a GIN index with `jsonb_path_ops` serves exactly
that operator. `jsonb_path_ops` rather than the default because it is smaller and
cheaper to maintain, and the key-existence operators the default also indexes are
used nowhere.

### The local implementation, and where it genuinely differs

Two differences, named rather than papered over:

- **Locking is per file, not per row.** The local repo's version is the file's
  mtime, forced strictly forward on each write, and every row reports that one
  number. `If-Match` there means „the file has not changed since you read it".
  Items already work this way; the point is that the same header means something
  coarser. Two people editing two rows of one collection at once succeeds on a DB
  source and is a `409` on a local one. Both are asserted, side by side, in
  [`plugin-store-product-roadmap.test.ts`](../scripts/db/plugin-store-product-roadmap.test.ts).
- **Everything in the file is public once a static deploy is.** A build
  materializes the file to `public/<data dir>/sources/<id>.json`. For `db`,
  `publicRead` (issue #20) asks „what may be served publicly"; for a static
  `local` deploy it asks „what has to be stripped while materializing". Same
  declaration, two implementations, and the second is the one that leaks if it is
  forgotten.

**Order is the array's order.** A JSON file has no `sort` column and inventing one
would give the file two places that claim to define the order. So the wire type
carries no `sort` either — the DB's column exists to reproduce the array order and
stays behind the repo.

## What makes a jsonb bag sufficient: the collections are declared

A bag alone is **not** enough to replace normalised tables, and pretending
otherwise is what would push a serious plugin back into bespoke tables. Postgres
enforces four things for `product-roadmap` today. Since a plugin ships neither DDL
nor server code, they are **declarations in the manifest that the host enforces**.

Enforcement sits in the **dispatcher, above the repo**
([`scripts/db/plugin-api.ts`](../scripts/db/plugin-api.ts), with the pure rules in
[`src/pluginHost/dataStore.ts`](../src/pluginHost/dataStore.ts)). That is what
makes it independent of the backing store: one implementation covers all three
repos and every client — the app, MCP, a third-party integration.

**1. Shape.** Each collection may declare a JSON Schema, validated on write.
Replaces the column types and the `not null`s. Only the subset in
[`dataSchema.ts`](../src/pluginHost/dataSchema.ts) is allowed, and a schema using
anything else makes the **manifest** invalid rather than being partly applied. That
refusal is the load-bearing part: a validator that skips what it does not
understand lets an author read their `minLength` in the manifest and believe the
host enforces it.

**2. References.** A collection may reference another of the same plugin, with
`onDelete: 'cascade' | 'restrict' | 'unlink'` and an `array` flag for a field
holding a list of ids. The host checks on write that every reference resolves —
there is no foreign key left to catch a dangling one — and applies the declared
outcome on delete. A `restrict` violation is known before the first row is
touched, so a delete never half-applies.

**3. Ordering.** `sort` plus a generic relative move
(`POST …/<collection>/move` with `{ id, after | before }`). A collection that did
not declare `ordered` refuses the move rather than inventing a position.

**4. Item links.** A plugin declares which `metadata` keys on items it owns, so
uninstalling can strip them instead of leaving them orphaned in the raw metadata
box.

**Composite identity.** `keyFields` makes the row id derived from its coordinates,
so a matrix cell is one row per (tier, feature) pair and writing the same
coordinates twice updates rather than duplicates. Each part is percent-encoded
before being joined with `:`, because the id travels in a URL path — left raw, a
`/` in a key value would split into two segments and address a different row.
Patching a key field is refused: it would silently make the row a different one and
leave the original behind under its old id.

## Routes

```
GET    /api/source/<id>/plugin/<pluginId>/<collection>
POST   /api/source/<id>/plugin/<pluginId>/<collection>          (If-Match)
POST   /api/source/<id>/plugin/<pluginId>/<collection>/move
PATCH  /api/source/<id>/plugin/<pluginId>/<collection>/<rowId>  (If-Match)
DELETE /api/source/<id>/plugin/<pluginId>/<collection>/<rowId>
```

One dispatcher, three repos behind it. A read-only runtime answers the writes the
way it answers item writes today, so „not editable" stays a property of the
deployment rather than of the plugin. The full contract is in
[`openapi.yaml`](../openapi.yaml).

**`plugin` opens a namespace.** Everything after it is named by the plugin, so
`parseSourcePath` stops interpreting segments there. Without that rule a collection
called `tier` would be read as the pricing sub-resource and the timeline id would
swallow `…/plugin/<pluginId>` — not a parse error, a write landing somewhere else.

**`move` shadows no row.** It is a verb on the collection under POST only; a row
whose id happens to be `move` is created by POSTing to the collection and is still
addressed by PATCH and DELETE on that path.

**The plugin path parts are exempt from the id charset rule** that guards the
timeline id. None of them ever becomes a filesystem path, and each is checked
against something stricter: the plugin id and collection against the installed
manifest (an allowlist), the row id by the store. A charset rule would meanwhile
reject legitimate values — a scoped plugin id carries `@` and `/`, a composite row
id carries `:` and percent escapes. Each part is decoded exactly once.

**Where the manifest comes from.** The dispatcher takes the lookup as an argument
and never names a plugin. Today that lookup reads the manifests the build shipped
with ([`plugin-manifests.ts`](../scripts/db/plugin-manifests.ts)), which is the
truthful answer for a deploy that can only run what it shipped with; issue #13
points it at the instance's install registry without a caller changing.

## Decisions settled here

**Plugin data reaches the client folded into `GET /api/source/<id>`,** under
`pluginData`, not through a second request the plugin makes after loading. The
deciding argument is the static local deploy: it has no server to ask, so the
materialized file has to be complete or the plugin renders nothing. Making the DB
path match gives one payload shape for both, and it is what keeps a local timeline
self-contained. Only plugins actually enabled on the timeline are folded in, which
is the same gate that decides whether their code loads at all. The cost is that a
timeline's payload grows with its enabled plugins; the lazier alternative would
have bought that back only for the DB case, at the price of two shapes.

**The file section is typed** (`PluginData` in [`src/types.ts`](../src/types.ts)),
so it is covered by the generated `schema/*.json` and an editor validates it. The
alternative — an untyped bag — is worse here than elsewhere, because this is a file
people hand-edit.

**Two generic MCP tools** (`plugin_data_list`, `plugin_data_write`) instead of per
plugin. The thirteen pricing tools are what one plugin costs when the surface is
per plugin, and a plugin installed at runtime could not add tools to a compiled
server at all.

**Realtime and the watermark.** `plugin_data` joins the realtime publication, and
the client subscribes to that one table instead of a list of plugin-owned ones. The
watermark gains `pv`/`pn` — the max version and the row count over `plugin_data` —
as two new optional fields rather than a widening of `v`/`n`, because `v` is the
item row version and a second counter space folded into it would spoil the own-echo
hint. A local source leaves them unset: its version is the file's mtime, which a
plugin write moves along with everything else.

## What is genuinely given up

**Database-level foreign keys and per-column constraints.** Enforcement moves from
Postgres into the host's write path, so a write that bypasses the API (psql, a
migration script) is no longer checked. Since a plugin cannot ship DDL at all,
this is the only place the rules can live, and putting them in the dispatcher means
one implementation rather than one per repo.

**No bulk collection replace.** Writes are one row at a time, plus the
whole-timeline `PUT`, which does carry `pluginData` so a `GET` → `PUT` round trip
preserves it. A „replace this whole collection" endpoint was left out because it is
the shape that loses concurrent edits, which is exactly what the normalised pricing
tables were introduced to stop.

## Proof against `product-roadmap`

Issue #12's acceptance criterion is that `product-roadmap` — the most demanding
plugin that exists here — must be expressible without one line of plugin code on
the server. It is checked as a test, not asserted in prose:
[`scripts/db/plugin-store-product-roadmap.test.ts`](../scripts/db/plugin-store-product-roadmap.test.ts)
drives the real manifest through the store on both source kinds.

| What Postgres used to do | How it is declared |
| --- | --- |
| `pricing_features` (+ `sort`) | collection `features`, `ordered` |
| `pricing_tiers` (+ `sort`) | collection `tiers`, `ordered` |
| `pricing_tier_values`, composite PK | collection `tier-values`, `keyFields: [tierId, featureId]` |
| `pricing_highlights` (+ `sort`) | collection `highlights`, `ordered` |
| two FKs on `pricing_tier_values` | two references, `onDelete: cascade` |
| `version` per row, `If-Match` | the store's `version`, per row on `db` |
| `moveFeature` | `POST …/features/move` |
| `Pricing.versions` | `timeline_plugins.config`, unchanged |

**One gap was found and closed rather than grandfathered.** A highlight bundles a
*list* of feature ids, and Postgres never enforced that relation — `deleteFeature`
strips a deleted id out of every highlight's `feature_ids` array by hand. The
manifest could not express it either: a reference named one field holding one id.
So `ReferenceDecl` gained `array` and `onDelete: 'unlink'`, which together say
„this field holds a list of ids, and a deleted target is removed from the list".
That replaces the hand-written loop with a declaration, and it makes the host able
to refuse a highlight naming a feature that does not exist — which nothing checked
before.

**What is outside this chapter:**

- The **public read** and the three gates in front of it: „Publishing a plugin's
  data" (docs/plugin-public-read.md).
- **Installing and enabling** a plugin: „Installed and enabled"
  (docs/plugin-lifecycle.md). `purgePlugin` in `plugin-api.ts` is the uninstall
  operation, deliberately not wired to a route here — uninstalling is an
  instance-level act with its own permission question and its own confirmation,
  and both belong with the install registry.

`product-roadmap`'s data **has** moved onto this store (`npm run migrate:pricing`),
and the fifteen repo methods, the seven hardcoded sub-resources, the thirteen MCP
tools and the dedicated public endpoint went with it. The four `pricing_*` tables
are still there, unread, until a later migration drops them: a drop in the same
migration as the copy removes the way back.

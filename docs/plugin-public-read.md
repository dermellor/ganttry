# Publishing a plugin's data

How a plugin serves data to the open internet without an endpoint of its own, and
the three gates in front of it.

This chapter covers [issue #20](https://github.com/zeitlines/zeitlines/issues/20).
For where the data lives, [`plugin-storage.md`](plugin-storage.md); for installing
and enabling, [`plugin-lifecycle.md`](plugin-lifecycle.md).

## Why it is generic

`GET /api/pricing/<id>` was public, unauthenticated, cached and fetched at build
time by external pages, served by a dedicated edge function and a dedicated repo
method that stripped the internal lock counters by hand.

A third-party plugin could have none of that, so the answer to „can an external
plugin do what `product-roadmap` does" was no. Publishing is therefore a declared
capability of the generic layer.

```
GET /api/public/plugin/<pluginId>/<timelineId>[?collection=<id>]
```

## The three gates

All must pass, and **every failure answers 404**:

1. **The instance has the plugin**, installed and switched on.
2. **The plugin asked.** It was granted `public:read` and its manifest declares
   `publicRead.collections`. Neither implies the other: the capability is what the
   operator allowed, the declaration is what the plugin requested. Capability with
   no declaration publishes nothing, which is the right reading of „it may, but it
   did not ask to".
3. **This timeline consented.** `public` on its plugin entry, **off by default**.

One status code for all three is deliberate. This endpoint is reachable by anyone,
so distinguishing „no such timeline" from „exists but is not published" would turn
it into a probe for which timelines exist — and the id is often a customer name.

### Consent is not enablement

A plugin being on does not mean the world may read it: plenty of timelines carry a
pricing model that is not meant to be public. The consent lives on
`timeline_plugins` (migration `0021`) for a `db` source and as `public` on the
`PluginRef` in the file for a local one — the same granularity the decision has,
in the place both source kinds already mirror.

Two rules protect it from drifting:

- **Reconfiguring says nothing about publishing.** A `PUT` without a `public` key
  leaves the consent as it was. Otherwise an unrelated config edit would silently
  publish, or silently withdraw.
- **`public: true` for a plugin that declares nothing is refused**, not stored. A
  switch that can never take effect invites somebody to believe their data is being
  served.

## What is removed

**Three fields always, whatever a plugin declared:** `version`, `updatedAt`,
`updatedBy`. The last one is an e-mail address; publishing it would tell anyone who
fetches the endpoint who works on a timeline. `stripRowVersions` does the first of
those by hand today, for one plugin.

**`publicRead.fields` is an allowlist**, not a removal list. A projection that only
knew what to strip would publish whatever a plugin starts storing next.

**Undeclared collections are absent, not empty.** An empty array would tell a
reader the collection exists, and what exists is itself something the declaration
decides.

## A local source inverts the question

A static `local` deploy materializes the whole timeline to
`public/<data dir>/sources/<id>.json` and hands that file to anyone who asks. So
for `db` the declaration asks *what may be served*; here it asks **what has to be
removed while writing the copy**. Same field, two implementations, and this is the
one that leaks if it is forgotten.

The consequence: the per-timeline opt-in cannot be the only guard on a local
source. Opting out has to *remove* the rows, because a file that is copied verbatim
is published whether or not anybody decided that. `stripFileForPublication` in
[`publicRead.ts`](../src/pluginHost/publicRead.ts) is applied at both
materialization sites in `build-data.ts`.

**The JSON path stopped copying raw bytes.** It used to write the source file
through unchanged, which is exactly the leak; it is now re-serialized from the
stripped object.

**Fail closed on an unknown plugin.** No manifest, no publication: „we could not
check" must not resolve to „ship it".

**It covers every plugin, with no exception left.** There used to be one: the
pricing model sat in a `pricing` field of its own and was materialized as-is, so
a local timeline's prices were as public as its file was, whatever anybody had
decided. That field is gone
([#17](https://github.com/zeitlines/zeitlines/issues/17)) and its rows go through
the check above like everybody else's.

## One exclusion in the auth gate

`/api/public/*` is excluded once, for every plugin that ever publishes, rather than
a line per plugin. The alternative would make an auth-gate edit part of installing
a plugin — and that is the edit nobody remembers to reverse on uninstall.

Served by `timelines-api` rather than a second edge function, because it needs
exactly the same driver setup; a function of its own would be the duplication this
replaces. Cache headers are fixed (`max-age=300`, as today) and
`Access-Control-Allow-Origin: *`. A manifest-declared TTL is deliberately not a
thing: a plugin that can set caching is a plugin that can cause a thundering herd.

## What happened to `/api/pricing/<id>`

Keeping it as a thin alias over the generic envelope, with no plugin-specific
server code, was the plan. **It does not hold**, and finding that out early is
what the plan was for.

The old payload folds the matrix cells into each tier's `values` and
`valueVersions`, grouped by `tierId` and keyed by `featureId`. The generic layer
cannot know that `tier-values` rows belong inside `tiers` under `values` — that is
plugin knowledge, and it now lives in the plugin
([`compose.ts`](../src/plugins/product-roadmap/compose.ts)). Expressing it as a
manifest declaration would mean inventing an embedding grammar with five
parameters for exactly one consumer.

So the endpoint is **retired**: it answers `410 Gone` and names its successor,

```
GET /api/public/plugin/dev.zeitlines.product-roadmap/<timelineId>
```

That is a break, chosen over a shim, and the reasoning is that the alternative is
worse in a way nobody would notice: a consumer silently handed the new shape
renders a price list with empty columns, and no build fails. A 410 with the new
address stops the build with the answer in the body.

Two details that are not incidental:

- **The route stays answered rather than dropped.** An unrouted `/api/pricing/…`
  falls through to the SPA, which returns `200` with HTML, so a build-time
  `fetch(...).json()` fails on a parse error that says nothing about what
  happened.
- **It stays outside the auth gate**, so the 410 reaches a consumer with no
  session instead of a login redirect it cannot follow.

The refusal lives in
[`scripts/db/retired-pricing-route.ts`](../scripts/db/retired-pricing-route.ts),
one file, because it has to name the plugin it used to serve and the isolation
check forbids that in core code. A one-file exception is deletable in a single
commit once the deprecation window closes.

## Rate limiting

There is none, and there was none before: the public endpoint has always relied on
the host's CDN caching plus its platform-level protections. This widens what is
reachable that way from one endpoint to any installed plugin that declares
`publicRead`, without changing the shape of the exposure — every response is a
cacheable `GET` over data an operator explicitly published.

Worth naming rather than leaving implicit: if a deployment ever publishes something
expensive to assemble, the fixed 300-second cache is the only thing between it and
a crawler.

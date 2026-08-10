# Writing a plugin

How to build a plugin **outside this repository** and get it running in an
instance. This is the author's chapter; the host's side of the same seams is
„Plugins" (docs/architecture.md), „The generic store" (docs/plugin-storage.md),
„Installed and enabled" (docs/plugin-lifecycle.md) and „Where plugin code runs"
(docs/plugin-isolation.md).

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands.

## What a plugin is

Two files.

```
manifest.json    what it declares: id, capabilities, views, collections, config schema
index.js         one ES module, exporting fields() and/or renderView()
```

That is the whole artifact. It imports nothing, it is not bundled against the
app, and it has no build step it cannot skip: a plugin can be two hand-written
files. Everything it knows about the host arrives as **arguments**, which is what
lets an instance load it from a URL with nothing to resolve at load time.

The contract as TypeScript types is
[`src/pluginHost/api.ts`](../src/pluginHost/api.ts) — one import for the manifest
shape, the host API and the version helpers, with no runtime code from the app
behind it. Packaging it as `@zeitlines/plugin-api` is
[#15](https://github.com/dermellor/zeitlines/issues/15); until then, that path is
the reference.

## What it exports

| Export | Called when | Shape |
| --- | --- | --- |
| `fields(file)` | building the item form, grouping and filtering | synchronous, returns `CustomFieldDef[]` |
| `renderView(container, viewId, host)` | entering a view, and on every repaint | may be async |

**`fields` is synchronous on purpose.** It runs on the item form's path, and an
`await` there would show an empty form first. Derive the options from the
timeline it is handed; do not fetch.

**Store ids, never labels.** A contributed field's value ends up in an item's
`metadata`, so a label as the value orphans every item the day somebody renames
something.

**`renderView` has to be idempotent**, because the host calls it again on every
repaint. It does *not* have to guard against overlapping calls: the host renders
into a detached element and swaps it in when your call settles, so two repaints
cannot interleave into one section.

Use `container.ownerDocument`, never the global `document`. It costs nothing
today and it is the difference between a view that can move behind a sandbox
later and one that has to be rewritten (docs/plugin-isolation.md).

## The host API

`renderView` receives it as its third argument. What is on it is decided by the
capabilities the manifest declares, structurally: a plugin without `items:write`
finds **no** item-write method rather than a method that refuses.

| Method | Needs | What it gives |
| --- | --- | --- |
| `apiVersion` | — | the contract version in force, as `"1.0"` |
| `timeline()` | `items:read` | the timeline as a snapshot; a copy, so mutating it changes nothing |
| `config()` | — | this plugin's config bag on this timeline |
| `subscribe(fn)` | — | fires after any change; returns an unsubscribe function |
| `currentUser()` | — | who is looking, or null |
| `items` | `items:write` | `add` / `update` / `remove`; the host reloads the view after each |
| `data` | `data:own` | `list` / `put` / `remove` / `move` over this plugin's own collections |

Everything is async and everything is JSON. That is insurance rather than
ceremony: an API shaped around shared live objects cannot be moved behind an
iframe or a worker afterwards without rewriting every plugin.

`data` is scoped to the plugin at construction. There is no argument that could
name another plugin's collections.

**A write through the host refreshes the app; you do not.** `host.items.update(…)`
resolves when the write is durable, and the reload runs on its own after that. A
plugin that repainted itself as well would repaint twice.

**There is no activate/deactivate hook yet, and it shows.** `subscribe` returns an
unsubscribe function, but a view plugin has nowhere to call it: `renderView` is
the only entry point, and it runs again on every repaint. Subscribe behind a
module-level flag so a repaint cannot add a second listener — and know that this
is the contract's gap rather than your mistake
([#11](https://github.com/dermellor/zeitlines/issues/11)).

```js
let subscribed = false;
function subscribeOnce(host) {
  if (subscribed) return;
  subscribed = true;
  host.subscribe(() => { /* invalidate whatever you cache */ });
}
```

Most views need no subscription at all: the host already calls `renderView` again
when the timeline changes. It is for state a plugin keeps *outside* the render.

## Declaring data

A collection is declared in the manifest and the host does the rest — storage,
identity, ordering, references, validation:

```json
"collections": [
  { "id": "notes", "schema": { "type": "object", "required": ["text"],
    "additionalProperties": false, "properties": { "text": { "type": "string" } } } }
]
```

An unknown collection is a 404, an undeclared property is a 400, and a missing
required one is a 400 — before anything is stored. `ordered: true` gives the
collection a position and the `move` call; `keyFields` makes a row's identity a
composite of its own fields. The rules, and what the host enforces in place of
columns and foreign keys, are „The generic store" (docs/plugin-storage.md).

## Installing it

Two paths, and the first one needs no service of any kind.

**Vendored (air-gapped).** Put the directory under the instance's `plugins/` and
rebuild:

```
plugins/
  <plugin-id>/
    manifest.json
    index.js
```

The build validates the manifest against that host's contract, pins the artifact
by `sha384`, registers it, and serves it from the deploy's own origin — so the
default `script-src 'self'` already covers it and nothing leaves the machine at
boot. The directory name has to equal the manifest's `id`.

**From a URL.** `POST /api/plugins` with the artifact's URL and its hash, on an
instance with a database. The operator gate and what an uninstall does to the
data are „Installed and enabled" (docs/plugin-lifecycle.md).

Either way, enabling it on a timeline is a second, separate step — a row with the
plugin's config:

```json
{ "id": "sprints", "config": { "start": "2026-01-05", "length": "2w", "count": 26 } }
```

## Local development

Point an instance's `plugins/<id>/` at your working copy (a symlink is enough) and
rebuild after each change. The integrity pin is computed at registration, so it
follows your edits instead of fighting them; nothing has to be switched off.

The one thing to know: a browser caches a module by URL. Reload with the cache
disabled, or bump the artifact's `version`, or you will debug the previous build.

## What was found by doing this

The first plugin built outside this repository was a Sprints plugin — a computed
field plus a small view over its own rows. Four things were missing, and each is
worth stating because each looked fine from the inside:

- **The host API reached nobody.** `createHostApi` had described the object since
  #14 and nothing supplied it, so a runtime-loaded view could render and nothing
  else — it could not read the timeline it was rendering into. Fixed by
  [`hostBackend.ts`](../src/pluginHost/hostBackend.ts) and by passing the API as
  `renderView`'s third argument.
- **`subscribe` had nothing to subscribe to.** There was no „the timeline
  changed" signal at all ([`changes.ts`](../src/pluginHost/changes.ts)).
- **A file-backed instance could not install anything.** The artifact was copied
  into the build and registered nowhere, so nothing loaded it — no error, no line
  in the plugin panel. The `plugins/` directory is now the registry for that
  shape, read by one scan that both the build and `GET /api/plugins` use.
- **An async view rendered twice.** Two overlapping repaints each cleared the
  section and appended. A plugin cannot fix that for itself, because the
  interleaving is the host's; the host now renders into a detached element and
  swaps it in.

A second plugin — Baseline, which remembers each item's planned dates and can put
an item back — was written for exactly what the first one left untouched, and
found two more:

- **An item write left the app showing stale data.** `HostApi.items` had been
  implemented and never called. The first plugin to call it moved an item
  correctly, on disk, and the interface kept showing the old dates until a
  reload — no error, no signal. The interface's own edits repaint because every
  call site does it by hand, and the host API has no call sites; a host write is
  now refreshed by the host ([`refresh.ts`](../src/pluginHost/refresh.ts)).
- **`subscribe` had never fired**, for the same root cause: the signal is sent at
  the end of a render, and nothing re-rendered.

That list is the argument for the exercise: none of it would have been found by
reading the contract, and all of it was found in an afternoon of using it. The
pattern is worth naming, because it will recur — every one of these was code that
existed, was documented, and had never been executed.

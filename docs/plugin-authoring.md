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
[#15](https://github.com/zeitlines/zeitlines/issues/15); until then, that path is
the reference.

## Choosing an id

**Reverse-DNS, from a domain you own:** `com.acme.sprints`. The validator refuses
anything else, and the reason is not tidiness — an id is global. It keys the
plugin's rows in the store, its registration on every timeline, and the metadata
it writes on items. There is no central registry handing names out, so the only
thing that makes a name safe to claim is that it comes from something already
yours. `sprints` is the name a hundred people would pick; a collision between two
of them is a collision in somebody's data.

The same string is a **path segment**, a **directory name** and a database key at
once, which is why an npm scope (`@acme/sprints`) was rejected: the `/` has to be
percent-encoded in every URL and makes the vendored directory a nested one.

An id is permanent in practice. Changing it after anyone has installed the plugin
orphans their rows, so pick it before you publish.

## What it exports

| Export | Called when | Shape |
| --- | --- | --- |
| `fields(file)` | building the item form, grouping and filtering | synchronous, returns `CustomFieldDef[]` |
| `derive(file)` | once per build, for the fields declared `derived` | synchronous factory, returns `(item) => values` or `null` |
| `renderView(container, viewId, host)` | entering a view, and on every repaint | may be async |

**`fields` is synchronous on purpose.** It runs on the item form's path, and an
`await` there would show an empty form first. Derive the options from the
timeline it is handed; do not fetch.

**Store ids, never labels.** A contributed field's value ends up in an item's
`metadata`, so a label as the value orphans every item the day somebody renames
something.

**Declare a field `derived: true` when its value follows from the item**, and
implement `derive(file)` for it. Requires `apiVersion: "^1.5"`; on an older host the
field appears as an editable control with nothing behind it. Nothing is stored: the
form shows it read-only, the context menu skips it, and the key stays out of
`metadataKeys`, since an uninstall has nothing to purge. That is what keeps a
computed bucket — the sprint an item's dates fall into — from surviving the item
moving out of it.

The factory shape is the contract, not a convenience: whatever the *whole* timeline
decides (a raster, a set of cohort boundaries) is computed in `derive(file)`, called
once per build, while the function it returns is pure over one item. So the rule is
unit-testable in your folder without a DOM, and the same function can back a tool
handler — one rule, two surfaces. Return `null` when the plugin is off or its config
is empty. The host drops values for any key you did not declare `derived`, and a
`derive` that throws costs your plugin its values rather than taking the build down.

**`renderView` has to be idempotent**, because the host calls it again on every
repaint. It does *not* have to guard against overlapping calls: the host renders
into a detached element and swaps it in when your call settles, so two repaints
cannot interleave into one section.

Use `container.ownerDocument`, never the global `document`. It costs nothing
today and it is the difference between a view that can move behind a sandbox
later and one that has to be rewritten (docs/plugin-isolation.md).

## Contributing verbs an agent can call

**Declare a tool per domain rule that turns one instruction into many item
changes.** An agent gets `add_item` and `update_item` from the core; what it
cannot get is the rule that decides *which* items and *what* dates. Kept in a
prompt, that rule cannot be tested, cannot be reused, and is wrong in a way
nobody notices until a date is wrong.

The declaration goes in the manifest, needs the `tools` capability, and needs
`apiVersion: "^1.3"` or later:

```json
{
  "capabilities": ["tools", "items:read", "items:write"],
  "tools": [
    {
      "name": "recalculate_deadlines",
      "title": "Recalculate deadlines",
      "description": "Recompute every deadline from the service date, skipping weekends.",
      "inputSchema": {
        "type": "object",
        "properties": { "servedOn": { "type": "string", "description": "ISO date." } },
        "required": ["servedOn"],
        "additionalProperties": false
      },
      "writes": "items"
    }
  ]
}
```

| Field | What it decides |
| --- | --- |
| `name` | what an agent calls. snake_case, at least four characters, no dots |
| `description` | whether an agent picks the tool at all. It is the only thing a model sees before calling |
| `inputSchema` | the arguments, in the same subset a collection's schema uses. `id` is reserved for the timeline |
| `writes` | `"items"`, or absent for a tool that only answers a question |

**A tool is a pure function**, and everything about the shape follows from that:

```ts
export const tools = {
  recalculate_deadlines: ({ file, config, args, now }) => ({
    changes: [{ op: 'update', itemId: 'frist-1', patch: { start: '2026-04-13' } }],
    notes: ['die vierte Frist war bereits verstrichen'],
  }),
};
```

- It reads `file`, its own `config` and the checked `args`, and it returns changes
  rather than performing them. The host applies them through the write path it
  already owns, so the capability checks, the optimistic locking and the audit
  trail keep holding.
- **`now` is handed in**; a rule that reads the clock itself cannot be tested
  against the boundary it exists for, which is the deadline landing on a weekend.
- A plan is applied whole or not at all. „Six dates moved, the seventh was
  refused" is worse than „nothing moved, here is why", because the first looks
  like it worked.
- A tool declaring no `writes` that returns changes is refused, so an analysis
  tool cannot quietly become a write.
- Throwing is a legitimate answer: a domain rule meeting data it cannot handle is
  an expected outcome, and the message reaches the agent.

Tool names share one flat namespace across every installed plugin. Two plugins
claiming one name is resolved by registration order and **reported**, never
silently shadowed, so pick a name your domain owns rather than `update_dates`.

**Two boundaries as of today.** A tool is called by a server process, and only
in-tree plugins are wired into it: an installed artifact's tools are listed as
declared with no implementation ([#108](https://github.com/zeitlines/zeitlines/issues/108)),
and running an artifact's code next to the database is a trust question
docs/plugin-isolation.md has not answered. The remote MCP server does not carry
plugin tools yet for the same reason.

## The host API

`renderView` receives it as its third argument. What is on it is decided by the
capabilities the manifest declares, structurally: a plugin without `items:write`
finds **no** item-write method rather than a method that refuses.

| Method | Needs | What it gives |
| --- | --- | --- |
| `apiVersion` | — | the contract version in force, as `"1.4"` |
| `timeline()` | `items:read` | the timeline as a snapshot; a copy, so mutating it changes nothing |
| `config()` | — | this plugin's config bag on this timeline |
| `subscribe(fn)` | — | fires after any change; returns an unsubscribe function |
| `currentUser()` | — | who is looking, or null |
| `canWrite()` | — | does this timeline accept writes at all |
| `status(text)` | — | a line in the app's status area |
| `items` | `items:write` | `add` / `update` / `remove`; the host reloads the view after each |
| `data` | `data:own` | `list` / `put` / `patch` / `remove` / `move` over this plugin's own collections |
| `panel` | `items:write` | the detail drawer: `open` / `close` / `showItem` |

**`canWrite` and the capability answer different questions**, and a plugin drawing
its own edit affordances needs both: the capability says what the plugin may do, and
this says what the timeline allows. A local JSON source is read-only at runtime, so
a „+ Feature" button drawn without asking is a button that fails on click.

**`put` replaces a row, `patch` changes part of one**, and in a patch a `null`
**removes** its key. That is what makes an emptied input actually empty instead of
leaving the stored value to reappear on the next reload. Reach for `put` when you
hold the whole row and for `patch` when you hold a form.

**`panel.open` hands you a container**, exactly as `renderView` does, and the host
keeps the books: it clears whatever the drawer held and records that a plugin form
is open, which is what stops background persistence from writing underneath an open
editor. `panel.showItem` is the other direction — handing the drawer back to the app
for one of its own items, which is what a view linking to the roadmap wants.

```ts
host.panel?.open({
  title: 'Feature: CSV-Import',
  render(container) {
    container.replaceChildren(buildMyForm());
  },
});
```

A write that sends a lock counter throws `ConflictError` when the row moved
underneath it. Catch it and reload; presenting stale data as saved is the failure
that matters here.

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
([#11](https://github.com/zeitlines/zeitlines/issues/11)).

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

## Making it look like the app

A plugin's view is rendered into the app's own page, so the theme is already
around it: the tokens in `src/styles/theme.css` are custom properties on `:root`
and they **cascade into a plugin's DOM**. Use them and the view follows a theme
change it never hears about; hardcode `#333` and it does not.

```js
cell.setAttribute('style', 'padding:6px 10px;border-bottom:1px solid var(--border);color:var(--fg-muted)');
```

These are the ones worth treating as the vocabulary:

| Token | For |
| --- | --- |
| `--bg`, `--surface` | the page behind you, and a raised surface on it |
| `--fg`, `--fg-muted` | body text, and text that is secondary rather than faint |
| `--border` | any hairline; it is a translucent accent, not grey |
| `--hover` | a hover wash on an interactive row |
| `--accent` | the one colour the product spends on emphasis |
| `--warning`, `--danger`, `--success` | states, in the app's own reading of them |
| `--font-body`, `--font-headline`, `--font-mono` | typography |

**The host styles exactly one thing inside your view: headings.** `h1`–`h3` get
the app's headline font, because a heading is part of the page's voice and a
plugin that writes a plain `<h2>` should not read as a foreign document pasted
into the app. Everything below that — tables, buttons, spacing — is yours, on
purpose: a default there is something a plugin with its own design would have to
fight.

A shared component vocabulary (`ds-*` classes, so a plugin gets a real button
rather than a browser one) is
[#60](https://github.com/zeitlines/zeitlines/issues/60). Until it lands, tokens
plus your own CSS is the whole story — and note what that implies once it does:
the class names become part of the versioned contract, like the manifest shape.

You can ship CSS with the artifact by injecting a `<style>` from your module; the
policy allows inline styles. Do not fetch a stylesheet from anywhere — the
Content-Security-Policy will refuse it unless the operator has allowlisted that
origin, and asking them to is a worse first impression than a plain table.

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
{ "id": "com.acme.sprints", "config": { "start": "2026-01-05", "length": "2w", "count": 26 } }
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

The second round of findings came from the opposite direction: moving the
**in-tree** plugin onto this same contract (#117). It had been reaching into
`src/state.ts`, `src/render.ts`, `src/detailPanel.ts`, `src/editor.ts` and four more
— so it never met a single one of these gaps, which is precisely why they survived:

- **No partial row update.** `DataApi` had `put`, which replaces a row. A form
  editing two fields of six had to read the row first and hope nothing changed in
  between, and an emptied input could not be told from a field the form does not
  manage. `patch` closes it, `null` removing a key.
- **Nowhere to put a form.** A plugin's own editor had no surface, so the in-tree
  one wrote into the app's drawer elements directly and parked two fields in the
  core's state to mark it open. `panel` is that surface, and the state slot is
  generic now.
- **No status line, and no way to ask about writability.** `status` and `canWrite`.
- **Two helpers were unreachable rather than missing.** `escapeHtml` was four lines
  inside 870 of item rendering, and `ConflictError` — the one failure `If-Match`
  exists to produce — lived in the app's editor. Both moved to where the contract
  can export them.

A fifth CI check now asserts the direction: a plugin may import the contract, the
shared types and its own folder, and nothing else
([`check-plugin-isolation.mjs`](../scripts/ci/check-plugin-isolation.mjs)). Its
allowlist is empty, and an entry in it means a gap to close rather than an exception
to grant.

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

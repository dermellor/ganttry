# Plugin isolation

Where a plugin's code runs, what protects an instance instead of a sandbox, and
the condition under which this decision gets revisited.

This is the decision half of [issue #14](https://github.com/zeitlines/zeitlines/issues/14).
The loader itself is [`src/pluginHost/loader.ts`](../src/pluginHost/loader.ts); for
installing a plugin read [`plugin-lifecycle.md`](plugin-lifecycle.md), for its data
[`plugin-storage.md`](plugin-storage.md).

## The decision

**A plugin runs in the app's own realm.** It is an ES module the host imports, and
once imported it can do everything the page can do: read the session, read every
timeline the user can, rewrite the screen.

**Installing a plugin is therefore trusting its author**, the way installing a
browser extension is. That sentence belongs in the install flow, not in a
footnote, because the alternative is implying a safety that does not exist.

## Why not a sandbox

The obvious wall is a sandboxed iframe: `sandbox="allow-scripts"` without
`allow-same-origin` gives an opaque origin, so the frame gets no cookies, no
storage and no access to the parent document, and it needs **no second domain** —
a common misconception, and it was in the issue.

It was still rejected, for one reason that outweighs the rest: **the cost is paid
per view, and views are the normal case here.** A plugin that only contributes
fields is the exception; a view is the shape most plugins are expected to take.
Behind a frame, every one of them pays for:

- **Overlays that cannot leave the frame.** A tooltip or popover near the frame's
  edge is clipped. The fix is a declarative overlay protocol — which is exactly the
  cost the issue attributed to the *worker* option, inherited by the iframe as soon
  as a view has a popover. The one view that existed when this was decided had
  two, neither of them unusual.
- **Height negotiation**, because the frame does not size to its content.
- **Focus and keyboard traversal** across the boundary.
- **Theming** pushed across, and **debugging** through a message channel.

Comparable products line up with that reading. Obsidian, VS Code, Neovim and Sketch
all run extensions with full access and have large ecosystems. The ones that
sandbox — Figma, Shopify — do it because third-party code runs on *their*
infrastructure against *other customers'* data. That is a business-model question
before it is a technical one, and it is not the shape Zeitlines is in today.

### The two rejected alternatives, and what would bring them back

| Option | Why not now |
| --- | --- |
| **Sandboxed iframe for everything** | Strongest guarantee and the only one that truly tests the contract, but every view pays the overlay, sizing, focus and theming cost, and every existing overlay has to be rebuilt against the protocol first. |
| **Iframe for third-party, same-realm for trusted** | The proposal in the issue. Rejected because the wall would never be exercised: the contract would be tested on the comfortable path only, and a same-realm assumption would reach the catalog through the gap. Two paths also mean two sets of bugs. |

**What brings the decision back:** a managed, multi-tenant Zeitlines with an open
catalog, where somebody installs a stranger's plugin and it runs against another
customer's data on our infrastructure. At that point the wall stops being optional,
and it should go up for *all* plugins rather than only the untrusted ones, for the
reason in the table.

## What keeps the door open

Deciding against the sandbox is cheap. Making it *impossible later* would not be,
so two things are deliberately in place:

1. **The host API is async and serializable throughout**
   ([`hostApi.ts`](../src/pluginHost/hostApi.ts)). No live object is handed to a
   plugin. That was paid for in the contract work (#11) and only has to stay true.
2. **Overlays come from the host** ([`overlay.ts`](../src/pluginHost/overlay.ts)).
   A plugin asks for a layer instead of attaching one to `document.body`, and the
   anchor is passed as a **rectangle** rather than an element — plain data, so the
   call survives a boundary where a plugin would hand over frame-local coordinates
   for the host to translate. Filling the layer is the part that would still have to
   change, from „write into this node" to „describe what goes in it".

Point 2 is the one piece of work in #14 that exists *only* for a sandbox that was
not built. It was worth it because the habit it removes — a plugin reaching for the
global document — is the assumption that would otherwise have to be unpicked from
every plugin ever written. Twenty lines now, unfixable at twenty plugins.

The host models the same discipline in its own code: `container.ownerDocument`,
never the global `document`.

## What protects an instance instead

**Integrity pinning.** The artifact is pinned by hash and the loader executes the
bytes it verified, rather than importing the URL a second time where the server may
answer differently. A plugin that changes under a fixed version does not load. This
addresses the realistic attack, which is not a hostile plugin at install time but a
benign one replaced afterwards, under a version somebody already approved.

**A Content-Security-Policy** ([`csp.ts`](../src/pluginHost/csp.ts)). `connect-src
'self'` means a plugin's `fetch` elsewhere fails; `form-action` and `img-src` close
the two obvious ways around it. **This is a barrier, not a proof**: a determined
plugin can still navigate the top-level window to a URL carrying data, and no
directive prevents that. What it buys is that exfiltration stops being three lines
and becomes conspicuous — which is the precondition for review and for the
integrity pin to be worth anything.

Two concessions in that policy, both named where they are made: `blob:` in
`script-src`, which is what lets the loader run verified bytes, and
`'unsafe-inline'` in `style-src`, which the app itself needs today and which is not
a plugin concession.

**Capability grants**, recorded at install and shown to whoever installs
([`plugin-lifecycle.md`](plugin-lifecycle.md)). A plugin that later declares more
does not get more.

**Failure containment.** A plugin that throws while registering, while contributing
fields or while rendering costs the user that plugin. `fields()` matters most here:
it runs on the item form's path, where an exception would take the form down for
every item.

**Every refusal is visible.** Six distinguishable load outcomes, each with a
sentence, surfaced in the footer's plugin list. A plugin that silently fails to
appear is indistinguishable from a bug in the app, and gets reported as one.

## Where a plugin's code runs, and the one place it does not

Everything above is about the browser. A plugin's **tools** are the one part
called by a server process instead, and that is a different trust question: the
browser realm holds a user's session, a server realm holds the database
credentials and every tenant's data at once. So the answer today is narrow and
deliberately so:

| Kind of plugin | Views and fields | Tools |
| --- | --- | --- |
| In-tree (`src/plugins/<id>/`) | app realm | run, in the local MCP server's process |
| Installed artifact | app realm, integrity-pinned | **not run**, and listed as declared with no implementation |

An artifact's tool code is not executed anywhere. That is not a gap somebody
forgot to close: the install gate makes „same realm as the app" defensible
because an operator chose the plugin, and the same argument does not extend by
itself to a process holding a service key. What a tool *is* keeps the question
answerable later — a pure function from a timeline and arguments to a plan of
item changes, with no I/O of its own to grant.

The condition that would revisit it is the same one this chapter uses everywhere
else: a plugin worth running server-side that cannot express its rule as such a
function. None exists yet.

## What is deliberately not claimed

- **No protection against a hostile plugin an operator installed.** Same realm
  means same access. The gate is the install, and the install is operator-only.
- **The CSP is not airtight.** See above.
- **No network egress control beyond the CSP.** A plugin cannot be prevented from
  trying; it can be prevented from succeeding at the easy routes.
- **No review of what a plugin does.** A catalog with a review gate is
  [#15](https://github.com/zeitlines/zeitlines/issues/15), and the human gate is the
  thing the technical measures here are meant to make meaningful rather than
  replace.

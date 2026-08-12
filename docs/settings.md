# Settings

What is true of the *instance* rather than of one timeline, in one place, with
every setting declaring where it lives.

## The problem it solves

Instance-wide state sits in three places, and none of them used to be visible
from inside the running app:

1. **The instance profile** (`~/.config/zeitlines/instances/<name>.env`, or the
   host's dashboard for a deploy): `TIMELINES_*`, `AUTH_REQUIRED`,
   `ALLOWED_EMAIL_DOMAINS`.
2. **`timelines.config.json`**, committed and therefore identical everywhere.
3. **The built `config.json`**, derived from the two above plus what the build
   discovered.

Answering „does this deployment require sign-in, which domains may sign in, what
do the automations act as" meant reading an env file, a hosting dashboard and
`psql` — and knowing in advance which of the three held the answer.

The second problem was shape rather than content. The membership screen shipped
as a dialog on its own header button, and the plugin work was heading for a
second one, then a CSP allowlist, then a catalog URL. That ends in four panels
and no overview, and the footer suits one button rather than an area.

## The spine: every setting declares where it lives

The failure mode to avoid is deciding „env or database" once per setting and
encoding that decision in the page, because then the page has to know each
setting by name and every new one is an interface change. Instead each setting
declares itself, in [`src/settings.ts`](../src/settings.ts):

```ts
{ key, group, label, home: 'env' | 'db' | 'build', editable, why?, expose?, resolve? }
```

- **`home`** is where the value comes from.
- **`editable`** is whether this deployment can change it here.
- **`why`** is the reason when it cannot („In der Umgebung dieser Instanz
  gesetzt, nicht hier.", „Beim Build festgelegt …").
- **`expose`** is the read gate, below.
- **`resolve`** turns the raw value into the effective one, using the parser the
  runtime actually uses.

**This repo already decides editability exactly this way, twice, and both times
the rule is the same: the runtime declares it and the client never guesses.** A
source adapter's `SourceCapabilities { editable, live }` travel to the client,
and a local source gets `view.source.editable` stamped at build time — both so
the client routes deterministically instead of probing. See
[`architecture.md`](architecture.md) → „Server-side adapter seam" and
[`local-sources.md`](local-sources.md). A client that tries a write to find out
whether it is allowed learns the answer from a failure, at a moment when the user
has already typed something. A settings area following the same rule is that rule
applied a third time.

**The acceptance criterion is that adding a setting is a declaration and nothing
else.** `src/settings.test.ts` asserts it against a declaration the registry does
not contain, because a test that could only reach the mechanism through the
registry would prove that the registry works rather than that the mechanism does.

### `resolve`: the effective value, not what was typed

`MCP_TOKEN_ROLE=nonsense` acts as `editor`; only the literal `true` turns
`TIMELINES_ACCESS_CONTROL` on. A page showing the raw string would describe an
instance that does not exist, so each declaration reuses the runtime's own parser
(`serviceRoleFrom`, `accessControlEnabled`) rather than restating the reading.

`set` and `value` are separate facts for the same reason: `MCP_TOKEN_ROLE` unset
serves `value: 'editor'`, `set: false`, and the interface marks it „(Standard)".
„What the instance does" and „why nothing in the dashboard says so" are different
questions.

## The read gate

`ALLOWED_EMAIL_DOMAINS` is harmless. A connection string is not, and „the
operator interface needs it" is not a reason to serve a secret. So the
declaration says whether the **value** may be served or only its **presence**,
and the default is presence:

```ts
expose: 'value'   // serve it
// absent        → only `set: true | false`
```

**Fail closed**, so a setting added without thinking about this one is withheld
rather than exposed. A withheld value is *absent* from the response, never masked
— a redacted string is still a claim about length and shape, and an absent field
cannot be un-redacted by a client that decides to render it anyway.

Presence is still served, and that matters: „the master key is unset" is exactly
what somebody debugging „nobody can invite" needs, and it is not a secret. The
interface distinguishes the three cases visibly, because taking a withheld secret
for an absent one sends an operator off to configure something that already is.

## The endpoint

`GET /api/settings` needs the `manage` capability, like `/api/members`: which
domains may sign in and which credentials exist is administration, not
viewer-facing state. It is declared in [`openapi.yaml`](../openapi.yaml).

Each runtime passes its own environment accessor as `ctx.env` — `Deno.env.get` in
the edge function, the Node cascade's `envValue` in `scripts/serve.ts`,
`process.env` in the Vite middleware. A function rather than a snapshot, because
only the runtime knows which. A runtime that omits it gets a `503` rather than an
empty list: „nothing is configured" and „I cannot see the configuration" look
identical on the page, and the first would send somebody debugging a lockout to
the wrong place.

### The cost of gating it on `manage`

While `TIMELINES_ACCESS_CONTROL` is off, the route answers `503`
`access_control_disabled` — and that is the instance whose operator most wants to
look at `TIMELINES_ACCESS_CONTROL`. The alternative is worse: with the switch off
there are no roles to satisfy `manage` with, so serving it anyway would answer
„which domains may sign in, which credentials are set" to whoever reaches the
URL, with nothing but the auth gate in front.

What makes the refusal useful instead of merely correct is that it names the
variable. The deep link `#settings` therefore answers the question it was
followed to ask, even though it cannot show the page.

## Where it sits

A hash route beside the views — `#settings`, or `#settings=<section>` — rather
than a dialog or a footer button. It is not a view (a view names a timeline
source) and a dialog is the wrong size for a surface that grows a section per
instance-wide concern.

Its frame is part of the app shell ([`src/appShell.ts`](../src/appShell.ts)) and
built from design-system components: the section list is `Tabs` in its vertical
variant, the rows are `Table`, the origin is a `Badge`, a refusal is a `Callout`.
[`src/styles/settings.css`](../src/styles/settings.css) holds only how this one
area arranges them, which is the bar [`design-system.md`](design-system.md) sets
for a stylesheet outside the layer.

The rest of the hash survives while the area is open, so closing it returns to
the timeline the operator left rather than to the default view. The section is
recorded from the URL *before* the first `syncUrl`, or the section a deep link
named would be stripped out of the URL it arrived in.

The header button is offered only to somebody who may `manage` — an affordance,
never the permission. The **deep link opens the area for anybody**, and the
sections then show whatever the server answers. A silently ignored link would
leave the reader with a timeline and no explanation.

While the area is open the timeline, the list, the detail panel, `+ Eintrag` and
the footer are hidden by a class on `<body>`, **not** by setting `hidden` on each
element. Every one of them owns its own `hidden` for its own reasons — the button
is hidden on a read-only source, the detail panel when nothing is selected — and
writing over that on open means guessing what to restore on close. The guess is
wrong for exactly the case that matters: the button comes back on a timeline that
cannot be edited.

## The risk this is designed against

An area that is 80% values you cannot change there teaches people to ignore it,
and once ignored the editable remainder is missed too. A read-only mirror of an
env file is worse than no page at all, because it looks like it should work.

The mitigation is that non-editability carries a **visible reason** rather than a
greyed-out field. That is what `why` is for, and it is also what makes the page
useful to somebody who cannot change anything on it: knowing where a value comes
from is most of what an operator is looking for.

A reason repeated under twelve consecutive rows is wallpaper, though, so each
distinct reason is stated **once per group** and carried on every row's tag as a
tooltip. A setting whose reason differs from its neighbours' states its own,
which is exactly when the sentence carries information.

## Sections

| Section | What it is |
| --- | --- |
| `#settings=instance` | The declared settings, grouped, read-only today. |
| `#settings=members` | The membership screen — see [`users.md`](users.md). |

Adding a section is an entry in `SECTIONS` in
[`src/settingsArea.ts`](../src/settingsArea.ts) with a `mount`, and the id is
verbatim what the hash carries (English, like every other key in the hash, even
though the labels beside them are German). A section builds its own body on
mount and drops it on unmount, so nothing a section needs is in the document for
the visitors who never open it.

## The second area, and what the two share

The open timeline has an area of the same shape
([`src/timelineSettings.ts`](../src/timelineSettings.ts), `#timeline-settings=<section>`),
because a timeline's name, its description and the dimension it opens with are the
same kind of thing one level down. What both areas are made of lives once, in
[`src/areaFrame.ts`](../src/areaFrame.ts) and in one `settingsFrame()` in
[`src/appShell.ts`](../src/appShell.ts): the section list, mounting exactly one
section, the class on `<body>` that hides what is behind it. The second area first
arrived as a copy of the first, and the copies had already drifted by a heading
level before either shipped.

**Two keys rather than one**, because they are two levels: `settings` is the
deployment, `timeline-settings` is this document (see
[`information-architecture.md`](information-architecture.md)). Only one is ever set
— both replace the content, so opening one closes the other, and that is enforced in
code rather than left to the URL.

**What each area hides differs by one thing.** The instance area hides the
timeline's identity too, since „8 items in Beispiel: Projektplan" under a page of
instance settings reads as a claim about the settings. The timeline's own area keeps
the name, the origin badge and the item count: that page is *about* that timeline, so
its subject has to stay visible.

## What is deliberately not here

- **An `instance_settings` table.** No setting is `home: 'db'` yet. One
  DB-resident setting would not justify a generic key-value store, and building
  one now would be designed against a single case and redesigned the first time a
  second arrived with different needs. The declaration shape does not depend on
  the answer, which is the point — `db` is in the union and needs no change here
  when the first one lands.
- **Editing.** `editable` exists and the interface reads it; nothing declares
  `true` yet, because everything an operator can currently change lives in a host
  dashboard or a build.

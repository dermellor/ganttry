# Items

What an item carries beyond dates: icons, status, owner, custom fields.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Item icons

Items can carry an optional `icon` — a small glyph rendered before the content on
the bar. The value is a **semantic key** (what the icon means, not a concrete
SVG): the key resolves to a glyph via a `--icon-<key>` CSS custom property. The
stored `content` stays clean (the glyph is prepended at render time via the
vis-timeline `template`), so it round-trips through the editor, the DB, and
exports unchanged.

Curated key set (defined once in [`src/icons.ts`](../src/icons.ts)):

`milestone` · `launch` · `done` · `warning` · `blocked` · `review` ·
`deadline` · `meeting` · `idea` · `research` · `design` · `build` · `bug` ·
`release` · `decision` · `goal` · `info` · `note`

Unknown values are dropped (validated by `normalizeIcon`). The base glyphs are
defined in the `:root` block of
[`src/design-system/tokens/tokens.css`](../src/design-system/tokens/tokens.css).

**How to render / extend:**

- **Render:** the glyph is a CSS `mask` on `.item-icon` (see
  [`src/styles/timeline.css`](../src/styles/timeline.css)), coloured with
  `currentColor` — it adapts to the item text colour automatically.
- **Change the icon look:** override any key in your own stylesheet, e.g.
  `:root { --icon-milestone: url("…"); }`.
- **Add a new semantic key:** add it to `IconKey` + `TIMELINE_ICONS` in
  `src/icons.ts` (label shown in the icon picker) and add a matching
  `--icon-<key>` to the `:root` set in `theme.css`. It then appears in the edit
  form, the `timeline_items.icon` column, and the MCP `add_item`/`update_item` tools.

Icons render on the live viewer, exported HTML, and the read-only Netlify deploy.

## Item status

Every item carries a built-in **status** — a first-class field with a fixed,
universal value set: `Open` · `Doing` · `Done`, defaulting to `Open`. Unlike a
per-timeline custom field, status is the *same* concept everywhere and is stored
as its own column (`timeline_items.status`, `NOT NULL DEFAULT 'Open'` + a CHECK
constraint), a peer of `icon` — so it round-trips through the DB, the editor,
exports and the MCP tools unchanged, and every existing/new item always has
exactly one of the three states.

- **Single source of truth:** the value set + default + `normalizeStatus` /
  `statusOrDefault` live in [`src/status.ts`](../src/status.ts) (`StatusKey`,
  `ITEM_STATUSES`, `DEFAULT_STATUS`), imported by both the client form and the
  server data-access layer — no duplicated list.
- **Editing:** the item form renders a Status dropdown
  ([`src/itemForm.ts`](../src/itemForm.ts)); new items seed `DEFAULT_STATUS`
  ([`src/render.ts`](../src/render.ts)).
- **The default is shown, not stored.** An item without a `status` displays as
  `Open`, and `statusToStore` keeps the form from writing that display value back
  — otherwise merely opening an item committed `"status": "Open"` into the source
  file, and on a DB-backed timeline bumped `version` and re-attributed
  `updatedBy`, so reading an item announced itself to the others as editing it.
  An item that already carries a status always gets an explicit value written,
  including back to `Open`, because the column is `NOT NULL` and an omitted key
  leaves the old value standing.
- **Server write:** `itemToRow` always writes a canonical value (never `null`,
  so inserts satisfy `NOT NULL`); `updateItem`'s patch map carries `status`
  ([`scripts/db/timeline-repo.ts`](../scripts/db/timeline-repo.ts)).
- **MCP:** `add_item` / `update_item` accept `status` as an enum
  ([`scripts/mcp/server.ts`](../scripts/mcp/server.ts)).
- **Add/rename a state:** change `ITEM_STATUSES` in `src/status.ts` and the DB
  CHECK constraint (a new migration). It then flows to the form, column and MCP.

Status also surfaces on the built `TimelineItem` ([`src/buildItems.ts`](../src/buildItems.ts))
and renders as a **Status column in the Liste view** ([`src/listView.ts`](../src/listView.ts));
items without a status (file-based sources) show „—".

It is also a **grouping and filter dimension** (`STATUS_DIM` in
[`src/listGrouping.ts`](../src/listGrouping.ts)): the toolbar offers **Status**
whenever the build carries one, sections/lanes run `Open → Doing → Done` in the
`ITEM_STATUSES` order, and the filter's checklist selects which of them stay
visible. Both controls share one dimension list on purpose, so a state added to
`ITEM_STATUSES` appears in both without a second edit. See „Shared toolbar:
Gruppieren + Filter" (docs/editing.md).

On the **timeline** the status is drawn on the bar as **one mark** in the item rail
(see „Item rail → The status mark" (docs/editing.md)), plus, where the status contradicts the dates,
a line that quantifies the contradiction:

- **`Done`** — the item is painted **lighter** and carries a **check**, so a glance
  separates what is behind from what is still ahead.
- **overdue** — the timeline shows the item as finished (its `end`, or its `start`
  when it has no extent, is in the past) while its status still says `Open`/`Doing`.
  It carries a **warning triangle**, and a range bar also grows a dashed
  **overrun line** from its own end to „now" — the mark says *that* it is late,
  the line *by how much* (see „Item rail → The overrun line" (docs/editing.md)).
- **`Open` / `Doing` on time** — no bar treatment at all. Three states each with
  their own paint would make every bar a legend lookup, and being in progress on
  schedule is the normal case; the Status column in the Liste view carries the
  full three-way split.

The rule is `isOverdue(item, now)` in [`src/status.ts`](../src/status.ts) (pure,
tested in [`src/status.test.ts`](../src/status.test.ts)), and it deliberately treats an
item with **no status at all** as never overdue: a file-based source has no status
concept, so „not Done" there would be a complaint about something nobody can act
on. Day strings are read as *local* midnight (`parseLocalDay`), the same boundary
vis places the item at, so the mark appears exactly when the bar's right edge
crosses „now".

## Item owner (links a user, not a name)

An item's **owner** links a person: `metadata.owner` holds that person's
**e-mail**, and the display resolves it to a name + avatar. It used to be a free
text input, which meant „Robin", „robin" and „R. Fischer" were three different
owners, a typo was invisible, and the value had no relation to the identities the
app already knows from auth and presence.

**Where the candidates come from.** A user directory in its own table,
`app_users` (migration `0015`, see „Schema" (docs/database.md)): `email` PK, optional `name`,
`first_seen_at` / `last_seen_at`. Deliberately **not** timeline-scoped and not a
membership list — the deploy is gated to an allowed sign-in domain, so „everyone
who has used this instance" already *is* the candidate set. It **fills itself**:
serving `GET /api/users` upserts its caller (`handleUsersApi` in
[`scripts/db/api.ts`](../scripts/db/api.ts)), and the client asks once per load, so
anyone who opens the app is assignable from then on. Migration `0015` seeds it
from the existing `created_by` / `updated_by` attribution, so it is not empty on
day one. There is no seeding step and no list to maintain by hand.

Only an **address-shaped** identity registers. `updated_by` also carries
non-person actors (`mcp`) and the dev server's placeholder `local`, and a local
`npm run dev` points at the live DB — an unfiltered upsert would put „local" in
the real directory. Same filter as the backfill, one rule for both.

- **Endpoint:** `GET /api/users` → `{ users: [{ email, name? }] }`, ordered for a
  picker (named users first, then by name). Served by the Vite middleware locally
  and by the **`timelines-api` edge function** on the deploy — the directory rides
  along in that function rather than getting its own, because it needs exactly the
  same driver setup and the same auth gate. Storage sits behind the usual
  `TimelineRepo` seam (`listUsers` / `touchUser`, both drivers).
- **Client:** the pure rules (what a stored value means, which users a query
  matches) are DOM-free in [`src/ownerModel.ts`](../src/ownerModel.ts) and tested in
  [`src/ownerModel.test.ts`](../src/ownerModel.test.ts); the cache, the fetch and the
  rendering sit on top in [`src/users.ts`](../src/users.ts) — the same split
  `presenceModel.ts`/`presence.ts` has. The directory is loaded **once per page
  load**: it changes only when someone new signs in, and it is read on every list
  repaint and every form open.
- **Editing:** the item form renders a single-value combobox
  (`wireOwnerPicker` in [`src/itemForm.ts`](../src/itemForm.ts)) — type to search name
  or address, pick to link. The picked value lives in a **hidden `owner` input**, so
  `FormData` still carries `owner` and `applyItemForm` is unchanged from when this
  was a text field. Chip and search box are two states of one slot, never both:
  one owner per item, so leaving the search box beside a filled chip would invite a
  pick that silently replaces it. Unlike Tags there is **no free-form fallback** —
  typed text that matches nobody must not become the value.
- **MCP:** `list_users` lists the assignable people; `metadata.owner` takes one of
  their addresses (`add_item` / `update_item`).

**A value that matches no user stays visible, marked as unlinked** — italic and
muted, no avatar (`resolveOwner().known === false`; `.is-unlinked`). Owner was free
text before this, so real data carries values like „Strategy Team", and
**file-based sources have no directory at all** — inventing a monogram and a colour
for a string the directory never knew would present it as a person. Rendering it as
what it is keeps someone's deliberate note legible instead of dropping it. The
committed example `data/launch-roadmap.json` keeps its role-shaped owners („UX
Lead", „Tech Lead") for exactly this reason: they are not people, and they
demonstrate the unlinked case.

**One person, one look.** The initials avatar is shared: `.user-avatar` in
[`src/styles/base.css`](../src/styles/base.css) carries the look, and
`.presence-avatar` adds only what is presence-specific (the stacking overlap, the
self ring). So the same colleague is the same monogram in the same colour as a
presence avatar, as a per-item presence mark, as an owner chip and in the list's
Owner column. Hue and initials come from `hueFor()` / `initials()`
([`src/presenceModel.ts`](../src/presenceModel.ts)). The avatar markup has **two forms
from one definition** (`userAvatarHtml` string / `userAvatar` element), because the
list builds html and the form assembles nodes.

Owner is not (yet) a Gruppieren/Filter dimension, and the read-only detail panel
does not show it — it surfaces in the item form and the Liste view's Owner column.

## Parent and children

An item can be **part of** another one: `metadata.parent` holds the id of its
parent, and an item has at most one. The parent then reads as an umbrella over
the items under it — a theme that runs for a quarter with the individual pieces
of work inside it, a phase of a project with its steps.

**The link is stored on the child**, exactly like `metadata.dependsOn` stores an
edge on the dependent side. Two things follow that a `children: []` array on the
parent would not give: „one parent per item" is structural instead of a rule
somebody has to enforce, and re-parenting is a write to one item rather than to
two (which is also what keeps it safe under the optimistic locking of a
concurrently edited timeline).

**The rules live in [`src/itemHierarchy.ts`](../src/itemHierarchy.ts)** — DOM-free
and tested, imported by the build, both views and the item form, so none of them
can disagree about what a tree is. Three ways a stored link can be wrong are
dropped there, once, when the timeline is built: a self-link, a parent id no item
carries, and any edge that would close a cycle. Hand-edited JSON produces all
three, a delete produces the second, and a renderer walking an unsanitized map
recurses forever on the third.

**On the timeline** the hierarchy bands a track before anything else lays it out:
every parent takes a lane above its complete, contiguous subtree. An unrelated
item may start only after that subtree, never between a summary and one of its
children; the same rule recursively keeps a grandchild beside its own parent
instead of below an unrelated sibling. The dependency staircase (see
„Dependency arrows" (docs/data-model.md)) still applies, but *within* one such
band — otherwise a chain of children would climb past the bar above them. A track
with no hierarchy is a single band, so its layout is exactly what it was. The
parent's bar carries a heavier outline (`item-summary`) and a fold caret at its
inner left edge. A light shadow separates that bar as the folder tab. While
expanded, a very pale, borderless body sits behind its contiguous subtree,
slightly inset from both horizontal edges of the tab and ending vertically after
the last descendant. It therefore communicates containment without pretending
that the parent owns another date span. Every child also carries a quiet branch
mark (`item-child`). Folding hides the whole subtree and its folder body,
grandchildren included, while the parent's structural band remains reserved so
unrelated items do not jump across it when toggled.

**Cross-track links are recorded but do not nest.** A parent in another group has
no row in this track, so banding under it would pull the child out of its own
track — the same rule the dependency edges follow. The link still shows in the
item form and still folds.

**Changing an item's track moves its subtree with it.** Dragging a summary bar
onto another track, or picking a track in the item form, carries every descendant
along, grandchildren included (`regroupSubtree`). Leaving them behind is what the
containment link exists to prevent: what reads as one unit would come apart, and
the user would re-assign every child by hand. Both write paths call the same
function, so the drag and the form cannot come to mean two different things.

What travels is the *contiguous* subtree. A descendant that sits on a **third**
track keeps it, and so does everything below that descendant: per the rule above
it is not drawn under this bar at all, so nothing on screen suggests it would
come along, and its placement was a decision. Moving a child alone is therefore
still possible — it takes its own children and leaves its parent where it is.
The `metadata.parent` links themselves are never touched by a track change.

**The parent's own dates stay authoritative.** They are maintained by hand, and a
rollup that overwrote them would replace a decision with a calculation. Where the
children run outside them, the item form says so under „Untereinträge" („…
beginnen am 16.07.2026") and changes nothing.

**Folding is a way of reading, not of editing**, so the caret is there on a
read-only source too, and which items are folded is persisted per source
(`timelines.collapsedItems`, keyed by source id — item ids are only unique within
one timeline). Everything folded away is dropped in one place,
`filterBuildForDisplay` in [`src/render.ts`](../src/render.ts), so the timeline,
the Liste view and the status-line counts cannot disagree about what is on
screen.

## Custom fields (per timeline)

Beyond the built-in item fields, each timeline can declare its own **custom
fields**. The *definitions* are timeline-level config (stored on the timeline
row in the `custom_fields` jsonb column, a peer of `phases`); a field's *value*
lives per item in `metadata[key]`. This keeps the field schema per-timeline
while reusing the existing `timeline_items.metadata` column for values.

A definition is:

```jsonc
{
  "key": "risk",                 // metadata key the value is stored under
  "label": "Risiko",             // shown in the editor
  "type": "multi-select",        // "text" | "select" | "multi-select"
  "options": [                   // choices for select / multi-select (ignored for text)
    { "value": "Technisch",   "color": "#64748B" },
    { "value": "Rechtlich",   "color": "#1D9E75" },
    { "value": "Kapazität",   "color": "#315DFF" }
  ],
  "group": "Risiken",            // optional: section heading in the item form
  "width": "full",               // optional: "half" (default) | "full" (spans both columns)
  "contextMenu": true            // optional: also settable from an item's right-click menu
}
```

**Values by type** (in `metadata[key]`): `text` / `select` → a string;
`multi-select` → a `string[]`. Definitions are read/written in
[`scripts/db/timeline-repo.ts`](../scripts/db/timeline-repo.ts) (`getTimeline`,
`replaceTimeline`, `updateMeta`) and flow to the viewer as `file.customFields`.

**The definitions are edited in the timeline's own settings**, section „Felder"
([`src/fieldsSection.ts`](../src/fieldsSection.ts), `#timeline-settings=fields`):
one card per definition with its label, key, type, option list, section and the
context-menu flag, plus add, remove and reorder. The order is what the item form and
the dimension lists read, so moving a card is the only ordering there is.

The rules live in [`src/fieldDefs.ts`](../src/fieldDefs.ts), DOM-free and
unit-tested, because they are what keeps an edit from destroying data:

- **A key is fixed once items use it.** The key *is* the metadata key, so changing it
  on a field that carries values orphans every one of them: the field reads empty
  everywhere and the values sit in the file under a key nothing offers. The input is
  disabled with that reason, and clearing the last value makes it editable again.
- **A key a plugin contributes is refused.** A contributed definition wins over a
  stored one (`mergeFieldDefs`), so storing one on the same key would never appear —
  an edit that looks like it did not take.
- **A reserved key is refused** (`owner`, `tags`, `parent`, …): the item form already
  renders its own control for those.
- **Every problem is reported at once**, at the card it belongs to, and the save stays
  disabled while any remains. Somebody fixing four problems one save at a time gives
  up.
- **Removing a definition removes no values.** They stay in the items and reappear if
  the key is declared again — said once above the list, because the opposite
  assumption is the dangerous one.

Still available, and unchanged: the MCP tool `set_custom_fields(id, customFields)`
(patches the definitions as a unit; items are untouched), `replace_timeline`'s
optional `customFields`, a direct `PATCH /api/source/<id>`, or SQL on the
`timelines.custom_fields` column.

**Editing values:** for a DB-backed (editable) timeline the item form renders one
control per custom field ([`src/customFields.ts`](../src/customFields.ts), wired
into [`src/itemForm.ts`](../src/itemForm.ts)) — a chip editor with a fixed-options
dropdown for `multi-select`, a `<select>` for `select`, a text input for `text`.
Custom-field keys are treated as managed metadata (like `tags` / `dependsOn`),
so they never leak into the free-form "Other metadata (JSON)" box.

**A stored value the definition no longer offers keeps its own row** in the
`<select>`, marked „(nicht in der Liste)" (`selectRowsFor` in
[`src/fieldDefs.ts`](../src/fieldDefs.ts)). Without it the control renders empty, and
because leaving the panel commits the form (see „Opening an item's form is a read"
(docs/editing.md)) that empty was written straight over the stored value: removing one
option cleared the field on every item that carried it, in a single click and with no
message. That was reproduced against the running form, which is why the rule now sits
in a tested module rather than in the renderer.

### Quick-editable from the context menu (`contextMenu`)

A definition may set **`contextMenu: true`**, which adds the field to an item's
right-click menu as a submenu of its options (see „Item context menu" (docs/editing.md)): a
`select` picks one value or „kein Wert", a `multi-select` toggles values and keeps
its panel open. Values are written to the same `metadata[key]` in the same shapes
the form writes, so the two ways in are interchangeable.

Off by default, per definition: the point is a *quick* action, and a menu listing
every field would not be one. `text` is never offered whatever it declares — a menu
can only present fixed rows, and free text needs a keyboard. The rule lives in
`contextMenuFields()` ([`src/customFields.ts`](../src/customFields.ts)), so the menu
itself reasons about no field types.

Set it the same ways as any other part of a definition (`set_custom_fields`,
`replace_timeline`, `PATCH`, SQL). Note that the MCP `customFieldDef` schema is
**not** pass-through — Zod strips keys it doesn't declare, so a property missing
from it is silently dropped on that path. `contextMenu` is declared; `group` and
`width` are not yet, and have to go through `PATCH`/SQL until they are added.

**A plugin opts in through its own `fields()`** rather than through stored
config, since its definitions are derived. The rule of thumb it should apply: a
short, fixed list that gets retargeted often while planning belongs in the menu;
one with dozens of options does not, because a submenu that long is a worse way
in than the form's searchable chip editor.

### Plugin-contributed fields

The stored definitions above are not the only source of custom fields: an enabled
**plugin** contributes its own, derived from the timeline's data rather than
declared by hand (see „Plugins" (docs/architecture.md)). `getCustomFields()`
concatenates the timeline's stored defs with `pluginFieldDefs(file)`, and
everything downstream — the form control, the managed-metadata rule, grouping and
filtering — works off that one list, so a plugin field needs no parallel code
path. Being derived, these defs are never persisted back as definitions.

Which fields a given plugin contributes is documented with that plugin
(`src/plugins/<id>/README.md`), not here: uninstall it and a table in this
chapter would be describing fields that no longer exist.

**A plugin lays out its own section.** The order of the array `fields(file)`
returns is the render order, and each def's `width` (`half`, the default, or
`full`) decides whether it shares its grid row — `full` reuses the form's
existing `.field.full` rule, the same seam the built-in fields use. So a pair of
compact pickers can share one row while a chip field spans both columns below
them. Changing that layout is a change to the plugin's `fields()`, not to the
form.

**One definition per key** — a contributed field *supersedes* a stored one with
the same key (`mergeFieldDefs` in `pluginHost/registry.ts`). Two defs on one key would
render two controls writing the same `metadata[key]` and sharing one multi-select
state bucket (that state is keyed by the field key). So a stored definition a
plugin has taken over is inert, and dropping it is a tidy-up rather than a fix.

**Derived beats stored, and that is the reason the seam exists.** A hand-seeded
stored field whose options are a copy of some list drifts the moment the list
changes: the field keeps offering yesterday's labels, and nothing says so.
Derived, it cannot. Two rules follow, and both are cheap only if applied from the
start: a contributed field's values are **ids** rather than labels, so a rename
orphans nothing; and anything cosmetic that would otherwise be picked per option
(a colour, an icon) is derived from the id too, because picking them in code
reintroduces exactly the duplication the derived field removed. Something that
genuinely has to be *chosen* belongs on the plugin's own row, not in the field
definition.

**Sections.** A def may carry a `group`, and the item form renders one titled
section per group in the Properties tab, after the ungrouped fields
(`.cf-group` fieldset, styled in [`src/styles/forms.css`](../src/styles/forms.css)):
an open block behind a hairline, not a disclosure — these are ordinary item
properties, and hiding them behind a click would cost a lookup on every edit. The
caption is centred over the rule, because it titles the whole section; left-aligned
at 11px uppercase it read as a label for the field directly beneath it.
Plugin fields get their plugin's `label` stamped as the group (so product fields
land under „Produkt"); a **stored** def may declare a `group` too, to file itself
under the same heading. The sections are plain markup inside the same `<form>`, so
`FormData`, `applyCustomFields` and `isManagedMetaKey` are untouched by the
grouping.

Because two sources can name a field the same thing, a grouped field is listed as
„&lt;Gruppe&gt; · &lt;Label&gt;" in the Gruppieren / Filter dropdowns
(`dimensionLabel` in [`src/listGrouping.ts`](../src/listGrouping.ts)); the stored key
stays untouched.

> Note: metadata-only edits (custom fields, tags, `dependsOn`, owner, JIRA) rely
> on the persist-diff seeing inside `metadata`. `canonicalItem`
> ([`src/persistence.ts`](../src/persistence.ts)) therefore serialises with a
> recursive key-sort — **not** a `JSON.stringify` array replacer, which silently
> drops nested keys and made metadata-only edits look unchanged.

# Editing and views

How a timeline is edited in the interface, and the two view modes.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Item rail (marks inside the bar's right edge)

A range bar reserves a strip at its inner right edge for small marks, and the
label fades into the bar's own fill under it instead of being hard clipped. Two
marks live there: the **delete affordance**, which appears on **hover as well as
on selection**, and the **status mark**, a permanent data mark carrying the item's
status (see „The status mark" below). They share one slot — hovering a marked bar
swaps the status glyph for the „×" instead of putting the two side by side.

**The mark is ours, not vis-timeline's** (`editable.remove` is off, and vis's
`onRemove` handler is gone with it). vis creates its `.vis-delete` button only
while an item is *selected* — hovering a bar showed nothing, so the only way to
find out a bar was deletable was to click it, which also opens its edit form.
Owning the mark ([`src/itemRail.ts`](../src/itemRail.ts)) keeps hover and selection
one affordance with one implementation instead of vis's button for the one state
and a copy of it for the other. Clicking it runs `deleteItem`
([`src/itemForm.ts`](../src/itemForm.ts)) — the same path the form's Löschen button
takes, so there is one delete flow, not two.

Geometry and states are **CSS**, in [`src/styles/timeline.css`](../src/styles/timeline.css)
(rail block), with the glyph in [`src/design-system/tokens/tokens.css`](../src/design-system/tokens/tokens.css)
(`--ui-icon-delete`, kept apart from the `--icon-<key>` item set because chrome
glyphs have no key). Slots are counted right-to-left from the bar's inner edge,
so a mark's position is arithmetic on `--rail-slot` and marks line up without
measuring anything.

- **JS renders, CSS decides when.** `attachItemRail` puts a `.rail-delete` button
  on every mounted editable item (phase-background items excluded) and re-applies
  after vis mounts item DOM — the `'changed'` hook and repaint-via-timer notes
  from [`src/itemPresence.ts`](../src/itemPresence.ts) apply verbatim. Visibility is
  left to `:hover` / `.vis-selected` in CSS; tracking hover in JS would duplicate
  what the selector already knows, and the mark is in the DOM either way.
- **The mark swallows the events vis builds gestures from** (`mousedown`,
  `pointerdown`, `touchstart`), or else deleting would also select the item and
  open its form. They are caught in the **capture** phase on the timeline
  container: vis binds its listeners further down the tree, so a bubbling
  listener would run after them, too late to stop anything. Those delegated
  listeners are wired once per container, not per render — the container outlives
  the timeline instances rendered into it.

- **Geometry** lives entirely in the vars on `.vis-item`: `--rail-mark` (mark
  box), `--rail-glyph` (the glyph inside it, shared so every mark draws at one
  size), `--rail-gap`, `--rail-inset`, `--rail-fade` (the gradient ramp),
  `--rail-slot` (mark + gap), and `--rail-w` (the space the occupied rail
  claims). `--rail-mark-dim` is a visible mark's resting opacity, a var because a
  faded item (status „Done") has to raise it to land at the same effective
  strength. `--bar-gutter` names the 2px gutter a range bar reserves so
  back-to-back bars don't touch — a mark sits inside the *visible* bar, so the
  rail has to offset by it.
- **Occupancy** is read off the DOM (`:has(> .rail-delete)`) for the delete, not
  off a state class, so a read-only timeline neither reserves that slot nor fades
  its labels for it. The slot is claimed only while the mark is actually visible,
  so an unhovered, unselected bar keeps its full width for the label. The status
  mark is data rather than an affordance, so it claims its slot off the item's own
  class (`--rail-marks: 1` on `.status-mark`) and holds it until the delete takes
  over. `--rail-delete` + `--rail-marks` add up to `--rail-slots`.
- **Marks fill the strip from the edge inward**, and the delete takes the
  outermost slot. The status mark shares that slot rather than sitting beside it,
  so the rail is one slot wide in every state — see „The status mark".
- **The fade** is an `::after` on `.vis-item-overflow` painted in
  `background-color: inherit` (whatever lane colour the wrapper carries) and
  masked into a ramp. Masking the wrapper itself would fade its border and fill
  along with the text. It stays in the DOM at `opacity: 0` so it fades in with
  the mark rather than snapping on. On a marked bar it is shown unconditionally:
  a status mark is always there, including on a read-only timeline where no
  `.rail-delete` exists. Its width never changes there either, since the delete
  replaces the status glyph in the same slot instead of adding one.
- **A range bar takes the in-bar slot at every width**, however narrow. Zoomed
  out most bars are a few dozen pixels wide — narrower than the rail itself — so
  on those the mark covers the bar and the fade swallows the whole label while
  the pointer is on it. That is the accepted trade: a mark hanging *outside* the
  bar is what the rail exists to get rid of, and a two-character label on a 29px
  bar carries little to lose. Only **milestones and boxes** keep vis's placement
  just outside their right edge — they size to their content, so there is no
  interior to put a mark in and no `.vis-item-overflow` to fade. Reserving room
  with `padding-right` would widen every milestone permanently for an affordance
  that only shows on hover.

Two vis-timeline collisions the rail has to defeat, both worth knowing before
touching it. The mark needs `z-index` above `.vis-drag-center` /
`.vis-drag-right` (vis appends those to the same item box *after* it, so they
would swallow the click). And the right-edge **resize handle** has to share the
edge with the mark: vis pins it to `right: -4px` at 24px wide, which is exactly
the rail's slot, so at that width „drag the right edge to resize" and „click × to
delete" fight over the same pixels.

The handle is therefore **narrowed, not moved** — it keeps `right: -4px` and ends
where the mark begins, a band straddling the bar's border. It used to be shifted
inward by `--rail-w` instead, and that is what made a bar resizable at its *left*
edge only: the outermost pixels became `.vis-drag-center`, the next ~18 the mark
(which swallows `mousedown`), and the grab zone started ~27px in, so aiming at the
visible right edge moved the bar or hit „×" and never resized it. The cost of the
current version is width, not reach: 10px on the right against vis's 24px on the
left, which is what it costs to keep the mark inside the bar. The width is
derived from `--bar-gutter` + `--rail-inset` (where the mark starts), so moving
the rail moves the handle with it, and vis's own `max-width: 20%` shrinks it
further on a narrow bar — no width threshold is involved either way.

`.vis-item.vis-range` stays a `container-type: inline-size` query container for
the **status mark**, which hides itself below 23px (see below). It is safe,
because vis sets a range bar's width inline from its dates, so inline-size
containment has nothing to break (verified: it moves no bar by a pixel).
Milestones and boxes are deliberately excluded, since containment would cut off
content-sized items.

### The status mark

The rail's one **data** mark, as opposed to the delete affordance: it draws the
item's status on the bar (see „Item status" (docs/items.md) for which states earn one and why).
Two do, and they are mutually exclusive, so an item never carries two — `Done`
(a check, item painted lighter) or overdue (a warning triangle).

- **It is a pseudo-element off the item's own class** (`.status-mark::after`),
  not something `itemRail` paints. The rail's JS runs for the delete only, which
  is editable-only; a status mark is data and has to show on a read-only
  timeline and in the exported HTML too, so it comes from the class alone with no
  JS (the export inlines `timeline.css`, so the CSS is already there).
  It shares one declaration block with `.rail-delete` for the mark box and the
  glyph, so both sit in the same slot geometry and draw at the same weight.
- **`status-mark` carries the shared behaviour, a state class only its glyph.**
  Everything in this section keys on `.status-mark`; `.status-done` /
  `.status-overdue` set `--rail-mark-glyph` (plus, for done, its own paint). So a
  third state mark is a rule with a glyph plus a branch in `statusMarkClass`, not a
  round of selector surgery.
- **The delete replaces it, it does not join it.** Both sit in the rail's
  outermost slot; while the delete shows, the status glyph fades out and gives up
  its slot (`--rail-marks: 0`), so the rail — and the label's fade under it — is
  one slot wide in every state. Two marks side by side would eat twice the label
  for a state that lasts as long as the pointer rests there, and the status has
  nothing to add while you are reaching for the „×". The hand-over is gated on
  `:has(> .rail-delete)`: on a read-only timeline nothing replaces the mark, so
  hovering there must not drop it. The mark also needs `pointer-events: none` —
  a pseudo-element paints after the item's real children, so it would otherwise
  swallow the delete's click.
- **The class comes from `withStatusMarks(items, now)`**
  ([`src/buildItems.ts`](../src/buildItems.ts)), called by `timelineItems()`
  ([`src/render.ts`](../src/render.ts)) — the one seam every populate of the item
  DataSet passes through — and by the HTML export, which serialises its own payload
  and would otherwise ship unmarked bars. It cannot be stamped *during* the build:
  `assignLanes` owns `className` there and overwrites it on every regroup. A marked
  item therefore gets a **shallow copy** rather than a mutation, so the build's own
  items stay untouched and the persist diff never sees a display concern. „Now" is
  read once per populate, so every item in one repaint is judged against the same
  instant.
- **Done's „lighter" is `opacity` on the whole item**, ring and marks included,
  rather than a lightened fill — that would mean re-deriving all six lane colours,
  and a faded fill under a full-strength label reads as a rendering glitch. The
  delete's resting opacity is raised on a done item (`--rail-mark-dim`) so it lands
  at the same effective strength as on any other bar.
- **The overdue glyph is the only mark not in the item's text colour**: a warning
  that blends into the bar it is warning about is no warning, so it takes
  `--overdue` at full opacity. That token exists because `--warning` cannot serve
  here — the theme spends the same amber on `--lane-1-border`, which put the
  triangle at ~1.4 contrast on that lane's own bars. `--overdue` aliases
  `--danger`; no lane uses red, and the delete's red never shows at the same time
  (it replaces the mark).
- **vis copies an item's `className` onto its satellite elements**, so every rule
  here matches them too: the dot of a point/box item and a box's connector line are
  each their own `.vis-item.vis-dot` / `.vis-item.vis-line` carrying the same
  classes. A milestone therefore grew a **second** mark, on its dot — i.e. left of
  its label, since the dot sits at the item's left edge. One reset block kills both
  pseudo-elements on the satellites (and un-does the done fade there, which would
  otherwise multiply with the box's). Custom properties inherit, so a satellite
  would even pick up its box's `--overrun`.
- **Its glyph is `--ui-icon-warning`, a *filled* triangle of its own** — not an
  alias of the item icon `warning`, which is an outline. An item may carry that
  icon itself, and two identical glyphs on one bar read as a rendering bug; solid
  also suits a mark that is chrome rather than a label.
- **It is hidden on a bar narrower than its own box** (a container query, max
  `23px` = `--rail-mark` + `--rail-inset` + `--bar-gutter`). The delete may
  overhang a narrow bar because it shows while the pointer is on that bar, so it
  is obviously about it; a permanent mark on a sliver hangs past the bar's left
  edge and reads as a glyph floating in empty space next to it. Below that width a
  done bar's lighter paint carries the status, and an overdue bar's overrun line
  does. `.vis-item.vis-range` is the query container and a pseudo-element queries
  its originating element, so this needs no extra element.

### The overrun line

A range bar whose status is overdue grows a dashed run-on from its own end to
„now" ([`src/overrun.ts`](../src/overrun.ts) + the overrun block in
`styles/timeline.css`). The mark says *that* an item is late; this says *by how
much*, which is the part you plan around.

- **JS supplies only the length.** end→now is a duration, and how many pixels that
  is depends on the zoom — so the module sets one custom property per overdue item
  (`--overrun`) and CSS owns height, dash pattern, colour and opacity
  (`--overrun-h` / `--overrun-dash` / `--overrun-gap` / `--overrun-dim`). Length
  comes from vis's own `body.util.toScreen`, so the line ends on the same pixel as
  vis's current-time marker (the phaseBand note about re-deriving the mapping
  yourself applies here too). It re-measures on `changed` / `rangechange` /
  `rangechanged` — the same set as the phase ribbon, since every one of those
  changes px-per-ms — coalesced through a timer, not `requestAnimationFrame`
  (hidden tabs stop firing rAF; see itemPresence.ts).
- **It continues at the bar's mid-height**, so it reads as that bar running on past
  its end. Hanging it below the bar — in the gutter vis leaves between sub-lanes,
  where no bar paints — dodges the overlap problem for free, and was tried:
  detached from the bar's own line of sight it reads as a stray rule under the whole
  row, belonging to no bar in particular. The line's one job is to say „this bar is
  still running", so it stays on the bar's axis.
- **It is part of the item's footprint, so nothing can cover it.** If the line
  behaves like a bar, then bars and lines must not overlap — and that is a layout
  question, answered in the layout: `endMs` in `assignLaneSubgroups`
  ([`src/buildItems.ts`](../src/buildItems.ts)) reserves an overdue range's room out
  to „now", exactly as it already reserves a point item's label width. A following
  bar is then packed into the next sub-lane instead of landing on the line. The cost
  is honest and visible: a group with late items gains sub-lanes and gets taller.
  Items starting *after* „now" don't collide with the reservation, so they stay put
  and lanes aren't inflated needlessly.
  A `z-index` lift was the first attempt and cannot work: vis puts every item at
  `z-index: 1`, so two overdue neighbours simply tie and the later one still wins.
- **It is deliberately quiet besides**: 2px tall, fine dashes, half opacity, and
  no pointer events. It is context for a mark that already carries the state, not
  a second alarm.
- **Colour is `--overdue`, not `--warning`.** Same reason as the mark: the theme
  spends that amber on `--lane-1-border`, so an amber line disappeared wherever it
  ran past one of that lane's bars. `--overdue` aliases `--danger`, which no lane
  uses.
- **Ranges only.** A milestone has no extent to overrun, and vis sizes a point
  item's box to its label, so `left: 100%` there would start the line a
  label-width right of the date it belongs to. Those items keep the mark alone.
- **Shorter than one dash, no line** (`MIN_OVERRUN_PX`): a 2px stub at the bar's
  edge reads as a rendering artefact, not as a signal.
- **Not in the exported HTML.** The export ships its own small inline script, not
  this module, so `--overrun` is never set there and the line's width stays `0`.
  The status mark carries the state in an export; wiring the line in would mean
  re-implementing the time→pixel measurement inside the export bundle.

**Adding a mark.** Another *status* state needs no new selector: a class setting
`--rail-mark-glyph`, plus its line in `statusMarkClass`. A mark of a different
kind, sitting *beside* the status one, is more work: render it as an absolutely
positioned child of the `.vis-item` (or a pseudo-element of it), position it with
`right: calc(var(--bar-gutter) + var(--rail-inset) + <marks already inside> *
var(--rail-slot))`, raise `--rail-marks` on the item so the fade widens with the
rail, and add it to the occupancy/fade selectors — deciding whether it stacks
beside the delete or hands its slot over the way the status mark does. A data mark
cannot come from the vis `template`: that output lands inside `.vis-item-content`,
which is content-sized, so it cannot anchor to the bar's right edge. If it needs
behaviour (a click), it needs a real element from JS — the pattern in
[`src/itemPresence.ts`](../src/itemPresence.ts) / [`src/itemRail.ts`](../src/itemRail.ts).

## Milestone rail (the head of the timeline)

A row of diamonds sitting **on the axis line**, one per milestone
(`type: "point"`), each centred on its own date
([`src/milestoneRail.ts`](../src/milestoneRail.ts) + the milestone-rail block in
`styles/timeline.css`).

It answers a question the lanes cannot. A point item lives in its track's lane, so
reading the whole set of milestones means scanning vertically across every track —
and past a handful of tracks that means scrolling, at which point a milestone near
the bottom is simply missed. The rail collects them onto one row without moving
them off their dates.

- **Colour is the item's lane colour**, taken from the `lane-N` class
  `assignLanes` already stamps on the item, so a mark and the point it stands for
  read as the same thing. `className` also carries status marks, hence the lane is
  picked out of it rather than used whole. A build with no groups has no lane
  classes and the marks fall back to `--accent`.
- **Clicking a mark selects that item** — highlight, URL, presence, detail panel —
  through `selectItemById` in [`src/render.ts`](../src/render.ts), the same
  function the timeline's own `select` handler calls. The rail's whole point is to
  behave like the item it stands for; a second copy of those steps is how the two
  drift apart, and the ones that drift silently (a forgotten
  `publishSelfPresence`) only surface on somebody else's screen.
- **…and scrolls its row into view** (`scrollItemIntoView` in
  [`src/visGeometry.ts`](../src/visGeometry.ts)). From the rail this is the other
  half of the click: its marks stand for milestones the user cannot see, so
  opening a form for a row still off screen answers only half of it. Vertically
  only — the time window is left alone, because the mark was clicked at a position
  it already occupies and re-centring would slide every other mark out from under
  the pointer. That rules out vis's own `focus()`, which always calls
  `range.setRange()`, `zoom: false` included (that option preserves the interval
  *width*, not the position).

  Two details make it work. The item's **group label** is measured rather than the
  item itself: vis only mounts items whose row is on screen, so the one worth
  scrolling to is exactly the one with no box to measure, while labels are always
  mounted and the panels are in vertical lockstep. And the scroll is applied in up
  to four corrective passes, because `_setScrollTop` clamps against vis's record of
  the content height, which is refreshed in a *throttled* redraw — a single pass
  issued right after a selection can be cut short by a stale limit and land
  part-way.
- **The title lives in the tooltip**, together with the date. Labelling every mark
  inline was the alternative and costs a second row plus collision handling, for
  information the rail is not trying to carry: it says *which* milestones exist and
  *when*, and the item itself is one click away.
- **Coincident marks are fanned apart** (`spreadCoincident`). Two milestones on the
  same day land on the same x, and one diamond then hides the other completely — the
  rail would claim a milestone does not exist, which is the one thing it exists to
  prevent. Drawing at the exact x was tried first and rejected for that reason. A run
  is spread symmetrically **around its own centre**, not by pushing each colliding
  mark right: pushing right accumulates, so a dense cluster walks steadily off its
  dates and the drift grows with every member. The exact date stays in the tooltip,
  and zooming in separates the marks for real.
- **It reads the display set**, the same post-filter, post-regroup item list the
  timeline is fed, so it follows „Nur Meilensteine" and the value filter without a
  second derivation of what is visible. When a tag/custom-field regroup clones a
  multi-valued item across lanes, the clones collapse back to one mark.
- **Positioning goes through vis's own conversion**
  ([`src/visGeometry.ts`](../src/visGeometry.ts)), shared with the phase ribbon —
  re-deriving the time→pixel mapping from `getWindow()` and a border-box width
  drifts right of the items, further toward the right edge. It redraws on
  `changed` / `rangechange` / `rangechanged` plus a `ResizeObserver`.
- **A mark that would not fit whole is dropped**, rather than cut off at the
  panel edge. Nothing clips the rail any more (see „Where the rail is mounted"),
  so a half-drawn mark would hang over the group labels instead.
- **It is created with the timeline, not with the data.** The ribbon is built only
  when the source has phases; the rail cannot be, because its count changes with the
  *filter* — a view showing no milestones now may show some a moment later. So the
  rail always exists and hides itself while the count is 0, releasing the row
  reserve with it.

### Where the rail is mounted, and why it is not in the center panel

The line the marks sit on is the **top border of `.vis-panel.vis-center`**, the
rule under the date labels. A mark centred on it is half above and half below,
which decides three things:

- **The rail lives in `.vis-panel.vis-top`**, the axis panel, not in the center
  panel it annotates. The center panel clips to its own box (`overflow: hidden`),
  so a mark centred on its top edge would lose its upper half. The axis panel does
  not clip, and vis renders it *after* the center panel, so the lower halves paint
  over the content below the line. Both panels share a left edge and a width, so
  the x from vis's conversion carries over with no adjustment.
- **`top` is measured, not assumed.** The axis panel normally ends exactly where
  the center panel starts, so anchoring the rail to `bottom: 0` would do — but vis
  positions the center panel from its *own* measurement of the axis, and anything
  that nudges that measurement parts the line from the panel edge with no visible
  symptom except marks floating beside the line. `alignToLine()` therefore reads
  the line's position on every redraw.
- **The date labels are lifted 8px by a `transform`.** They ended flush against
  the line, so the marks' upper halves ran straight through them. A transform is
  the only shift vis cannot see: it derives the axis height, and from it the center
  panel's offset, by measuring the label boxes, and `offsetHeight` ignores
  transforms. `margin-top` was tried first and fed straight back into that
  measurement (the center panel then sat 12px above where the axis panel ends);
  `padding` fails the other way, since vis never re-measures it and the box simply
  grows down through the line. The lift fits in the ~22px vis already leaves above
  the major label, so nothing is pushed out of the axis.

**Vertical room below the line.** Only the marks' lower halves reach into the
content, so the rail's row reserve is 12px, against the ribbon's 30px. Both are
padded onto the group set — `margin.axis` only offsets the first *item*, which
leaves an empty parent/nested group header sitting behind the band — and the
padding is the **sum** of the two (`--phase-band-h` + `--milestone-rail-h`), so
they stack instead of one landing on the other. The ribbon's own `top` reads
`--milestone-rail-h` for the same reason.

That padding goes on `.vis-itemset > .vis-foreground`, never a bare
`.vis-foreground`: the time axis carries that class too
(`.vis-time-axis.vis-foreground`). The unscoped selector padded the axis panel by
the same amount, leaving it reaching that far past the line — invisible on its own,
since the panel is transparent and its labels hang from the top, but vis's axis
measurement does not include the padding, so the line and the panel edge drifted
apart by exactly the reserve.

## Item context menu (right-click quick actions)

Right-clicking an item on the timeline opens a small menu of the actions worth
having without the detail form open: **Status**, every **custom field that opted
in**, **Duplizieren**, **Löschen**. It lives in
[`src/contextMenu.ts`](../src/contextMenu.ts) with its styling in
[`src/styles/menu.css`](../src/styles/menu.css).

**Value pickers are submenus, one per field; the root menu holds only nouns and
the two verbs.** Status alone was three flat rows, and one opted-in field turned
the root into a wall of values in which „Löschen" was just another line. Behind
submenus the root stays the same size however many fields opt in, and each panel
marks the item's current value(s):

```
Status       ▸        (● Open · Doing · Done)
Version      ▸        (kein Wert · 1.0 · 2.0 · …)      ← a field that opted in
Tier         ▸        (☑ Free · Starter · ☑ Scale · …)
──────────────
Duplizieren
Löschen
```

A root row's mark is the item's **current** value when the field has exactly one
(the status dot, a single-select's colour dot) and blank for a multi-select, where
there is no single value to show. Submenu rows are `menuitemradio` for a single
choice and `menuitemcheckbox` for a toggle, so the role itself says whether picking
replaces or adds.

**Which fields appear is per-definition opt-in:** `def.contextMenu` on a custom
field (see „Custom fields → Quick-editable from the context menu" (docs/items.md)). Off by
default — a menu of every field would defeat the point of a *quick* action.

**The trigger is vis-timeline's own `contextmenu` event**, not a DOM listener of
our own. vis hands the callback `getEventProperties()` — the display id under the
cursor plus the raw event — so nothing here walks the DOM looking for a
`.vis-item`. (itemRail.ts *has* to delegate a click listener, because a rail
*mark* is not a vis concept and vis cannot resolve one; an item is.) A right-click
that lands on the rail's own „×" still resolves to its item. vis does not suppress
the browser menu itself (its `oncontextmenu` only emits), so `preventDefault()` is
ours — and it is called **only once the click is known to have an actionable
item**: on empty space, on an axis, on a phase tint (no row in the source file) or
on a read-only view the browser's own menu is left intact rather than being
replaced with nothing.

- **The menu is built per open**, not created once and reused: which status row
  carries `aria-checked` is a property of the item that was right-clicked.
- **The mutations are not in this module.** They are passed in from render.ts the
  way the rail takes its `deleteItem`, so each lives beside its peers:
  `setItemStatus` / `setItemFieldValue` next to `deleteItem` in
  [`src/itemForm.ts`](../src/itemForm.ts), `duplicateItem` next to `createItem` in
  [`src/render.ts`](../src/render.ts). Delete routes through the *same* `deleteItem`
  the rail mark and the form button use — one delete flow, not three.
- **This module knows nothing about field types.** Which definitions qualify is
  `contextMenuFields()` in [`src/customFields.ts`](../src/customFields.ts), beside the
  rest of the per-type field semantics — that is also where `text` is filtered out
  whatever it declares, since a menu can only offer fixed rows and free text needs
  a keyboard.
- **A single-select stores a scalar, a multi-select an array** — the same shapes
  the form's `<select>` / chip editor write, so a value set from the menu round-trips
  through `metadata[key]` identically. A single-select carries a „kein Wert" row
  (the empty choice its `<select>` has); a multi-select clears by untoggling.
- **A multi-select keeps its panel open between picks** and re-marks the clicked
  row from the values the mutation returns; everything else closes first. Picking
  three tiers shouldn't mean reopening the menu three times, while delete raises a
  `confirm()` the menu must not sit over.
- **An emptied field loses its key, and an item with none left loses `metadata`.**
  Same rule as `applyItemForm`, and load-bearing for the same reason: the persist
  diff sends a missing clearable field as an explicit `null` (`buildItemPatch`), or
  the old value comes back on reload. The one exception is a collection that was
  *stored* empty (`"dependsOn": []`, `"metadata": {}`): both spellings mean the
  same thing, so rewriting one into the other is not an edit, and doing it anyway
  turned every click on such an item into a diff — see `writeListMeta` in
  [`src/fieldValue.ts`](../src/fieldValue.ts).
- **A status or field change has to re-render an open form**, and that is
  correctness, not polish: the form's pickers keep their values in hidden inputs,
  so a form still open on that item would hold the *old* value in its `FormData`
  and the next `commitItemForm` would write it straight back over the change. Both
  mutations therefore call `showItemForm` when the form is on that item, exactly as
  `handleMove` does after a drag.
- **No `markSelfEditing()` on a status change.** Presence attributes activity to
  the item the open form / selection points at, and a right-click does not select
  — so on an unselected item it would flag the wrong item as being edited.
  Marking the right one needs the presence activity model to carry an explicit
  item, which is a separate change.
- **Duplicate** drops the server-managed fields (`version` + the audit stamps), so
  the persist diff sees an id it has never saved and POSTs a new row instead of
  PATCHing over the original, and deep-clones `metadata` (a shared object would
  make a later edit to either copy change the other). The copy is placed clear of
  its original — a bar starts where the original ended, anything without an extent
  shifts by a day, a date-less item stays date-less — at day granularity, like
  every drag. Its form opens with the title focused, which is why the content is
  copied verbatim rather than suffixed.
- **The status dot is the global `.status-dot`** from
  [`src/styles/forms.css`](../src/styles/forms.css), deliberately un-scoped from
  `.detail-tools` when this menu arrived: two copies of the value→colour mapping
  is how one of them ends up stale after a change to `--status-*`.
- **Dismissal** is Escape, a pointerdown outside, a wheel, a window resize, and
  the timeline's own `rangechange` (panning would slide the bar out from under a
  menu anchored to viewport coordinates). Document-level listeners live only while
  the menu is open. Escape backs out **one level** when a submenu is open, and that
  check lives in the *document* handler rather than the menu's: the document one
  captures, so it runs first and would otherwise dismiss everything from inside a
  submenu.
- **Keyboard** navigation is per level — arrow keys move within the open panel when
  focus is inside it, the root otherwise. ArrowRight/Enter opens a submenu and
  focuses its first row, ArrowLeft closes it and returns to the parent row, Tab
  closes rather than trapping focus, and closing hands focus back where it came
  from.
- **Positioning** is viewport coordinates on `<body>`, so panels can overhang the
  timeline's scroll panes instead of being clipped by them. The arithmetic is
  DOM-free in [`src/menuPosition.ts`](../src/menuPosition.ts) and unit-tested
  (contextMenu.ts imports `state`, which touches `document` at load, so nothing in
  it can be pulled into a test): the root menu is clamped horizontally and flipped
  *up* on bottom overflow; a submenu goes right of its parent, flips left when
  there is no room (never into negative x), and slides up rather than flipping,
  because its top edge is tied to the row it belongs to. Submenu panels are DOM
  children of the menu — which is what keeps `menuEl.contains()` true for clicks
  inside them, so they don't read as a dismissal, and removes them with the parent.

**Adding an action** is an entry in `menuHtml` plus a handler in
`ItemMenuActions`; put the mutation itself next to its peers rather than in this
module. **Adding a value picker** needs no menu change at all — flag the field
`contextMenu: true`. Scope is the timeline view; the list view has no context menu.

## Editing JSON timelines

When the active view points to a **DB-backed** source (the timeline exists in Supabase, so `GET /api/source/<id>` returns it), the viewer is editable. A **local** source (a `data/*.json` file, or a directory of Markdown notes) is editable when a process with filesystem access serves it, which means the dev server; editing a directory patches the individual notes' frontmatter and moves a deleted one to `.trash/` rather than removing it; on a static deploy the same file loads read-only, because there is nothing there to write with. Whether the running build is one or the other was decided when it was built (see „Source kinds" (docs/architecture.md)).

- **Drag** an item left/right to move start, drag either edge to resize, drag vertically to switch group. Persists on drop. Both handles sit on the bar's edge; the right one is the narrower of the two because it shares that edge with the rail's „×" (see „Item rail"). Dragging an item that has children onto another track takes its subtree along, and so does the form's **Group** control — see „Parent and children" (docs/items.md) for what „its subtree" covers.
- **Delete** an item via the „×" mark at the bar's right edge, which appears on hover and while the item is selected — inside the bar on a bar wide enough for it, just outside on a narrow one. Clicking it neither selects the item nor opens its form. See „Item rail".
- **Right-click** an item for quick actions without opening the form: set the
  status, set any custom field that declared `contextMenu: true` (each a submenu of
  its options), duplicate the item, delete it. Read-only views keep the browser's
  own menu. See „Item context menu".
- **Double-click** on empty timeline space to add a new item (defaults: 1-week duration, current group, content "Neuer Eintrag"). Form opens for further edits. The **+ Eintrag** toolbar button (editable views only) does the same, placing the item at the centre of the visible window. In **list mode** a new item (toolbar or per-section button) is created **date-less** — empty start/end/duration — so it starts as a clean row to fill in via the form; it stays list-only until a start is set.
- **Click** an item to open the edit form in the side panel. The title is edited
  in the panel headline and the icon/type/status trio sits in the header row above
  it (both outside the tabs, see below); the remaining fields are split across
  three tabs ([`src/itemForm.ts`](../src/itemForm.ts), `FORM_TABS`), with the Delete
  button + audit footer below the tabstrip so they stay reachable from any tab:
  - **Properties** — group, owner (a user picker, see „Item owner" (docs/items.md)), body
    (Markdown), tags, and the per-timeline
    custom fields. The free-form metadata JSON box sits behind an „Erweitert"
    `<details>` disclosure, collapsed unless the item actually carries extra
    metadata.
  - **Date & Time** — start, end, duration (a Meilenstein has no extent, so
    picking that type mutes end/duration). The two date pickers are bounded
    against each other so they can't cross, and a reversed pair typed in anyway is
    refused with a status-line message — see „An item's `end` must lie after its
    `start`".
  - **Relationships** — containment (`parent`), dependencies (`dependsOn`) and
    JIRA links.

  All panels stay in the DOM (inactive ones just `hidden`), so `FormData` keeps
  seeing every field and `applyItemForm` / the persist diff need no knowledge of
  the tabs. Tab-strip order and panel order in the markup are kept in sync, since
  roving-tabindex and reading order both follow the DOM. The chosen tab is
  remembered across item switches (module-level `activeFormTab`, which starts on
  Properties — the leftmost tab — and is not persisted across reloads). Save
  writes back; Delete removes the item.

  **The panel headline IS the title editor.** The form used to repeat the title
  in a labelled input directly under the heading — the same string twice, one of
  them costing a row. The `<h2>` is now `contenteditable` for an editable item
  (`setDetailTitle` / `focusDetailTitle` in
  [`src/detailPanel.ts`](../src/detailPanel.ts), the single entry point every panel
  uses for the headline, so a read-only note or a phase form resets the editable
  state). The form keeps a hidden `content` input, so `applyItemForm` and the
  persist diff read the title out of `FormData` unchanged; typing writes into it
  and dispatches a bubbling `input`. Enter and Escape blur (a title is one line),
  and because the headline sits outside the form its `blur` commits explicitly —
  the form's own `focusout` never fires for it.

  Two headline entry points, and the distinction matters: `setDetailTitle` is for
  **switching what the panel shows** (it also resets the editable state and
  clears the header tools row), `setDetailTitleText` is for **syncing the caption
  during an edit** (text only, and a no-op while the headline has focus — setting
  `textContent` under the caret would throw it back to the start of the line).
  Routing the in-edit sync through `setDetailTitle` wiped the picker row on every
  keystroke, and since the pickers own form-associated hidden inputs, `FormData`
  then lost `icon` / `type` / `status` and the next edit reset the status to its
  default. `applyItemForm` therefore also only touches those three when
  `fd.has(...)` — a missing key means "control not in the DOM", not "user cleared
  the field".

  **Icon, type and status share one control** (`PickerSpec` / `pickerHtml` /
  `wirePicker` in [`src/itemForm.ts`](../src/itemForm.ts)): all three are "pick one
  value from a small fixed set", and as labelled `<select>`s they cost a full
  field row each while showing German words for something visual. Each is now a
  30px trigger button displaying the current value's **mark** — the icon glyph,
  the temporal shape (diamond = Meilenstein, bar = Zeitraum, dashed band =
  Phase), the status colour dot — that opens a popover with the choices (a
  mark-only grid for the 19 icons, mark + label rows for type and status).
  Adding a fourth such field is a new `PickerSpec` plus a `wirePicker` call.

  The trio lives in the **panel header** (`#detail-tools`, filled by
  `renderPickerTools`, laid out in [`src/styles/detail.css`](../src/styles/detail.css)),
  on the close button's line and above the headline: it costs the form no row,
  sits outside the tabs, and the sticky header keeps it in place while the body
  scrolls. That puts it *outside* the `<form>`, which makes two details load-
  bearing: each hidden input carries `form="item-form"` (a form-attribute-
  associated control is still part of `FormData`, so `applyItemForm` keeps
  reading `status` / `icon` / `type` exactly as it did with the selects), and
  picking calls `scheduleLiveEdit()` directly — an event dispatched in the header
  bubbles up the header, never reaching the form's listener.

  **Panel height is the scarce resource** in this form, so it is spent on fewer
  rows rather than on tighter ones: the rows that remain are deliberately airy
  (16px between fields, 4px between a label and its own control — the air goes
  *between* fields, not inside them), and the height comes back by removing
  fields instead. Every chip field (tags, custom multi-selects,
  dependencies, JIRA) renders its chips and its search input inside **one**
  bordered `.chip-box` that reads as a single control
  ([`src/styles/chips.css`](../src/styles/chips.css)) — that frees a row per field
  and lets a chip field sit at half width beside another one. **Tags spans the
  full width** (`.field.full`) even so: a chip row fills up fast, and at half
  width it wrapped into a second line after two or three tags, costing back the
  row the `.chip-box` had just saved. Custom multi-selects stay at half width.
  The Markdown body
  grows from a low floor instead of reserving a screenful
  ([`src/styles/wysiwyg.css`](../src/styles/wysiwyg.css)), and the read-only item
  **id** lives in the audit footer (`auditBlockHtml`) instead of a labelled
  input, being metadata of the same category as the created/updated rows. Unlike
  those rows the id renders in every environment, not only on localhost.

  **Focus tints, it does not frame.** Focusing a field, a chip box, the body
  editor or the headline recolours its border (the headline: a background tint)
  instead of drawing the former 2px accent ring, which read as a heavy frame
  around everything you touched. Buttons — tabs, pickers — keep a real ring, but
  only on `:focus-visible`, where there is no border to recolour.
- **Übergeordnet** is the same autosuggest, single-valued: pick the item this one is part of (`metadata.parent`). The suggestions leave out the item itself and everything already below it — offering a pick that the build would then drop as a cycle looks exactly like a pick that did not register. Filling it hides the input behind the chip; removing the chip brings it back. Directly under it, **Untereinträge** lists the children as read-only chips, plus a line wherever they run outside the parent's own dates: the parent's dates stay authoritative and nothing is rewritten. See „Parent and children" (docs/items.md).
- **Depends on** is a title-autosuggest field: type to search the current timeline's items by title (or id), pick to link a dependency (rendered as a removable chip). Stored as `metadata.dependsOn` IDs — the chips just show the target's title.
- **Tags** is a chip editor with autosuggest: type to match tags already used in the timeline, or type a new label and press Enter to create one. Each chip carries its resolved colour and a remove button. Stored as `metadata.tags` (string[]); saving migrates any legacy singular `metadata.tag` into the array.
- **Phases** render as a ribbon along the top. Drag a segment to move it, drag either edge to resize (snaps to whole days, min. 1 day), and click it (without dragging) to open the phase form in the side panel: title, start/end, duration, icon, colour. Persists on drop / Save; Delete removes the phase.

**Opening an item's form is a read.** Leaving the panel commits it — on
`focusout`, on switching to another item, on closing, on a view switch, on
unload — and `commitItemForm` runs `applyItemForm` whether or not anything was
typed. So every value the form *displays* on behalf of an absent one has to stay
out of the model, or the commit invents an edit and the persist diff faithfully
writes it: on a JSON source the file gains a field on every click, on a DB source
the same no-op bumps `version` and re-attributes `updatedBy`. Four of these were
live at once — a defaulted `status`, a `<select>` with no empty option putting
its first group on a group-less item (and silently reassigning a dangling group
id), `DEFAULT_EXTENT` on a stored-extentless range, and an empty `dependsOn` /
`metadata` losing its key. The rule the fixes share: a default is applied for
display only, and a stored spelling of "nothing" is left exactly as it is.
`statusToStore` ([`src/status.ts`](../src/status.ts)) and `writeListMeta`
([`src/fieldValue.ts`](../src/fieldValue.ts)) carry the two halves that are worth
unit-testing; the other two are guards inside `applyItemForm` /
`buildGroupOptions`. The seeding that stays is the one a *change* triggers:
emptying a range's extent still re-seeds `DEFAULT_EXTENT`, because a range
without one vanishes from the timeline.

  The strip the ribbon sits in is reserved by an **empty group** prepended to the group set (`BAND_SPACER_GROUP_ID` in [`src/render.ts`](../src/render.ts)), which is why the DataSet carries one row nobody can put an item in. It looks removable and is not: reserving the strip with CSS padding instead is invisible to vis, which derives its content height *and* its vertical scroll range from the sum of the group heights — the panel then holds more than vis knows about, scrolling stops short by the height of the reserve, and `.vis-timeline` (fixed height, `overflow: hidden`) cuts off whatever hangs below, always the last track. Two details in the spacer are load-bearing and commented where they live: it is added after filtering and lane assignment, and its height comes from a strut inside its label rather than from a `height` rule on the row.

Persistence path: viewer → item-level calls (`POST/PATCH/DELETE /api/source/<id>/item`, `PUT …/phases`) → middleware (`vite.config.ts`) → Supabase via `scripts/db/api.ts`. `PATCH` carries the item `version` in `If-Match`; a stale version returns `409` and the client reloads that item. Only DB-backed sources are editable; genuine file-based sources (the examples) load read-only from their static `/data/sources/<id>.json`. Builds (`npm run build`) and exported HTML have no edit endpoint. DB-backed timelines are discovered from the DB at build time (`collectDbSources`); the registration **stub** (`name` + `items: []`, no content) is written only to the gitignored build output `public/data/sources/<id>.json` — nothing DB-backed is committed, and there is deliberately no committed content cache (see „Principle: no emergency or fallback data").

### Why a track reserves its height

Scrolling a dense timeline used to shuffle it vertically: tracks changed height,
rows moved, and the total content height oscillated. Two independent causes, both
measured on a six-track, 84-item timeline.

**vis derives a track's height from what it has drawn.** `Group._calculateHeight`
runs over `visibleItems`, so a track whose items all sit outside the current time
window collapses to its label height and every track below it jumps up. In one
window holding seven and six items respectively, two tracks rendered *zero* items
and stayed at 28px, while a third still showed eleven with only two in the window:
`Group._redrawItems` only restacks a track while it is inside the vertical viewport
(`isVisible && !lastIsVisible`), so a track outside keeps stale items and a stale
height until it is scrolled into view, and then pops. Directly after load the
content measured 1050px; a later redraw with no input at all made 560px of it.

That behaviour is right for the mode vis was written around, where `stack: true`
resolves overlaps among the items on screen and vertical position is a function of
the window. This viewer runs the opposite mode: `stack: false` with lanes
precomputed into `subgroup` (`assignLaneSubgroups`), so an item's row follows from
the data. vis has no concept for „this lane exists regardless of what is visible",
so the reservation is made where vis does take a number from us: **the group label**.
`_calculateHeight` ends in `Math.max(height, props.label.height)` and falls back to
the label height when nothing is drawn, so a label that is `lanes × lane pitch` tall
pins the track. `laneCountStyle` publishes the lane count as `--lanes` on the group
(`DataGroup.style`, a documented property), `timeline.css` turns it into a
`min-height`, and `--lane-pitch` is measured from a rendered bar rather than written
down twice. The phase-band spacer above already works this way.

The cost is the one the overrun line already pays: a track is as tall as its densest
stretch needs, so a sparse window shows empty rows. That is the trade for a layout
that does not move, and it is visible rather than hidden.

**Zoom re-packed more than it had to.** A point item reserves its label width
translated through px/day, so every zoom step could reassign lanes — and packing
from scratch moved items that had no reason to move. `packBand` now prefers the lane
an item already sat in whenever that lane is still free, which costs nothing: with
items processed in start order and a new lane opened only when every existing one is
busy, the lane count is the widest overlap no matter which free lane is picked.
`packingPxPerDay` additionally snaps the density to quarter-octave steps, rounding
*down* so the reserved width errs generous and the snapping can never let two labels
overlap.

**The reservation covers a neighbourhood, and how it is measured is the whole
point.** Reserving for every lane a track needs anywhere makes it as tall as its
densest stretch for good, and on a 131-item roadmap that turned a screen holding
fourteen tracks into one holding two. Reserving for the visible window instead puts
the jumping back, since the reservation then moves with every pan. So `repackLanes`
packs the items reaching into a neighbourhood around the window and leaves that
stretch alone until the window travels within half a margin of its edge
(`reservationFor`).

The margin is `max(2 × window width, one year)`, and the second term is what a first
version lacked. With the margin in window widths alone, a two-month zoom re-centres
after a month of travel, which in use is constantly — that version was built,
measured, reverted, and only then reinstated with the floor. Expressing the margin as
a *duration* keeps the re-centre rare at every zoom level, and it degrades the right
way: on a roadmap shorter than the neighbourhood it collapses to reserving for the
whole timeline, which is the behaviour that never moves at all.

Measured at a two-month window. On a one-year roadmap: identical to reserving
globally, 2796px, and 0 items moved across 32 pan steps in three step sizes. On a
four-year one: 1260px against 2394px reserving globally, three months of travel in
weekly steps moves nothing, and travelling all four years in 60-day steps re-centres
nine times over 24 steps, each time by one or two lanes. Occasionally, in other words,
and in proportion to how far you went.

`RESERVE_MARGIN_WINDOWS` and `RESERVE_MARGIN_MIN_MS` are the two halves of that knob.

**A re-centre still moves items it could leave alone.** It changes which items are
packed, and a newcomer with an earlier start is placed before the incumbent that
remembers the lane, so it can take it. Placing all remembered lanes first and only
then filling the rest would fix it, at the risk of costing a lane where a
rearrangement would have fit — not attempted yet.

**Zoom reflows.** The lane count legitimately follows the reserved label width, and a
fresh reservation reaches the track one redraw late, because vis measures the label in
`_didResize`, which its redraw queue runs *after* the `_calculateHeight` that consumes
the measurement. `repackLanes` schedules a redraw on the next frame for it; two calls
in one tick collapse into one and do not help.

## View modes: Timeline / Liste

The header **Ansicht** icon toggle (a segmented two-button control, styled in
[`src/styles/base.css`](../src/styles/base.css) as `.mode-toggle` / `.mode-btn`,
active state driven by `aria-pressed`) switches between two renderings of the
*same* active build:

- **Timeline** — the vis-timeline (default).
- **Liste** — a scrollable, grouped table ([`src/listView.ts`](../src/listView.ts)):
  sections along the active **grouping dimension** (items sorted by start),
  with columns Eintrag (icon + tag pills + content), Start, Ende, Typ, Status,
  Owner. Phase background items are omitted. The milestones-only filter applies
  here too. Children follow their parent, indented one step per level, with the
  same fold caret the timeline's summary bars carry (see „Parent and children"
  (docs/items.md)) — a section that has no tree in it reserves no caret column at
  all, since an indent only some rows take reads as a rendering bug rather than
  as a level. A section can hold a child whose parent fell outside it (they carry
  different tags, say); that one stays at the top level rather than disappearing.

**Stored backgrounds stay editable.** vis-timeline deliberately gives a
`type: "background"` item no selection target, because the library treats it as
decoration. Zeitlines uses that type for two different things: generated phase
tints (`.phase-bg`) really are decoration, while a stored background is a real
entry such as an absence or a blocking interval. `backgroundItemSelection.ts`
marks only the latter after vis mounts it and delegates click/Enter/Space to the
same `selectItemById` path every other item uses. The full-height rendering is
therefore preserved without making phase tints editable.

Their labels reserve lanes too. The display model splits a stored background
into its full-height tint and a foreground-only label range. Every label shares
one header subgroup; ordinary bars start in the subgroup after it. Overlapping
tints stack in depth instead of pushing their titles onto separate rows. The
upper layer is progressively lighter (35%, 25%, 15%, then a 12% floor), so the
overlap remains legible without making the header taller. The title itself has
no fill of its own; it sits directly on the full-height tint. Its display extent
is subtracted from every higher phase, so the lower title ends where the upper
phase begins instead of leaving two label boxes geometrically overlapping. This
makes the clearance structural rather than a CSS translation. Like an ordinary
range bar, the title stays clipped to its own date span. The label-derived
group-height floor includes both the header and item rows, so it does not
reintroduce the vertical jumping described in „Why a track reserves its height"
above.

### Loading placeholder

Until a source has been fetched, the timeline area carries a placeholder drawn by
[`src/timelineSkeleton.ts`](../src/timelineSkeleton.ts): a label column, an axis,
and staggered bars and milestone dots in the lane colours. It goes up in
`bootstrap()` (before the config is even in) and again at the top of
`renderTimeline()`, and comes down the moment the vis-timeline is constructed, so
the config fetch and the source fetch read as one wait rather than two.

Three of its properties are load-bearing, and each replaces something that was
visibly wrong without it:

- **It previews the structure rather than spinning.** What it replaces is an
  empty white area, which says „this timeline has no items" instead of „still
  loading"; the only signal to the contrary sat in the footer status line at the
  other end of the window.
- **It stays well below item fidelity, on purpose.** Borderless pills in a
  heavily diluted lane tint, on a grid drawn in `--grid-line` rather than
  `--border`. A first version painted the bars the way real ones look — lane
  background, lane border, 2px corners — and it read as a timeline that had
  finished loading, which starts the eye looking for labels that are not there.
  All the placeholder owes the user is the rhythm and the lane colours; the
  dilution is one number in `.tl-skeleton-bar`.
- **It is an opaque overlay above the outgoing timeline** (`z-index: 11`,
  `.tl-skeleton` in [`src/styles/base.css`](../src/styles/base.css)), not a
  sibling. A view switch destroys the previous timeline only *after* the new data
  has arrived, and `.vis-timeline` opens no stacking context — so without that
  z-index the previous view's dependency arrows draw straight through the
  placeholder.
- **It comes down on failure too.** Both load paths remove it before they report
  the error, because a placeholder that outlives its load keeps promising a
  timeline that is not coming.

### Shared toolbar: Gruppieren + Filter

A single toolbar (`#view-toolbar`, styled `.view-toolbar` in
[`src/styles/base.css`](../src/styles/base.css)) sits above **both** the timeline
and the list (in the shared `.content-area` column, left of the detail panel)
and is identical in either mode — hidden when a plugin view is active, since
grouping and filtering apply to items and a plugin view renders something else.
It holds two
controls that drive both views from one shared state; the app-state-aware glue
lives in [`src/grouping.ts`](../src/grouping.ts), the pure sectioning stays in
[`src/listGrouping.ts`](../src/listGrouping.ts) (`computeSections`, unit-tested in
`src/listGrouping.test.ts`).

- **Gruppieren** (`#groupby`, `state.groupBy`, persisted per timeline, see „Where
  the display state lives") chooses the dimension: **Gruppe** (default, the item
  group — build order preserved), **Tag** (offered when anything is tagged, from
  `metadata.tags`), **Status** (offered when any item carries one — see „Item
  status" (docs/items.md)), and one entry per **custom field** (e.g. **Tier**, from
  `metadata.<key>`). Multi-valued dimensions (tags, `multi-select` fields) place
  an item under *every* value it carries; items without a value land in an
  "Ohne …" bucket. A dimension that declares its values up front is ordered by
  that declaration — `Open → Doing → Done` for status, the field's `options` for a
  custom field — everything else by first appearance. Falls back to Gruppe when
  the chosen dimension isn't available on the active build.

  Status is deliberately offered on evidence rather than always: a file-based
  source has no status concept, so the dimension would collapse to a single "Ohne
  Status" bucket. For the same reason an item without a *stored* status buckets as
  "Ohne Status" and not as `Open` — it only *displays* as `Open` (see „The default
  is shown, not stored" (docs/items.md)), and filtering for `Open` must not sweep
  those in.

  In the **list** these are the table sections. In the **timeline** they are the
  vis lanes: for a non-Gruppe dimension the build is *regrouped*
  (`regroupForTimeline` in `grouping.ts`) into one lane per value, and a
  multi-valued item is **cloned into each lane** (the first clone keeps the real
  id; extras get a `<id>␟<n>` id). Display↔real id maps
  ([`src/render.ts`](../src/render.ts)) map a clicked/dragged clone back to its real
  item and highlight all clones of a selection at once. While regrouped, the
  lanes are derived values, so vertical group-drag (`updateGroup`),
  double-click-add and dependency arrows are suppressed; horizontal move, resize,
  delete and click-to-edit keep working on the real item. Lane assignment
  (`assignLaneSubgroups`/`assignLanes`) and repacking run on this display set.

- **Filter** ([`src/filterControl.ts`](../src/filterControl.ts)) narrows the visible
  items. It is **independent** of grouping: a dimension `<select>` (`#filter-dim`,
  same categories as Gruppieren, plus an "Aus" option) selects *what* to filter
  on, and a popover checklist (`#filter-menu`) of that dimension's values selects
  *which* to keep. An item passes if it carries a selected value (the "Ohne …"
  bucket, `NO_BUCKET`, is selectable to keep value-less items); an **empty
  selection means no restriction**. Persisted per timeline (see „Where the display
  state lives"); a stored dimension that no longer exists on this timeline turns
  the filter off. The filtering itself lives in `filterBuildForDisplay`
  ([`src/render.ts`](../src/render.ts)) via `passesFilter`, so every consumer
  (timeline, list, export, status line) honours it from one place, composed with
  the milestones-only toggle; empty lanes are pruned once by `pruneGroupsToItems`.

The per-section "+ Eintrag" button (list) shows only in the Gruppe dimension (it
pins the new item to that group).

Both modes share all state and machinery: the timeline instance stays alive
(just hidden) in list mode, so drags, the detail/edit form, and persistence keep
working. Clicking a row opens the same detail panel (or edit form on editable
sources), tracks the selection, and highlights the row — identical to selecting
a timeline item. Edits (form, add, delete) repaint the list live via
`applyBuildToDataSets`. The mode persists per timeline (see „Where the display
state lives") and in the URL hash (`mode=list`), so list views can be
deep-linked and survive reload.

### Where the display state lives

Presentation, grouping dimension, value filter and the milestones narrowing are
stored **per timeline**, in one `localStorage` key holding
`{ [viewId]: … }` ([`src/viewPrefs.ts`](../src/viewPrefs.ts), swapped by
`loadViewPrefs` and written by `saveViewPrefs` in
[`src/state.ts`](../src/state.ts)). Each of them says how *one* timeline is being
looked at, and each used to be a single key for the whole instance, so switching
timelines carried a filter into a timeline it was never meant for. The shape
follows the fold store (`COLLAPSED_ITEMS_KEY`), which had already solved this for
folded items.

Three consequences worth knowing:

- **The guards stay, and their reason changed.** A stored dimension that no longer
  exists still turns the filter off, and an unavailable grouping dimension still
  resolves to `Gruppe`. That now covers a timeline changing under its own stored
  state (a custom field was removed), never another timeline's dimension.
- **The resolved fallback is not written back.** `resolveGrouping` derives it on
  every render, and `state.groupBy` keeps the user's choice. Storing the fallback
  instead meant that a filter which left no tagged item flattened the grouping to
  `Gruppe` permanently, so clearing the filter did not bring it back.
- **A link outranks the stored state, and how much it outranks depends on the
  path.** On load, only the parameters the link actually carries win, so a link
  without `mode` opens the timeline in the presentation it remembers. A hash
  change inside the running app (back/forward, a pasted link) is authoritative
  about all of it, absences included, which is what makes back reverse a
  narrowing rather than leave it standing. The result is stored on the timeline
  that was opened.

The five instance-wide keys this replaces (`timelines.viewMode`,
`timelines.listGroupBy`, `timelines.filterDim`, `timelines.filterValues`,
`timelines.milestonesOnly`) are read once, to seed the first timeline opened after
the update, and then removed. Dropping them without that read resets every user's
saved view, grouping and filter, which is the trap
[`AGENTS.md`](../AGENTS.md) names for the `timelines.*` prefix.

## URL state

Selected view, opened item, visible time window, milestones-only filter, and the
view mode are encoded in the location hash so links can be shared and
back/forward navigation works. Format:

```
#view=<id>&item=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&m=1&mode=list
```

Only non-default values are written (`mode` only when `list`). Switching views
via the dropdown clears `item` and `from`/`to`. Hash changes from outside the
app (paste, back/forward) re-apply state without reload.

`from`/`to` are calendar days like every other date the app stores, so they are
read as **local** midnight — via `parseUrlWindow`, which both the initial load and
the hashchange handler go through so the rule keeps living in one place. `new Date`
would read a bare day as UTC midnight and open the window a timezone offset away
from the days vis-timeline places items on. A value carrying a time component is
still accepted and resolves to that instant, which keeps older shared links valid.

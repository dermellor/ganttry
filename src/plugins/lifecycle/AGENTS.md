# Lifecycle

Conventions for changing **this plugin**. Rules that apply to the whole codebase stay in
the root [`AGENTS.md`](../../../AGENTS.md); what a reader needs in order to *use* the
plugin is in [`README.md`](README.md), which is also its public page.

## Invariants

- **No verb writes a vendor date.** `endOfSupport` and `extendedUntil` are inputs and
  nothing but inputs, and neither appears in any tool's `inputSchema`
  (`manifest.test.ts` holds that line). A verb able to move end of support could make a
  late plan look on time, which is the one failure this plugin exists to prevent.
- **No rule derives one lifecycle date from another.** Extended support is taken as a
  date or not at all. The temptation is a rule like „extended support runs three years
  past end of support"; there is no such rule, because the terms have no industry-wide
  definition and what a vendor provides differs per vendor. A derived second date would
  be untraceable and trusted.
- **No default for `minParallelRunDays` or `defaultLeadTimeDays`.** Absent means the
  rules report that they cannot answer. The sources disagree by an order of magnitude,
  so a default would be this plugin inventing a domain rule that every plan then
  inherits silently. `manifest.test.ts` asserts the absence of a `default` keyword,
  because adding one is a one-word change that looks like a convenience.
- **`plan_cutover` moves a blocked cutover EARLIER; `shift_out_of_freeze` moves it
  LATER.** That asymmetry is deliberate and is the thing most likely to be „tidied up"
  into consistency. Backward dating has a minimum parallel run to protect, so it walks
  back; a freeze announced after the fact cannot un-happen, so leaving it walks forward
  and reports what the plan loses. Both directions have their own test.
- **`shift_out_of_freeze` never touches the shutdown.** Moving it would preserve the
  parallel run and push the old system past the vendor's date. Leaving it makes the cost
  visible instead of hiding it in a date nobody re-read.
- **Both freeze ends are inclusive.** A window „from the 20th to the 31st" blocks the
  31st. Half-open would silently free the last day of every year-end freeze.
- **`day()` refuses anything that is not `YYYY-MM-DD`,** including a well-formed but
  impossible day. `new Date('14.10.2026')` succeeds and lands the answer months away,
  with nothing on screen saying so — that is the bug the strictness prevents, not
  fussiness. Loosening it means every computed date can silently be wrong.
- **The walk helpers are bounded.** `nextFreeDay` and `previousFreeDay` take a `limit`
  and return `null` at it. A row with an absurd `to` would otherwise spin; returning
  null lets the caller report „no admissible day" instead of inventing one.

## Data

- **Six metadata keys are stored on items**: `system`, `endOfSupport`, `extendedUntil`,
  `leadTimeDays`, `cutover`, `shutdown`. All six are declared in the manifest's
  `metadataKeys`, which is what an uninstall purges. **Renaming any of them silently
  drops every existing value**, including the committed example's.
- **Two keys are computed and stored nowhere**: `latestStart` and `supportWindow`. They
  are deliberately *not* in `metadataKeys` — there is nothing on an item to purge, and
  listing them would suggest the dates are stored.
- **The three `supportWindow` ids stay English** (`standard`, `extended`,
  `unsupported`). They are what a grouping dimension keys on, so translating one would
  split a lane in two the first time somebody switched language. Only the labels in
  `messages.ts` move.
- **One collection, `freezes`**, with `name`, `from` and `to` all required. A span with
  one end is not a span, and defaulting the other would block days nobody declared. Rows
  are written by a person or by `plugin_data_write`, never by a tool: a tool returns item
  changes only, and a freeze calendar is a decision rather than a computation.

## Domain rules

Every rule lives in [`lifecycle.ts`](lifecycle.ts) as a pure function and is tested in
[`lifecycle.test.ts`](lifecycle.test.ts). [`tools.ts`](tools.ts) is only the adapter that
reads arguments and phrases notes; putting arithmetic there would make it reachable only
by constructing a `ToolContext`.

| Rule | Where | Grounded in | Confidence |
| --- | --- | --- | --- |
| Latest start = deadline − lead time | `latestStart` | „the support deadline is the last possible moment, not the right one" — mioritichost.com, read 2026-08-18 | verified arithmetic, sourced rule |
| Standard → extended → unsupported, in that order | `supportWindowOf` | suse.com, flexera.com, tuxcare.com, read 2026-08-18 | plausible, sourced |
| What extended support covers or how long it runs | **nowhere, on purpose** | tuxcare.com: no universal industry definition, confirm per vendor | not modelled |
| A cutover inside a freeze window is an error | `freezeAt` | freeze/blackout windows are a first-class scheduling object in ITSM tools (Atlassian, Freshservice, ServiceNow), read 2026-08-18 | verified arithmetic, sourced rule |
| Parallel run has a minimum the plan cannot undercut | `parallelRunDays`, `placeCutover` | en.wikipedia.org/wiki/Parallel_running, groenewold-it.solutions, read 2026-08-18 | rule sourced; the **number** is deliberately unset |
| Moving a blocked cutover forward is standard practice | `nextFreeDay` | „ein Alternativtermin sollte immer vorbereitet werden" — lexmair-solutions.de, read 2026-08-18 | plausible, sourced |

A rule added here needs its row in this table with a source and a date, or it is a guess
that the next reader will „improve" into a different wrong rule.

## Verification

```bash
npm test -- --test-name-pattern lifecycle
npm run typecheck
npm run schema:check              # validates the committed example
npm run plugins:catalogue:check   # catalogue entry + preview.png present
node scripts/ci/check-plugin-isolation.mjs
```

- **The rules**: [`lifecycle.test.ts`](lifecycle.test.ts), one test per rule and one per
  boundary the domain cares about rather than one per happy path.
- **The verbs as the host sees them**: [`tools.test.ts`](tools.test.ts). Every plan is
  run through `validateToolPlan`, which is the frame the host puts around a rule.
- **The derivation**: [`fields.test.ts`](fields.test.ts), including the empty and
  malformed config cases, which is where plugins actually break.
- **By hand**: [`data/example-eol-migration.json`](../../../data/example-eol-migration.json)
  carries every state the rules distinguish, one per item. Group by **Lifecycle · Support
  window** to see the three that end past their own end of life separate out. Because the
  example's dates are fixed and `now` is not, `check_eol_risk` will report a past deadline
  on more items as time passes — that is the rule working, not a stale example.

**This plugin has no view**, so nothing here draws. A change that wants one is a change
to the shape argued in phase 0 (grouping by the computed field is the rendering), not an
addition — and it would need the `views` capability, a chunk, and the bundle-split and
design-system checks that go with it.

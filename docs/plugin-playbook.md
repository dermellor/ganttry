# Plugin playbook

How a new plugin gets built here, start to finish. It exists because the expensive
mistakes in a plugin are not coding mistakes: they are building something that
should not have been a plugin, modelling a domain shallowly enough that a
practitioner dismisses it, naming a field after a word nobody searches for, and
writing the plugin's documentation into the core docs where it does not belong.

The phases are ordered on purpose and each one has an exit condition. Skipping
phase 1 is the one that costs the most later, twice over: the domain model it
produces is what makes the plugin worth installing, and the vocabulary it produces
ends up in `metadata` keys, which are expensive to rename once items carry them.

Copy [`src/plugins/_template/`](../src/plugins/_template/) to start. The template
carries the file layout this playbook assumes.

**A plugin is not a skin over the timeline.** It is what makes an agent competent in
one domain. Without a legal plugin, "the service date moved by two weeks, redo the
schedule" is guesswork; with one, there are deadlines with a reference point and a
calculation rule, and the instruction is executable. Every phase below is written
with that in mind, and it is why phase 0 asks about agent verbs and not only about
fields.

**A plugin is also a shop window.** Each one is a public page, a catalogue entry and
an invitation to the person who will build the next plugin. Phases 1, 5 and 6 carry
that weight; treating them as documentation chores is how a plugin ends up correct
and invisible.

---

## What the code does and does not carry

Everything this playbook asks for exists. Two boundaries are worth knowing before
you plan a plugin around them, because both are about *where a tool runs* rather
than whether you can write one:

| Boundary | What it means for a plugin |
| --- | --- |
| **An installed artifact's tools do not run** | Tools are called by a server process, and only in-tree plugins (`src/plugins/<id>/`) are wired into it. An artifact's verbs are listed as declared with no implementation. Running an artifact's code next to the database is a trust question [`docs/plugin-isolation.md`](plugin-isolation.md) has not answered |
| **The remote MCP server carries no plugin tools** ([#108](https://github.com/zeitlines/zeitlines/issues/108)) | A local agent sees a plugin's verbs, one connected over HTTP does not |

Neither is a reason to skip phase 0's fourth question. A plugin's fields make a
domain visible; its tools make an agent able to act in it, and that is the half
that cannot be recovered by writing better prompts.

**The plugin's own rules stay testable regardless**, because a tool is a pure
function from the timeline, the config, the arguments and today's date to a plan
of item changes. That is what the tests in phase 4 exercise, with no server
involved.

---

## Phase 0: is this a plugin at all?

Answer four questions before writing anything:

1. **Does it come out of derived fields alone?** A field whose options are computed
   from the timeline's own data or from the plugin's config is the cheapest possible
   plugin: it flows into the item form, grouping, filtering and the context menu with
   no further work.
2. **Does it need data of its own?** Item-level values live in `metadata[key]` and
   need nothing. Rows of its own are declared as `collections` in the manifest and
   stored generically by the host — a plugin never ships a migration. See
   [`docs/plugin-storage.md`](plugin-storage.md).
3. **Does it need a view of its own?** A view is a lazily loaded chunk and roughly
   ten times the work of a field. Grouping by a contributed field often gives the
   useful rendering already, so a first cut without a view is usually right.
4. **Does it need verbs of its own?** An agent gets `add_item` and `update_item` from
   the core. What it cannot get from the core is domain action:
   `recalculate_deadlines`, `shift_trade_with_lead_time`, `check_regulatory_gates`.
   If the domain has rules that turn one instruction into many item changes, those
   rules belong in the plugin as tools, not in the head of whoever writes the prompt.

**The budget:** one folder, one registration line, and **no core file touched**. If
the design needs a change in the generic core, that is not permission to make one.
It is a finding: comment on [#10](https://github.com/zeitlines/zeitlines/issues/10) or
[#11](https://github.com/zeitlines/zeitlines/issues/11) with what was missing. Every
plugin built this way measures the contract, which is the point.

**Exit condition:** you can name which of the four shapes the plugin has, and no
core file appears in your plan.

---

## Phase 1: research

Two different activities, done together because each constrains the other. The
domain model decides whether the plugin is worth installing; the vocabulary decides
whether anybody finds it.

### 1.1 The domain model

What does this domain actually plan, and by which rules? Not what a Gantt chart can
show, but what a practitioner would recognise:

- **Entities beyond the item.** Parties and roles, trades, storylines, cohorts.
- **Rules that compute.** A statutory deadline runs from service, not from judgment.
  A trade has a lead time before the next one can start. A trial phase cannot open
  before its gate closes.
- **Constraints that must hold.** Dates that cannot move, orders that cannot invert,
  overlaps that are errors rather than choices.
- **The two clocks, where the domain has them.** Narrative order against chronology,
  planned against committed, internal against what was promised outside.

This section is what phase 0's fourth question feeds on: every rule that computes is
a candidate agent verb.

### 1.2 Confidence and open questions

**Write down what you do not know.** For each part of the domain model, state whether
it is verified, plausible or guessed, and list the questions a practitioner would
have to answer.

This is not a disclaimer. It is the single most effective recruitment device the
project has: a legal plugin that says "models deadlines at a basic level; open:
service fiction, public-holiday rules, appeal periods — corrections welcome" is
more credible than one that pretends to be finished, and it names the exact gap for
the person who might contribute next. A plugin with no open questions has either
been reviewed by a practitioner or has not been thought about hard enough.

**Exit condition for 1.1 and 1.2:** the domain model and the confidence statement
exist in writing. They go into the plugin's `README.md` in phase 5.

### 1.3 Collect target questions

Generative engines answer questions; being the answer requires knowing the question.
This runs **before** the plugin is named, because the vocabulary decided here goes
into the plugin id, the field labels and the example data. Deciding it afterwards
means renaming labels that are already stored on items.

Three to five, in the form somebody actually types into a model, in **English and
German** (the interface and the users are German, the documentation and the wider
search space are English):

- `Alternative to <tool> for <job>`
- `<category> tool that is self-hosted`
- `Gantt chart with <capability>`
- `Roadmap tool without <common drawback>`

Be specific: "self-hosted roadmap tool with sprints" beats "project management".
A plugin covers a niche; its reach comes from answering one narrow question
completely rather than a broad one vaguely.

### 1.4 Measure the baseline

Put the same questions to several models and record what they answer **today**:
which tools get named, in what order, with which words. This is the before-picture
that phase 6 compares against, and it is also the fastest way to learn which
vocabulary the answers are written in.

### 1.5 Build the terminology table

| Our word | The common word | Used where |
| --- | --- | --- |
| Aufwand | Story Points | field label, README |

Where the two differ, **the common word wins for anything visible** (field label,
README, plugin name). Ours may stay in the code. A plugin whose field is called
"Aufwand" will not be found by anybody searching for story points.

**The core vocabulary is out of scope for this table.** Item, group, phase,
dependency, status and version mean the same thing in every plugin and are never
renamed, however the domain would say it. A domain word may be *added* next to a
core concept ("Gewerk" as a kind of group, "Wendepunkt" as a kind of phase), and
that mapping belongs in the table. Renaming a core concept in one plugin means the
same thing has five names across fifty plugins, which is good for one search result
and bad for everything else. See „Core vocabulary" below.

### 1.6 Claim rules

These are binding, not stylistic:

- A category comparison is fine: "an alternative to X for teams that want to
  self-host". A claim about a competitor's features needs a **source and a date**,
  or it does not get written.
- Use other products' names descriptively. Never in a way that suggests an
  affiliation, endorsement or a shared origin.
- No invented numbers, no invented user counts, no comparison table whose other
  column you have not verified.
- Do not overstate the domain model. The confidence statement from 1.2 is the
  binding version, and marketing copy may not contradict it.

**Exit condition:** domain model, confidence statement, target questions, the
baseline recording and the terminology table exist in writing. They go into the
plugin's `README.md` in phase 5.

---

## Phase 2: specification

Half a page, in the plugin's `README.md` as a draft, using this raster:

- **Fields:** key, label, type, where the options come from.
- **Agent tools:** name, what it changes, which domain rule it applies. None is a
  valid answer for a fields-only plugin; write "none" rather than leaving the row
  out, so the decision is visible.
- **View:** one, or none. If one: what it shows that grouping cannot.
- **Config:** the shape of the `timeline_plugins.config` bag.
- **Data:** none, item metadata, or rows of its own.
- **Catalogue entry:** name, one-sentence summary, domain category, keywords. These
  go into the manifest and are what the generated catalogue renders. Writing them
  here rather than at publication time keeps the plugin from being named after
  something the summary then contradicts.
- **What it deliberately does not do.** This section is what keeps plugins small,
  and it is the one most worth writing.

**Exit condition:** somebody else could build it from the spec.

---

## Phase 3: implementation

Copy the template and work in this order, because each step is usable on its own:

1. `fields.ts`, the derived field definitions. Ship this alone if you can.
2. `tools.ts`, the agent verbs, if any.
3. Data, if any.
4. The view, if any.

Files, all inside the plugin's own folder:

| File | What |
| --- | --- |
| `manifest.ts` | what the plugin declares: id, capabilities, views, tools, config schema, the metadata keys it owns, and the catalogue entry from phase 2 |
| `descriptor.ts` | the one object the registry takes: the manifest, `matches`/`applies`, `fields`, `tools`, and `load()` |
| `fields.ts` | derived `CustomFieldDef[]`, gated on the plugin being enabled |
| `fields.test.ts` | the derivation, tested without a DOM |
| `tools.ts` | the agent verbs and the domain rules behind them, if any |
| `tools.test.ts` | the rules, tested without a DOM. This is where a wrong deadline calculation gets caught |
| `index.ts` | the lazily loaded view module, if there is a view |
| `README.md` | what it does, the field and tool reference, the domain confidence, the GEO material from phase 1 |
| `preview.png` | generated in phase 4, used by the catalogue |
| `AGENTS.md` | conventions for changing **this** plugin: its invariants with the failure each prevents, where its data lives, what must not be renamed, and how to verify it |
| `docs/` | anything longer than the README carries: the model reference, the migrations, the endpoints |

### Which id, and which contract version

**The id is reverse-DNS from a domain you own** (`com.acme.sprints`), at least two
lowercase labels. The validator refuses anything else, and the reason is that the
id keys the plugin's rows and the metadata it writes on items: a collision is a
collision in somebody's data. It is permanent in practice, so pick it in phase 1
rather than here.

**`apiVersion` is `"^1"`** unless the plugin declares `tools`, which arrived in
1.2 and needs `"^1.2"`. A plugin using a newer section while claiming `^1` loads on
an older host with its verbs listed nowhere, and no host can warn about that on the
older one's behalf.

### The two registration shapes

The playbook fits both, and the difference is one file plus what covers it:

| | **In-tree** (`src/plugins/<id>/`) | **Vendored artifact** (`plugins/<id>/`) |
| --- | --- | --- |
| Registration | one `register()` call plus a static import in [`src/pluginHost/registry.ts`](../src/pluginHost/registry.ts) | none. `manifest.json` plus an ES module, installed with `npm run plugin:install -- <id>` |
| Covered by | this repository's `npm test`, `npm run typecheck` and the CI guards | its own tests, wherever it lives |
| Agent tools | run | declared, not run ([#108](https://github.com/zeitlines/zeitlines/issues/108)) |
| Use it when | the plugin ships with Zeitlines | the plugin is somebody else's, or lives in its own repository |

For anything built by following this playbook, in-tree is the answer. The artifact
path is documented in [`docs/plugin-authoring.md`](plugin-authoring.md).

The registry entry has to stay cheap and synchronous: `descriptor.ts`, `fields.ts`
and `tools.ts` may import types and the plugin helpers and nothing else, or the
plugin's code lands in the generic bundle and the lazy split is gone. An invalid
manifest is refused at `register()`, so a missing capability shows up at startup
rather than halfway through a render.

**Domain rules live in `tools.ts` and are testable without a DOM.** That is the whole
point of pulling them out of prompts: a rule in a prompt cannot be tested and cannot
be reused, and it is wrong in a way nobody notices until a date is wrong.

**The documentation lives with the plugin from the first commit.** Do not write a
chapter in the core `docs/`. `product-roadmap` was the counter-example for a
while — a 200-line chapter in `docs/pricing.md` plus a field table in
`docs/items.md`, so uninstalling it would have left the core documentation wrong
rather than merely shorter. Both moved into its folder
([#18](https://github.com/zeitlines/zeitlines/issues/18)), and writing it there
in the first place costs nothing.

**Exit condition:** `npm run typecheck` shows no new errors, and no file outside the
plugin folder changed except the one registry line.

---

## Phase 4: verification

- **Unit test** the derived options, including the empty and malformed config cases.
  Derivation is where plugins actually break.
- **Unit test every domain rule** in `tools.ts`, including the boundary the domain
  cares about: the deadline that falls on a weekend, the trade with zero lead time,
  the gate that is already closed. A plausible-looking wrong rule is worse than a
  missing one, because it gets trusted.
- **An example timeline** in `data/`, named in the manifest's `catalogue.example`.
  Every top-level `data/*.json` is validated by `npm run schema:check`, so the
  example doubles as a test, and phase 5 needs it anyway as the public
  demonstration.

  **It has to consent to publication.** A plugin's rows are materialized into the
  build only with `"public": true` on its entry in the file's `plugins` array.
  Without it the build strips `pluginData` and the example renders as a plain
  timeline — which reads as „the plugin is broken" rather than as the publication
  gate doing its job ([`docs/plugin-public-read.md`](plugin-public-read.md)).
- **A preview image**, `npm run plugins:preview -- <folder>`, committed as
  `preview.png` in the plugin folder. It needs the app running and a Chrome on the
  machine. The catalogue needs the image, and fifty of them reviewed side by side
  catch what fifty separate click paths would not: the plugin that renders
  correctly and still looks like nothing.
- **`npm test`, `npm run typecheck`, `npm run schema:check`,
  `npm run plugins:catalogue:check`, `npm run build`**, plus, if the plugin has a
  view, [`scripts/ci/check-bundle-split.sh`](../scripts/ci/check-bundle-split.sh)
  (a generic build must download none of it) and
  [`scripts/ci/check-design-system.sh`](../scripts/ci/check-design-system.sh) (the
  view is built from the components and the tokens, like everything else that
  draws).
- **A manual click path**, written down as steps and expected results. It goes into
  the pull request or the commit message so the change can be checked by somebody
  who did not build it.

  **Switching the plugin on is part of that path**, and there is no interface for
  it yet ([#85](https://github.com/zeitlines/zeitlines/issues/85)): on a database
  timeline it is the `configure_plugin` MCP tool, on a local file the `plugins`
  array. Write down which one, or the reader cannot reproduce step one.

**Exit condition:** green, the preview image is committed, and the click path is
written down.

---

## Phase 5: publication

### 5.1 The plugin README

This file is the public page. Today it is served by GitHub; later the same markdown
becomes a page under `zeitlines.dev`, so keep it portable: no GitHub-only markup, and
metadata (name, summary, keywords, domain) belongs in the plugin's manifest rather
than in front matter.

Structure, in this order:

1. **What it does**, one paragraph, first sentence answering the question outright.
2. **Who it is for**, one paragraph naming the situation, not a persona.
3. **See it**, a link to this plugin's example timeline on the public instance, plus
   the preview image. A reader who cannot see it in one click will not install it to
   find out.
4. **How to enable it**, with the exact config.
5. **Field reference**, as a table.
6. **What your agent can do with it**, the tool reference as a table: tool name, what
   it changes, which rule it applies. Omit the section only if the plugin has no
   tools.
7. **How well this domain is modelled**, the confidence statement and the open
   questions from phase 1.2, verbatim rather than softened.
8. **Improve this plugin**, naming the open questions as the concrete way in and
   linking the contribution guide. Every plugin recruits for the next one.
9. **Example**, linking the committed example timeline.
10. **How it compares**, the phase 1 material: the category, the terminology table,
    and the honest boundaries.

Write it the way an engine can quote it: **headings in question form**, the first
line of every section answering that question in one sentence, tables instead of
prose for anything enumerable, no filler. A section that needs three paragraphs
before it says anything will be summarised into nothing.

### 5.2 The uninstall test

Before committing, read every sentence you wrote outside the plugin folder and ask:
**if this plugin were uninstalled, would this still be true?** If it becomes false or
orphaned, it is plugin documentation and belongs in the plugin folder. If it stays
true because it describes a mechanism and merely cites an example, it is core
documentation and may stay.

Zero mentions in the core docs is the wrong target, and aiming for it makes the
seam chapters unreadable: „Plugins" (docs/architecture.md) is good precisely
because it names a real case. The rule is narrower — **no core chapter is the
home of a plugin fact.** Applied to `product-roadmap`, it left
`docs/architecture.md` almost untouched while the field table in `docs/items.md`
moved out entirely.

The same question has a code half, and that one is checked mechanically:
`node scripts/ci/check-plugin-isolation.mjs` refuses a core file that imports
from a plugin folder, names a plugin id as a literal, adds a plugin-specific
method to `TimelineRepo`, or links a plugin's markup from `index.html`. Run it
before committing; the prose half is still yours to read.

### 5.3 The catalogue

The plugin appears in the catalogue because its manifest carries the entry from
phase 2, not because anybody edited a list. `npm run plugins:catalogue` regenerates
the catalogue page from the manifests and `npm run plugins:catalogue:check` fails
when a plugin is missing a required entry field or a preview image, in the same way
`schema:check` and `openapi:check` already work here. Generated artefacts are not
edited by hand.

A hand-maintained list in the root README is fine at three plugins and is a wall of
links at fifty. The catalogue is what a reader browses and what a crawler indexes,
so the entry fields are a publication requirement and not metadata hygiene.

**Exit condition:** the plugin README stands on its own for a reader who has never
seen this repository, and `plugins:catalogue:check` is green.

---

## Phase 6: measurement and done

Two to four weeks after publishing, put the phase 1 questions to the same models
again and record the result with its date in the plugin README's own log. A plugin
that never gets named is not a failed plugin; it is a signal that the questions were
wrong or the page answers them incompletely, and both are fixable.

**Budget it, because nothing automates it.** Three to five questions in two
languages, against several models, twice per plugin — for one plugin an afternoon's
interruption, for a batch of ten the largest single block of manual work in the
whole process. Two consequences worth deciding up front: measure the batch on one
date rather than per plugin, and if the baseline (phase 1.4) was not recorded, phase
6 has nothing to compare against and is skipped rather than estimated.

Done means what it means everywhere in this repository: committed, pushed, and the
deploy verified green. See „Branching, Commits & Session Isolation" in
[`AGENTS.md`](../AGENTS.md).

---

## Core vocabulary

These words mean the same thing in every plugin and are never renamed by one:

| Core concept | What it is |
| --- | --- |
| item | one thing on the timeline, with a start and optionally an end or duration |
| group | the lane an item sits in |
| phase | a labelled span across items |
| dependency | an ordering constraint between items |
| status | the built-in state field |
| version | an ordered release marker |

A domain word may be added *next to* a core concept and mapped in the terminology
table (phase 1.5): a Gewerk is a kind of group, a Wendepunkt is a kind of phase, a
Frist is an item with a rule attached. What must not happen is a plugin that calls a
group a Gewerk everywhere, because then the same concept has a different name in
every plugin, and no cross-plugin reasoning, documentation or agent instruction
survives it.

---

## Building many plugins at once

Building plugins in a batch, with an orchestrating agent and one subagent per
plugin, changes four things. Everything else in this playbook applies unchanged.

**Findings are collected, not raised one at a time.** Phase 0's contract gaps get
more useful in bulk: twelve domains reporting the same missing capability is one
gap in the extension point, not twelve exceptions. The orchestrator collects them
and reports the set.

**The core vocabulary is held by the orchestrator and passed into every subagent.**
A subagent optimises its terminology locally for findability and cannot see that
four other plugins just named the same concept differently. Without the shared list
handed down, parallelism actively makes the terminology worse. A consistency pass
over all manifests closes the batch.

**Approval happens per batch, not per plugin.** Phases 0, 1 and 2 are reviewed as a
table covering the whole batch: name, visible field labels, terminology, domain
confidence. The judgement being asked for is vocabulary and domain plausibility, and
it is faster and more consistent over fifty rows than over fifty conversations.

**Phase 4's visual check becomes a contact sheet.** The preview images from all
plugins are reviewed side by side; only the ones that look wrong get a click path
walked manually.

**The one shared file is the bottleneck.** An in-tree plugin touches its own folder
plus a single `register()` line, so parallel subagents collide on exactly one file:
[`src/pluginHost/registry.ts`](../src/pluginHost/registry.ts). The runtime loader
([#14](https://github.com/zeitlines/zeitlines/issues/14)) does **not** remove that
— it reads an installed *artifact's* manifest, while an in-tree plugin still needs
its import and its `register()` call. So there are two real options:

1. **The orchestrator writes every registry line itself**, after the subagents are
   done. This is the answer for a batch of in-tree plugins: it serialises exactly
   one step, and it is the step where a manifest error surfaces anyway.
2. **Build them as vendored artifacts** (`plugins/<id>/`), which touch no shared
   file at all. Parallelism is then free, and the price is that the plugins are
   outside this repository's tests and typecheck, and that their agent verbs do not
   run ([#108](https://github.com/zeitlines/zeitlines/issues/108)). Right for
   plugins that belong somewhere else, wrong for a first batch.

Whichever it is, the catalogue is regenerated **once** at the end of the batch:
`PLUGINS.md` is one file too, and it is derived, so there is no reason for a
subagent to touch it.

**What batching does not solve is depth.** Subagents in parallel produce breadth;
the domain model in phase 1 is where a plugin becomes worth installing, and no
amount of orchestration substitutes for knowing the domain. Spend the review budget
on phase 1, not on phase 4. A plugin whose domain model is right survives an average
view; the best view does not rescue a legal plugin that computes deadlines from the
wrong date.

---

## What the platform work already changed, and what is still open

The epic ([#9](https://github.com/zeitlines/zeitlines/issues/9)) has landed the
parts this playbook depends on. Two of its steps changed a paragraph here and are
noted so a reader of an older version is not confused:

- **The path** is `src/plugins/<id>/`, with the host under `src/pluginHost/`
  ([#19](https://github.com/zeitlines/zeitlines/issues/19)).
- **A runtime loader** installs an artifact from a URL or from `plugins/<id>/`
  ([#14](https://github.com/zeitlines/zeitlines/issues/14), [#15](https://github.com/zeitlines/zeitlines/issues/15)).
  It did **not** remove the `register()` line for an in-tree plugin: see „The two
  registration shapes" in phase 3.

Still open, and both about where a tool runs rather than how one is written:
[#108](https://github.com/zeitlines/zeitlines/issues/108) (the remote MCP server
carries no plugin tools) and the artifact-execution question in
[`docs/plugin-isolation.md`](plugin-isolation.md). Everything else — the gate, the
research, the spec, the verification and the publication — is unaffected by either.

---

## Checklist

```
[ ] 0  Shape named (fields / data / view / tools); no core file in the plan
[ ] 1  Domain model, confidence + open questions, target questions,
       baseline recording, terminology table (core vocabulary respected)
[ ] 2  Spec written: fields, tools, view, config, data, catalogue entry,
       and what it does not do
[ ] 3  Reverse-DNS id, apiVersion (^1.2 with tools); manifest, descriptor,
       fields.ts, tools.ts, tests, README, AGENTS.md; one registry line
[ ] 4  Tests incl. domain rules; typecheck, schema check, catalogue check,
       build, bundle split, design system; example with "public": true;
       preview.png; click path incl. how the plugin gets switched on
[ ] 5  Plugin README incl. tools, confidence and contribution call;
       uninstall test on every sentence outside the plugin folder;
       check-plugin-isolation green; plugins:catalogue:check green
[ ] 6  Baseline recorded → measurement scheduled (or explicitly skipped);
       committed, pushed, deploy green
```

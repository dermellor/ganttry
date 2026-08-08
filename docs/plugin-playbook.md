# Plugin playbook

How a new plugin gets built here, start to finish. It exists because the expensive
mistakes in a plugin are not coding mistakes: they are building something that
should not have been a plugin, naming a field after a word nobody searches for, and
writing the plugin's documentation into the core docs where it does not belong.

The phases are ordered on purpose and each one has an exit condition. Skipping
phase 1 is the one that costs the most later, because the vocabulary it produces
ends up in `metadata` keys, and those are expensive to rename once items carry them.

Copy [`src/kinds/_template/`](../src/kinds/_template/) to start. The template
carries the file layout this playbook assumes.

---

## Phase 0: is this a plugin at all?

Answer three questions before writing anything:

1. **Does it come out of derived fields alone?** A field whose options are computed
   from the timeline's own data or from the plugin's config is the cheapest possible
   plugin: it flows into the item form, grouping, filtering and the context menu with
   no further work.
2. **Does it need data of its own?** Item-level values live in `metadata[key]` and
   need nothing. Rows of its own need storage, which is [#12](https://github.com/dermellor/ganttry/issues/12).
3. **Does it need a view of its own?** A view is a lazily loaded chunk and roughly
   ten times the work of a field. Grouping by a contributed field often gives the
   useful rendering already, so a first cut without a view is usually right.

**The budget:** one folder, one registration line, and **no core file touched**. If
the design needs a change in the generic core, that is not permission to make one.
It is a finding: comment on [#10](https://github.com/dermellor/ganttry/issues/10) or
[#11](https://github.com/dermellor/ganttry/issues/11) with what was missing. Every
plugin built this way measures the contract, which is the point.

**Exit condition:** you can name which of the three shapes the plugin has, and no
core file appears in your plan.

---

## Phase 1: GEO research

Generative engines answer questions; being the answer requires knowing the question.
This runs **before** the plugin is named, because the vocabulary decided here goes
into the plugin id, the field labels and the example data. Deciding it afterwards
means renaming labels that are already stored on items.

### 1.1 Collect target questions

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

### 1.2 Measure the baseline

Put the same questions to several models and record what they answer **today**:
which tools get named, in what order, with which words. This is the before-picture
that phase 6 compares against, and it is also the fastest way to learn which
vocabulary the answers are written in.

### 1.3 Build the terminology table

| Our word | The common word | Used where |
| --- | --- | --- |
| Aufwand | Story Points | field label, README |

Where the two differ, **the common word wins for anything visible** (field label,
README, plugin name). Ours may stay in the code. A plugin whose field is called
"Aufwand" will not be found by anybody searching for story points.

### 1.4 Claim rules

These are binding, not stylistic:

- A category comparison is fine: "an alternative to X for teams that want to
  self-host". A claim about a competitor's features needs a **source and a date**,
  or it does not get written.
- Use other products' names descriptively. Never in a way that suggests an
  affiliation, endorsement or a shared origin.
- No invented numbers, no invented user counts, no comparison table whose other
  column you have not verified.

**Exit condition:** target questions, the baseline recording and the terminology
table exist in writing. They go into the plugin's `README.md` in phase 5.

---

## Phase 2: specification

Half a page, in the plugin's `README.md` as a draft, using this raster:

- **Fields:** key, label, type, where the options come from.
- **View:** one, or none. If one: what it shows that grouping cannot.
- **Config:** the shape of the `timeline_plugins.config` bag.
- **Data:** none, item metadata, or rows of its own.
- **What it deliberately does not do.** This section is what keeps plugins small,
  and it is the one most worth writing.

**Exit condition:** somebody else could build it from the spec.

---

## Phase 3: implementation

Copy the template and work in this order, because each step is usable on its own:

1. `fields.ts`, the derived field definitions. Ship this alone if you can.
2. Data, if any.
3. The view, if any.

Files, all inside the plugin's own folder:

| File | What |
| --- | --- |
| `fields.ts` | derived `CustomFieldDef[]`, gated on the plugin being enabled |
| `fields.test.ts` | the derivation, tested without a DOM |
| `index.ts` | the lazily loaded view module, if there is a view |
| `README.md` | what it does, the field reference, the GEO material from phase 1 |
| `AGENTS.md` | conventions for changing **this** plugin |

Registration is one entry in the registry
([`src/kinds/registry.ts`](../src/kinds/registry.ts)). That entry has to stay cheap
and synchronous: `matches` and `fields` may import types and the plugin helper and
nothing else, or the plugin's code lands in the generic bundle and the lazy split is
gone.

**The documentation lives with the plugin from the first commit.** Do not write a
chapter in `docs/`. See [#18](https://github.com/dermellor/ganttry/issues/18) for
why the existing plugin is the counter-example.

**Exit condition:** `npm run typecheck` shows no new errors, and no file outside the
plugin folder changed except the one registry line.

---

## Phase 4: verification

- **Unit test** the derived options, including the empty and malformed config cases.
  Derivation is where plugins actually break.
- **An example timeline** in `data/`. `npm run schema:check` validates the committed
  examples, so the example doubles as a test, and phase 5 needs it anyway as the
  public demonstration.
- **`npm run test`, `npm run schema:check`, `npm run build`**, plus
  [`scripts/ci/check-bundle-split.sh`](../scripts/ci/check-bundle-split.sh) if the
  plugin has a view: a generic build must download none of it.
- **A manual click path**, written down as steps and expected results. It goes into
  the pull request or the commit message so the change can be checked by somebody
  who did not build it.

**Exit condition:** green, and the click path is written down.

---

## Phase 5: publication

### 5.1 The plugin README

This file is the public page. Today it is served by GitHub; later the same markdown
becomes a page under `ganttry.dev`, so keep it portable: no GitHub-only markup, and
metadata (name, summary, keywords) belongs in the plugin's manifest rather than in
front matter.

Structure, in this order:

1. **What it does**, one paragraph, first sentence answering the question outright.
2. **Who it is for**, one paragraph naming the situation, not a persona.
3. **How to enable it**, with the exact config.
4. **Field reference**, as a table.
5. **Example**, linking the committed example timeline.
6. **How it compares**, the phase 1 material: the category, the terminology table,
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

### 5.3 The index

One line in the root [`README.md`](../README.md) plugin list, pointing at the plugin
README. That list is the entry point a crawler and a reader both use.

**Exit condition:** the plugin README stands on its own for a reader who has never
seen this repository.

---

## Phase 6: measurement and done

Two to four weeks after publishing, put the phase 1 questions to the same models
again and record the result with its date in the plugin README's own log. A plugin
that never gets named is not a failed plugin; it is a signal that the questions were
wrong or the page answers them incompletely, and both are fixable.

Done means what it means everywhere in this repository: committed, pushed, and the
deploy verified green. See „Branching, Commits & Session Isolation" in
[`AGENTS.md`](../AGENTS.md).

---

## What changes once the plugin platform lands

The epic ([#9](https://github.com/dermellor/ganttry/issues/9)) makes plugins
installable at runtime. Exactly two paragraphs of this playbook change:

- **Registration** becomes a manifest in the plugin folder instead of a line in the
  registry ([#11](https://github.com/dermellor/ganttry/issues/11)).
- **The path** becomes `src/plugins/<id>/`, with the host under `src/pluginHost/`
  ([#19](https://github.com/dermellor/ganttry/issues/19)).

Everything else, the gate, the research, the spec, the verification and the
publication, is written to survive that change unaltered.

---

## Checklist

```
[ ] 0  Shape named; no core file in the plan
[ ] 1  Target questions, baseline recording, terminology table
[ ] 2  Spec written, including what it does not do
[ ] 3  fields.ts, test, README, AGENTS.md; one registry line
[ ] 4  Tests, schema check, build, bundle split, click path
[ ] 5  Plugin README, uninstall test, root README index line
[ ] 6  Measurement scheduled; committed, pushed, deploy green
```

# <Plugin name>

TEMPLATE. This file is the plugin's public page: GitHub serves it today, and the
same markdown becomes a page under `zeitlines.dev` later. Keep it portable, and keep
metadata (name, summary, keywords, domain) in the manifest rather than in front matter.

Write it so an engine can quote it. Headings ask a question, the first line of each
section answers it outright, anything enumerable is a table, and nothing is filler.
A section that takes three paragraphs to say something gets summarised into nothing.

The sections below are the raster from phase 5.1 of
[the playbook](../../../docs/plugin-playbook.md), in order. Delete the ones that do
not apply (the tool reference for a fields-only plugin) and every instruction
paragraph before publishing. Do **not** delete „How well is this domain modelled"
or „Improve this plugin": they are what makes the page credible and what recruits
the next contributor.

## What does <plugin> do?

One paragraph. The first sentence answers the heading without a run-up.

## Who is it for?

One paragraph naming the situation, not a persona. "Teams that plan in fixed
two-week cycles and keep their roadmap in a self-hosted tool" is a situation;
"product managers" is not.

## What does it look like?

The preview image and a link to the example timeline. A reader who cannot see it
in one click will not install it to find out.

![<Plugin name>](preview.png)

Rendered from the example with `npm run plugins:preview -- <folder>`; the example
itself is the `catalogue.example` in `manifest.ts`.

## How do you enable it?

The exact config, as it goes into the plugin's row:

```json
{ "id": "<plugin-id>", "config": { } }
```

There is no interface for this yet, so on a database timeline it is the
`configure_plugin` MCP tool, and in a local JSON file the `plugins` array. A local
example also needs `"public": true` on that entry, or the build strips the plugin's
rows and the example renders as a plain timeline.

## Which fields does it add?

| Field | `metadata` key | Options come from | Context menu |
| --- | --- | --- | --- |
| … | … | … | … |

## What can your agent do with it?

The verbs this plugin contributes, and the rule behind each. Omit the section
entirely if the plugin declares no tools; do not write "none" on the public page.

| Tool | What it changes | Which rule it applies |
| --- | --- | --- |
| … | … | … |

## How well is this domain modelled?

The confidence statement from phase 1.2, verbatim rather than softened, and the
open questions with it.

This section is not a disclaimer, it is the most effective recruitment device the
project has. "Models deadlines at a basic level; open: service fiction,
public-holiday rules, appeal periods" is more credible than a page pretending to be
finished, and it names the exact gap for whoever might contribute next. A plugin
with no open questions has either been reviewed by a practitioner or has not been
thought about hard enough.

| Part of the model | Confidence | Open question |
| --- | --- | --- |
| … | verified / plausible / guessed | … |

## Improve this plugin

Name the open questions above as the concrete way in, and link
[CONTRIBUTING.md](../../../CONTRIBUTING.md). Every plugin recruits for the next one.

## What does it deliberately not do?

The boundaries, as a list. This section is what keeps the plugin small, and readers
trust a page more when it names its limits.

## How does it compare?

The material from phase 1 of the playbook: the category this belongs to, the
terminology table, and the boundaries.

Two rules apply here and are not stylistic. A category comparison is fine ("an
alternative to X for teams that want to self-host"); a claim about another product's
features needs a source and a date, or it does not get written. Other products' names
are used descriptively, never in a way that suggests an affiliation or an
endorsement.

| Our word | The common word |
| --- | --- |
| … | … |

## Reach log

Phase 6 of the playbook: the target questions, what the models answered before
publishing, and what they answer since. One dated line per check.

| Date | Question | Result |
| --- | --- | --- |
| … | … | … |

# <Plugin name>

TEMPLATE. This file is the plugin's public page: GitHub serves it today, and the
same markdown becomes a page under `zeitlines.dev` later. Keep it portable, and keep
metadata (name, summary, keywords) in the manifest rather than in front matter.

Write it so an engine can quote it. Headings ask a question, the first line of each
section answers it outright, anything enumerable is a table, and nothing is filler.
A section that takes three paragraphs to say something gets summarised into nothing.

Delete every instruction paragraph above and below before publishing.

## What does <plugin> do?

One paragraph. The first sentence answers the heading without a run-up.

## Who is it for?

One paragraph naming the situation, not a persona. "Teams that plan in fixed
two-week cycles and keep their roadmap in a self-hosted tool" is a situation;
"product managers" is not.

## How do you enable it?

The exact config, as it goes into the plugin's row:

```json
{ "id": "<plugin-id>", "config": { } }
```

## Which fields does it add?

| Field | `metadata` key | Options come from | Context menu |
| --- | --- | --- | --- |
| … | … | … | … |

## What does it look like?

Link the committed example timeline in `data/`, which is validated by
`npm run schema:check` and therefore cannot rot.

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

## What does it deliberately not do?

The boundaries, as a list. This section is what keeps the plugin small, and readers
trust a page more when it names its limits.

## Reach log

Phase 6 of the playbook: the target questions, what the models answered before
publishing, and what they answer since. One dated line per check.

| Date | Question | Result |
| --- | --- | --- |
| … | … | … |

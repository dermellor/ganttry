---
name: new-plugin
description: Build one Zeitlines plugin, or a whole batch of them, end to end: from the is-this-a-plugin gate through domain research, GEO research, implementation, verification and publication. Use when the user wants to add a plugin, a new timeline capability (sprints, board, risks, baseline, absences), a domain plugin (legal, construction, research, fiction), or asks to extend Zeitlines with a new kind of field, view or agent tool.
---

# New plugin

Read [`docs/plugin-playbook.md`](../../../docs/plugin-playbook.md) first and follow
it. This file only carries what an agent has to be told on top of it: where to stop,
and what not to do.

Copy [`src/plugins/_template/`](../../../src/plugins/_template/) to start.

**Two modes.** One plugin: follow „Single plugin" below. Several plugins in one run:
follow „Batch mode", which changes the granularity of the stop points and nothing
else.

## What a plugin is

A plugin is what makes an agent competent in one domain, not a skin over the
timeline. The domain rules it encodes are the reason it exists: without them, an
instruction like „the service date moved by two weeks, redo the schedule" is
guesswork. That is why phase 0 has a fourth question about agent verbs, and why a
plugin whose domain model is thin has failed even when every test is green.

A plugin is also a public page, a catalogue entry and an invitation to the next
contributor. Phases 1.2, 5.1 and 5.3 carry that and are not documentation chores.

## Before anything: four things the code does not have yet

The playbook's „What this playbook presupposes" section lists them. Agent tools
contributed by a plugin, catalogue metadata in the manifest, catalogue generation and
preview rendering are **not built**. Do not fake any of them, and do not work around
them by touching core files.

If a plugin needs agent tools, say so and stop: that is the load-bearing gap, and the
seam has to exist before a plugin can carry the half of its value that lives in
domain rules. Where a requirement cannot be met yet, name it in the report rather
than silently dropping it from the checklist.

## Single plugin: stop points

Do not run these phases together. Each ends with something the user has to see.

- **After phase 0**, report which of the four shapes the plugin has (fields, data,
  view, tools) and whether any core file would have to change. If one would, stop and
  say so: that is a finding for
  [#10](https://github.com/dermellor/zeitlines/issues/10) or
  [#11](https://github.com/dermellor/zeitlines/issues/11), not something to work
  around.
- **After phase 1**, show the domain model, the confidence statement with its open
  questions, the target questions, the baseline and the terminology table. Get
  agreement on the plugin name and the visible field labels before writing code.
  They end up in `metadata` keys, which are expensive to rename later.
- **After phase 2**, show the spec, including the agent tools and the catalogue entry.
- **After phase 4**, deliver the preview image and the manual click path (URL, view,
  exact steps, expected result) and stop. The user tests before anything is merged
  or pushed.

## Batch mode

When several plugins are built in one run, one orchestrating agent runs the batch and
one subagent builds each plugin. The stop points do not disappear; they move up a
level.

**Before starting the batch:**

- Check whether [#14](https://github.com/dermellor/zeitlines/issues/14) has landed. If
  the loader reads manifests from the plugin folders, a plugin touches no shared file
  and subagents can run fully in parallel. If it has not, the single
  `register()` line in
  [`src/pluginHost/registry.ts`](../../../src/pluginHost/registry.ts) is the only
  collision point: **the orchestrator writes every registry line itself, after the
  subagents finish.** Never let subagents edit that file concurrently.
- Assemble the core vocabulary („Core vocabulary" in the playbook) and hand it to
  every subagent verbatim. Without it, each subagent optimises terminology locally
  and the same concept ends up with a different name in every plugin.
- Use one git worktree per subagent, per „Branching, Commits & Session Isolation"
  in [`AGENTS.md`](../../../AGENTS.md), and clean them up afterwards.

**Batch stop points, in place of the per-plugin ones:**

- **After phase 0 for the whole batch**, report the collected contract findings as a
  set, not one at a time. Several domains reporting the same missing capability is
  one gap in the extension point and worth naming as such.
- **After phase 1 for the whole batch**, present one table covering every plugin:
  name, visible field labels, domain terminology, and the domain confidence with its
  open questions. This is the review that matters, because it is where depth is
  decided. Do not proceed to implementation without agreement on it.
- **After phase 2 for the whole batch**, present the specs together, in particular
  the agent tools and the catalogue entries.
- **After phase 4 for the whole batch**, present the preview images as a contact
  sheet. Walk a manual click path only for the ones the user flags.
- **Close the batch with a terminology consistency pass** over all manifests, and
  report any concept that acquired more than one name.

**Depth is not a batching problem.** Parallel subagents produce breadth. The domain
model in phase 1 is what makes a plugin worth installing, and no orchestration
substitutes for knowing the domain. If a subagent cannot ground a rule, it says so in
the confidence statement rather than inventing a plausible one.

## Rules

- **Never touch a file outside the plugin folder**, except the one registry line.
  Anything else is a contract gap to report, never a workaround to apply.
- **Documentation goes into the plugin folder**, never into `docs/`. Apply the
  uninstall test from phase 5.2 to every sentence written outside the plugin folder.
- **Domain research comes before vocabulary research, and both come before naming.**
  Do not skip either because the plugin seems obvious.
- **Never rename a core concept.** Item, group, phase, dependency, status and version
  mean the same thing in every plugin. A domain word is added next to a core concept
  and mapped in the terminology table, never substituted for it.
- **Domain rules go into `tools.ts` and get unit tests**, including the boundary the
  domain cares about. A rule that lives only in a prompt cannot be tested, cannot be
  reused, and is wrong in a way nobody notices until a date is wrong.
- **State what you do not know.** Every plugin ships a confidence statement and a
  list of open questions. A plugin with no open questions has either been reviewed by
  a practitioner or has not been thought about hard enough. Never present a guessed
  rule as verified.
- **Claims need sources.** A category comparison is fine. A statement about another
  product's features needs a source and a date, or it does not get written. Never
  imply an affiliation with a named product.
- **No invented numbers** anywhere on the public page.
- **Marketing copy may not contradict the confidence statement.**

## Baseline measurement

Phase 1.4 needs what models answer today. Query what you can reach, and where you
cannot, hand the user the exact list of questions to run and record their answers
verbatim. Do not estimate a baseline; an invented before-picture makes phase 6
meaningless.

## Publication requirements

A plugin is not publishable until all of these exist. They are what turns a correct
plugin into a findable one.

| Requirement | Where |
| --- | --- |
| Catalogue entry: name, one-sentence summary, domain category, keywords | `manifest.ts` |
| Preview image rendered from the example timeline | `preview.png` |
| Link to the example timeline on the public instance | plugin `README.md` |
| Agent tool reference | plugin `README.md` |
| Domain confidence and open questions | plugin `README.md` |
| Contribution call naming the open questions | plugin `README.md` |
| `plugins:catalogue:check` green | CI |

## Done

The repository's done gate applies: committed, pushed, deploy green, with the push
as a separate explicit step after the user has tested.

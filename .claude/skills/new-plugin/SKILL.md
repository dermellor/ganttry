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

## Before anything: what exists, and the two boundaries

Everything the playbook asks for is built: `manifest.tools` with pure-function
handlers, catalogue metadata, `npm run plugins:catalogue`, and
`npm run plugins:preview`. Do not describe any of them as missing.

Two boundaries remain, both about *where* a tool runs and neither a reason to skip
phase 0's fourth question:

- an installed **artifact's** tools do not run (only in-tree plugins are wired in);
- the **remote** MCP server carries no plugin tools
  ([#108](https://github.com/zeitlines/zeitlines/issues/108)).

Build in-tree unless the user asked otherwise, and the boundaries do not apply.
Where a requirement genuinely cannot be met, name it in the report rather than
silently dropping it from the checklist.

## Constraints that bite in the first ten minutes

- **The id is reverse-DNS** from a domain the author owns: `com.acme.sprints`, at
  least two lowercase labels. `sprints` is refused, and `register()` throws on an
  invalid manifest at module load — which takes the app down rather than skipping
  the plugin.
- **`apiVersion` is `"^1"`, or `"^1.3"` if the plugin declares `tools`.**
- **Copy [`src/plugins/_template/`](../../../src/plugins/_template/)**, which
  carries the manifest, the descriptor, `fields.ts`, `tools.ts` and their tests in
  the shape the host expects. Delete what the plugin does not have; do not
  reverse-engineer the wiring from `product-roadmap`.
- **There is no interface for enabling a plugin**
  ([#85](https://github.com/zeitlines/zeitlines/issues/85)). On a database timeline
  use the `configure_plugin` MCP tool; in a local example file, the `plugins` array
  — and there it needs `"public": true`, or the build strips the plugin's rows and
  the example renders as a plain timeline.

## Single plugin: stop points

Do not run these phases together. Each ends with something the user has to see.

- **After phase 0**, report which of the four shapes the plugin has (fields, data,
  view, tools) and whether any core file would have to change. If one would, stop and
  say so: that is a finding for
  [#10](https://github.com/zeitlines/zeitlines/issues/10) or
  [#11](https://github.com/zeitlines/zeitlines/issues/11), not something to work
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

- **The orchestrator writes every registry line itself, after the subagents
  finish.** The single `register()` line in
  [`src/pluginHost/registry.ts`](../../../src/pluginHost/registry.ts) is the only
  collision point for an in-tree plugin, and the runtime loader did not remove it
  (it reads an installed *artifact's* manifest). Never let subagents edit that file
  concurrently.
- **Regenerate `PLUGINS.md` once, at the end.** It is derived from the manifests, so
  a subagent has no reason to touch it and two that do will conflict.
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

| Requirement | Where | How it is checked |
| --- | --- | --- |
| Catalogue entry: summary, domain, keywords, example | `manifest.ts` → `catalogue` | `plugins:catalogue:check` |
| Example timeline, with `"public": true` on the plugin entry | `data/<slug>.json` | `schema:check` validates it; without the flag the rows are stripped |
| Preview image from that timeline | `preview.png` | `plugins:catalogue:check` requires the file; `npm run plugins:preview -- <folder>` makes it |
| Regenerated catalogue page | `PLUGINS.md` | `plugins:catalogue:check` compares it |
| Agent tool reference | plugin `README.md` | review |
| Domain confidence and open questions | plugin `README.md` | review |
| Contribution call naming the open questions | plugin `README.md` | review |

The preview image is the one generated artefact CI cannot regenerate (it needs a
browser), so a stale one passes the check. Re-render it whenever the view changes.

## Done

The repository's done gate applies: committed, pushed, deploy green, with the push
as a separate explicit step after the user has tested.

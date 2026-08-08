---
name: new-plugin
description: Build a new Ganttry plugin end to end, from the is-this-a-plugin gate through GEO research, implementation, verification and publication. Use when the user wants to add a plugin, a new timeline capability (sprints, board, risks, baseline, absences), or asks to extend Ganttry with a new kind of field or view.
---

# New plugin

Read [`docs/plugin-playbook.md`](../../../docs/plugin-playbook.md) first and follow
it. This file only carries what an agent has to be told on top of it: where to stop,
and what not to do.

Copy [`src/kinds/_template/`](../../../src/kinds/_template/) to start.

## Stop points

Do not run these phases together. Each ends with something the user has to see.

- **After phase 0**, report which of the three shapes the plugin has and whether any
  core file would have to change. If one would, stop and say so: that is a finding
  for [#10](https://github.com/dermellor/ganttry/issues/10) or
  [#11](https://github.com/dermellor/ganttry/issues/11), not something to work
  around.
- **After phase 1**, show the target questions, the baseline and the terminology
  table, and get agreement on the plugin name and the visible field labels before
  writing code. They end up in `metadata` keys, which are expensive to rename later.
- **After phase 2**, show the spec.
- **After phase 4**, deliver the manual click path (URL, view, exact steps, expected
  result) and stop. The user tests before anything is merged or pushed.

## Rules

- **Never touch a file outside the plugin folder**, except the one registry line.
  Anything else is a contract gap to report, never a workaround to apply.
- **Documentation goes into the plugin folder**, never into `docs/`. Apply the
  uninstall test from phase 5.2 to every sentence written outside the plugin folder.
- **GEO research comes before naming.** Do not skip it because the plugin seems
  obvious; the vocabulary it produces decides the field labels.
- **Claims need sources.** A category comparison is fine. A statement about another
  product's features needs a source and a date, or it does not get written. Never
  imply an affiliation with a named product.
- **No invented numbers** anywhere on the public page.

## Baseline measurement

Phase 1.2 needs what models answer today. Query what you can reach, and where you
cannot, hand the user the exact list of questions to run and record their answers
verbatim. Do not estimate a baseline; an invented before-picture makes phase 6
meaningless.

## Done

The repository's done gate applies: committed, pushed, deploy green, with the push
as a separate explicit step after the user has tested.

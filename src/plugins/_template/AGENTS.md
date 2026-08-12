# <Plugin name>

TEMPLATE. Conventions for changing **this plugin**. Rules that apply to the whole
codebase stay in the root [`AGENTS.md`](../../../AGENTS.md); do not restate them
here, because a copy is how one of them ends up fixed and the other does not.

What belongs in this file:

- **The plugin's own invariants**, each with the failure mode it prevents. A rule
  without its reason gets refactored away by the next reader.
- **Where its data lives** and what may write it.
- **What must not be touched**, and why. Metadata keys already stored on items are
  the usual case: renaming one silently drops every existing value.
- **The domain rules and where they are grounded.** For every rule in `tools.ts`,
  whether it is verified, plausible or guessed. A rule nobody can trace to a source
  gets „improved" into a different wrong rule by the next reader.
- **The verification path**: which tests cover the derivation and the rules, which
  example timeline demonstrates it, what has to be clicked to check it by hand.

What does not belong here:

- Anything a reader needs in order to *use* the plugin. That is `README.md`, which
  is also the public page.
- Anything about the generic core. If a rule here describes the core, it is in the
  wrong file, and probably a finding for
  [#11](https://github.com/dermellor/zeitlines/issues/11).

## Invariants

- …

## Data

- …

## Domain rules

| Rule | Where | Grounded in | Confidence |
| --- | --- | --- | --- |
| … | `tools.ts` | … | verified / plausible / guessed |

## Verification

- …

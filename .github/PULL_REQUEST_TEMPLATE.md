## What breaks without this change

<!-- The failure mode, not just the feature name. If it is a bug fix, what went
wrong and why. This is also what belongs in the commit message. -->

## How you verified it

<!-- Tests, a click-through, a screenshot for anything visual. Rendering
behaviour is much of this project and tests cannot capture all of it. -->

## Checklist

- [ ] `npm test` green
- [ ] `npm run build` succeeds with no credentials configured
- [ ] `npm run typecheck` reports no *new* errors (7 are pre-existing)
- [ ] `AGENTS.md` updated if behaviour, schema or a convention changed
- [ ] No credentials, and no timeline data that is not yours to publish

# The reach harvest

Playbook phase 1.3 to 1.5 for this plugin: the questions, where each came from, what
the pages that answer them today do and leave out, and which pages that justifies.

**Harvested on 2026-08-13.** A result page is a measurement of one day, so every entry
carries that date. Re-run the harvest rather than trusting this file a year from now.

## What could not be measured

- **No search volume.** That needs a tool with data access, and there is none here. No
  number in this file is a demand figure, and no proxy (result counts, autocomplete) is
  presented as one.
- **Two page teardowns failed and were not worked around.** `bigpicture.one`'s
  „sprints on a Gantt chart" article answers a 429 to automated fetches and now
  redirects to `appfire.com` after the acquisition; a Plane listicle returned nothing
  extractable. What is recorded below from those results is the **result page** itself
  (title, snippet, position), which is evidence of what the answer looks like, not of
  what the page argues.
- **The baseline (1.4) is outstanding.** It needs the questions below put to several
  models, and whoever does that has to be able to reach them. Until it exists, phase 6
  is skipped explicitly.

## The questions, and where they came from

| Question | Where it came from | What answers it today |
| --- | --- | --- |
| „self-hosted sprint planning tool open source burndown" | search, EN | listicles: `ones.com` „10 self-hosted sprint management platforms", `plane.so` „11 Jira alternatives you can self-host", `openalternative.co`, `thedigitalprojectmanager.com`. Then tool pages: Taiga, OpenProject, ZenTao, Plane, Redmine + Agile plugin |
| „selbst gehostetes Scrum Tool Open Source Sprint Burndown" | search, DE | the same shape in German: Capterra directories, `alltena.com` comparison, `opensourcescrum.com`, plus Taiga and OpenProject again. **Kunagi** appears only in the German results |
| „gantt chart with sprints roadmap same view" | search, EN | **theory**, not tools: „Gantt chart vs roadmap" from Smartsheet, ProductPlan, GanttPRO, Fibery, Atlassian. The one product answer is a Jira add-on (BigPicture/Appfire) |
| „why does my sprint show the wrong items, dates versus sprint assignment" | search, EN | vendor documentation and forum answers, all about **priority**: „Issue Start/End Date Fields have higher priority than sprint dates" (ActivityTimeline), and Jira's Advanced Roadmaps setting „Use sprint dates when issues don't have start and end dates" — where **both** date fields have to be empty for the sprint to decide |
| „burndown chart not accurate, staircase, wrong remaining work" | search, EN | Atlassian's own tutorial, Azure DevOps documentation, Appfire's „burndown chart 101", and a blog titled „Your Jira Burndown Chart Is Lying To You". The consensus explanation is **team behaviour**: stories too large, updates in batches |
| „Sprint Goal — wo dokumentiere ich es" | search, DE/EN | scrum.org, Scrum Alliance, Parabol: how to *write* one, and that it is added to the Sprint Backlog. Nothing about where a tool keeps it; in the tools it is a nullable text field |
| „Sprint-Planung und Roadmap doppelt pflegen" | search, DE | Miro templates, monday.com and Atlassian guides. Every answer is „sync the two tools" or „use one platform" |

## What the answers have in common, and what they leave out

Three observations, and each one is a hole this plugin can answer:

1. **The dates-versus-sprint question has exactly one mainstream answer: give up one of
   them.** Clear the item's dates and the sprint decides, or keep them and the sprint is
   ignored. Nobody offers „keep both and tell me when they disagree", which is what a
   plan drawn on a date axis actually needs.
2. **The burndown's accuracy problem is discussed as a team problem, never as a data
   problem.** The staircase is blamed on batch updates and oversized stories. That a
   curve reconstructed from current records describes *when somebody typed*, and that a
   past sprint's chart silently rewrites itself when an item is edited afterwards, is
   not what those pages are about.
3. **„Self-hosted sprint tool" is answered by inventories.** Ten tools, a table of
   features, no position. A page that says what it does *not* do, and why, is not in
   that set.

The German half is thinner than the English half and answered mostly by directories,
which is worth knowing before deciding what language a page is written in.

## The pages this justifies

| Intent | Page | Status |
| --- | --- | --- |
| „what is it / how does it work" | `/plugins/sprints` | exists, rewritten from this harvest |
| „X versus Y", „how do other tools do this" | a comparison of how six products model a sprint | written from the sourced material in `model.md` |
| „how do I run a real job with this" | a use case: one plan carrying a roadmap and its sprints | **not written yet** |

The comparison page is the one this harvest most clearly asks for: the questions that
have real answers today are answered by inventories, and the material to do better —
what Jira, Azure DevOps, Linear, GitHub Projects, YouTrack, OpenProject and Taiga
actually store — is already collected with sources in
[`model.md`](model.md). The claim rules from playbook 1.7 govern every line of it.

## Language

The site is English. Half of these questions were harvested in German, and the German
results are answered by directories rather than by pages with a position, which makes
that the weaker-defended half. No German page exists and none is planned here; this
paragraph is the record of that being a decision rather than an oversight.

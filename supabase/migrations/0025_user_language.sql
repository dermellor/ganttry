-- The interface language becomes a property of the reader (#153).
--
-- It used to be a property of the *source*: the strings were German literals where
-- they were rendered, so „which language" was answered by the build for everybody
-- at once. One deployment has German and English speakers looking at the same
-- timelines, so the grain was wrong — and `app_users` is where per-person facts
-- already live (docs/users.md), which makes this a column rather than a new table.
--
-- ---- why the column is nullable, and has no default --------------------------
--
-- Three different questions decide what somebody sees, and collapsing them into a
-- column default gets one of them wrong (src/i18n/locale.ts, `resolveLocale`):
--
--   1. What did this person choose?          → this column
--   2. What does somebody who never chose    → TIMELINES_DEFAULT_LANGUAGE,
--      get on THIS deployment?                 the operator's answer, in the
--                                              instance profile
--   3. What does a deployment that said      → the product default, 'en'
--      nothing at all speak?
--
-- A `default 'en'` would answer (1) with (3) and materialise a choice nobody made:
-- the row would then say „chose English" and stop following the deployment's own
-- answer the moment an operator set one. NULL means „has not chosen", which is a
-- different fact from „chose the default" and the only one that is true.
--
-- No check constraint, for the reason `saved_views.visibility` has none and
-- `timelines.group_order` has none: the reader normalises anything it does not
-- recognise back to the fallback chain (`normalizeLocale`), so a bad value degrades
-- to today's behaviour instead of failing a write. A constraint would also have to
-- be migrated for every language added.

alter table public.app_users
  add column if not exists language text;

comment on column public.app_users.language is
  'Interface language chosen by this person (de|en). Null = never chosen: falls back to TIMELINES_DEFAULT_LANGUAGE, then to the product default.';

-- ---- the backfill, and why it is not a default -------------------------------
--
-- Every person who is ALREADY in this directory has been working in a German
-- interface, because that is the only one that existed before this migration. They
-- get that recorded as an explicit choice, so the day this ships changes nothing
-- for anybody already using the deployment.
--
-- This is deliberately a one-time statement about the rows that exist at this
-- instant, not a rule about the table:
--
--   * A person who joins AFTER this migration has never seen the German interface
--     and is not covered by it. They get the deployment's own answer
--     (TIMELINES_DEFAULT_LANGUAGE) — which is why that variable exists, and why an
--     operator whose team works in German sets it rather than relying on this.
--   * `where language is null` makes it idempotent: re-running never overwrites a
--     choice somebody has since made. `db:migrate` checksums applied migrations,
--     but a restored dump replayed against a live database would otherwise silently
--     reset every English speaker back to German.
--
-- **Safe on an empty table**, which is the normal case rather than the exception: a
-- fresh install, a file-backed deployment and every CI run have no rows here, and
-- this updates none of them. There is no seeding step and nothing to configure —
-- an empty directory simply falls through to the two defaults above.

update public.app_users
   set language = 'de'
 where language is null;

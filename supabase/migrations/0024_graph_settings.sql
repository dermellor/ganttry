-- Three timeline settings the relation graph reads, given somewhere to be stored.
--
-- They arrived as fields on `TimelineFile` and were only ever readable: a
-- directory source carries them in its `timeline.json` and can be hand-edited, a
-- database timeline had no column for any of them. So the client read a setting
-- that could not be set — which is worse than the setting not existing, because a
-- field that is read announces itself as supported. Somebody configuring a
-- DB-backed timeline finds it documented, cannot change it, and cannot tell
-- whether they mistyped the key or whether the feature does not reach their source
-- kind (#137).
--
-- All three are additive and nullable, so an existing timeline keeps behaving
-- exactly as before: absent `group_order` means the alphabetical sort every
-- timeline shipped with, absent `graph` means anonymous bands, absent `color`
-- means the positional lane palette.

-- A group's own colour, any CSS colour. The lane palette answers „which track is
-- this" by position; this answers „what kind of thing is this", which is the
-- author's statement and not something the code can hold. Same shape as
-- `timeline_phases.color` and a custom field's option colour.
alter table public.timeline_groups
  add column if not exists color text;

-- 'alpha' (the default and what every timeline shipped with) or 'declared'.
--
-- No check constraint, deliberately, and for the same reason `saved_views.visibility`
-- has none: the reader treats anything other than 'declared' as 'alpha'
-- (src/groupOrder.ts), so an unexpected value degrades to today's behaviour rather
-- than breaking a page. A constraint would buy a loud write-time error at the cost
-- of a migration for every future ordering rule.
alter table public.timelines
  add column if not exists group_order text;

-- `GraphConfig`: which group supplies band roots, which group is shown as
-- references on a node. jsonb rather than two columns because it is one
-- declaration about one presentation and it will grow — a column per future key
-- means a migration per future key.
alter table public.timelines
  add column if not exists graph jsonb;

comment on column public.timeline_groups.color is
  'CSS colour for this group, honoured by the relation graph. Null = positional lane palette.';
comment on column public.timelines.group_order is
  'alpha (default) or declared: whether groups[] order is honoured or ids are sorted.';
comment on column public.timelines.graph is
  'GraphConfig: bandRootGroup, referenceGroup. Null = anonymous bands, no reference lines.';

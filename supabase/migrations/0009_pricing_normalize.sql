-- Normalize the pricing model out of the single `timelines.pricing` jsonb blob
-- into per-row tables, so edits become granular and collision-free — mirroring
-- the item-level optimistic-locking pattern of `timeline_items`.
--
-- Why: the whole model lived in one jsonb cell, so EVERY writer (browser, MCP,
-- bulk PUT) replaced it wholesale (last-write-wins). Parallel edits clobbered
-- each other and the MCP could only take a complete dump. Splitting into rows
-- gives per-feature / per-tier `version` locking and lets two people edit
-- different matrix cells (tier×feature) without touching the same row.
--
-- This migration is ADDITIVE and non-breaking: the legacy `timelines.pricing`
-- column stays in place and is left untouched (old code keeps reading it). The
-- backfill at the bottom populates the new tables from it. The column is dropped
-- only later, in 0010, AFTER the code that reads the new tables is deployed.
--
-- The `version` INTEGER column on the versioned tables is the optimistic-lock
-- counter (reuses the existing bump_row_version() trigger). It is unrelated to a
-- pricing "version" label (e.g. "2.0"); that domain field is `available_from` on
-- pricing_features, deliberately renamed to avoid the name clash. The ordered
-- list of version labels is kept small and whole-replaced, so it lives as a
-- jsonb array column on the timeline row (like `phases`), not as its own table.

alter table public.timelines
  add column if not exists pricing_versions jsonb not null default '[]'::jsonb;

-- ---- features --------------------------------------------------------------
create table if not exists public.pricing_features (
  timeline_id            text    not null references public.timelines(id) on delete cascade,
  id                     text    not null,
  name                   text    not null default '',
  "group"                text,                                  -- matrix section label
  description            text,
  available_from         text,                                  -- = PricingFeature.version (version label it's available from)
  name_by_version        jsonb   not null default '{}'::jsonb,  -- version-scoped name overrides (cumulative)
  description_by_version jsonb   not null default '{}'::jsonb,  -- additive version-scoped description notes (PR #22)
  sort                   integer,                               -- preserves matrix row order
  version                integer not null default 1,           -- optimistic-lock counter (NOT a pricing version)
  updated_at             timestamptz not null default now(),
  updated_by             text,
  primary key (timeline_id, id)
);
-- `create table if not exists` skips entirely when the table already exists, so
-- this ALTER makes the description_by_version column land on a re-run against an
-- environment where 0009 created the table before the column existed.
alter table public.pricing_features
  add column if not exists description_by_version jsonb not null default '{}'::jsonb;

-- ---- tiers -----------------------------------------------------------------
create table if not exists public.pricing_tiers (
  timeline_id  text    not null references public.timelines(id) on delete cascade,
  id           text    not null,
  name         text    not null default '',
  tagline      text,
  use_case     text,
  target_group text,
  price        text    not null default '',
  sort         integer,
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  primary key (timeline_id, id)
);

-- ---- tier×feature values (the matrix, cell-granular) -----------------------
-- One row per set cell. A cell is either a boolean `true` (included) or a string
-- (verbatim value). Absent row = not included (–). Deleting a feature or tier
-- cascades away its value rows (FKs below), so no manual cleanup on delete.
-- No `version` column: a single cell is atomic; two editors touching different
-- cells hit different rows and never conflict, and same-cell is last-write-wins
-- (acceptable for one scalar). `updated_at`/`updated_by` are set in the repo.
create table if not exists public.pricing_tier_values (
  timeline_id text  not null references public.timelines(id) on delete cascade,
  tier_id     text  not null,
  feature_id  text  not null,
  value       jsonb not null,                             -- true | "3.000" (bool | string)
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (timeline_id, tier_id, feature_id),
  foreign key (timeline_id, tier_id)    references public.pricing_tiers(timeline_id, id)    on delete cascade,
  foreign key (timeline_id, feature_id) references public.pricing_features(timeline_id, id) on delete cascade
);

-- ---- highlights (curated card tiles) ---------------------------------------
-- feature_ids stays a text[] (not FK-enforced): a highlight bundles raw feature
-- ids, and deleting a feature strips it from these arrays in the repo layer.
create table if not exists public.pricing_highlights (
  timeline_id      text    not null references public.timelines(id) on delete cascade,
  id               text    not null,
  label            text    not null default '',
  section          text,
  icon             text,
  feature_ids      text[]  not null default '{}',
  description      text,
  label_by_version jsonb   not null default '{}'::jsonb,
  sort             integer,
  version          integer not null default 1,
  updated_at       timestamptz not null default now(),
  updated_by       text,
  primary key (timeline_id, id)
);

create index if not exists pricing_features_timeline_idx    on public.pricing_features(timeline_id);
create index if not exists pricing_tiers_timeline_idx        on public.pricing_tiers(timeline_id);
create index if not exists pricing_tier_values_timeline_idx  on public.pricing_tier_values(timeline_id);
create index if not exists pricing_highlights_timeline_idx   on public.pricing_highlights(timeline_id);

-- Reuse the generic version-bump trigger on the three versioned tables.
drop trigger if exists pricing_features_version on public.pricing_features;
create trigger pricing_features_version
  before update on public.pricing_features
  for each row execute function public.bump_row_version();

drop trigger if exists pricing_tiers_version on public.pricing_tiers;
create trigger pricing_tiers_version
  before update on public.pricing_tiers
  for each row execute function public.bump_row_version();

drop trigger if exists pricing_highlights_version on public.pricing_highlights;
create trigger pricing_highlights_version
  before update on public.pricing_highlights
  for each row execute function public.bump_row_version();

-- RLS + anon read policies + realtime, mirroring 0003 for the item tables.
alter table public.pricing_features   enable row level security;
alter table public.pricing_tiers       enable row level security;
alter table public.pricing_tier_values enable row level security;
alter table public.pricing_highlights  enable row level security;

-- Idempotent (drop-then-create) so re-running 0009 doesn't error on the policy.
drop policy if exists "anon read pricing_features"    on public.pricing_features;
drop policy if exists "anon read pricing_tiers"        on public.pricing_tiers;
drop policy if exists "anon read pricing_tier_values"  on public.pricing_tier_values;
drop policy if exists "anon read pricing_highlights"   on public.pricing_highlights;
create policy "anon read pricing_features"    on public.pricing_features    for select to anon using (true);
create policy "anon read pricing_tiers"        on public.pricing_tiers        for select to anon using (true);
create policy "anon read pricing_tier_values"  on public.pricing_tier_values  for select to anon using (true);
create policy "anon read pricing_highlights"   on public.pricing_highlights   for select to anon using (true);

-- Add each table to the realtime publication only if not already a member
-- (alter publication ... add table errors on a duplicate).
do $$
declare t text;
begin
  foreach t in array array['pricing_features','pricing_tiers','pricing_tier_values','pricing_highlights'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---- backfill from the legacy timelines.pricing jsonb ----------------------
-- Idempotent (on conflict do nothing / value-set update): safe to re-run. Order
-- matters — features and tiers first, then the value rows (their FKs point at
-- both), then highlights and the versions array.

insert into public.pricing_features (timeline_id, id, name, "group", description, available_from, name_by_version, description_by_version, sort)
select t.id,
       f->>'id',
       coalesce(f->>'name', ''),
       f->>'group',
       f->>'description',
       f->>'version',
       coalesce(f->'nameByVersion', '{}'::jsonb),
       coalesce(f->'descriptionByVersion', '{}'::jsonb),
       (fa.ord - 1)::integer
from public.timelines t
cross join lateral jsonb_array_elements(t.pricing->'features') with ordinality as fa(f, ord)
where jsonb_typeof(t.pricing->'features') = 'array'
  and coalesce(f->>'id', '') <> ''
on conflict (timeline_id, id) do nothing;

-- Backfill description_by_version onto feature rows that were inserted before
-- this column existed (a re-run of 0009). Guarded to the still-default value so
-- it never overwrites a note edited via the new code after the first run.
with src as (
  select t.id as timeline_id, fe->>'id' as feature_id, fe->'descriptionByVersion' as dbv
  from public.timelines t
  cross join lateral jsonb_array_elements(t.pricing->'features') as fe
  where jsonb_typeof(t.pricing->'features') = 'array'
    and jsonb_typeof(fe->'descriptionByVersion') = 'object'
)
update public.pricing_features pf
set description_by_version = src.dbv
from src
where src.timeline_id = pf.timeline_id
  and src.feature_id = pf.id
  and pf.description_by_version = '{}'::jsonb;

insert into public.pricing_tiers (timeline_id, id, name, tagline, use_case, target_group, price, sort)
select t.id,
       tr->>'id',
       coalesce(tr->>'name', ''),
       tr->>'tagline',
       tr->>'useCase',
       tr->>'targetGroup',
       coalesce(tr->>'price', ''),
       (ta.ord - 1)::integer
from public.timelines t
cross join lateral jsonb_array_elements(t.pricing->'tiers') with ordinality as ta(tr, ord)
where jsonb_typeof(t.pricing->'tiers') = 'array'
  and coalesce(tr->>'id', '') <> ''
on conflict (timeline_id, id) do nothing;

-- Values: one row per (tier, feature) cell. Skip cells whose feature id has no
-- matching feature row (dangling refs in the old blob) so the FK insert can't
-- abort the migration.
insert into public.pricing_tier_values (timeline_id, tier_id, feature_id, value)
select t.id, tr->>'id', kv.key, kv.value
from public.timelines t
cross join lateral jsonb_array_elements(t.pricing->'tiers') as ta(tr)
cross join lateral jsonb_each(tr->'values') as kv(key, value)
where jsonb_typeof(t.pricing->'tiers') = 'array'
  and jsonb_typeof(tr->'values') = 'object'
  and coalesce(tr->>'id', '') <> ''
  and exists (select 1 from public.pricing_features pf where pf.timeline_id = t.id and pf.id = kv.key)
on conflict (timeline_id, tier_id, feature_id) do nothing;

insert into public.pricing_highlights (timeline_id, id, label, section, icon, feature_ids, description, label_by_version, sort)
select t.id,
       h->>'id',
       coalesce(h->>'label', ''),
       h->>'section',
       h->>'icon',
       coalesce((select array_agg(x) from jsonb_array_elements_text(h->'featureIds') as x), '{}')::text[],
       h->>'description',
       coalesce(h->'labelByVersion', '{}'::jsonb),
       (ha.ord - 1)::integer
from public.timelines t
cross join lateral jsonb_array_elements(t.pricing->'highlights') with ordinality as ha(h, ord)
where jsonb_typeof(t.pricing->'highlights') = 'array'
  and coalesce(h->>'id', '') <> ''
on conflict (timeline_id, id) do nothing;

update public.timelines
set pricing_versions = coalesce(pricing->'versions', '[]'::jsonb)
where jsonb_typeof(pricing->'versions') = 'array'
  and pricing_versions = '[]'::jsonb;

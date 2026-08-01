-- Generic per-timeline plugin registry.
--
-- A "plugin" (a.k.a. timeline kind, e.g. 'product-roadmap') is enabled on a
-- timeline by the mere existence of a row here — no schema change, no core
-- column. This replaces the two plugin-specific leaks on the `timelines` table:
--   - `timelines.type = 'product'`   (the product-roadmap gate)
--   - `timelines.pricing_versions`   (the product-roadmap ordered version list)
-- both of which are dropped in 0013 once the code reads/writes this table.
--
-- `config` is the plugin's own opaque bag; for 'product-roadmap' it holds
-- `{ "versions": [...] }` (the ordered version labels that used to live in the
-- dropped `pricing_versions` column). The normalized pricing_* tables are
-- unchanged — they are plugin-owned tables, not columns on a core table, so they
-- were never the problem this migration solves.

create table if not exists public.timeline_plugins (
  timeline_id text  not null references public.timelines(id) on delete cascade,
  plugin_id   text  not null,                        -- e.g. 'product-roadmap'
  config      jsonb not null default '{}'::jsonb,    -- plugin-owned settings, e.g. { versions: [...] }
  updated_at  timestamptz not null default now(),
  primary key (timeline_id, plugin_id)
);

create index if not exists timeline_plugins_timeline_idx on public.timeline_plugins(timeline_id);

alter table public.timeline_plugins enable row level security;

-- anon SELECT for the Realtime subscription path (mirrors the pricing_* tables).
-- Writes stay server-side via the service key.
drop policy if exists "anon read timeline_plugins" on public.timeline_plugins;
create policy "anon read timeline_plugins" on public.timeline_plugins for select to anon using (true);

-- Add to the realtime publication only if not already a member (add table errors
-- on a duplicate).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'timeline_plugins'
  ) then
    alter publication supabase_realtime add table public.timeline_plugins;
  end if;
end $$;

-- ---- backfill from the columns 0013 drops -------------------------------------
-- Every timeline that was a product timeline (`type = 'product'`) becomes a
-- product-roadmap plugin registration, carrying its version list into config.
-- Idempotent (on conflict do nothing): safe to re-run.
insert into public.timeline_plugins (timeline_id, plugin_id, config)
select id,
       'product-roadmap',
       jsonb_build_object('versions', coalesce(pricing_versions, '[]'::jsonb))
from public.timelines
where type = 'product'
on conflict (timeline_id, plugin_id) do nothing;

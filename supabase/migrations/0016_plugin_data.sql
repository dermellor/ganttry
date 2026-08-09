-- Generic storage for the rows a plugin owns.
--
-- A plugin installed at runtime can never ship a migration: it would have to run
-- DDL on somebody else's database at install time, and uninstalling it cleanly
-- would be impossible. So the storage a plugin needs has to exist BEFORE the
-- plugin does, which is what this table is. Uninstalling is then a delete, not a
-- drop.
--
-- What Postgres normally enforces per plugin-owned table — the column shape, the
-- foreign keys, the row order, a composite primary key for a row that has no id
-- of its own — is declared in the plugin's manifest instead and enforced in the
-- write path (src/pluginHost/dataStore.ts). That is a real trade and it is
-- written down in docs/plugin-storage.md → „What is given up": a write that
-- bypasses the API (psql, a script) is no longer checked. Since a plugin cannot
-- ship DDL at all, the host's write path is the only place those rules can live.
--
-- Note this table does NOT replace the pricing_* tables yet. product-roadmap
-- moves onto it in issue #17, which is also the test of whether this design is
-- sufficient; until then both exist and this one is empty on existing instances.

create table if not exists public.plugin_data (
  timeline_id text        not null references public.timelines(id) on delete cascade,
  plugin_id   text        not null,                     -- e.g. 'product-roadmap'
  collection  text        not null,                     -- declared in the manifest, e.g. 'features'
  row_id      text        not null,                     -- the plugin's own id, or its derived composite key
  data        jsonb       not null default '{}'::jsonb, -- the plugin's object; shape checked against the manifest
  sort        integer,                                  -- reproduces array order for an `ordered` collection
  version     integer     not null default 1,           -- optimistic-lock counter (bump_row_version trigger)
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (timeline_id, plugin_id, collection, row_id)
);

-- The primary key already serves every lookup by (timeline, plugin, collection),
-- which is how rows are read. The GIN index serves the one query that is not a
-- prefix of it: the cascade, which asks „which rows reference this id" as a
-- containment test (`data @> '{"tierId": "..."}'`). jsonb_path_ops is the
-- narrower operator class — it supports exactly `@>`, and is smaller and faster
-- to maintain than the default, which also indexes key-existence operators that
-- nothing here uses.
create index if not exists plugin_data_data_idx on public.plugin_data using gin (data jsonb_path_ops);

-- Reuse the generic version-bump trigger, so an If-Match write is rejected the
-- same way it is for an item or a pricing row — one locking rule, not a second.
drop trigger if exists plugin_data_version on public.plugin_data;
create trigger plugin_data_version
  before update on public.plugin_data
  for each row execute function public.bump_row_version();

-- RLS on with an anon read policy, mirroring the item and pricing tables: the
-- browser's Realtime subscription reads through the anon role, every write goes
-- through the server's service key.
alter table public.plugin_data enable row level security;
drop policy if exists "anon read plugin_data" on public.plugin_data;
create policy "anon read plugin_data" on public.plugin_data for select to anon using (true);

-- Add to the realtime publication only if not already a member (add table errors
-- on a duplicate).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'plugin_data'
  ) then
    alter publication supabase_realtime add table public.plugin_data;
  end if;
end $$;

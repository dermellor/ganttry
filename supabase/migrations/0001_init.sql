-- Timelines schema — replaces the Google-Sheets backing store.
-- One row per timeline, one row per item/group. Item-level writes with
-- optimistic version bump enable concurrent editing without whole-doc clobber.

create table if not exists public.timelines (
  id          text primary key,
  name        text,
  description text,
  group_by    text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.timeline_items (
  timeline_id text    not null references public.timelines(id) on delete cascade,
  id          text    not null,
  start       text    not null,
  "end"       text,
  duration    text,
  content     text    not null,
  "group"     text,
  type        text,
  title       text,
  body        text,
  icon        text,
  class_name  text,
  metadata    jsonb   not null default '{}'::jsonb,  -- dependsOn, owner, jira, freie Extras
  sort        integer,                               -- bewahrt Item-Reihenfolge fürs Round-Trip
  version     integer not null default 1,            -- optimistic locking pro Item
  updated_at  timestamptz not null default now(),
  updated_by  text,                                  -- Attribution (Google-Session-User)
  primary key (timeline_id, id)
);

create table if not exists public.timeline_groups (
  timeline_id   text    not null references public.timelines(id) on delete cascade,
  id            text    not null,
  content       text,
  nested_groups text[],
  show_nested   boolean,
  sort          integer,
  primary key (timeline_id, id)
);

create index if not exists timeline_items_timeline_idx  on public.timeline_items(timeline_id);
create index if not exists timeline_groups_timeline_idx on public.timeline_groups(timeline_id);

-- Bump version + updated_at on every UPDATE so stale-write detection works.
create or replace function public.bump_row_version() returns trigger as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists timeline_items_version on public.timeline_items;
create trigger timeline_items_version
  before update on public.timeline_items
  for each row execute function public.bump_row_version();

-- RLS on. Server access uses the service_role key (bypasses RLS). Anon read
-- policies for the client-side realtime subscription are added in a later
-- migration once the client talks to Supabase directly.
alter table public.timelines       enable row level security;
alter table public.timeline_items  enable row level security;
alter table public.timeline_groups enable row level security;

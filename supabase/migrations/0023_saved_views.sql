-- Named ways of looking at a timeline: a presentation, a grouping dimension and a
-- filter selection, under a name, stored where somebody else can reach them.
--
-- The display state this promotes is per person and per browser
-- (`timelines.viewPrefs` in localStorage). That answers „how am I looking at this
-- right now" and cannot answer „the way we look at this every Monday": it has no
-- name, no second reader and no address. So a saved view is a row rather than a
-- key, and `visibility` is what makes it somebody else's to read.
--
-- Owned by an address rather than by a member id, for the same reason
-- `timeline_items.metadata.owner` stores one: membership rows are never deleted
-- (docs/users.md → „Removal is a status"), so an address stays resolvable, and a
-- deployment that has not turned access control on has addresses but no members.
--
-- No `sort` column, unlike plugin_data. An explicit order needs a move endpoint
-- and a rule for what reordering a shared list does to everybody else's position;
-- the picker sorts by name, which needs none of that and is what makes a view
-- findable in the first place.

create table if not exists public.saved_views (
  timeline_id text        not null references public.timelines(id) on delete cascade,
  id          text        not null,                     -- slug, unique per timeline; travels as `sv=<id>`
  name        text        not null,
  mode        text,                                     -- a ViewMode: timeline / list / plugin:<id>:<view>
  group_by    text,                                     -- 'group', 'tag', 'cf:<key>', …
  filters     jsonb       not null default '{}'::jsonb, -- selected values per dimension
  owner       text,                                     -- address of whoever created it
  visibility  text        not null default 'private',   -- 'private' | 'instance'
  version     integer     not null default 1,           -- optimistic-lock counter (bump_row_version trigger)
  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (timeline_id, id),
  -- A value outside the two the host knows would be neither private nor shared,
  -- and every read would have to guess which. Checked here as well as in the write
  -- path, because a psql session reaches the table without passing the host.
  constraint saved_views_visibility_check check (visibility in ('private', 'instance'))
);

-- The primary key serves a lookup by (timeline, id). The other query the API makes
-- is „everything on this timeline this caller may see", which filters on owner and
-- visibility after a prefix scan of the key — cheap at the scale a timeline's
-- saved views live at (tens, not thousands), so no second index is warranted.

-- The same locking rule as an item or a plugin row, from the same trigger: an
-- If-Match write is rejected identically wherever it lands.
drop trigger if exists saved_views_version on public.saved_views;
create trigger saved_views_version
  before update on public.saved_views
  for each row execute function public.bump_row_version();

-- RLS on, with no anon policy at all — unlike the item and plugin_data tables.
--
-- Those are read through the anon role by the browser's Realtime subscription,
-- which is fine for content the timeline already serves to whoever is past the
-- gate. A private saved view is not that: it is the one row here whose whole point
-- is that another signed-in member cannot read it, and an anon select policy would
-- hand every one of them to any client holding the publishable key. Reads go
-- through the server's service key, which is where the visibility filter runs.
alter table public.saved_views enable row level security;

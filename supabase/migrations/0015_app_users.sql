-- User directory: the people an item's Owner can be linked to.
--
-- `metadata.owner` used to be free text, so "Robin", "robin" and "R. Fischer"
-- were three different owners and a typo was invisible. It now carries an e-mail
-- — a stable id — and this table is what an e-mail resolves to for display.
--
-- Deliberately NOT timeline-scoped and NOT a membership list: the app is gated to
-- an allowed sign-in domain, so "everyone who has used this deploy" is already
-- the right candidate set. It fills itself — serving `GET /api/users` upserts the
-- caller (see handleUsersApi in scripts/db/api.ts) — so there is no seeding step
-- and no list to maintain by hand.
--
-- No `version` column and no optimistic locking: a row holds no user-authored
-- content, only the identity the auth provider already asserted. Nothing here can
-- be edited into conflict.

create table if not exists public.app_users (
  email         text not null primary key,
  name          text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- The directory is read as a whole, ordered for a picker.
create index if not exists app_users_name_idx on public.app_users(name nulls last, email);

alter table public.app_users enable row level security;

-- No anon policy on purpose. The pricing_*/timeline_* tables carry one so the
-- browser's Realtime subscription can read them; the directory is served through
-- the server-gated `/api/users` endpoint (service key) and never subscribed to,
-- so exposing a roster of e-mail addresses to anyone holding the public anon key
-- would buy nothing.

-- ---- backfill from existing edit attribution ---------------------------------
-- Everyone who has already created or edited an item is a real user of this
-- deploy, so seed them rather than starting empty. The `like '%@%'` filter drops
-- the two non-person actors the write path uses: 'mcp' (service token) and
-- 'local' (the dev-server identity). Idempotent — safe to re-run.
insert into public.app_users (email)
select distinct actor
from (
  select updated_by as actor from public.timeline_items
  union
  select created_by as actor from public.timeline_items
) a
where actor like '%@%'
on conflict (email) do nothing;

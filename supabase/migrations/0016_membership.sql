-- Membership: who belongs to this instance, and what they may do.
--
-- Until now a deployment had a door and no rooms. The auth gate let in every
-- Google account matching ALLOWED_EMAIL_DOMAINS, and everyone who got in could
-- read and write every timeline. `app_users` (0015) was a *display directory*
-- that filled itself, explicitly not a membership list.
--
-- This extends that same table rather than adding a second one. Once an
-- invitation is the only way in, "everyone in the directory" and "everyone who
-- is a member" are the same set, and two tables would be two copies of one
-- statement that drift the first time somebody writes to only one of them
-- (AGENTS.md → „A rule lives in exactly one place").
--
-- THE DEFAULTS ARE LOAD-BEARING. `role='editor'` / `status='active'` mean that
-- applying this migration changes nothing: every address already in the
-- directory comes out able to do exactly what it could do yesterday. The
-- behaviour change is a separate, opt-in step (TIMELINES_ACCESS_CONTROL), so a
-- deploy of this file alone can never lock anybody out of a running instance.

alter table public.app_users
  -- Instance-wide, deliberately not per timeline. Per-timeline access is a
  -- later cut; putting it here first would make every read path timeline-aware
  -- before anything enforces even the coarse rule.
  add column if not exists role text not null default 'editor'
    check (role in ('admin', 'editor', 'viewer')),

  -- `removed` rather than deleting the row: an item's `metadata.owner` stores an
  -- address (see „Item owner" in docs/items.md), so a deleted member would leave
  -- historical attributions pointing at nothing. Display resolves every status;
  -- only `active` rows are offered in the owner picker.
  add column if not exists status text not null default 'active'
    check (status in ('invited', 'active', 'suspended', 'removed')),

  add column if not exists invited_by text references public.app_users(email),
  add column if not exists invited_at timestamptz,
  add column if not exists accepted_at timestamptz,

  -- Only the hash, never the token: a database read must not yield a usable
  -- invitation. The token is a convenience and an audit device rather than an
  -- authorization — the identity provider proves the address and the row below
  -- decides — so losing it costs a resend, not access.
  add column if not exists invite_token_hash text,
  add column if not exists invite_expires_at timestamptz;

-- A token resolves to at most one row. Partial, because every accepted member
-- carries NULL here and a plain unique index would allow exactly one of them.
create unique index if not exists app_users_invite_token_uidx
  on public.app_users (invite_token_hash)
  where invite_token_hash is not null;

-- The admin screen lists by status, and the enforcement path looks a member up
-- by the primary key, which already has an index.
create index if not exists app_users_status_idx on public.app_users (status);

-- RLS stays as 0015 left it: enabled, with no anon policy. These columns are
-- read through the server-gated endpoints on the service key, and a roster of
-- addresses plus roles is the last thing to expose to the public anon key that
-- ships in the browser bundle.

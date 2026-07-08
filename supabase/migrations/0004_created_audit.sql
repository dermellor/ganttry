-- Creation audit for items: who first created a row and when. updated_at /
-- updated_by already track the *last* edit (bumped by the version trigger);
-- these add the same for the initial insert so the viewer can show
-- "created by X" next to "updated by Y".

alter table public.timeline_items
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists created_by text;

-- Backfill existing rows: they predate this column, so their best-known
-- creation time is the last-update time (better than the migration's "now()").
-- The creator stays unknown (null). Disable the version trigger for the
-- backfill — otherwise it would reset updated_at to now() and bump every
-- row's version, destroying exactly the update-audit we want to preserve.
alter table public.timeline_items disable trigger timeline_items_version;
update public.timeline_items set created_at = updated_at;
alter table public.timeline_items enable trigger timeline_items_version;

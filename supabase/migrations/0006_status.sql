-- Built-in item status: a first-class field with a fixed value set
-- (Open / Doing / Done), the same across every timeline, defaulting to Open.
-- Stored as its own column (peer of `icon`), not as a per-timeline custom field.
--
-- ADD COLUMN ... DEFAULT 'Open' backfills every existing row to 'Open' in the
-- same statement (Postgres applies the default to pre-existing rows), so all
-- current items become "Open" with no separate update pass. NOT NULL keeps the
-- field mandatory: an item always has exactly one of the three states.
--
-- Disable the version trigger for the DDL-backfill so adding the column does not
-- bump every row's version / reset updated_at (mirrors 0004_created_audit).

alter table public.timeline_items disable trigger timeline_items_version;
alter table public.timeline_items
  add column if not exists status text not null default 'Open';
alter table public.timeline_items enable trigger timeline_items_version;

-- Guard the value set at the DB level so a bad write can never store a
-- non-canonical status (the app normalises, but the constraint is the backstop).
alter table public.timeline_items
  drop constraint if exists timeline_items_status_check;
alter table public.timeline_items
  add constraint timeline_items_status_check
  check (status in ('Open', 'Doing', 'Done'));

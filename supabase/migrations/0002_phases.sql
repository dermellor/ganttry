-- Phases are a small, ordered timeline-level list (band tints), edited as a unit
-- and rarely — stored as jsonb on the timeline row rather than a normalized table.
alter table public.timelines
  add column if not exists phases jsonb not null default '[]'::jsonb;

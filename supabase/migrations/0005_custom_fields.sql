-- Custom fields are a small, per-timeline schema list (field definitions),
-- edited rarely and as config — stored as jsonb on the timeline row rather than
-- a normalized table, mirroring `phases`. Each definition is
-- { key, label, type: 'text'|'select'|'multi-select', options?: [{ value, label?, color? }] }.
-- Field *values* live per item in timeline_items.metadata under each field's key
-- (string for text/select, string[] for multi-select).
alter table public.timelines
  add column if not exists custom_fields jsonb not null default '[]'::jsonb;

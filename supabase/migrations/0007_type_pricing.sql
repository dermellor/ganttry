-- Product timelines carry a pricing model (tiers + features), edited rarely and
-- as a unit — stored as jsonb on the timeline row like `phases` / `custom_fields`.
-- `type` gates the feature: only 'product' timelines surface the pricing matrix.
-- `pricing` shape: { features: [{ id, name, group?, description? }],
--                    tiers:    [{ id, name, price, featureIds: [] }] }.
-- The model is authored in Markdown (Preismodell.md) and synced one-way into
-- this column; the viewer reads it read-only.
alter table public.timelines
  add column if not exists type    text,
  add column if not exists pricing jsonb not null default '{}'::jsonb;

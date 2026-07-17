-- Make a matrix cell's availability version-dependent.
--
-- Until now a `pricing_tier_values` row was a flat scalar (boolean `true` or a
-- string): a cell was either included or not, with no version dimension. That
-- made "included in Enterprise now, in Scale only from v4" impossible to model —
-- the rollout had to be smuggled into a feature-level description note.
--
-- This adds an optional `available_from` version label to the cell, mirroring
-- `pricing_features.available_from` (the feature-level "available from" field)
-- but one level deeper (per tier×feature). Semantics, resolved cumulatively in
-- the app (see cellActiveForVersion in src/pricing.ts):
--   * NULL            → the cell is available from the start (unchanged behaviour)
--   * a version label  → the cell counts as included only from that version on;
--                        before it, the cell renders as "–". The stored `value`
--                        is still the end-state value (shown once available).
--
-- Additive and non-breaking: existing rows get NULL and behave exactly as before.
-- No optimistic-lock counter is added — a single cell stays atomic, same as the
-- rest of pricing_tier_values (same-cell writes are last-write-wins).

alter table public.pricing_tier_values
  add column if not exists available_from text;

-- Drop the legacy `timelines.pricing` jsonb column. The pricing model now lives
-- in the normalized tables from 0009 (pricing_features / pricing_tiers /
-- pricing_tier_values / pricing_highlights) plus the `pricing_versions` array.
--
-- APPLY THIS ONLY AFTER the code that reads/writes the new tables is deployed
-- and verified. Until then the column must stay (old code still selects it).
-- Keeping both would mean two sources of truth for the same data — exactly the
-- drift trap AGENTS.md forbids ("keine Notfall-/Fallback-Daten"). This drop
-- makes the normalized tables the single source of truth.
alter table public.timelines drop column if exists pricing;

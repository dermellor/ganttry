-- Drop the two product-roadmap-specific columns from the core `timelines` table.
-- Their data now lives in `timeline_plugins` (0012): plugin enablement replaces
-- `type = 'product'`, and the ordered version list lives in the product-roadmap
-- plugin's `config.versions`.
--
-- Deliberately a SEPARATE migration from 0012 (expand/contract): deploy 0012 +
-- the code that reads/writes timeline_plugins first, verify, THEN drop here. That
-- keeps a rollback window where both the old columns and the new table coexist.

alter table public.timelines drop column if exists pricing_versions;
alter table public.timelines drop column if exists type;

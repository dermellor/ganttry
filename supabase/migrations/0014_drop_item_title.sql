-- Drop the per-item `title` column. It backed the vis-timeline hover tooltip,
-- a field distinct from `content` (the bar label) with NO editor control in the
-- sidebar, so stale imported values were invisible and non-editable. The
-- tooltip feature is removed end-to-end; the notes-derived tooltip (title +
-- date) is a separate computed value and unaffected.
--
-- Expand/contract: deploy the code that no longer references the column first
-- (the new code works whether or not the column exists), THEN drop it here.

alter table public.timeline_items drop column if exists title;

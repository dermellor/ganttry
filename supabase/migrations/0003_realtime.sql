-- Realtime: let the browser subscribe to row changes so concurrent edits show
-- up live. Realtime delivers rows to the `anon` role only where an RLS SELECT
-- policy permits it, so add read-only anon policies and register the tables on
-- the supabase_realtime publication.
--
-- NOTE: the anon key is public once shipped to the browser, so these policies
-- make timeline *reads* available to anyone holding it. Writes stay server-only
-- (service key). Realtime is therefore opt-in per environment via the
-- VITE_SUPABASE_* client env vars — see AGENTS.md.

create policy "anon read timelines"       on public.timelines       for select to anon using (true);
create policy "anon read timeline_items"  on public.timeline_items  for select to anon using (true);
create policy "anon read timeline_groups" on public.timeline_groups for select to anon using (true);

alter publication supabase_realtime add table public.timeline_items;
alter publication supabase_realtime add table public.timelines;

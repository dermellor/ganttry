-- Prerequisites so the later migrations run on a *vanilla* Postgres, not only
-- on a Supabase-managed instance.
--
-- 0003_realtime.sql and 0009_pricing_normalize.sql reference the `anon` role
-- (`... to anon` policies) and the `supabase_realtime` publication. On Supabase
-- both are created by the platform; on a plain Postgres they don't exist and
-- those migrations would fail. This creates them idempotently.
--
-- They only matter for the optional Supabase-Realtime path (browser realtime via
-- the anon key). A self-hosted deployment using postgres.js + poll live-mode
-- never uses them — they sit unused and harmless. Guarded so this is a no-op on
-- Supabase (where they already exist).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

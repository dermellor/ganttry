-- Which plugins this INSTANCE has installed, as opposed to which are enabled on a
-- timeline.
--
-- The second half already exists (`timeline_plugins`, migration 0012) and is
-- unchanged. What was missing is the level above it: until now the installed set
-- was whatever got compiled into the bundle, so „install a plugin" meant „ship a
-- new build". This table is what makes it a row.
--
-- Two levels, deliberately separate:
--   installed (here)      — this instance has the code and granted it capabilities
--   enabled (0012)        — this timeline uses it, with this config
-- A plugin has to be installed before it can be enabled anywhere, and disabling it
-- on a timeline says nothing about the install. Neither operation discards the rows
-- the plugin owns; only uninstalling does, and it has to ask.
--
-- `manifest` is stored rather than re-derived. The host must be able to list,
-- verify and version-check a plugin **without executing it**, and the write path
-- enforces a plugin's declared collections against this very copy
-- (docs/plugin-storage.md). Keeping the manifest that was validated at install
-- time is what keeps those checks working when the artifact's origin is
-- unreachable — an air-gapped instance is a requirement, not an edge case.

create table if not exists public.installed_plugins (
  plugin_id     text        primary key,
  version       text        not null,                     -- the artifact's own semver
  api_version   text        not null,                     -- contract range, e.g. '^1'
  -- Where the code came from. 'builtin' is the truthful label for a plugin that
  -- shipped inside the build: there is no artifact to refetch, and pretending
  -- otherwise would invite a reinstall of something that was never fetched.
  artifact_kind text        not null default 'builtin'
                            check (artifact_kind in ('builtin', 'url', 'package', 'vendored')),
  artifact      text,                                     -- URL, package spec or path
  integrity     text,                                     -- e.g. 'sha384-…', pins the artifact
  capabilities  jsonb       not null default '[]'::jsonb,  -- granted AT INSTALL, never widened later
  manifest      jsonb       not null default '{}'::jsonb,  -- the copy validated at install time
  -- Instance-level off switch, distinct from „not enabled on this timeline": this
  -- one stops the plugin everywhere without discarding what it stored.
  enabled       boolean     not null default true,
  installed_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);

-- No `version` counter and no bump trigger, unlike the row tables: this is
-- operator-level configuration written one plugin at a time, not content two
-- people edit concurrently. Optimistic locking here would be ceremony around a
-- conflict that does not happen.

-- anon SELECT so the browser can read the registry over Realtime and on boot, the
-- same as `timeline_plugins`. Writes stay server-side behind the service key AND
-- the operator gate — installing is a code-loading act, not a timeline edit.
alter table public.installed_plugins enable row level security;
drop policy if exists "anon read installed_plugins" on public.installed_plugins;
create policy "anon read installed_plugins" on public.installed_plugins for select to anon using (true);

-- Add to the realtime publication only if not already a member (add table errors
-- on a duplicate).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'installed_plugins'
  ) then
    alter publication supabase_realtime add table public.installed_plugins;
  end if;
end $$;

-- ---- seed from what is already enabled ---------------------------------------
-- Every plugin some timeline already uses is, by definition, installed on this
-- instance — it has been running. Without this an existing deployment would come
-- back from the migration with an empty registry and a write path that refuses
-- every plugin as „not installed", which is a self-inflicted outage.
--
-- `manifest` stays empty here on purpose. Filling it would mean guessing a
-- manifest in SQL, and the server already falls back to the manifest the build
-- ships for a built-in plugin (scripts/db/plugin-manifests.ts). An empty bag is
-- the truthful record of „installed, manifest known from the build".
insert into public.installed_plugins (plugin_id, version, api_version, artifact_kind)
select distinct plugin_id, '0.0.0', '^1', 'builtin'
from public.timeline_plugins
on conflict (plugin_id) do nothing;

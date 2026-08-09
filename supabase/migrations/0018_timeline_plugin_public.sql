-- Per-timeline consent to publish a plugin's data.
--
-- Enabling a plugin on a timeline and publishing that timeline's plugin data are
-- two different decisions, and conflating them is the one that leaks: plenty of
-- timelines carry a pricing model that is not meant to be public, and „the plugin
-- is on" must not be read as „the world may read it".
--
-- It lives on `timeline_plugins` because that is exactly the granularity the
-- decision has — this timeline, this plugin — and because it is the table both
-- source kinds already mirror (a local source carries the same fact as a field on
-- its `PluginRef`). A column on `timelines` would be a core-schema change for a
-- plugin concern, and a separate table would be a second place to keep in step.
--
-- `default false` is the whole point. Fail closed: an existing row, a row written
-- by hand, a row created by a bulk import — none of them publishes anything until
-- somebody says so. The migration therefore changes no visible behaviour, which is
-- the correct outcome for a migration that introduces a publishing switch.

alter table public.timeline_plugins
  add column if not exists public boolean not null default false;

comment on column public.timeline_plugins.public is
  'Consent to serve this plugin''s declared publicRead collections without authentication. Off by default; see docs/plugin-public-read.md.';

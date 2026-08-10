-- Plugin ids become reverse-DNS (see src/pluginHost/manifest.ts → ID_RE).
--
-- An id is global: it keys `timeline_plugins`, the plugin's own rows in
-- `plugin_data`, and the install registry. With no central registry handing out
-- names, the only thing that makes a name safe to claim is that it derives from a
-- domain the author owns — so `product-roadmap` becomes `dev.zeitlines.product-roadmap`.
--
-- This runs now, while three plugins exist and essentially nothing is installed.
-- After the first third-party plugin is published the same change would have to
-- rewrite foreign data on instances nobody here can reach.
--
-- Only the one id this repository owns is rewritten. Any other value is left
-- alone: an instance that installed something else keeps it, and the manifest
-- validator refuses the next write rather than this migration guessing at a
-- namespace on somebody's behalf.

update timeline_plugins  set plugin_id = 'dev.zeitlines.product-roadmap' where plugin_id = 'product-roadmap';
update plugin_data       set plugin_id = 'dev.zeitlines.product-roadmap' where plugin_id = 'product-roadmap';
update installed_plugins set plugin_id = 'dev.zeitlines.product-roadmap' where plugin_id = 'product-roadmap';

-- The stored manifest carries the id too, and a stale copy there would make the
-- registry disagree with its own key on the next read.
update installed_plugins
   set manifest = jsonb_set(manifest, '{id}', '"dev.zeitlines.product-roadmap"')
 where plugin_id = 'dev.zeitlines.product-roadmap'
   and manifest ? 'id';

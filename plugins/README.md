# Vendored plugins

Plugin artifacts this deployment carries itself, rather than fetching from
somewhere. This is the **air-gapped install path**: nothing leaves the machine at
boot, and the default `script-src 'self'` already covers it, so installing this
way needs no change to the Content-Security-Policy.

```
plugins/
  <plugin-id>/
    manifest.json     what the plugin declares (see src/pluginHost/manifest.ts)
    index.js          an ES module exporting renderView() and/or fields()
```

Install one:

```bash
npm run plugin:install -- <plugin-id>
```

That validates the manifest against **this** host's contract version, hashes the
entry file, and writes the registry row. Then enable it on a timeline
(`enable_plugin` over MCP, or `PUT /api/source/<id>/plugin/<plugin-id>`).

`npm run build` copies these directories into the build output and logs each
artifact's `sha384-…`, which is the value to paste into an install call made over
HTTP instead.

## Why the directories are gitignored

Which plugins a deployment carries is **instance state**, the same as
`data/<subdir>/`, so the artifacts stay out of the public history. It also means a
stray `git add plugins` cannot publish somebody's private plugin. Only this file
is committed.

`TIMELINES_PLUGINS_DIR` moves the directory elsewhere, for an instance that keeps
its artifacts outside the checkout.

The chapters: [`docs/plugin-lifecycle.md`](../docs/plugin-lifecycle.md) for
installing and enabling, [`docs/plugin-isolation.md`](../docs/plugin-isolation.md)
for what a plugin can and cannot do once it runs.

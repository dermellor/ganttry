import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, basename, dirname, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { envValue } from './db/env.ts';
import { scanDirectory, timelineDirectories } from './local/scan.ts';
import { buildCsp, parseOrigins } from '../src/pluginHost/csp.ts';
import { stripFileForPublication } from '../src/pluginHost/publicRead.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(ROOT, 'timelines.config.json');
// Build output lives under public/ so Vite serves it. The directory name is
// per-instance (`TIMELINES_DATA_DIR`), which is what lets two instances run
// from one checkout without overwriting each other's build. The client reads
// the matching base path, derived from the same value in vite.config.ts.
const DATA_DIR = (envValue('TIMELINES_DATA_DIR') || 'data').replace(/^\/+|\/+$/g, '');
const OUT_DIR = join(ROOT, 'public', DATA_DIR);
// Via the shared cascade, so which data an instance builds is part of its
// profile rather than something the shell has to export.
const SOURCES_SUBDIR = envValue('TIMELINES_SOURCES_SUBDIR').replace(/^\/+|\/+$/g, '');
const SOURCES_DIR_IN = SOURCES_SUBDIR ? join(ROOT, 'data', SOURCES_SUBDIR) : join(ROOT, 'data');
const SOURCES_DIR_OUT = join(OUT_DIR, 'sources');

type Config = {
  dateFields: string[];
  filenameDatePatterns: string[];
};



async function loadConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}










/**
 * Local sources are stamped NOT editable here, and the dev server overrides that
 * for its own responses (see the `/data/config.json` middleware in
 * `vite.config.ts`).
 *
 * The obvious alternative — an env var like TIMELINES_DEV set by the `dev`
 * script — was tried and is a trap: `npm run dev` and `npm run build` write the
 * SAME `public/<data dir>/config.json`, so running a build once flips the
 * running dev server to read-only, silently, until someone restarts it. Nothing
 * in the interface explains that, and it looks like the feature broke.
 *
 * Not editable is also the right default on its own terms: it is what a static
 * deploy is, and it is the answer that cannot cause a write to be attempted
 * against something that cannot take one.
 */
const LOCAL_EDITABLE = false;

// Discover DB-backed timelines from the DB at build time and register them as
// views. The registration stub (name/description/groupBy + empty items —
// deliberately never the item/group/phase content) is written to the BUILD
// OUTPUT (public/data/sources), NOT to the committed data/ dir: the repo carries
// no tenant timeline files, yet the deploy still lists its DB timelines because
// it has DB credentials and queries them here.
//
// Principle upheld: no committed snapshot of live data, ever. The stub is
// metadata only; the viewer loads item/group/phase content live from
// /api/source (or fails loudly). `kind: 'db'` routes the client to the API.
//
// Scope: TIMELINES_SOURCES_SUBDIR filters by id namespace prefix (mirrors the
// old data/<subdir>/ folder scoping). No DB configured → no DB views (file-only
// deploys are unaffected). If a DB IS configured but the list query fails, the
// build fails loudly rather than shipping a deploy with an empty dropdown.
async function collectDbSources(): Promise<unknown[]> {
  let resolveRepoFromEnv: () => { listTimelines(): Promise<{ id: string; name?: string; description?: string; groupBy?: string }[]> } | null;
  let timelineInScope: (id: string, subdir: string) => boolean;
  try {
    ({ resolveRepoFromEnv } = (await import('./db/repo-node.ts')) as any);
    ({ timelineInScope } = (await import('./db/sql.ts')) as any);
  } catch (err) {
    console.warn('[build-data] db discovery skipped (module load failed):', err);
    return [];
  }
  // Same driver selection as the runtime glue: postgres.js when
  // TIMELINES_DATABASE_URL is set, else supabase-js. No DB → no DB views.
  const repo = resolveRepoFromEnv();
  if (!repo) return [];

  // A failed list query on a DB-configured build is fatal (propagated): better a
  // red build than a deploy that silently drops every DB timeline. On the
  // postgres.js path the module-scoped handle is left open (reused across
  // watch-mode rebuilds); main() closes it for the one-shot build so it exits.
  const rows = await repo.listTimelines();

  await mkdir(SOURCES_DIR_OUT, { recursive: true });
  const views: unknown[] = [];
  for (const row of rows) {
    if (!timelineInScope(row.id, SOURCES_SUBDIR)) continue;
    // Registration stub only — no items/groups/phases (that's the whole point).
    const stub: Record<string, unknown> = { kind: 'db', name: row.name ?? row.id };
    if (row.description != null) stub.description = row.description;
    if (row.groupBy != null) stub.groupBy = row.groupBy;
    stub.items = [];
    const outPath = join(SOURCES_DIR_OUT, `${row.id}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeIfChanged(outPath, `${JSON.stringify(stub, null, 2)}\n`);
    views.push({
      id: `src:${row.id}`,
      name: row.name || row.id,
      description: row.description ?? '',
      filter: {},
      groupBy: row.groupBy,
      source: { kind: 'db', id: row.id },
    });
  }
  return views;
}

/**
 * The instance's install registry, baked into the built config.
 *
 * It has to travel this way because a static deploy has no API to ask: the same
 * reason a plugin's rows are folded into the timeline file rather than fetched
 * (docs/plugin-storage.md). A served instance re-reads it live from
 * `GET /api/plugins`; this copy is what a build-only deploy has, and it is
 * metadata about which plugins exist — never a snapshot of anybody's content, so
 * it does not touch „No fallback data, ever".
 *
 * A failing read is NOT fatal here, unlike the timeline list: a deploy with no
 * registry still runs the plugins its build shipped with, which is what the
 * fallback in `installedPluginStatuses` returns.
 */
async function collectPlugins(): Promise<unknown[]> {
  try {
    const { resolveRepoFromEnv } = (await import('./db/repo-node.ts')) as any;
    const { installedPluginStatuses } = (await import('./db/plugin-manifests.ts')) as any;
    const repo = resolveRepoFromEnv();
    // Without a DB there is no registry to read; the client falls back to the
    // built-ins the same way the server does.
    if (!repo) return [];
    return await installedPluginStatuses(repo);
  } catch (err) {
    console.warn('[build-data] plugin registry skipped:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Write the Content-Security-Policy into the build output.
 *
 * A `_headers` file rather than an edge function, so a static asset is still
 * served by the host's CDN instead of routed through Deno for one header. The
 * consequence is that changing the policy needs a redeploy — which for a security
 * policy is arguably the right cost: you want that change reviewed and shipped,
 * not flipped live.
 *
 * Two of the values come from the build's own environment because they already
 * do: `VITE_SUPABASE_URL` is what the client opens its realtime socket to, and a
 * `connect-src` that omitted it would break live updates in a way that looks like
 * a broken database.
 */
async function writeHeaders(): Promise<void> {
  const policy = buildCsp({
    supabaseUrl: envValue('VITE_SUPABASE_URL') || undefined,
    jiraUrl: envValue('VITE_JIRA_BASE_URL') || undefined,
    pluginOrigins: parseOrigins(envValue('PLUGIN_ALLOWED_ORIGINS')),
  });
  const body = ['/*', `  Content-Security-Policy: ${policy}`, '  X-Content-Type-Options: nosniff', '  Referrer-Policy: same-origin', ''].join('\n');
  await writeIfChanged(join(ROOT, 'public', '_headers'), body);
}

/**
 * Copy vendored plugin artifacts into the build output.
 *
 * This is the air-gapped install path, and it is a requirement rather than a
 * nicety: an instance with no outbound network has to be able to run a plugin. An
 * artifact under `plugins/<id>/` is served from the deploy's own origin, which
 * means no request leaves the machine at boot and the default `script-src 'self'`
 * already covers it — an operator installing this way needs no CSP change.
 *
 * The sha384 of each file is logged, because that is the value an operator pastes
 * into the install call to pin it. Computing it by hand is the step people skip.
 */
async function collectVendoredPlugins(): Promise<void> {
  const from = envValue('TIMELINES_PLUGINS_DIR') || join(ROOT, 'plugins');
  if (!existsSync(from)) return;
  const to = join(ROOT, 'public', 'plugins');
  let copied = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(from, entry.name);
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const bytes = await readFile(join(dir, file.name));
      const outPath = join(to, entry.name, file.name);
      await mkdir(dirname(outPath), { recursive: true });
      await writeIfChanged(outPath, bytes);
      copied++;
      if (file.name.endsWith('.js')) {
        const hash = createHash('sha384').update(bytes).digest('base64');
        console.log(`[build-data] vendored /plugins/${entry.name}/${file.name}  sha384-${hash}`);
      }
    }
  }
  if (copied) console.log(`[build-data] copied ${copied} vendored plugin file(s)`);
}

/**
 * The manifests this build can evaluate a `publicRead` declaration against.
 *
 * Registry first, the shipped ones as the fallback — the same order the server
 * uses, so what the build strips and what the API would serve agree. Resolved
 * once per build rather than per file, and lazily, because a file-only deploy has
 * no database to ask.
 */
async function manifestLookup(): Promise<(pluginId: string) => any> {
  const byId = new Map<string, any>();
  try {
    const { builtInManifests, installedPluginStatuses } = (await import('./db/plugin-manifests.ts')) as any;
    for (const m of builtInManifests()) byId.set(m.id, m);
    const { resolveRepoFromEnv } = (await import('./db/repo-node.ts')) as any;
    const repo = resolveRepoFromEnv();
    if (repo) {
      for (const status of await installedPluginStatuses(repo)) {
        if (status?.manifest?.id) byId.set(status.manifest.id, status.manifest);
      }
    }
  } catch (err) {
    console.warn('[build-data] manifest lookup limited to the build:', err instanceof Error ? err.message : err);
  }
  return (pluginId: string) => byId.get(pluginId) ?? null;
}

async function buildOnce(): Promise<void> {
  const config = await loadConfig();
  await mkdir(OUT_DIR, { recursive: true });

  // File sources (committed data/*.json) plus DB timelines discovered live from
  // the DB. On an id collision the DB timeline wins (it is the live source of
  // truth); file sources are listed first for a stable dropdown order.
  const manifestFor = await manifestLookup();
  const fileViews = await collectStandaloneSources(config, manifestFor);
  const dbViews = await collectDbSources();
  const dbIds = new Set(dbViews.map((v: any) => v.id));
  const views = [...fileViews.filter((v: any) => !dbIds.has(v.id)), ...dbViews];
  // Every view is discovered. `defaultView` may still name one from the
  // committed config; if it names nothing that exists (or nothing at all), the
  // first discovered source is the honest fallback — otherwise the viewer opens
  // on a view id that no longer resolves and shows an empty screen.
  const declared: string = (config as any).defaultView;
  const defaultView = views.some((v: any) => v.id === declared)
    ? declared
    : ((views[0] as any)?.id ?? declared);
  await writeHeaders();
  await collectVendoredPlugins();
  const plugins = await collectPlugins();
  const mergedConfig = { ...config, defaultView, views, plugins };
  const configOut = join(OUT_DIR, 'config.json');
  const configChanged = await writeIfChanged(configOut, JSON.stringify(mergedConfig, null, 2));

  if (configChanged) {
    console.log(`[build-data] wrote ${views.length} source(s), ${plugins.length} plugin(s)`);
  }
}

/**
 * Write only when the bytes differ, so the dev server's watcher does not fire on
 * a rebuild that produced the same output.
 *
 * Compared as BYTES rather than as a utf8 string: a vendored plugin directory may
 * hold a source map, a wasm module or an image, and reading one of those as utf8
 * would both mis-compare it and rewrite it corrupted.
 */
async function writeIfChanged(path: string, content: string | Uint8Array): Promise<boolean> {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const newHash = createHash('sha1').update(bytes).digest('hex');
  try {
    const existing = await readFile(path);
    if (createHash('sha1').update(existing).digest('hex') === newHash) return false;
  } catch {
    // file does not exist
  }
  await writeFile(path, bytes);
  return true;
}

async function* walkJsonFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJsonFiles(abs);
    } else if (e.isFile() && extname(e.name).toLowerCase() === '.json') {
      yield abs;
    }
  }
}

async function collectStandaloneSources(config: Config, manifestFor: (pluginId: string) => any): Promise<unknown[]> {
  if (!existsSync(SOURCES_DIR_IN)) return [];
  await mkdir(SOURCES_DIR_OUT, { recursive: true });
  const views: unknown[] = [];
  // Scanning is limited to SOURCES_DIR_IN (e.g. data/<subdir> on a scoped
  // deploy), but the id is always derived relative to data/ so it is identical
  // across environments and matches the DB timeline id (e.g. "<subdir>/<name>").
  // Otherwise TIMELINES_SOURCES_SUBDIR would strip the prefix on the deploy and
  // the client would request /api/source/<name> which the DB doesn't have.
  const DATA_ROOT = join(ROOT, 'data');

  // Directory sources: a folder holding a container file, with one Markdown
  // file per item. Materialized into the build output the same way a JSON
  // source is copied, because a static deploy has no process to scan with —
  // there the built copy IS what the client reads (read-only, see
  // docs/local-sources.md → „How a local source is served").
  const dirs = await timelineDirectories(SOURCES_DIR_IN);
  for (const dir of dirs) {
    const id = relative(DATA_ROOT, dir).replace(/\\/g, '/');
    const file = await scanDirectory(dir, {
      dateFields: config.dateFields,
      filenameDatePatterns: config.filenameDatePatterns,
    });
    const outPath = join(SOURCES_DIR_OUT, `${id}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    // A static deploy hands this file to anyone who asks, so a plugin's rows in it
    // are published unless the timeline said so. See stripFileForPublication.
    await writeIfChanged(outPath, `${JSON.stringify(stripFileForPublication(file, manifestFor), null, 2)}\n`);
    views.push({
      id: `src:${id}`,
      name: file.name || basename(id),
      description: file.description ?? '',
      filter: {},
      groupBy: file.groupBy,
      source: { kind: 'local', id, editable: LOCAL_EDITABLE },
    });
  }

  for await (const inPath of walkJsonFiles(SOURCES_DIR_IN)) {
    // A directory source owns every file under it, its container file included.
    // Without this the container is picked up as a malformed timeline (it has no
    // `items` by design), and any JSON a user keeps next to their notes turns
    // into a second, unintended source.
    if (dirs.some((dir) => inPath.startsWith(dir + sep))) continue;
    const rel = relative(DATA_ROOT, inPath).replace(/\\/g, '/');
    const id = rel.slice(0, -extname(rel).length);
    let raw: string;
    try {
      raw = await readFile(inPath, 'utf8');
    } catch {
      continue;
    }
    let parsed: { kind?: string; name?: string; description?: string; groupBy?: string; items?: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[build-data] skipping invalid JSON: ${rel}`);
      continue;
    }
    if (!Array.isArray(parsed.items)) {
      console.warn(`[build-data] skipping ${rel}: missing "items" array`);
      continue;
    }
    // DB-backed timelines are discovered live from the DB (collectDbSources), not
    // from committed files. A `kind: 'db'` file here is a leftover registration
    // stub — skip it so it neither shadows the live discovery nor resurrects a
    // committed snapshot. Everything else is a genuine file source (read-only).
    if (parsed.kind === 'db') {
      console.warn(`[build-data] ignoring committed db stub ${rel} (discovered from the DB instead)`);
      continue;
    }
    const outPath = join(SOURCES_DIR_OUT, `${id}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    // Re-serialized rather than copied verbatim, which is the change that closes
    // the leak: a byte-for-byte copy publishes every plugin row in the file
    // regardless of whether the timeline consented.
    const published = stripFileForPublication(parsed as any, manifestFor);
    await writeIfChanged(outPath, `${JSON.stringify(published, null, 2)}\n`);
    views.push({
      id: `src:${id}`,
      name: parsed.name || basename(id),
      description: parsed.description ?? '',
      filter: {},
      groupBy: parsed.groupBy,
      source: { kind: 'local', id, editable: LOCAL_EDITABLE },
    });
  }
  return views;
}

async function main() {
  await buildOnce();

  if (process.argv.includes('--watch')) {
    await mkdir(SOURCES_DIR_IN, { recursive: true });
    const { default: chokidar } = await import('chokidar');
    let timer: NodeJS.Timeout | null = null;
    let pending = false;
    let running = false;
    const run = async () => {
      if (running) { pending = true; return; }
      running = true;
      try { await buildOnce(); }
      catch (err) { console.error(err); }
      finally {
        running = false;
        if (pending) { pending = false; setTimeout(run, 100); }
      }
    };
    const trigger = (path: string) => {
      const ext = extname(path).toLowerCase();
      if (path !== CONFIG_PATH && ext !== '.md' && ext !== '.json') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 1000);
    };
    // Both shapes of a local source: a JSON timeline, and the Markdown files of
    // a directory one. Watching only the JSON would leave a directory source
    // stale in the build output after a note changes.
    const watchPaths = [
      CONFIG_PATH,
      join(SOURCES_DIR_IN, '**', '*.json'),
      join(SOURCES_DIR_IN, '**', '*.md'),
    ];

    chokidar
      .watch(watchPaths, {
        ignoreInitial: true,
        ignored: [
          /(^|[/\\])\../,
          /(^|[/\\])(node_modules|dist|public)([/\\]|$)/,
          /\.icloud$/,
        ],
        ignorePermissionErrors: true,
      })
      .on('add', trigger)
      .on('change', trigger)
      .on('unlink', trigger);

    // No sheet polling anymore — realtime handles live content updates in the
    // browser, and the DB timeline list refreshes on each build via
    // collectDbSources().
    console.log(
      `[build-data] watching ${relative(ROOT, SOURCES_DIR_IN)}/**/*.{json,md} + config`,
    );
    return; // stay alive; the watcher keeps the event loop (and DB handle) open
  }

  // One-shot build: close any open DB handle (collectDbSources may have opened
  // a module-scoped postgres.js connection) so the process exits cleanly.
  try {
    const { getSql } = (await import('./db/sql.ts')) as { getSql: () => { end: () => Promise<void> } | null };
    const sql = getSql();
    if (sql) await sql.end();
  } catch { /* module load / teardown errors are non-fatal for the build */ }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

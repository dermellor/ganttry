import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, basename, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(ROOT, 'timelines.config.json');
const OUT_DIR = join(ROOT, 'public', 'data');
const OUT_FILE = join(OUT_DIR, 'notes.json');
const SOURCES_SUBDIR = (process.env.TIMELINES_SOURCES_SUBDIR ?? '').replace(/^\/+|\/+$/g, '');
const SOURCES_DIR_IN = SOURCES_SUBDIR ? join(ROOT, 'data', SOURCES_SUBDIR) : join(ROOT, 'data');
const SOURCES_DIR_OUT = join(OUT_DIR, 'sources');

type Config = {
  notesDir: string;
  dateFields: string[];
  filenameDatePatterns: string[];
};

type Note = {
  id: string;
  path: string;
  filename: string;
  folder: string;
  title: string;
  start: string | null;
  end: string | null;
  dateSource: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
};

function expandHome(p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1));
  return p;
}

/**
 * Directory to scan for Markdown notes. `TIMELINES_NOTES_DIR` (env) overrides the
 * committed `notesDir` in the config, so a checkout can point at its own notes
 * without editing the tracked file.
 */
function resolveNotesDir(config: Config): string {
  return expandHome(process.env.TIMELINES_NOTES_DIR ?? config.notesDir);
}

async function loadConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (e.isFile() && extname(e.name).toLowerCase() === '.md') {
      out.push(full);
    }
  }
  return out;
}

function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function pickDate(
  fm: Record<string, unknown>,
  fields: string[],
): { iso: string; field: string } | null {
  for (const field of fields) {
    const v = fm[field];
    const iso = toIsoDate(v);
    if (iso) return { iso, field };
  }
  return null;
}

function dateFromFilename(filename: string, patterns: string[]): string | null {
  const stem = basename(filename, extname(filename));
  for (const p of patterns) {
    const re = new RegExp(p);
    const m = stem.match(re);
    if (m) {
      const y = m[1];
      const mo = m[2];
      const d = m[3];
      if (y && mo && d) {
        const iso = `${y}-${mo}-${d}T00:00:00`;
        const date = new Date(iso);
        if (!isNaN(date.getTime())) return date.toISOString();
      }
    }
  }
  return null;
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;

function parseDuration(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // ISO 8601 duration (subset): PnYnMnDTnHnMnS
  if (/^P/.test(s)) return parseIsoDuration(s);
  const m = s.match(DURATION_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return n * unitToMs(unit);
}

function parseIsoDuration(s: string): number | null {
  const re = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
  const m = s.match(re);
  if (!m) return null;
  const [, y, mo, w, d, h, mi, sec] = m;
  let ms = 0;
  ms += (parseInt(y || '0') || 0) * 365 * 24 * 3600 * 1000;
  ms += (parseInt(mo || '0') || 0) * 30 * 24 * 3600 * 1000;
  ms += (parseInt(w || '0') || 0) * 7 * 24 * 3600 * 1000;
  ms += (parseInt(d || '0') || 0) * 24 * 3600 * 1000;
  ms += (parseInt(h || '0') || 0) * 3600 * 1000;
  ms += (parseInt(mi || '0') || 0) * 60 * 1000;
  ms += (parseFloat(sec || '0') || 0) * 1000;
  return ms || null;
}

function unitToMs(unit: string): number {
  switch (unit) {
    case 'ms': return 1;
    case 's': case 'sec': case 'secs': case 'second': case 'seconds': return 1000;
    case 'm': case 'min': case 'mins': case 'minute': case 'minutes': return 60 * 1000;
    case 'h': case 'hr': case 'hrs': case 'hour': case 'hours': return 3600 * 1000;
    case 'd': case 'day': case 'days': return 24 * 3600 * 1000;
    case 'w': case 'wk': case 'weeks': case 'week': return 7 * 24 * 3600 * 1000;
    case 'mo': case 'month': case 'months': return 30 * 24 * 3600 * 1000;
    case 'y': case 'yr': case 'year': case 'years': return 365 * 24 * 3600 * 1000;
    default: return 0;
  }
}

const STATIC_ONLY = /^(1|true|yes)$/i.test(process.env.TIMELINES_STATIC_ONLY ?? '');

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

async function buildOnce(): Promise<void> {
  const config = await loadConfig();
  const notesDir = resolveNotesDir(config);

  // Missing notes dir is non-fatal: proceed with zero notes so a fresh clone
  // (or a deploy with no notes) still builds standalone/DB sources. Set
  // TIMELINES_NOTES_DIR (or config.notesDir) to scan Markdown notes.
  const notesDirMissing = !STATIC_ONLY && !existsSync(notesDir);
  if (notesDirMissing) {
    console.warn(`[build-data] notesDir not found, skipping notes scan: ${notesDir}`);
  }

  const files = STATIC_ONLY || notesDirMissing ? [] : await walk(notesDir);
  const notes: Note[] = [];
  let skipped = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch {
      continue;
    }
    const fm = (parsed.data ?? {}) as Record<string, unknown>;
    const rel = relative(notesDir, file);
    const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '';
    const filename = basename(file);
    const title =
      (typeof fm.title === 'string' && fm.title.trim()) ||
      basename(file, extname(file));

    const fmDate = pickDate(fm, config.dateFields);
    let startIso: string | null = fmDate?.iso ?? null;
    let dateSource: string | null = fmDate?.field ?? null;
    if (!startIso) {
      const fileDate = dateFromFilename(filename, config.filenameDatePatterns);
      if (fileDate) {
        startIso = fileDate;
        dateSource = '__filename__';
      }
    }

    if (!startIso) {
      skipped++;
      continue;
    }

    let endIso: string | null = null;
    const durationMs = parseDuration(fm.duration);
    if (durationMs && durationMs > 0) {
      endIso = new Date(new Date(startIso).getTime() + durationMs).toISOString();
    } else {
      const fmEnd = pickDate(fm, ['end', 'end_date', 'until']);
      if (fmEnd) endIso = fmEnd.iso;
    }

    notes.push({
      id: rel,
      path: rel,
      filename,
      folder,
      title,
      start: startIso,
      end: endIso,
      dateSource,
      frontmatter: fm,
      body: parsed.content,
    });
  }

  notes.sort((a, b) => (a.start! < b.start! ? -1 : 1));

  await mkdir(OUT_DIR, { recursive: true });

  const notesPayload = JSON.stringify({ count: notes.length, notes }, null, 2);
  const notesChanged = await writeIfChanged(OUT_FILE, notesPayload);

  // File sources (committed data/*.json) plus DB timelines discovered live from
  // the DB. On an id collision the DB timeline wins (it is the live source of
  // truth); file sources are listed first for a stable dropdown order.
  const fileViews = await collectStandaloneSources();
  const dbViews = await collectDbSources();
  const dbIds = new Set(dbViews.map((v: any) => v.id));
  const autoViews = [...fileViews.filter((v: any) => !dbIds.has(v.id)), ...dbViews];
  const baseViews = STATIC_ONLY
    ? [] // hide markdown-driven views in static mode
    : (config as any).views ?? [];
  let defaultView: string = (config as any).defaultView;
  if (STATIC_ONLY) {
    const firstSrc = (autoViews[0] as any)?.id;
    if (firstSrc) defaultView = firstSrc;
  }
  const mergedConfig = {
    ...config,
    defaultView,
    views: [...baseViews, ...autoViews],
  };
  const configOut = join(OUT_DIR, 'config.json');
  const configChanged = await writeIfChanged(configOut, JSON.stringify(mergedConfig, null, 2));

  if (notesChanged || configChanged) {
    console.log(
      `[build-data] wrote ${notes.length} notes (${skipped} skipped, no date) + ${autoViews.length} standalone source(s)` +
        (notesChanged ? ' [notes]' : '') + (configChanged ? ' [config]' : ''),
    );
  }
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const newHash = createHash('sha1').update(content).digest('hex');
  try {
    const existing = await readFile(path, 'utf8');
    const existingHash = createHash('sha1').update(existing).digest('hex');
    if (existingHash === newHash) return false;
  } catch {
    // file does not exist
  }
  await writeFile(path, content);
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

async function collectStandaloneSources(): Promise<unknown[]> {
  if (!existsSync(SOURCES_DIR_IN)) return [];
  await mkdir(SOURCES_DIR_OUT, { recursive: true });
  const views: unknown[] = [];
  // Scanning is limited to SOURCES_DIR_IN (e.g. data/<subdir> on a scoped
  // deploy), but the id is always derived relative to data/ so it is identical
  // across environments and matches the DB timeline id (e.g. "<subdir>/<name>").
  // Otherwise TIMELINES_SOURCES_SUBDIR would strip the prefix on the deploy and
  // the client would request /api/source/<name> which the DB doesn't have.
  const DATA_ROOT = join(ROOT, 'data');
  for await (const inPath of walkJsonFiles(SOURCES_DIR_IN)) {
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
    await writeIfChanged(outPath, raw);
    views.push({
      id: `src:${id}`,
      name: parsed.name || basename(id),
      description: parsed.description ?? '',
      filter: {},
      groupBy: parsed.groupBy,
      source: { kind: 'file', id },
    });
  }
  return views;
}

async function main() {
  await buildOnce();

  if (process.argv.includes('--watch')) {
    const config = await loadConfig();
    const notesDir = resolveNotesDir(config);
    await mkdir(SOURCES_DIR_IN, { recursive: true });
    const watchNotes = process.argv.includes('--watch-notes');
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
    const watchPaths = [CONFIG_PATH, join(SOURCES_DIR_IN, '**', '*.json')];
    if (watchNotes) watchPaths.unshift(join(notesDir, '**/*.md'));

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
      watchNotes
        ? `[build-data] watching ${notesDir}/**/*.md + ${relative(ROOT, SOURCES_DIR_IN)}/**/*.json + config`
        : `[build-data] watching ${relative(ROOT, SOURCES_DIR_IN)}/**/*.json + config (notes excluded — use 'npm run dev:notes' to include)`,
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

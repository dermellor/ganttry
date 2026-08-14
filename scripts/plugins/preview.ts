// Render a plugin's preview image from its own example timeline.
//
//   npm run dev                                  # in another shell
//   npm run plugins:preview -- product-roadmap   # writes src/plugins/<folder>/preview.png
//
// Why an image at all: the catalogue needs one, and fifty previews reviewed side
// by side catch what fifty separate click paths would not — the plugin that
// renders correctly and still looks like nothing.
//
// **Which timeline is not a flag.** It comes from the plugin's own
// `catalogue.example`, the same field the catalogue links, so the picture cannot
// end up showing a timeline the page does not link.
//
// ## The two decisions this script makes
//
// **A real browser, not a second renderer.** Drawing the preview from the data
// with our own code would be dependency-free and would show something the app
// does not actually render — which defeats the point of looking at it. So it is a
// screenshot of the real view.
//
// **An installed Chrome, not a bundled one.** Playwright or Puppeteer would pin a
// browser and cost every `npm ci` — including CI, and including every contributor
// who never renders a preview — a few hundred megabytes for a command that runs
// when a plugin ships. Instead this drives a Chrome that is already on the
// machine and fails with an install hint when there is none.
//
// The consequence, stated rather than hidden: **this does not run in CI.**
// `plugins:catalogue:check` requires the committed `preview.png` to EXIST; it
// cannot regenerate one to compare against, so a stale image is caught by a human
// looking at the catalogue, not by a check. Regenerate it when the view changes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginManifest } from '../../src/pluginHost/manifest.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN_DIR = join(ROOT, 'src', 'plugins');

/** Where a Chrome usually is. Ordered by how likely it is to be the one wanted. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p);

// 16:9 by default, which suits a plugin whose picture is the timeline. A view that is
// taller than wide gets cut off in it, and a cropped chart is exactly the „renders
// correctly and still looks like nothing" this image exists to catch — hence `--size`.
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

function fail(message: string): never {
  console.error(`[preview] ${message}`);
  process.exit(1);
}

function findChrome(): string {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    fail(
      'no Chrome found. Install Google Chrome or Chromium, or point CHROME_PATH at one:\n' +
        '          CHROME_PATH=/path/to/chrome npm run plugins:preview -- <plugin-folder>',
    );
  }
  return found;
}

async function manifestOf(folder: string): Promise<PluginManifest> {
  const modulePath = join(PLUGIN_DIR, folder, 'manifest.ts');
  if (!existsSync(modulePath)) fail(`no plugin folder "${folder}" (looked for ${modulePath})`);
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const manifest = Object.values(mod).find(
    (v): v is PluginManifest => !!v && typeof v === 'object' && typeof (v as PluginManifest).id === 'string',
  );
  if (!manifest) fail(`${folder}/manifest.ts exports no manifest`);
  return manifest;
}

/**
 * The URL that shows this plugin at its best: its example timeline, in its own
 * view when it has one.
 *
 * The view mode is the addressable `plugin:<id>:<viewId>` the header writes into
 * the hash, so a field-only plugin falls back to the timeline.
 *
 * For such a plugin that is often the wrong picture, and `--param` is the way out.
 * A plugin whose point is a *perspective* on the item list — a derived field you
 * group by — renders as an ordinary timeline here, because the grouping dimension
 * is deliberately not in the hash (it is per-timeline display state, see „Where the
 * display state lives" in docs/editing.md). What IS addressable is a saved view,
 * so such a plugin ships one in its example and names it:
 *
 *   npm run plugins:preview -- sprints --param savedView=nach-sprints
 *
 * Generic on purpose: the flag carries a hash parameter, and the script stays free
 * of any knowledge about which plugin wants which one.
 */
function previewUrl(base: string, manifest: PluginManifest, extra: string[]): string {
  const example = manifest.catalogue?.example;
  if (!example) fail(`${manifest.id} declares no catalogue.example, so there is nothing to render`);
  const parts = [`view=${encodeURIComponent(example)}`];
  const view = manifest.views?.[0];
  if (view) parts.push(`mode=${encodeURIComponent(`plugin:${manifest.id}:${view.id}`)}`);
  for (const param of extra) {
    const [key, ...rest] = param.split('=');
    if (!key || !rest.length) fail(`--param wants key=value, got "${param}"`);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(rest.join('='))}`);
  }
  return `${base.replace(/\/+$/, '')}/#${parts.join('&')}`;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const folder = args.find((a) => !a.startsWith('-'));
if (!folder) {
  fail(
    'usage: npm run plugins:preview -- <plugin-folder> [--url http://localhost:3120] ' +
      '[--param key=value …] [--size 1280x900]',
  );
}

const urlFlag = args.indexOf('--url');
const base = urlFlag >= 0 ? args[urlFlag + 1] : `http://localhost:${process.env.TIMELINES_PORT ?? '3120'}`;
const extra = args.flatMap((a, i) => (a === '--param' && args[i + 1] ? [args[i + 1]] : []));

const sizeFlag = args.indexOf('--size');
const VIEWPORT = ((): { width: number; height: number } => {
  if (sizeFlag < 0) return DEFAULT_VIEWPORT;
  const raw = args[sizeFlag + 1] ?? '';
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(raw);
  if (!m) fail(`--size wants WIDTHxHEIGHT, got "${raw}"`);
  return { width: Number(m![1]), height: Number(m![2]) };
})();

const manifest = await manifestOf(folder);
const url = previewUrl(base, manifest, extra);

if (!(await reachable(base))) {
  fail(
    `nothing answering at ${base}. Start the app first:\n` +
      '          npm run dev\n' +
      '          (or pass --url http://localhost:<port> for a server you already have)',
  );
}

const chrome = findChrome();
// Chrome writes `screenshot.png` into its working directory, so it gets a
// throwaway one rather than whatever the caller happened to be standing in.
const scratch = mkdtempSync(join(tmpdir(), 'zeitlines-preview-'));
const shot = join(scratch, 'screenshot.png');
const out = join(PLUGIN_DIR, folder, 'preview.png');

try {
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      // The app fetches its timeline and then renders, so a screenshot taken at
      // load returns an empty frame. Virtual time lets those ticks pass without
      // making the script sleep and hope.
      '--virtual-time-budget=8000',
      `--screenshot=${shot}`,
      url,
    ],
    { cwd: scratch, stdio: 'pipe' },
  );
  if (!existsSync(shot)) fail(`Chrome produced no image for ${url}`);
  renameSync(shot, out);
  console.log(`[preview] wrote src/plugins/${folder}/preview.png — ${url}`);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  fail(`Chrome failed: ${detail}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

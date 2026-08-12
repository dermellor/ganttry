// Keeps a plugin from becoming special again.
//
// Issue #9's acceptance criterion is that a native plugin has no privilege a
// third-party one lacks. #17 made that true for `product-roadmap` by removing
// fifteen repo methods, seven API sub-resources, thirteen MCP tools, a public
// endpoint and a field on the core file format. None of that stays true on its
// own: every one of those started as one reasonable-looking line, and the next
// one will too. So the rules are asserted rather than remembered, the same way
// `check-bundle-split.sh` asserts the lazy-loading promise.
//
// Four checks, each with a failure it prevents:
//
// 1. **No core file imports from a plugin folder.** That import is how a plugin's
//    vocabulary reaches code that must not know it — and, in a client file, how
//    the plugin's chunk ends up in the entry bundle.
// 2. **No plugin id as a string literal outside its own folder.** A hardcoded id
//    is a branch nobody else can take: `if (pluginId === 'x')` is a privilege
//    whatever it guards.
// 3. **`TimelineRepo` carries only known-generic methods.** The seam had fifteen
//    plugin-specific ones for four years, and nobody noticed because each was
//    added next to a plausible neighbour. Adding one now means editing the list
//    below, which is the checkpoint.
// 4. **No plugin stylesheet is linked from `index.html`.** A plugin's CSS belongs
//    in its chunk; a link in the shell downloads it for everyone.
//
// The allowlists below are short on purpose, and each entry says why it is there.
// A new entry is the thing to argue about in review.
//
// Run: node scripts/ci/check-plugin-isolation.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Files that may reach into a plugin folder, and why.
 *
 * A registry has to name what it registers — that is what a registry is. The two
 * migration files are dated: they exist to move one plugin's data off its old
 * tables and are deleted by the migration that drops them.
 */
const IMPORT_ALLOWLIST = new Map([
  ['src/pluginHost/registry.ts', 'the client registry; it imports descriptors it does not understand'],
  ['scripts/db/plugin-manifests.ts', 'the server-side registry of built-in manifests'],
  ['scripts/db/legacy-pricing.ts', 'dated: reads the pre-#17 tables for the migration, deleted with them'],
  ['scripts/db/migrate-pricing-to-plugin-data.ts', 'dated: the migration itself'],
  ['scripts/db/migrate-version-ids.ts', 'dated: the version label→id migration (#110)'],
]);

/** Same idea for a bare id literal. A registry entry is an id by definition. */
const LITERAL_ALLOWLIST = new Map([
  ['scripts/db/legacy-pricing.ts', 'dated: see above'],
  ['scripts/db/migrate-pricing-to-plugin-data.ts', 'dated: see above'],
  ['scripts/db/retired-pricing-route.ts', 'dated: a retired route names the plugin it used to serve'],
]);

/**
 * Every method the storage seam is allowed to carry.
 *
 * Generic means: it would read the same if a plugin nobody has written yet were
 * the only one installed. `putPluginRow` qualifies; `addFeature` did not.
 */
const REPO_METHODS = [
  'listTimelines', 'getTimeline', 'getWatermark',
  'listUsers', 'touchUser',
  'getMember', 'listMembers', 'inviteMember', 'updateMemberRole', 'setMemberStatus',
  'replaceTimeline', 'updateMeta', 'updatePhases',
  'addItem', 'updateItem', 'getItem', 'deleteItem',
  'upsertGroup', 'deleteGroup',
  'listInstalledPlugins', 'installPlugin', 'setPluginInstalledEnabled', 'removeInstalledPlugin',
  'setTimelinePlugin', 'getTimelinePlugin', 'removeTimelinePlugin',
  'listPluginRows', 'listPluginData', 'putPluginRow', 'patchPluginRow', 'deletePluginRow',
  'orderPluginRows', 'purgePluginData', 'purgeItemMetadata',
];

/** The source folder an id lives in. Filled once the manifests are read. */
const folders = new Map();
const folderFor = (id) => folders.get(id) ?? id;

const problems = [];
const note = (file, message) => problems.push(`${file}: ${message}`);

// ---- the plugins that exist -------------------------------------------------

const PLUGIN_ROOT = join(ROOT, 'src/plugins');

/**
 * The ids are read out of each plugin's manifest, not taken from its directory
 * name. Since ids became reverse-DNS, a source folder called
 * `dev.zeitlines.product-roadmap` would be the only way to keep those in step —
 * and a dotted directory name in `src/` buys nothing and reads badly. A vendored
 * artifact still has to match, because the URL is built from that directory name;
 * that is a different directory and its own rule.
 */
const pluginIds = readdirSync(PLUGIN_ROOT)
  // `_template` is scaffolding rather than a plugin; it ships no id and nothing
  // may import it either way.
  .filter((name) => !name.startsWith('_') && statSync(join(PLUGIN_ROOT, name)).isDirectory())
  .map((name) => {
    const manifest = readFileSync(join(PLUGIN_ROOT, name, 'manifest.ts'), 'utf8');
    const found = /\bid:\s*'([^']+)'/.exec(manifest);
    if (!found) {
      console.error(`check-plugin-isolation: no id found in src/plugins/${name}/manifest.ts`);
      process.exit(1);
    }
    folders.set(found[1], name);
    return found[1];
  });
if (!pluginIds.length) {
  console.error('check-plugin-isolation: no plugins found under src/plugins — the checks below would pass vacuously');
  process.exit(1);
}

// ---- every source file, minus the plugin folders and the tests --------------

/**
 * Tests are exempt from both file checks.
 *
 * A test for the host needs a real plugin to point at, and a stand-in that
 * carries none of the real declarations tests less than nothing. What matters is
 * that shipping code cannot name a plugin; a test naming one changes no
 * behaviour.
 */
function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* sources(path);
    } else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
      yield path;
    }
  }
}

/**
 * Drop comments before looking for a literal.
 *
 * Without this the check fails on prose: every one of these rules is explained in
 * a comment that quotes the id it is about, and a checker that cannot tell an
 * explanation from a branch would force the explanations out — the opposite of
 * what this repo wants.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

for (const path of sources(join(ROOT, 'src'))) checkFile(path);
for (const path of sources(join(ROOT, 'scripts'))) checkFile(path);
for (const path of sources(join(ROOT, 'netlify'))) checkFile(path);

function checkFile(path) {
  const rel = relative(ROOT, path).replace(/\\/g, '/');
  if (rel.startsWith('src/plugins/')) return;
  const source = readFileSync(path, 'utf8');
  const code = stripComments(source);

  for (const id of pluginIds) {
    const importPattern = new RegExp(`from ['"][^'"]*plugins/${folderFor(id)}/`);
    if (importPattern.test(code) && !IMPORT_ALLOWLIST.has(rel)) {
      note(rel, `imports from src/plugins/${folderFor(id)}/ — only a registry or a dated migration may`);
    }
    const literalPattern = new RegExp(`['"\`]${id}['"\`]`);
    if (literalPattern.test(code) && !LITERAL_ALLOWLIST.has(rel) && !IMPORT_ALLOWLIST.has(rel)) {
      note(rel, `names the plugin id "${id}" as a literal — no third-party plugin can be named there`);
    }
  }
}

// ---- the storage seam -------------------------------------------------------

const repoSource = readFileSync(join(ROOT, 'scripts/db/repo.ts'), 'utf8');
const body = repoSource.slice(repoSource.indexOf('export interface TimelineRepo'));
const declared = [...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)].map((m) => m[1]);
if (!declared.length) {
  note('scripts/db/repo.ts', 'no methods parsed out of TimelineRepo — this check would pass vacuously');
}
for (const name of declared) {
  if (!REPO_METHODS.includes(name)) {
    note(
      'scripts/db/repo.ts',
      `TimelineRepo.${name}() is not in the known-generic list. If it would read the same for a plugin ` +
        'nobody has written yet, add it to REPO_METHODS in this script; if it would not, it does not belong on the seam.',
    );
  }
}

// ---- the application shell --------------------------------------------------

const shell = readFileSync(join(ROOT, 'index.html'), 'utf8');
for (const id of pluginIds) {
  if (shell.includes(id)) {
    note('index.html', `names "${id}" — a plugin's markup and stylesheet belong in its own chunk`);
  }
}

// ---- report -----------------------------------------------------------------

if (problems.length) {
  console.error('check-plugin-isolation: FAILED\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nA plugin that is special is a plugin nobody else can write. See docs/architecture.md → „Plugins".',
  );
  process.exit(1);
}

console.log(
  `check-plugin-isolation: ok    ${pluginIds.length} plugin(s), ` +
    `${declared.length} generic repo method(s), ${IMPORT_ALLOWLIST.size} documented exception(s)`,
);

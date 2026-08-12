// The plugin catalogue, generated from the manifests.
//
//   npm run plugins:catalogue        # regenerate PLUGINS.md
//   npm run plugins:catalogue:check  # verify the committed copy, and that every
//                                    # plugin is publishable (CI)
//
// Why generated: a hand-kept list is fine at three plugins and a wall of links at
// fifty, and the copy in the list is the one that goes stale. The entry lives in
// each plugin's manifest, so publishing a plugin is a change inside its own folder
// — the „one folder, one registration line, no core file touched" budget the
// playbook holds every plugin to.
//
// The plugins are found by scanning `src/plugins/*/manifest.ts` rather than by
// asking the registry, because the catalogue needs something the registry does not
// carry: the folder a plugin lives in, which is what its README link and its
// preview image hang off. A reverse-DNS id does not name its own directory. The
// scan cannot go stale the way a list would, and `_`-prefixed directories are
// skipped, which is what keeps the template out of the catalogue.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogueProblems, type PluginManifest } from '../../src/pluginHost/manifest.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN_DIR = join(ROOT, 'src', 'plugins');
const OUT = join(ROOT, 'PLUGINS.md');
const PREVIEW = 'preview.png';

const check = process.argv.includes('--check');

type Found = {
  /** Directory name under src/plugins. */
  folder: string;
  manifest: PluginManifest;
  hasPreview: boolean;
  hasReadme: boolean;
};

/** Every in-tree plugin folder, in directory order. */
async function findPlugins(): Promise<Found[]> {
  const out: Found[] = [];
  for (const entry of readdirSync(PLUGIN_DIR, { withFileTypes: true })) {
    // `_template` is scaffolding, not a plugin. It is also deliberately the one
    // folder whose manifest is allowed to be an example.
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const dir = join(PLUGIN_DIR, entry.name);
    const modulePath = join(dir, 'manifest.ts');
    if (!existsSync(modulePath)) continue;
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const manifest = Object.values(mod).find(
      (v): v is PluginManifest => !!v && typeof v === 'object' && typeof (v as PluginManifest).id === 'string',
    );
    if (!manifest) continue;
    out.push({
      folder: entry.name,
      manifest,
      hasPreview: existsSync(join(dir, PREVIEW)),
      hasReadme: existsSync(join(dir, 'README.md')),
    });
  }
  return out;
}

/**
 * Everything that stops a plugin from being published.
 *
 * The entry fields come from the shared check in the manifest module, so „a
 * summary is one line" is enforced in one place rather than restated here. The two
 * file requirements are the catalogue's own: a card with no page behind it and no
 * picture is a row a reader skips.
 */
function publishProblems(found: Found): string[] {
  const problems: string[] = [];
  if (found.manifest.catalogue == null) {
    problems.push('no catalogue entry in its manifest (summary, domain, keywords)');
  } else {
    problems.push(...catalogueProblems(found.manifest.catalogue));
  }
  if (!found.hasReadme) problems.push('no README.md, which is the plugin\'s public page');
  if (!found.hasPreview) problems.push(`no ${PREVIEW}; run \`npm run plugins:preview -- ${found.folder}\``);
  return problems;
}

const rel = (folder: string, file: string) => relative(ROOT, join(PLUGIN_DIR, folder, file)).split('\\').join('/');

function renderPlugin(found: Found): string {
  const { manifest, folder } = found;
  const entry = manifest.catalogue;
  const lines: string[] = [];
  lines.push(`### [${manifest.name}](${rel(folder, 'README.md')})`);
  lines.push('');
  if (entry) lines.push(entry.summary, '');
  if (found.hasPreview) lines.push(`![${manifest.name}](${rel(folder, PREVIEW)})`, '');

  const views = (manifest.views ?? []).map((v) => v.label);
  const tools = (manifest.tools ?? []).map((t) => `\`${t.name}\``);
  const rows: Array<[string, string]> = [
    ['Id', `\`${manifest.id}\``],
    ['Version', manifest.version],
  ];
  if (entry) rows.push(['Keywords', entry.keywords.join(', ')]);
  // A reader who cannot see the plugin in one click will not install it to find
  // out. `src:<name>` is the id a local source gets, so the file behind it is
  // `data/<name>.json`; anything else is linked as the plain view id.
  if (entry?.example) {
    const local = /^src:(.+)$/.exec(entry.example);
    const target = local && existsSync(join(ROOT, 'data', `${local[1]}.json`)) ? `data/${local[1]}.json` : null;
    rows.push(['Example', target ? `[\`${entry.example}\`](${target})` : `\`${entry.example}\``]);
  }
  if (views.length) rows.push(['Views', views.join(', ')]);
  // Named rather than counted: „what can my agent do with this" is the question a
  // reader has, and a number does not answer it.
  if (tools.length) rows.push(['Agent tools', tools.join(', ')]);
  lines.push('| | |', '| --- | --- |');
  for (const [key, value] of rows) lines.push(`| ${key} | ${value} |`);
  lines.push('');
  return lines.join('\n');
}

function render(plugins: Found[]): string {
  const byDomain = new Map<string, Found[]>();
  for (const p of plugins) {
    const domain = p.manifest.catalogue?.domain ?? 'uncategorised';
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push(p);
  }

  const out: string[] = [
    '<!-- Generated by scripts/plugins/catalogue.ts — do not edit by hand. -->',
    '<!-- Run `npm run plugins:catalogue` after changing a plugin manifest. -->',
    '',
    '# Plugins',
    '',
    'What a Zeitlines timeline can carry beyond items and groups. Each plugin adds',
    'item fields, sometimes a view of its own, and sometimes verbs an agent can call.',
    'Its own README is the page that documents it.',
    '',
    'Writing one: [docs/plugin-authoring.md](docs/plugin-authoring.md) for the contract,',
    '[docs/plugin-playbook.md](docs/plugin-playbook.md) for the process.',
    '',
  ];

  for (const domain of [...byDomain.keys()].sort()) {
    out.push(`## ${domain}`, '');
    for (const plugin of byDomain.get(domain)!.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
      out.push(renderPlugin(plugin));
    }
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

const plugins = await findPlugins();
const problems = plugins.flatMap((p) => publishProblems(p).map((problem) => `${p.folder}: ${problem}`));
const page = render(plugins);

if (check) {
  // Both halves matter, and reporting only one turns the check into a silent pass:
  // a stale page hides a manifest change, and a plugin with no entry renders a
  // blank card that the diff-compare alone would happily accept.
  let failed = false;
  if (problems.length) {
    console.error('[catalogue] NOT PUBLISHABLE');
    for (const problem of problems) console.error(`            ${problem}`);
    failed = true;
  }
  let committed = '';
  try {
    committed = readFileSync(OUT, 'utf8');
  } catch {
    console.error('[catalogue] MISSING PLUGINS.md — run `npm run plugins:catalogue`');
    process.exit(1);
  }
  if (committed !== page) {
    console.error(
      '[catalogue] STALE PLUGINS.md — it no longer matches the plugin manifests.\n' +
        '            Run `npm run plugins:catalogue` and commit the result.',
    );
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`[catalogue] ok    PLUGINS.md matches ${plugins.length} plugin manifest(s)`);
} else {
  writeFileSync(OUT, page);
  console.log(`[catalogue] wrote PLUGINS.md — ${plugins.length} plugin(s)`);
  for (const problem of problems) console.warn(`[catalogue] warn  ${problem}`);
}

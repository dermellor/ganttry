// Install a plugin that lives in this deploy's own `plugins/` directory.
//
// The air-gapped path, and the reason it is a script rather than a curl recipe:
// an instance with no outbound network usually also has no convenient way to make
// an authenticated HTTP call to itself, and the operator gate would then be the
// thing standing between an operator and their own machine. This talks to the
// repo directly, which is the same access writing the row by hand would need —
// so it grants nothing extra, it just spells the row correctly.
//
//   npm run plugin:install -- sprints
//   npm run plugin:install -- sprints --no-pin      (skip the integrity hash)
//
// It reads `plugins/<id>/manifest.json`, validates it against THIS host's
// contract, hashes the entry file, and writes the registry row. Everything it
// refuses, it refuses for the same reason the HTTP install does, because both go
// through the same validation.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest } from '../../src/pluginHost/manifest.ts';
import { envValue } from '../db/env.ts';
import { resolveRepoFromEnv } from '../db/repo-node.ts';
import type { InstalledPlugin } from '../../src/types.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function fail(message: string): never {
  console.error(`[plugin:install] ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const pin = !args.includes('--no-pin');
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) fail('usage: npm run plugin:install -- <plugin-id> [--no-pin]');

  const base = envValue('TIMELINES_PLUGINS_DIR') || join(ROOT, 'plugins');
  const dir = resolve(base, id!);
  // Containment: the id reaches a filesystem path, so a `..` segment would read
  // and register a file from anywhere the process can see. Checked on the RESOLVED
  // path, the same rule the file repo applies to a timeline id.
  if (dir !== resolve(base) && !dir.startsWith(resolve(base) + '/')) {
    fail(`„${id}" resolves outside ${base}`);
  }
  if (!existsSync(dir)) fail(`no such directory: ${dir}`);

  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    fail(`${manifestPath} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }

  const result = validateManifest(raw);
  if (!result.ok) fail(`manifest is not valid:\n  - ${result.problems.join('\n  - ')}`);
  const manifest = result.manifest;
  if (manifest.id !== id) {
    // The directory name is what the URL is built from, so a mismatch would serve
    // one plugin's code under another's id.
    fail(`the manifest declares id „${manifest.id}" but the directory is „${id}"`);
  }

  // `entry` names the module inside the directory; the manifest's own default is
  // the conventional one, so a plugin with a single file needs no entry at all.
  const entry = manifest.entry ?? 'index.js';
  const entryPath = join(dir, entry);
  if (!existsSync(entryPath)) fail(`missing entry file ${entryPath} (manifest entry: ${entry})`);

  const row: InstalledPlugin = {
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    artifact: { kind: 'vendored', source: `/plugins/${manifest.id}/${entry}` },
    capabilities: [...(manifest.capabilities ?? [])],
    manifest: manifest as unknown as Record<string, unknown>,
    enabled: true,
  };
  if (pin) {
    // Optional for a vendored artifact — the deploy serves its own bytes — but
    // cheap, and it turns „somebody edited the file in place" into a refusal to
    // load rather than a silent change.
    const hash = createHash('sha384').update(await readFile(entryPath)).digest('base64');
    row.artifact.integrity = `sha384-${hash}`;
  }

  const repo = resolveRepoFromEnv();
  if (!repo) {
    fail(
      'no database configured, and the install registry lives there. Set TIMELINES_DATABASE_URL, ' +
        'or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY. A file-backed instance runs the ' +
        'plugins its build shipped with (see docs/plugin-lifecycle.md).',
    );
  }
  const stored = await repo.installPlugin(row, 'plugin:install');
  console.log(
    `[plugin:install] ${stored.id} ${stored.version} from ${stored.artifact.source}` +
      `${stored.artifact.integrity ? ' (pinned)' : ' (not pinned)'}`,
  );
  console.log('[plugin:install] enable it on a timeline with the enable_plugin MCP tool or PUT /api/source/<id>/plugin/' + stored.id);
}

await main();

// `resolveRepoFromEnv` may have opened a module-scoped postgres.js handle, and an
// open handle keeps the event loop alive: without this the script does its work
// and then hangs forever, which reads as „the install is stuck" rather than „done".
// Same teardown as the one-shot build in scripts/build-data.ts.
try {
  const { getSql } = (await import('../db/sql.ts')) as { getSql: () => { end: () => Promise<void> } | null };
  await getSql()?.end();
} catch {
  /* teardown failures must not fail an install that already succeeded */
}

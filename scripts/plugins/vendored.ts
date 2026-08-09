// The `plugins/` directory as an install registry.
//
// **This is the whole install flow for an instance with no database.** The epic's
// constraint is that a self-hosted instance can install a plugin with no central
// service involved (#15); until this existed, a file-backed instance could not
// install one at all. The artifact was copied into the build and registered
// nowhere, so nothing ever loaded it — no error, no line in the plugin panel,
// just a plugin that was never there.
//
// One scan, two consumers, because two would drift: the file repo answers
// `GET /api/plugins` from it, and `build-data.ts` bakes the same list into the
// built config for a deploy that has no API to ask. A build that registered one
// set while the server answered another is the failure this shape prevents.
//
// Every artifact is validated against THIS host's contract and pinned by hash —
// the same two things `npm run plugin:install` does. A registry entry that skipped
// validation would move the refusal from the build, where somebody is watching,
// to the browser, where nobody is. An invalid one is skipped with a reason and
// the rest continue: one broken plugin must not cost the deploy its timelines.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { validateManifest } from '../../src/pluginHost/manifest.ts';
import type { InstalledPlugin } from '../../src/types.ts';

export type VendoredProblem = { plugin: string; problem: string };

export type VendoredScan = {
  plugins: InstalledPlugin[];
  /** Why an artifact was skipped. The caller decides how loudly to say it. */
  skipped: VendoredProblem[];
};

/**
 * Read `<dir>/<plugin-id>/manifest.json` for every subdirectory.
 *
 * A missing directory is not an error: most instances have none, and „no plugins
 * installed" is a legitimate state rather than a misconfiguration.
 */
export async function scanVendoredPlugins(dir: string): Promise<VendoredScan> {
  const plugins: InstalledPlugin[] = [];
  const skipped: VendoredProblem[] = [];
  if (!existsSync(dir)) return { plugins, skipped };

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (e) {
      skipped.push({ plugin: entry.name, problem: `manifest is not valid JSON: ${e}` });
      continue;
    }
    const result = validateManifest(raw);
    if (!result.ok) {
      skipped.push({ plugin: entry.name, problem: result.problems.join('; ') });
      continue;
    }
    const manifest = result.manifest;
    if (manifest.id !== entry.name) {
      // The directory name is what the URL is built from, so a mismatch would
      // serve one plugin's code under another plugin's id.
      skipped.push({ plugin: entry.name, problem: `the manifest declares id „${manifest.id}"` });
      continue;
    }
    const file = manifest.entry ?? 'index.js';
    const entryPath = join(dir, entry.name, file);
    if (!existsSync(entryPath)) {
      skipped.push({ plugin: entry.name, problem: `missing entry file ${file}` });
      continue;
    }

    const integrity = `sha384-${createHash('sha384').update(await readFile(entryPath)).digest('base64')}`;
    plugins.push({
      id: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      // Pinned even though the deploy serves its own bytes: it costs nothing here
      // and turns „somebody edited the file in place" into a refusal to load
      // rather than a silent change.
      artifact: { kind: 'vendored', source: `/plugins/${manifest.id}/${file}`, integrity },
      capabilities: [...(manifest.capabilities ?? [])],
      manifest: manifest as unknown as Record<string, unknown>,
      enabled: true,
    });
  }

  plugins.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { plugins, skipped };
}

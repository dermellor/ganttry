// Every relative import reachable from an edge function carries an explicit
// `.ts`, because Deno resolves an extensionless one to nothing.
//
// This is a deploy-only failure mode, which is what makes it worth a test. The
// Vite build resolves extensionless imports happily, `npm test` runs under tsx
// which does too, and the typechecker never looks at module resolution the way
// Deno does — so every local signal stays green while the edge bundler fails
// with „Could not find file: …/pluginHost/plugins". It happened exactly that
// way: moving `src/plugins.ts` to `src/pluginHost/plugins.ts` left one
// extensionless import behind in the edge graph, and the deploy stayed broken
// until somebody read a build log.
//
// It lives here rather than next to the edge functions on purpose: Netlify
// bundles *every* file in `netlify/edge-functions/` as an edge function, so a
// test file there would itself become one — and `npm test` only globs
// `{src,scripts}/**/*.test.ts`, so it would never have run either.
//
// The walk starts at the edge functions and follows relative imports only.
// Bare specifiers (`@netlify/edge-functions`) and URLs (`https://esm.sh/…`) are
// Deno's business, not ours.

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EDGE_DIR = join(ROOT, 'netlify', 'edge-functions');

/**
 * Every specifier a module imports **as a value**.
 *
 * `import type` / `export type` are skipped: the TypeScript transform erases
 * them before the bundler ever resolves anything, so an extensionless one is
 * harmless. Getting this wrong in the strict direction is not free — the first
 * version of this test flagged eight type-only imports of `src/types` and would
 * have sent the next reader off to "fix" imports that were never the problem.
 *
 * Only statement-level `type` is treated as erased. An inline `{ type A }`
 * still leaves a value import behind unless every binding is a type, and
 * over-reporting that rare case is the safe direction.
 */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)) {
    if (!m[2]) out.push(m[3]);
  }
  // Dynamic `import('…')` is always a value import.
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

const isRelative = (spec: string): boolean => spec.startsWith('./') || spec.startsWith('../');

type Offender = { file: string; spec: string };

async function walk(entry: string, seen: Set<string>, offenders: Offender[]): Promise<void> {
  if (seen.has(entry)) return;
  seen.add(entry);
  let source: string;
  try {
    source = await readFile(entry, 'utf8');
  } catch {
    return;
  }
  for (const spec of specifiersOf(source)) {
    if (!isRelative(spec)) continue;
    if (extname(spec) === '') {
      offenders.push({ file: relative(ROOT, entry), spec });
      continue; // cannot follow it: that is the bug
    }
    await walk(resolve(dirname(entry), spec), seen, offenders);
  }
}

test('no edge-reachable module has an extensionless relative import', async () => {
  const entries = (await readdir(EDGE_DIR, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(EDGE_DIR, e.name));
  assert.ok(entries.length > 0, 'the walk has to start somewhere');

  const seen = new Set<string>();
  const offenders: Offender[] = [];
  for (const entry of entries) await walk(entry, seen, offenders);

  assert.deepEqual(
    offenders,
    [],
    `Deno cannot resolve these; the deploy fails while every local check passes:\n` +
      offenders.map((o) => `  ${o.file} → '${o.spec}'`).join('\n'),
  );
});

test('the walk actually reaches beyond the edge directory', async () => {
  const entries = (await readdir(EDGE_DIR, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(EDGE_DIR, e.name));
  const seen = new Set<string>();
  await walk(entries[0], seen, []);
  for (const entry of entries.slice(1)) await walk(entry, seen, []);

  // Without this the test above passes trivially the day the walk breaks: an
  // empty offender list means nothing if nothing was ever visited.
  const outside = [...seen].filter((f) => !f.startsWith(EDGE_DIR));
  assert.ok(outside.length > 5, `the walk left the edge directory into ${outside.length} module(s)`);
  assert.ok(
    outside.some((f) => f.includes(join('src', 'plugins'))),
    'and it reaches the plugin modules, which is where the extension bug was',
  );
});

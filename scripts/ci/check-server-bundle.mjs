#!/usr/bin/env node
// The server does not carry the interface.
//
// A Netlify Function is bundled by esbuild, which has no loader for a `.css`
// import — so the moment a server-side module reaches one, the function stops
// bundling and **every deploy fails**. What makes that expensive rather than
// annoying is the shape of the failure: the site keeps serving the last good
// deploy, the smoke test asks that deploy whether it answers and it does, and CI
// is green because `npm test` and `vite build` never touch the function bundler.
// Nothing shipped for a day before anyone noticed.
//
// How it happened, so the next person recognises it: the MCP server started
// reading plugin **fields** and **derived values** from `src/pluginHost/registry.ts`.
// That is the client registry. It imports each plugin's descriptor, the descriptor
// carried `load: () => import('./index')`, and `pluginHost/api.ts` re-exported
// `export * from '../design-system'`. Two ordinary-looking lines, and the function
// bundle grew to 118 modules — 50 of them design-system, 27 of them stylesheets.
//
// Two rules came out of it, and this script is what holds them:
//
//   - `pluginHost/api.ts` is DOM-free; the design system lives behind
//     `pluginHost/viewApi.ts`, which only a module that draws may import.
//   - a built-in plugin's view loader is registered by the client
//     (`pluginHost/viewLoaders.ts`) instead of sitting on its descriptor.
//
// The check bundles the function the way Netlify does and asserts what came out.
// It is not a proxy for the real thing: with the loaders below removed it fails
// exactly as the deploy did.

import { build } from 'esbuild';

const ENTRY = 'netlify/functions/mcp.ts';

/** Nothing on this list may appear in a server bundle, each for the same reason. */
const FORBIDDEN = [
  { label: 'stylesheet', test: (p) => p.endsWith('.css') },
  { label: 'design-system module', test: (p) => p.includes('src/design-system/') },
  { label: "plugin view", test: (p) => /src\/plugins\/[^/]+\/index\.ts$/.test(p) },
  { label: 'markdown editor', test: (p) => p.endsWith('src/wysiwyg.ts') },
  // The client's view-loader registry. Reaching it from here means a descriptor
  // has grown a static path to a view again.
  { label: 'built-in view registry', test: (p) => p.endsWith('src/pluginHost/builtInViews.ts') },
];

let result;
try {
  result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    write: false,
    // Deliberately no `.css` / `.svg` loader: that is the point. If one is needed
    // to get through, the bundle contains something it must not.
    logLevel: 'silent',
  });
} catch (err) {
  console.error(`check-server-bundle: ${ENTRY} does not bundle\n`);
  for (const e of err.errors ?? []) {
    console.error(`  ${e.location?.file ?? '?'}:${e.location?.line ?? '?'}  ${e.text}`);
  }
  console.error(
    '\nA server bundle reached the interface. The usual cause is a plugin descriptor\n' +
      'carrying its view, or a server-side module importing pluginHost/viewApi.\n' +
      'See the note at the top of this file.',
  );
  process.exit(1);
}

const modules = Object.keys(result.metafile.inputs);
const problems = [];
for (const rule of FORBIDDEN) {
  const hits = modules.filter((m) => rule.test(m));
  if (hits.length) problems.push({ rule, hits });
}

if (problems.length) {
  console.error(`check-server-bundle: ${ENTRY} carries the interface\n`);
  for (const { rule, hits } of problems) {
    console.error(`  ${hits.length} ${rule.label}(s):`);
    for (const h of hits.slice(0, 6)) console.error(`    ${h}`);
    if (hits.length > 6) console.error(`    … and ${hits.length - 6} more`);
  }
  process.exit(1);
}

console.log(`check-server-bundle: ok    ${modules.length} module(s), no interface in the function`);

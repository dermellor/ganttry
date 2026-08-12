// Module hooks that let `node --test` import a component.
//
// A design-system component imports its own stylesheet — that colocation is what
// makes a build carry only the CSS for what it renders, which the plugin
// bundle-split check depends on. Vite understands `import './Button.css'`; Node
// does not, and answers ERR_UNKNOWN_FILE_EXTENSION.
//
// The unit tests reach components transitively (buildItems → Tag, icons → Icon),
// so the choice is either a stub here or moving the CSS import away from the
// component and losing the splitting. This resolves any `.css` specifier to an
// empty module: nothing under test asserts on styles, and a test that wanted to
// would need a browser, not a stub.
//
// Vite's `?raw` asset imports need the equivalent bridge. The AppMark component
// embeds the product SVG so exported HTML stays self-contained; serving a fake
// value here would hide malformed markup, so the test hook reads and exports the
// same bytes Vite does.

import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true, format: 'module' };
  }
  if (specifier.endsWith('.svg?raw')) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default undefined;', shortCircuit: true };
  }
  if (url.endsWith('.svg?raw')) {
    const source = await readFile(new URL(url.slice(0, -'?raw'.length)), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  }
  return next(url, context);
}

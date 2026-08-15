// Where the built-in plugins' views live, for the browser and for nothing else.
//
// The registry knows every plugin's *data* — its manifest, its fields, its derived
// values, its tools — because the server asks for those. It deliberately does not
// know where a view is: a `() => import('./index')` on the descriptor is followed
// by any bundler that reaches the descriptor, so the MCP function ended up
// carrying both plugin views, their stylesheets and all 50 design-system modules,
// and stopped bundling because esbuild has no loader for `.css`. Netlify then
// failed every deploy while serving the last good one, so nothing shipped for a
// day and no check noticed.
//
// This module is the one place that names both halves, and only `main.ts` imports
// it. `scripts/ci/check-server-bundle.mjs` fails if anything the MCP function
// reaches imports it.
//
// It is on the import allowlist in `check-plugin-isolation.mjs` for the same
// reason the registry is: it is a registry, of the one thing a registry of
// third-party plugins cannot hold — a static import path.

import '../plugins/product-roadmap/view';
import '../plugins/sprints/view';

// Where this plugin's view lives, declared to the **client** registry.
//
// Separate from `descriptor.ts` on purpose: the descriptor is read by the server
// too (fields, derived values, tool handlers), and a `() => import('./index')`
// sitting on it pulls this plugin's view, its stylesheet and the whole design
// system into the MCP function's bundle — which stopped bundling altogether when
// that happened. See `attachView` in src/pluginHost/registry.ts.
//
// Imported only from src/pluginHost/builtInViews.ts, which only the browser entry
// reaches.

import { attachView } from '../../pluginHost/api';
import { sprintsManifest } from './manifest';

attachView(sprintsManifest.id, () => import('./index'));

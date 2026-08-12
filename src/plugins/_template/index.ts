// The lazily-loaded module surface of this plugin: everything the registry reaches
// through its dynamic `load()`, and therefore everything Rollup emits as a separate
// chunk. A generic build downloads none of it.
//
// TEMPLATE. **Delete this file if the plugin has no view of its own**, and the
// `load()` line in `descriptor.ts` with it. A field-only plugin is the common case
// and the cheaper one: grouping by a contributed field already gives a useful
// rendering, and a view costs roughly ten times what a field does.
//
// If you keep it: this is the only place allowed to import view code, DOM helpers,
// the plugin's CSS and anything else heavy. `fields.ts`, `tools.ts` and the
// descriptor stay data-only, or the split is lost.

import type { HostApi } from '../../pluginHost/api';

/**
 * Render the plugin's view into the container the host created for it.
 *
 * The host builds both the container and the header button from the views the
 * manifest declares, so a plugin never touches `index.html` — a core file naming
 * a plugin's markup is refused by `scripts/ci/check-plugin-isolation.mjs`.
 *
 * Called on entry and on every repaint, so it has to be **idempotent**. It does
 * not have to guard against overlapping calls: the host renders into a detached
 * element and swaps it in when the call settles, so two repaints cannot interleave
 * into one section.
 *
 * `host` is the plugin's gated API and the ONLY way into the app: the timeline, its
 * own config, its own rows, a change signal, the status line, whether this timeline
 * accepts writes, and `host.panel` for opening the detail drawer with a form of your
 * own. It arrives as an ARGUMENT rather than through an import, which is what lets a
 * plugin be a file fetched from a URL — there is nothing for it to resolve at load
 * time.
 *
 * Reaching past it into `src/state.ts` or `src/render.ts` is refused by CI, and the
 * reason is not tidiness: a plugin that reaches into the app never meets a gap in
 * the contract, so the gaps survive. If something is missing, that is a finding to
 * file (see docs/plugin-authoring.md → „What was found by doing this").
 */
export async function renderView(container: HTMLElement, viewId: string, host: HostApi): Promise<void> {
  // Use `container.ownerDocument`, never the global `document`. It costs nothing
  // today and it is the difference between a view that can move behind a sandbox
  // later and one that has to be rewritten (docs/plugin-isolation.md).
  const doc = container.ownerDocument;
  const timeline = await host.timeline();

  container.replaceChildren();
  const heading = doc.createElement('h2');
  heading.textContent = timeline?.name ?? viewId;
  container.append(heading);

  // TODO: build the view. Reach the design system through `src/pluginHost/api.ts`
  // rather than writing your own controls — a button that merely resembles the
  // app's drifts away from it (docs/design-system.md).
}

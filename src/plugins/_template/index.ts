// The lazily-loaded module surface of this plugin: everything the registry reaches
// through its dynamic `load()`, and therefore everything Rollup emits as a separate
// chunk. A generic build downloads none of it.
//
// TEMPLATE. **Delete this file if the plugin has no view of its own.** A field-only
// plugin is the common case and the cheaper one: grouping by a contributed field
// already gives a useful rendering, and a view costs roughly ten times what a field
// does.
//
// If you keep it: this is the only place allowed to import view code, DOM helpers,
// the plugin's CSS and anything else heavy. `fields.ts` and the registry entry stay
// data-only, or the split is lost.

/**
 * Render the plugin's view into its host container. Called when a timeline enters
 * this view and on every repaint afterwards, so it has to be idempotent and cheap
 * enough to run on each state change.
 */
export function renderView(): void {
  // TODO: read the app state, build the DOM, write it into the host container.
  //
  // Today the host container and its header button are declared in `index.html`
  // (see how `product-roadmap` does it). After #10 the host creates both from the
  // plugin's declared views, and this function receives its container instead of
  // looking one up.
}

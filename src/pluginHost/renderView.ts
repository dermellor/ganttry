// Calling a plugin's `renderView`, and the race the host has to absorb.
//
// Its own module, with no app imports at all, for two reasons that point the same
// way: it is pure host mechanics over a container, and everything around it in
// `views.ts` reaches the app's state and therefore its DOM — a rule this
// load-bearing has to be testable without a browser.

import type { HostApi } from './hostApi';

/** What the host calls. Structural, so a test needs no module to stand in for one. */
export type RenderableModule = {
  renderView(container: HTMLElement, viewId: string, host: HostApi): void | Promise<void>;
};

/**
 * How many renders this section has started. The token a render holds is compared
 * against it when the render finishes, so a slow one that lost the race is
 * discarded instead of overwriting a newer paint.
 */
const generation = new WeakMap<HTMLElement, number>();

/**
 * Call a plugin's `renderView` and put the result into `section`.
 *
 * **The plugin never renders into the live section.** It is handed a detached
 * element and the host swaps it in when the call settles, which fixes a race that
 * an idempotent plugin cannot fix for itself: `renderView` may be async, two
 * repaints can overlap, and both then clear the section and append — leaving the
 * view rendered twice. Found by building a plugin outside this repository, where
 * the view awaits the host API before it can paint anything at all
 * (<https://github.com/dermellor/zeitlines/issues/16>), so the shape is the
 * normal one rather than an exotic mistake.
 *
 * The swap also removes the half-painted state: a plugin that throws mid-render
 * leaves the previous view standing rather than a fragment of the new one.
 */
export function renderPluginViewInto(
  section: HTMLElement,
  pluginId: string,
  viewId: string,
  mod: RenderableModule,
  host: HostApi,
): void {
  const token = (generation.get(section) ?? 0) + 1;
  generation.set(section, token);
  // Deliberately unclassed. It used to carry `plugin-view-body`, which no stylesheet
  // ever defined: the wrapper is styled as „the section's child" (`.plugin-view > *`
  // in app.css) precisely because a plugin is handed this element and may set
  // `className` on it, which would drop any class we put here — silently, and only
  // for that plugin.
  const staging = section.ownerDocument.createElement('div');

  const swap = () => {
    // A render that is no longer the latest is dropped: the newer one either has
    // already swapped in or is about to, and the user asked for that state.
    if (generation.get(section) === token) section.replaceChildren(staging);
  };

  let result: void | Promise<void>;
  try {
    result = mod.renderView(staging, viewId, host);
  } catch {
    // The loader already wrapped the plugin's own throw into a failure notice
    // inside `staging`; showing it is the point.
    swap();
    return;
  }
  if (result && typeof (result as Promise<void>).then === 'function') {
    void (result as Promise<void>).then(swap, swap);
  } else {
    swap();
  }
}


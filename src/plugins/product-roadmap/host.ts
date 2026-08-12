// The host this plugin was handed, and the timeline snapshot it renders from.
//
// Every module here used to read `state.activeSourceFile` and `state.activeSourceId`
// straight out of the app. That was the plugin's largest privilege (#117): a
// third-party plugin has no such import, so every gap in the host API was invisible
// to the one plugin that could have found it.
//
// **Why a module-level snapshot rather than an await at each call site.** The host
// API is async by contract, because it has to survive being moved behind an iframe
// (docs/plugin-isolation.md). This view's render tree reads the model in about two
// dozen places, most of them inside DOM builders that cannot be async without
// turning every caller async too. So the snapshot is taken ONCE per render and read
// synchronously from here — the same shape the app's own render path has, where
// `state.activeSourceFile` is filled before anything draws.
//
// The consequence to respect: `file()` is a snapshot, not a live object. Writing
// through it changes nothing on the server. Every write goes through `./api.ts` and
// is mirrored into the snapshot by `./store.ts`, which is what makes the next
// repaint show it.

import type { HostApi, TimelineSnapshot } from '../../pluginHost/api';

let host: HostApi | null = null;
let snapshot: TimelineSnapshot | null = null;
let writable = false;

/**
 * The host API, or a refusal that names what is missing.
 *
 * A throw rather than a silent no-op: reaching for `data` without `data:own` is a
 * manifest mistake, and a write that quietly does nothing is the version of it
 * that costs an afternoon.
 */
export function hostApi(): HostApi {
  if (!host) throw new Error('product-roadmap: no host API — renderView has not run yet');
  return host;
}

/**
 * The plugin's own rows and the timeline they hang off. Null before the first
 * render.
 *
 * This is also the object `./store.ts` mirrors a write into — the mirror functions
 * stay pure over a file argument, which is what keeps them testable without a host.
 */
export function file(): TimelineSnapshot | null {
  return snapshot;
}

/** Does this timeline accept writes? Read once per render, so it stays synchronous. */
export function canWrite(): boolean {
  return writable;
}

/** The status line, through the host rather than the app's own. */
export function status(text: string): void {
  host?.status(text);
}

/**
 * Take the snapshot for one render pass.
 *
 * `canWrite` is resolved here for the same reason the file is: the matrix asks it
 * while building cells, and an await there would make every builder async.
 */
export async function beginRender(next: HostApi): Promise<void> {
  host = next;
  snapshot = await next.timeline();
  writable = await next.canWrite();
}

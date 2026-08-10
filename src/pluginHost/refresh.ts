// „Something the host wrote for a plugin has landed — reload the view."
//
// The counterpart of `changes.ts`, and the direction is what makes it a separate
// module: that one is a notification going OUT to plugins, this one is a request
// coming IN from the host API.
//
// It exists because of a bug that only showed up once a plugin actually wrote an
// item. `HostApi.items` had been implemented and never called; the first plugin
// to call it moved an item successfully — the file on disk was right — and the
// app kept showing the old dates, with no error and no signal, until a reload.
// The interface's own edits refresh because every call site does it by hand, and
// the host API has no call sites.
//
// So the rule is: **a write that goes through the host is refreshed by the
// host.** A plugin cannot be made responsible for it — every plugin would have
// to remember, and the one that forgets looks like a broken app rather than a
// broken plugin.
//
// A function slot rather than a direct import, because `hostBackend.ts` calling
// `render.ts` closes a cycle (render → views → hostBackend → render). The app
// registers its reload at startup; before that, and in a test, this is a no-op.

type Refresh = () => void | Promise<void>;

let refresh: Refresh | null = null;

/** Called once by the app at startup. */
export function setTimelineRefresh(fn: Refresh | null): void {
  refresh = fn;
}

/**
 * Reload the active view after a host-API write.
 *
 * Deliberately not awaited by its callers: the plugin's `await host.items.update(…)`
 * resolves when the WRITE is durable, which is the promise the API makes. Waiting
 * for the app's repaint too would make a plugin's write appear to take as long as
 * a full source reload, and a failure to repaint would surface as a failed write.
 */
export function refreshAfterHostWrite(): void {
  if (!refresh) return;
  try {
    void refresh();
  } catch (error) {
    console.error('[plugin] refreshing after a host write failed', error);
  }
}

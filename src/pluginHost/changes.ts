// „The timeline changed" as one signal, for `HostApi.subscribe`.
//
// A plugin view is rendered by the host on entry and on every repaint, so a
// plugin that only draws needs no subscription. One that holds derived state —
// a computed board, a cached aggregate — does: without a signal its only options
// are polling or recomputing on every mouse move, and both are worse than the
// four lines here.
//
// It is deliberately a bare notification with no payload. Handing listeners the
// new file would make the signal a second delivery path for the snapshot, and
// then two of them can disagree; `subscribe` says *that* something changed, and
// `timeline()` says what it is now. That also keeps the signal shippable across
// a sandbox boundary later (docs/plugin-isolation.md), where a payload could not
// be a live object anyway.
//
// The host fires it from the one place that already knows: the end of a
// successful render. Firing per write instead would miss every change that
// arrives from somebody else through the realtime channel.

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Subscribe to timeline changes. Returns an unsubscribe function.
 *
 * A listener that throws must not stop the others, and must not take the render
 * down: this runs at the end of the render path, and one badly behaved plugin
 * would otherwise cost every other plugin its update and the user their view.
 */
export function onTimelineChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fire the signal. Called by the host, never by a plugin. */
export function notifyTimelineChanged(): void {
  // Iterate a copy: a listener that unsubscribes itself while being notified is
  // ordinary (a view tearing down), and mutating the set mid-iteration would
  // skip the next one.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[plugin] a timeline-change listener threw', error);
    }
  }
}

/** Drop every listener. For tests, and for a hard view teardown. */
export function resetTimelineChangeListeners(): void {
  listeners.clear();
}

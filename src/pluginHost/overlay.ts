// Floating layers, owned by the host.
//
// A view that needs a tooltip, a popover or a small editor has to escape its own
// container: the container scrolls, and `overflow-x` clips `overflow-y` with it,
// so a layer nested inside gets cut off at the row's edge. The obvious fix is
// `document.body` plus `position: fixed`, which is what the pricing view did.
//
// It is also the single worst habit a plugin can have. Three global reaches come
// with it — `document.body`, `document.getElementById` and a capture listener on
// `document` for dismissal — and every one of them is an assumption that the
// plugin and the app share a realm. Today they do. If that ever changes
// (docs/plugin-isolation.md names the condition), those assumptions are what
// would have to be unpicked from every plugin that was ever written.
//
// So the host owns the layer and the plugin asks for one. What is gained now:
// no plugin touches the global document, dismissal behaves the same everywhere,
// and placement is solved once instead of per plugin.
//
// What is gained later, and the honest limit of it: the CALL SHAPE survives a
// boundary. `open`, `showAt(rect)`, `hide` need no live object between the two
// sides — the anchor is passed as a rectangle, which is plain data, so a plugin
// in a frame could hand over frame-local coordinates for the host to translate.
// Filling `element` is the part that would still have to change, from „you write
// into this node" to „you describe what goes in it". Half the migration, removed
// in advance, for the price of one indirection.

/** An anchor as plain data. `DOMRect` satisfies it, and so does a message. */
export type OverlayRect = {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
};

export type OverlayOptions = {
  /** Added to the host's own class, so the plugin's stylesheet can reach it. */
  className?: string;
  /** ARIA role for the layer, e.g. `tooltip` or `dialog`. */
  role?: string;
};

export type Overlay = {
  /**
   * The node to render into.
   *
   * The one live object in this API, and the reason is that the view seam already
   * hands one over: a plugin that renders its view into an element is not made
   * more isolated by receiving its popover as a message.
   */
  readonly element: HTMLElement;
  readonly visible: boolean;
  /**
   * Called when the user dismisses the layer with Escape or a click outside. The
   * host owns those listeners, so a plugin never registers a global one.
   *
   * Assignable rather than an open() option, because a layer is reused by id: a
   * popover reopened against a different anchor needs a different „and put the
   * focus back where it was", and an option fixed at creation would keep sending
   * the focus to whatever was clicked first.
   */
  onDismiss: (() => void) | null;
  /** Show the layer, placed against `anchor`, flipping and clamping as needed. */
  showAt(anchor: OverlayRect): void;
  hide(): void;
  /** Remove the layer and its listeners. */
  destroy(): void;
};

export type OverlayApi = {
  /**
   * Open (or reuse) a layer under `id`. Reusing by id is what keeps a repaint
   * from leaving a trail of dead layers on the page.
   */
  open(id: string, options?: OverlayOptions): Overlay;
};

const GAP = 8;

/**
 * Place `layer` just below `anchor`, flipping above when it would overflow the
 * bottom and clamping the left edge into the viewport.
 *
 * Each adjustment is guarded on a known viewport metric: a not-yet-painted tab
 * reports 0, and an unguarded flip would then fire on every layer in it.
 */
export function placeLayer(layer: HTMLElement, anchor: OverlayRect, viewport: { width: number; height: number }): void {
  const lw = layer.offsetWidth;
  const lh = layer.offsetHeight;
  let left = anchor.left;
  let top = anchor.bottom + GAP;
  if (viewport.height > 0 && top + lh > viewport.height - GAP) top = anchor.top - GAP - lh;
  if (viewport.width > 0) left = Math.max(GAP, Math.min(left, viewport.width - GAP - lw));
  top = Math.max(GAP, top);
  layer.style.left = `${left}px`;
  layer.style.top = `${top}px`;
}

/**
 * The host's implementation, over one document.
 *
 * `host` is where layers are attached. It takes the document rather than reading
 * a global for the same reason the rest of this module exists: the code that
 * tells plugins not to assume one realm should not assume one itself.
 */
export function createOverlayApi(host: HTMLElement): OverlayApi {
  const open = new Map<string, Overlay>();

  return {
    open(id, options = {}) {
      const existing = open.get(id);
      if (existing) return existing;

      const doc = host.ownerDocument;
      const element = doc.createElement('div');
      element.className = ['plugin-overlay', options.className].filter(Boolean).join(' ');
      if (options.role) element.setAttribute('role', options.role);
      element.hidden = true;
      host.appendChild(element);

      let visible = false;

      const dismiss = () => {
        handle.hide();
        handle.onDismiss?.();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || !visible) return;
        // Stopped here so the app's own Escape handling does not also fire: from
        // the user's side one press closed one thing.
        e.stopPropagation();
        dismiss();
      };
      // Capture phase: a click outside has to close this layer BEFORE the element
      // under the pointer reacts, or a click on the control that opens the layer
      // closes and immediately reopens it.
      const onOutside = (e: Event) => {
        if (!visible || element.contains(e.target as Node)) return;
        dismiss();
      };
      doc.addEventListener('keydown', onKey, true);
      doc.addEventListener('pointerdown', onOutside, true);

      const handle: Overlay = {
        element,
        onDismiss: null,
        get visible() {
          return visible;
        },
        showAt(anchor) {
          element.hidden = false;
          visible = true;
          const view = doc.defaultView;
          placeLayer(element, anchor, {
            width: view?.innerWidth ?? doc.documentElement.clientWidth ?? 0,
            height: view?.innerHeight ?? doc.documentElement.clientHeight ?? 0,
          });
        },
        hide() {
          element.hidden = true;
          visible = false;
        },
        destroy() {
          doc.removeEventListener('keydown', onKey, true);
          doc.removeEventListener('pointerdown', onOutside, true);
          element.remove();
          open.delete(id);
        },
      };
      open.set(id, handle);
      return handle;
    },
  };
}

// The app's own layer root.
//
// Reading the global document here is the one place it is correct: this is the
// HOST creating the root of its own page, which is exactly the thing a plugin
// must not do. Lazy so a test can build its own with `createOverlayApi` and never
// touch a global at all.
let appOverlays: OverlayApi | null = null;

/**
 * The overlay API a plugin uses.
 *
 * Imported by plugins today. Handing it through `HostApi` instead is part of the
 * SDK work (<https://github.com/dermellor/zeitlines/issues/16>), which is where the
 * remaining host imports in a plugin get replaced by one injected object; the call
 * sites here do not change when that happens.
 */
export function overlays(): OverlayApi {
  if (!appOverlays) appOverlays = createOverlayApi(document.body);
  return appOverlays;
}

// The detail drawer, as something a plugin can open.
//
// A plugin's own forms have to live somewhere, and the honest options were only
// two: the app's drawer, or a layer of the plugin's own. The drawer wins because a
// plugin view is a first-class surface of the product (docs/design-system.md) — a
// form that opens beside the drawer instead of in it closes differently, focuses
// differently and sits somewhere else, and a reader reads that as the app being
// inconsistent rather than as a plugin being separate.
//
// `product-roadmap` did it by writing into `els.detailBody` and setting two state
// fields named after its own rows. That is the privilege this module removes: the
// same drawer, reachable by any plugin, with the host keeping the books.
//
// **The host renders nothing of the plugin's.** It supplies the container and the
// heading, exactly as `views.ts` does for a view, and the plugin fills it. That is
// the same shape the overlay layer already has, and the reason is the same: it is
// the version that survives a boundary where the plugin no longer shares a DOM
// (docs/plugin-isolation.md).
//
// The implementation arrives through a slot rather than an import, like
// `./refresh.ts`: this module is reached from `hostBackend.ts`, and importing
// `detailPanel.ts` from there closes a cycle through the item form.

/** What a plugin puts in the drawer. */
export type PanelForm = {
  /** The drawer's heading while this form is open. */
  title: string;
  /**
   * Fill the container the host created. Called once per `open`.
   *
   * Use `container.ownerDocument`, never the global `document` — the same rule the
   * view path carries, for the same reason.
   */
  render(container: HTMLElement): void;
};

export type PanelApi = {
  /**
   * Open the drawer with this plugin's form, replacing whatever it showed.
   *
   * The host records that a plugin form is open, which is what keeps background
   * persistence from writing underneath it (`isAnyFormOpen` in src/state.ts).
   */
  open(form: PanelForm): void;
  /** Close the drawer, if this plugin's form is what is in it. */
  close(): void;
  /**
   * Show the app's own detail view for one of its items — the read-only note or
   * the item form, whichever the source allows.
   *
   * Separate from `open` because it is the opposite direction: the plugin is
   * handing the drawer back to the app rather than borrowing it. A pricing matrix
   * linking a feature to the roadmap item that ships it needs exactly this.
   */
  showItem(itemId: string): void;
};

/** What the app supplies. Every method is a handful of lines in `detailPanel.ts`. */
export type PanelBackend = {
  open(pluginId: string, form: PanelForm): void;
  close(pluginId: string): void;
  showItem(itemId: string): void;
};

let backend: PanelBackend | null = null;

/** Called once by the app at startup. */
export function setPanelBackend(next: PanelBackend | null): void {
  backend = next;
}

/**
 * The panel API for one plugin, with its id bound.
 *
 * Bound rather than passed, for the reason `dataApi` binds it: there is no call
 * shape in which one plugin closes another's form.
 *
 * Before the app registers a backend — and in a test — every method is a no-op
 * rather than a throw. A plugin is not the right place to discover that the host
 * has not finished starting up.
 */
export function createPanelApi(pluginId: string): PanelApi {
  return {
    open(form) {
      backend?.open(pluginId, form);
    },
    close() {
      backend?.close(pluginId);
    },
    showItem(itemId) {
      backend?.showItem(itemId);
    },
  };
}

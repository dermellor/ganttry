// `HostApi.data`: a plugin's own rows, over the generic plugin-data routes.
//
// It is its own module, separate from the rest of the backend, for one reason:
// this is the part that decides **which rows a plugin can reach**, and the rest
// of the backend cannot be imported without the app's `state` and its DOM. A
// security-relevant construction that cannot be unit-tested gets verified by
// reading it, which is how the encoding bug arrives.
//
// So everything here is parameterised: the plugin id is bound at construction
// (there is no call shape in which one plugin names another's collections), and
// the two host facilities it needs — which source is active, and how a response
// becomes JSON — arrive as functions.

import type { DataApi, PluginRow } from './hostApi';

/** What the host supplies. Both are one-liners in the app and stubs in a test. */
export type DataApiContext = {
  /** The active timeline's id. Throws when nothing is loaded. */
  sourceId(): string;
  /** Response → parsed body, applying the host's error and session rules. */
  json(res: Response): Promise<any>;
  /** Defaults to the global; injectable so a test needs no server. */
  fetch?: typeof fetch;
};

/**
 * The path of one collection. Each part is encoded exactly once, which is what
 * lets a scoped plugin id (`@acme/sprints`) and a composite row id (`pro:calls`)
 * survive a URL: a value containing a separator arrives double-encoded and comes
 * back out intact.
 */
export function collectionPath(sourceId: string, pluginId: string, collection: string): string {
  return `/api/source/${sourceId}/plugin/${encodeURIComponent(pluginId)}/${encodeURIComponent(collection)}`;
}

export function createDataApi(pluginId: string, ctx: DataApiContext): DataApi {
  const send = ctx.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = (collection: string) => collectionPath(ctx.sourceId(), pluginId, collection);

  return {
    async list(collection) {
      const res = await ctx.json(await send(base(collection)));
      return (res?.rows ?? []) as PluginRow[];
    },

    async put(collection, row) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // The lock counter travels as a header, never in the body: the store keeps
      // it in the row envelope, and a `version` inside `data` would be stored as
      // the plugin's own field by the next plugin that happens to declare one.
      if (row.version != null) headers['If-Match'] = String(row.version);
      return ctx.json(
        await send(base(collection), {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: row.id, data: row.data }),
        }),
      );
    },

    async remove(collection, id) {
      await ctx.json(await send(`${base(collection)}/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    },

    async move(collection, id, anchor) {
      const res = await ctx.json(
        await send(`${base(collection)}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...anchor }),
        }),
      );
      // The host owns the order and returns the full resulting list, so the
      // caller adopts it rather than replaying its own move.
      return (res?.order ?? []) as string[];
    },
  };
}

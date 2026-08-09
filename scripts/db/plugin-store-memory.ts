// An in-memory implementation of the generic plugin-store methods.
//
// It exists so the dispatcher's rules can be tested without a database and
// without a filesystem — those two are covered by their own suites, and mixing
// them in here would make a failing enforcement test look like a storage bug.
//
// It is deliberately a FAITHFUL store rather than a stub: per-row version
// counters, the upsert, the sort order, the If-Match refusal. A permissive fake
// would let a dispatcher bug pass, which is the failure mode a test double is
// most likely to have.
//
// Not a test file, because two suites use it (the dispatcher's and the
// product-roadmap proof) and the test glob would otherwise run it as one.

import type { InstalledPlugin, PluginData, PluginDataRow, TimelineFile } from '../../src/types';
import { ConflictError, NotFoundError, type TimelineRepo } from './repo.ts';

type Stored = { data: Record<string, unknown>; version: number; sort: number; updatedBy?: string };

export type MemoryStore = {
  repo: TimelineRepo;
  /** Seed rows without going through the write path, for arranging a case. */
  seed(timelineId: string, pluginId: string, collection: string, rows: { id: string; data: Record<string, unknown> }[]): void;
  /** Raw view of one collection, for asserting on what the store actually holds. */
  dump(timelineId: string, pluginId: string, collection: string): PluginDataRow[];
  /** Make a timeline exist, so enablement has something to attach to. */
  seedTimeline(timelineId: string): void;
  /** Put a plugin in the registry directly, bypassing the install checks. */
  seedInstalled(plugin: InstalledPlugin): void;
};

export function makeMemoryStore(): MemoryStore {
  // timelineId → pluginId → collection → rowId → row
  const data = new Map<string, Map<string, Map<string, Map<string, Stored>>>>();

  const collectionMap = (timelineId: string, pluginId: string, collection: string): Map<string, Stored> => {
    const byPlugin = data.get(timelineId) ?? new Map();
    data.set(timelineId, byPlugin);
    const byCollection = byPlugin.get(pluginId) ?? new Map();
    byPlugin.set(pluginId, byCollection);
    const rows = byCollection.get(collection) ?? new Map();
    byCollection.set(collection, rows);
    return rows;
  };

  const ordered = (rows: Map<string, Stored>): PluginDataRow[] =>
    [...rows.entries()]
      .sort((a, b) => a[1].sort - b[1].sort || (a[0] < b[0] ? -1 : 1))
      .map(([id, row]) => ({ id, data: row.data, version: row.version, ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}) }));

  // The install registry and per-timeline enablement, so the lifecycle handlers
  // can be tested against the same faithful double.
  const installed = new Map<string, InstalledPlugin>();
  const enabled = new Map<string, Map<string, Record<string, unknown>>>();
  const timelines = new Set<string>();

  const repo = {
    async listInstalledPlugins() {
      return [...installed.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    async installPlugin(plugin: InstalledPlugin) {
      const previous = installed.get(plugin.id);
      const stored = { ...plugin, installedAt: previous?.installedAt ?? '2026-01-01T00:00:00.000Z' };
      installed.set(plugin.id, stored);
      return stored;
    },
    async setPluginInstalledEnabled(pluginId: string, on: boolean) {
      const row = installed.get(pluginId);
      if (!row) throw new NotFoundError(`plugin „${pluginId}" is not installed`);
      installed.set(pluginId, { ...row, enabled: on });
    },
    async removeInstalledPlugin(pluginId: string) {
      installed.delete(pluginId);
    },
    async getTimeline(timelineId: string) {
      if (!timelines.has(timelineId)) return null;
      const refs = [...(enabled.get(timelineId) ?? new Map())].map(([id, config]) =>
        Object.keys(config).length ? { id, config } : { id },
      );
      return { items: [], ...(refs.length ? { plugins: refs } : {}) } as TimelineFile;
    },
    async setTimelinePlugin(timelineId: string, pluginId: string, config: Record<string, unknown>) {
      if (!timelines.has(timelineId)) throw new NotFoundError(`timeline „${timelineId}" not found`);
      const byPlugin = enabled.get(timelineId) ?? new Map();
      enabled.set(timelineId, byPlugin);
      byPlugin.set(pluginId, config ?? {});
    },
    async removeTimelinePlugin(timelineId: string, pluginId: string) {
      enabled.get(timelineId)?.delete(pluginId);
    },
    async listPluginRows(timelineId, pluginId, collection) {
      return ordered(collectionMap(timelineId, pluginId, collection));
    },
    async listPluginData(timelineId, pluginIds) {
      const out: PluginData = {};
      for (const [pluginId, byCollection] of data.get(timelineId) ?? new Map()) {
        if (pluginIds != null && !pluginIds.includes(pluginId)) continue;
        const collections: Record<string, PluginDataRow[]> = {};
        for (const [collection, rows] of byCollection) collections[collection] = ordered(rows);
        out[pluginId] = collections;
      }
      return out;
    },
    async putPluginRow(timelineId, pluginId, collection, row, expectedVersion, updatedBy) {
      const rows = collectionMap(timelineId, pluginId, collection);
      const existing = rows.get(row.id);
      if (existing && expectedVersion != null && existing.version !== expectedVersion) {
        throw new ConflictError(`${collection}/${row.id} changed since version ${expectedVersion}`);
      }
      const stored: Stored = {
        data: row.data ?? {},
        version: existing ? existing.version + 1 : 1,
        sort: existing ? existing.sort : rows.size,
        updatedBy,
      };
      rows.set(row.id, stored);
      return { id: row.id, data: stored.data, version: stored.version };
    },
    async patchPluginRow(timelineId, pluginId, collection, rowId, patch, expectedVersion, updatedBy) {
      const rows = collectionMap(timelineId, pluginId, collection);
      const existing = rows.get(rowId);
      if (!existing) throw new NotFoundError();
      if (expectedVersion != null && existing.version !== expectedVersion) {
        throw new ConflictError(`${collection}/${rowId} changed since version ${expectedVersion}`);
      }
      const merged = { ...existing.data };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      const stored: Stored = { ...existing, data: merged, version: existing.version + 1, updatedBy };
      rows.set(rowId, stored);
      return { id: rowId, data: merged, version: stored.version };
    },
    async deletePluginRow(timelineId, pluginId, collection, rowId) {
      collectionMap(timelineId, pluginId, collection).delete(rowId);
    },
    async orderPluginRows(timelineId, pluginId, collection, orderedIds) {
      const rows = collectionMap(timelineId, pluginId, collection);
      orderedIds.forEach((id, i) => {
        const row = rows.get(id);
        if (row && row.sort !== i) rows.set(id, { ...row, sort: i, version: row.version + 1 });
      });
    },
    async purgePluginData(pluginId, timelineId) {
      for (const [id, byPlugin] of data) {
        if (timelineId != null && id !== timelineId) continue;
        byPlugin.delete(pluginId);
      }
    },
    async purgeItemMetadata() {
      return 0; // items are not modelled here; the repos' own suites cover this
    },
  } as Partial<TimelineRepo> as TimelineRepo;

  return {
    repo,
    seed(timelineId, pluginId, collection, rows) {
      const map = collectionMap(timelineId, pluginId, collection);
      for (const row of rows) map.set(row.id, { data: row.data, version: 1, sort: map.size });
    },
    dump(timelineId, pluginId, collection) {
      return ordered(collectionMap(timelineId, pluginId, collection));
    },
    seedTimeline(timelineId) {
      timelines.add(timelineId);
    },
    seedInstalled(plugin) {
      installed.set(plugin.id, plugin);
    },
  };
}

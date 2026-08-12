// Re-key a product-roadmap timeline from version LABELS to stable version IDS.
//
// Before issue #110 a version was only its label: `config.versions` was the label
// list, and everything pointed at a version by that exact string — a feature's
// `version`, the keys of `nameByVersion` / `descriptionByVersion` /
// `labelByVersion`, a cell's `availableFrom`, and an item's `featureVersion`
// metadata. Renaming a label silently orphaned every one of them.
//
// The new model splits the two: `config.versions` holds stable ids and
// `config.versionLabels` maps id → label. This script performs the one-off move
// for existing timelines: it slugs each current label into an id (via the same
// `versionConfigFromEntries` the write path uses, so the ids match), writes the
// id list + label map into the plugin config, and rewrites every reference above
// from its label to the corresponding id. After it, a rename touches only
// `versionLabels` and breaks nothing.
//
//   tsx scripts/db/migrate-version-ids.ts                    # dry run, all DB timelines
//   tsx scripts/db/migrate-version-ids.ts --timeline <id>    # dry run, one timeline
//   tsx scripts/db/migrate-version-ids.ts --apply            # write
//
// **Idempotent by construction.** A timeline that already carries a non-empty
// `versionLabels` is treated as migrated and skipped, so a second run — or a run
// over a mixed instance — is a no-op rather than a re-slug that would overwrite
// real labels with ids.
//
// **Database only.** The blast radius is DB-backed product timelines; a local
// file/Markdown source that ever grows versions is not covered here and is logged
// as skipped rather than silently passed over (there is no such source today).
// Nothing is dropped: the old label strings survive as the new `versionLabels`
// values.

import { PRODUCT_ROADMAP_PLUGIN } from '../../src/plugins/product-roadmap/plugin.ts';
import { versionLabelsFromConfig, versionsFromConfig } from '../../src/plugins/product-roadmap/plugin.ts';
import { versionConfigFromEntries } from '../../src/plugins/product-roadmap/pricing.ts';
import { PRICING_COLLECTIONS } from '../../src/plugins/product-roadmap/manifest.ts';
import { PRICING_ITEM_VERSION_META_KEY } from '../../src/plugins/product-roadmap/plugin.ts';
import { resolveRepoFromEnv, closeRepoFromEnv } from './repo-node.ts';
import { hydrateProcessEnv } from './env.ts';
import { pathToFileURL } from 'node:url';
import type { TimelineRepo } from './repo.ts';

const { features: FEATURES, tierValues: CELLS, highlights: HIGHLIGHTS } = PRICING_COLLECTIONS;

const APPLY = process.argv.includes('--apply');
const onlyIdx = process.argv.indexOf('--timeline');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

/** Re-key an object's keys through the label→id map, leaving unknown keys alone. */
function remapKeys(
  obj: Record<string, unknown> | undefined,
  labelToId: Map<string, string>,
): { next: Record<string, unknown>; changed: boolean } | null {
  if (!obj || typeof obj !== 'object') return null;
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [k, v] of Object.entries(obj)) {
    const id = labelToId.get(k);
    if (id && id !== k) changed = true;
    next[id ?? k] = v;
  }
  return changed ? { next, changed } : null;
}

type Report = { id: string; refs: number; ok: boolean; detail?: string; skipped?: string };

/** A stored row as the plugin data collections carry it. */
type Row = { id: string; data: Record<string, unknown> };
/** Just the item fields the migration reads/writes. */
type ItemLike = { id?: string; version?: number; metadata?: Record<string, unknown> };

/** The full set of writes the migration will perform, plus the new config. */
export type MigrationPlan = {
  ids: string[];
  versionLabels: Record<string, string>;
  featurePatches: { rowId: string; patch: Record<string, unknown> }[];
  cellPatches: { rowId: string; patch: Record<string, unknown> }[];
  highlightPatches: { rowId: string; patch: Record<string, unknown> }[];
  itemPatches: { itemId: string; metadata: Record<string, unknown>; version?: number }[];
  refs: number;
  /** True when every remapped reference lands on a declared version id. */
  valid: boolean;
};

/**
 * Pure core of the migration: given the current label list, the plugin data
 * collections and the timeline's items, work out the new config and every
 * reference rewrite. No I/O, so the six reference sites can be proven in a unit
 * test rather than only against a live database.
 */
export function planVersionIdMigration(
  labels: string[],
  collections: Record<string, Row[]>,
  items: ItemLike[],
): MigrationPlan {
  // The current strings are labels; slug each into a stable id, exactly as the
  // write path would. `versionConfigFromEntries` uniquifies collisions.
  const { versions: ids, versionLabels } = versionConfigFromEntries(labels.map((label) => ({ label })));
  const labelToId = new Map<string, string>(labels.map((label, i) => [label, ids[i]]));
  const idSet = new Set(ids);

  let refs = 0;
  const featurePatches: { rowId: string; patch: Record<string, unknown> }[] = [];
  const cellPatches: { rowId: string; patch: Record<string, unknown> }[] = [];
  const highlightPatches: { rowId: string; patch: Record<string, unknown> }[] = [];
  const itemPatches: { itemId: string; metadata: Record<string, unknown>; version?: number }[] = [];

  for (const row of collections[FEATURES] ?? []) {
    const d = row.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const ver = typeof d.version === 'string' ? labelToId.get(d.version) : undefined;
    if (ver && ver !== d.version) patch.version = ver;
    const nbv = remapKeys(d.nameByVersion as Record<string, unknown> | undefined, labelToId);
    if (nbv) patch.nameByVersion = nbv.next;
    const dbv = remapKeys(d.descriptionByVersion as Record<string, unknown> | undefined, labelToId);
    if (dbv) patch.descriptionByVersion = dbv.next;
    if (Object.keys(patch).length) {
      featurePatches.push({ rowId: row.id, patch });
      refs += Object.keys(patch).length;
    }
  }

  for (const row of collections[CELLS] ?? []) {
    const d = row.data as Record<string, unknown>;
    const af = typeof d.availableFrom === 'string' ? labelToId.get(d.availableFrom) : undefined;
    if (af && af !== d.availableFrom) {
      cellPatches.push({ rowId: row.id, patch: { availableFrom: af } });
      refs++;
    }
  }

  for (const row of collections[HIGHLIGHTS] ?? []) {
    const d = row.data as Record<string, unknown>;
    const lbv = remapKeys(d.labelByVersion as Record<string, unknown> | undefined, labelToId);
    if (lbv) {
      highlightPatches.push({ rowId: row.id, patch: { labelByVersion: lbv.next } });
      refs++;
    }
  }

  for (const it of items) {
    const meta = it.metadata;
    const cur = meta?.[PRICING_ITEM_VERSION_META_KEY];
    if (typeof cur !== 'string') continue;
    const mapped = labelToId.get(cur);
    if (!mapped || mapped === cur || !it.id) continue;
    itemPatches.push({ itemId: it.id, metadata: { ...meta, [PRICING_ITEM_VERSION_META_KEY]: mapped }, version: it.version });
    refs++;
  }

  // Every planned reference must land on a declared id — a miss means the map is
  // wrong and writing would orphan a row.
  const lands = (v: unknown) => typeof v !== 'string' || idSet.has(v);
  const valid =
    !featurePatches.some((p) => !lands(p.patch.version)) &&
    !cellPatches.some((p) => !lands(p.patch.availableFrom)) &&
    !itemPatches.some((p) => !idSet.has(p.metadata[PRICING_ITEM_VERSION_META_KEY] as string));

  return { ids, versionLabels, featurePatches, cellPatches, highlightPatches, itemPatches, refs, valid };
}

async function migrateOne(repo: TimelineRepo, id: string): Promise<Report | null> {
  const entry = await repo.getTimelinePlugin(id, PRODUCT_ROADMAP_PLUGIN);
  if (!entry) return null; // plugin not enabled here → not a product timeline
  const config = entry.config ?? {};
  const labels = versionsFromConfig(config);
  if (!labels.length) return { id, refs: 0, ok: true, skipped: 'no versions declared' };
  if (Object.keys(versionLabelsFromConfig(config)).length) {
    return { id, refs: 0, ok: true, skipped: 'already migrated (has versionLabels)' };
  }

  const data = await repo.listPluginData(id, [PRODUCT_ROADMAP_PLUGIN]);
  const file = await repo.getTimeline(id);
  const plan = planVersionIdMigration(labels, data[PRODUCT_ROADMAP_PLUGIN] ?? {}, file?.items ?? []);
  if (!plan.valid) return { id, refs: plan.refs, ok: false, detail: 'a remapped reference does not land on a declared version id' };

  if (!APPLY) return { id, refs: plan.refs, ok: true };

  // Config first: the id list + label map is what makes the ids below meaningful.
  // `setTimelinePlugin` leaves `public` untouched (options.public omitted), so a
  // migration never changes who may read the timeline.
  await repo.setTimelinePlugin(id, PRODUCT_ROADMAP_PLUGIN, { ...config, versions: plan.ids, versionLabels: plan.versionLabels });
  for (const p of plan.featurePatches) await repo.patchPluginRow(id, PRODUCT_ROADMAP_PLUGIN, FEATURES, p.rowId, p.patch, undefined, 'migrate-version-ids');
  for (const p of plan.cellPatches) await repo.patchPluginRow(id, PRODUCT_ROADMAP_PLUGIN, CELLS, p.rowId, p.patch, undefined, 'migrate-version-ids');
  for (const p of plan.highlightPatches) await repo.patchPluginRow(id, PRODUCT_ROADMAP_PLUGIN, HIGHLIGHTS, p.rowId, p.patch, undefined, 'migrate-version-ids');
  for (const p of plan.itemPatches) await repo.updateItem(id, p.itemId, { metadata: p.metadata }, p.version, 'migrate-version-ids');

  // Read back and confirm no reference still carries a pre-migration label.
  const after = await repo.listPluginData(id, [PRODUCT_ROADMAP_PLUGIN]);
  const afterFile = await repo.getTimeline(id);
  const known = new Set(labels);
  const idSet = new Set(plan.ids);
  const stale = (v: unknown) => typeof v === 'string' && known.has(v) && !idSet.has(v);
  const leftover =
    (after[PRODUCT_ROADMAP_PLUGIN]?.[FEATURES] ?? []).some((r) => stale((r.data as any).version)) ||
    (after[PRODUCT_ROADMAP_PLUGIN]?.[CELLS] ?? []).some((r) => stale((r.data as any).availableFrom)) ||
    (afterFile?.items ?? []).some((it) => stale((it.metadata as any)?.[PRICING_ITEM_VERSION_META_KEY]));
  if (leftover) return { id, refs: plan.refs, ok: false, detail: 'a pre-migration label survived the write' };
  return { id, refs: plan.refs, ok: true };
}

async function main(): Promise<void> {
  // Load the selected instance profile (TIMELINES_INSTANCE) into process.env, so
  // `resolveRepoFromEnv` sees the instance's database rather than only bare env.
  hydrateProcessEnv();
  const repo = resolveRepoFromEnv();
  if (!repo) {
    console.error('[migrate-version-ids] no database configured (TIMELINES_DATABASE_URL or Supabase env)');
    process.exit(1);
  }

  let timelines: { id: string }[];
  try {
    timelines = ONLY ? [{ id: ONLY }] : await repo.listTimelines();
  } catch (e) {
    console.error(`[migrate-version-ids] could not list timelines: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const reports: Report[] = [];
  for (const { id } of timelines) {
    const report = await migrateOne(repo, id);
    if (!report) continue;
    reports.push(report);
    if (report.skipped) {
      console.log(`[migrate-version-ids] skip ${id}  — ${report.skipped}`);
      continue;
    }
    const mark = report.ok ? 'ok  ' : 'FAIL';
    console.log(`[migrate-version-ids] ${mark} ${id}  ${report.refs} reference(s)${report.detail ? `  — ${report.detail}` : ''}`);
    if (!report.ok) break; // stop before writing more on a timeline that failed verification
  }

  const failed = reports.filter((r) => !r.ok);
  const migrated = reports.filter((r) => !r.skipped);
  const refs = reports.reduce((n, r) => n + r.refs, 0);
  console.log(
    `[migrate-version-ids] ${APPLY ? 'applied' : 'dry run'}: ` +
      `${migrated.length} timeline(s), ${refs} reference(s), ${failed.length} failure(s)`,
  );
  if (!APPLY && migrated.length) console.log('[migrate-version-ids] re-run with --apply to write.');
  await closeRepoFromEnv();
  if (failed.length) process.exit(1);
}

// Run only when invoked as a script, not when a test imports the pure planner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

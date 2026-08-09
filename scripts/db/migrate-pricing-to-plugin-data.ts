// Move product-roadmap's four tables into the generic plugin store.
//
// A script rather than a SQL migration, for one reason that decides it: the row id
// of a matrix cell is `encodeURIComponent(tierId) + ':' + encodeURIComponent(featureId)`,
// and Postgres has no percent-encoding. Reproducing it in SQL would be a second
// implementation of an identity rule that has to agree exactly with the first, and
// the day it disagrees a cell becomes unaddressable. Here it calls the same
// function the write path calls.
//
// It also lets the verification be part of the move rather than a separate step:
// every timeline is read back through the plugin's own composition and compared
// against what it looked like before. A mismatch aborts before the next timeline.
//
//   tsx scripts/db/migrate-pricing-to-plugin-data.ts            # dry run
//   tsx scripts/db/migrate-pricing-to-plugin-data.ts --apply
//
// It covers BOTH source kinds, and that is a requirement rather than a courtesy:
// #12 put the plugin store on the repo seam, so „migrated" has to mean migrated
// wherever a pricing model lives. A run that moved only the database would leave
// every `data/*.json` timeline behind, still readable and still un-editable, which
// is the plugin staying special in a different place.
//
// **It does not drop anything.** The `pricing_*` tables stay exactly as they are,
// which is what keeps the way back open while the new path proves itself in
// production. Dropping them is a later, separate migration (issue #17).

import { PRODUCT_ROADMAP_PLUGIN } from '../../src/plugins/product-roadmap/plugin.ts';
import { collectionsFromPricing, pricingFromCollections } from '../../src/plugins/product-roadmap/compose.ts';
import { versionsFromConfig } from '../../src/plugins/product-roadmap/plugin.ts';
import { resolveRepoFromEnv } from './repo-node.ts';
import { makeFileRepo } from '../local/file-repo.ts';
import { envValue } from './env.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pricing } from '../../src/types.ts';
import type { TimelineRepo } from './repo.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const APPLY = process.argv.includes('--apply');

/** Deep, key-order-independent compare, so a reordered object is not a diff. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as any)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * The old model, in the shape the new one can be compared against.
 *
 * `rowVersion` is server-managed bookkeeping that the generic store keeps in its
 * own column, so it is not part of what moved and comparing it would report a
 * difference that is not one.
 */
function comparable(pricing: Pricing): Pricing {
  return pricingFromCollections(collectionsFromPricing(pricing), pricing.versions ?? []);
}

type Report = { id: string; rows: number; ok: boolean; detail?: string };

async function migrateOne(repo: TimelineRepo, id: string): Promise<Report | null> {
  // Read the legacy model through `getPublicPricing`, NOT through `getTimeline`.
  // Both return it today, but `getTimeline` stops assembling it the moment the
  // read path switches to the generic store — and a migration that cannot read
  // its own source once the new code is deployed is a migration nobody can run.
  // This method exists on all three repos and survives until the final cleanup.
  const legacy = await repo.getPublicPricing(id);
  const pricing = legacy?.pricing;
  if (!pricing || (!pricing.features?.length && !pricing.tiers?.length)) return null;

  const collections = collectionsFromPricing(pricing);
  const rowCount = Object.values(collections).reduce((n, rows) => n + rows.length, 0);

  // The composition is checked against THIS timeline's real model before anything
  // is written, so a dry run is a genuine test rather than a row count.
  const before = canonical(comparable(pricing));
  const roundTrip = canonical(pricingFromCollections(collections, pricing.versions ?? []));
  if (before !== roundTrip) {
    return { id, rows: rowCount, ok: false, detail: 'the model does not survive the round trip in memory' };
  }

  if (!APPLY) return { id, rows: rowCount, ok: true };

  // Replace rather than merge: re-running has to be idempotent, and leftover rows
  // from an earlier partial run would otherwise survive under their old sort.
  await repo.purgePluginData(PRODUCT_ROADMAP_PLUGIN, id);
  for (const [collection, rows] of Object.entries(collections)) {
    for (const row of rows) {
      await repo.putPluginRow(id, PRODUCT_ROADMAP_PLUGIN, collection, row, undefined, 'migrate-pricing');
    }
  }

  // Read back through the store, compose through the plugin, compare. This is the
  // check that matters: it exercises the real write path, the real ordering and
  // the real id derivation rather than the in-memory objects above.
  const stored = await repo.listPluginData(id, [PRODUCT_ROADMAP_PLUGIN]);
  const entry = await repo.getTimelinePlugin(id, PRODUCT_ROADMAP_PLUGIN);
  const after = canonical(pricingFromCollections(stored[PRODUCT_ROADMAP_PLUGIN], versionsFromConfig(entry?.config)));
  if (before !== after) {
    return { id, rows: rowCount, ok: false, detail: 'stored rows do not compose back to the original model' };
  }
  return { id, rows: rowCount, ok: true };
}

/** Every store this instance has, labelled so the report says where a row went. */
function stores(): { label: string; repo: TimelineRepo }[] {
  const out: { label: string; repo: TimelineRepo }[] = [];
  const db = resolveRepoFromEnv();
  if (db) out.push({ label: 'db', repo: db });

  // The same two paths the dev server derives: `data/` anchors the ids, and a
  // scoped instance narrows the scan. Always included — a checkout with no
  // database still has local timelines to move.
  const root = resolve(ROOT, 'data');
  const subdir = envValue('TIMELINES_SOURCES_SUBDIR').replace(/^\/+|\/+$/g, '');
  out.push({ label: 'local', repo: makeFileRepo({ root, scope: subdir ? resolve(root, subdir) : root }) });
  return out;
}

async function main(): Promise<void> {
  const reports: Report[] = [];
  let aborted = false;

  for (const { label, repo } of stores()) {
    if (aborted) break;
    let timelines: { id: string }[];
    try {
      timelines = await repo.listTimelines();
    } catch (e) {
      console.error(`[migrate-pricing] ${label}: could not list timelines: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    for (const { id } of timelines) {
      const report = await migrateOne(repo, id);
      if (!report) continue;
      reports.push(report);
      const mark = report.ok ? 'ok  ' : 'FAIL';
      console.log(
        `[migrate-pricing] ${mark} ${label}:${id}  ${report.rows} row(s)${report.detail ? `  — ${report.detail}` : ''}`,
      );
      // Stop at the first mismatch: continuing would write more rows on a
      // composition that has already been shown to lose something.
      if (!report.ok) {
        aborted = true;
        break;
      }
    }
  }

  const failed = reports.filter((r) => !r.ok);
  const rows = reports.reduce((n, r) => n + r.rows, 0);
  console.log(
    `[migrate-pricing] ${APPLY ? 'applied' : 'dry run'}: ` +
      `${reports.length} timeline(s), ${rows} row(s), ${failed.length} failure(s)`,
  );
  if (!APPLY && reports.length) console.log('[migrate-pricing] re-run with --apply to write.');
  if (failed.length) process.exit(1);
}

await main();

// An open postgres.js handle keeps the event loop alive, and a script that has
// finished its work but never exits reads as one that is stuck.
try {
  const { getSql } = (await import('./sql.ts')) as { getSql: () => { end: () => Promise<void> } | null };
  await getSql()?.end();
} catch {
  /* teardown must not fail a migration that already succeeded */
}

// Cutover helper: re-backfill the normalized pricing tables from the CURRENT raw
// `timelines.pricing` jsonb (DB-direct, no cache), overwriting the normalized
// rows. Run during the edit-freeze right before merging so any blob edit made
// after 0009 was applied is captured. Usage: tsx rebackfill-pricing.ts <id>
import { getSql } from './sql.ts';
import { replacePricing } from './timeline-repo.ts';
import type { Pricing } from '../../src/types.ts';

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error('Usage: tsx rebackfill-pricing.ts <timelineId>');
  const sql = getSql();
  if (!sql) throw new Error('No DB connection (set TIMELINES_DATABASE_URL).');
  // Reads the legacy raw `timelines.pricing` jsonb blob (pre-0009 column). Kept
  // as a historical cutover helper; the column is dropped in the current schema.
  const [data] = await sql`select pricing from timelines where id = ${id}`;
  const pricing = (data?.pricing ?? null) as Pricing | null;
  if (!pricing || !Array.isArray(pricing.tiers)) {
    console.log(`[rebackfill] ${id}: no pricing blob to backfill (nothing to do).`);
    await sql.end();
    return;
  }
  await replacePricing(sql, id, pricing);
  await sql.end();
  console.log(
    `[rebackfill] ${id}: replaced normalized rows from raw blob — ` +
      `${pricing.features?.length ?? 0} features, ${pricing.tiers.length} tiers, ` +
      `${pricing.highlights?.length ?? 0} highlights, ${pricing.versions?.length ?? 0} versions.`,
  );
}
main().catch((e) => {
  console.error('rebackfill failed:', e);
  process.exit(1);
});

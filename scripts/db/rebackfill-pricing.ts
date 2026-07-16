// Cutover helper: re-backfill the normalized pricing tables from the CURRENT raw
// `timelines.pricing` jsonb (DB-direct, no cache), overwriting the normalized
// rows. Run during the edit-freeze right before merging so any blob edit made
// after 0009 was applied is captured. Usage: tsx rebackfill-pricing.ts <id>
import { getServiceClient } from './client.ts';
import { replacePricing } from './timeline-repo.ts';
import type { Pricing } from '../../src/types.ts';

async function main() {
  const id = process.argv[2] ?? 'acme/example-roadmap';
  const db = getServiceClient();
  if (!db) throw new Error('No service client.');
  const { data, error } = await db.from('timelines').select('pricing').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  const pricing = (data?.pricing ?? null) as Pricing | null;
  if (!pricing || !Array.isArray(pricing.tiers)) {
    console.log(`[rebackfill] ${id}: no pricing blob to backfill (nothing to do).`);
    return;
  }
  await replacePricing(db, id, pricing);
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

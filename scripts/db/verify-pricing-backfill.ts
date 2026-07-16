// One-off verification for the pricing normalization backfill (issue #21).
// Compares the NEW assembled pricing (from the normalized tables) against a
// snapshot of the OLD public blob captured before the migration. Also exercises
// the granular write layer (locking + cell independence) on a throwaway
// timeline, then cleans up. Run: tsx scripts/db/verify-pricing-backfill.ts <oldBlobJson>
import { readFileSync } from 'node:fs';
import { getServiceClient } from './client.ts';
import {
  getPublicPricing,
  addFeature,
  updateFeature,
  addTier,
  setTierValue,
  assemblePricing,
  replacePricing,
  ConflictError,
} from './timeline-repo.ts';

const SONA = 'acme/example-roadmap';
const TEST = '__pricing_verify_tmp';

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as any)[k]);
    return out;
  }
  return v;
}
// Normalize a pricing model the way storage does (drop falsy/dangling value
// cells, drop rowVersion) so old-blob and new-assembly are comparable.
function normalize(p: any): any {
  const featureIds = new Set((p.features ?? []).map((f: any) => f.id));
  const c = JSON.parse(JSON.stringify(p));
  for (const f of c.features ?? []) delete f.rowVersion;
  for (const t of c.tiers ?? []) {
    delete t.rowVersion;
    const kept: Record<string, any> = {};
    for (const [k, val] of Object.entries(t.values ?? {})) {
      if (val === false || val == null || val === '') continue;
      if (!featureIds.has(k)) continue;
      kept[k] = val;
    }
    t.values = kept;
  }
  for (const h of c.highlights ?? []) delete h.rowVersion;
  return c;
}
const canon = (v: unknown) => JSON.stringify(sortDeep(v));

async function main() {
  const oldBlobPath = process.argv[2];
  const db = getServiceClient();
  if (!db) throw new Error('No service client — check TIMELINES_SUPABASE_* env.');

  // 1) Backfill correctness: new assembled == old blob (normalized).
  const nu = await getPublicPricing(db, SONA);
  if (!nu) throw new Error('getPublicPricing(sona) returned null after migration!');
  console.log(
    `[assemble] sona: ${nu.pricing.features.length} features, ${nu.pricing.tiers.length} tiers, ` +
      `${nu.pricing.highlights?.length ?? 0} highlights, ${nu.pricing.versions?.length ?? 0} versions`,
  );
  if (oldBlobPath) {
    const old = JSON.parse(readFileSync(oldBlobPath, 'utf8')).pricing;
    const eq = canon(normalize(nu.pricing)) === canon(normalize(old));
    console.log(`[backfill] assembled == old blob (normalized): ${eq ? 'MATCH ✅' : 'MISMATCH ❌'}`);
    if (!eq) {
      // Surface a compact diff of top-level counts + first differing feature.
      const a = normalize(nu.pricing), b = normalize(old);
      console.log(`  features ${a.features.length} vs ${b.features.length}, tiers ${a.tiers.length} vs ${b.tiers.length}, highlights ${(a.highlights||[]).length} vs ${(b.highlights||[]).length}`);
      for (const f of b.features) {
        const m = a.features.find((x: any) => x.id === f.id);
        if (!m || canon(m) !== canon(f)) { console.log('  first feature diff:', f.id, '\n   old:', canon(f), '\n   new:', m ? canon(m) : '(missing)'); break; }
      }
      for (const t of b.tiers) {
        const m = a.tiers.find((x: any) => x.id === t.id);
        if (!m || canon(m.values) !== canon(t.values)) { console.log('  first tier.values diff:', t.id, '\n   old:', canon(t.values), '\n   new:', m ? canon(m.values) : '(missing)'); break; }
      }
      process.exitCode = 1;
    }
  } else {
    console.log('[backfill] no old-blob path given → skipped exact comparison');
  }

  // 2) Granular write layer on a throwaway timeline: locking + cell independence.
  await db.from('timelines').upsert({ id: TEST, name: 'verify', type: 'product' });
  await replacePricing(db, TEST, {
    versions: ['1.0'],
    features: [
      { id: 'f1', name: 'F1' },
      { id: 'f2', name: 'F2' },
    ],
    tiers: [{ id: 't1', name: 'T1', price: '0', values: {} }],
  });

  // Locking: two updates with the same expectedVersion → second must 409.
  const f = (await assemblePricing(db, TEST, ['1.0'])).features.find((x) => x.id === 'f1')!;
  const v0 = f.rowVersion!;
  await updateFeature(db, TEST, 'f1', { name: 'F1-a' }, v0, 'verify');
  let conflicted = false;
  try {
    await updateFeature(db, TEST, 'f1', { name: 'F1-b' }, v0, 'verify'); // stale
  } catch (e) {
    conflicted = e instanceof ConflictError;
  }
  console.log(`[locking] stale updateFeature → 409 ConflictError: ${conflicted ? 'YES ✅' : 'NO ❌'}`);
  if (!conflicted) process.exitCode = 1;

  // Cell independence: set two different cells; both persist.
  await setTierValue(db, TEST, 't1', 'f1', '100', 'verify');
  await setTierValue(db, TEST, 't1', 'f2', true, 'verify');
  const t = (await assemblePricing(db, TEST, ['1.0'])).tiers.find((x) => x.id === 't1')!;
  const bothCells = t.values.f1 === '100' && t.values.f2 === true;
  console.log(`[cells] two independent cells both persisted: ${bothCells ? 'YES ✅' : 'NO ❌'}`);
  if (!bothCells) process.exitCode = 1;

  // Clearing a cell removes it.
  await setTierValue(db, TEST, 't1', 'f1', false, 'verify');
  const t2 = (await assemblePricing(db, TEST, ['1.0'])).tiers.find((x) => x.id === 't1')!;
  console.log(`[cells] clear (value=false) removes cell: ${!('f1' in t2.values) ? 'YES ✅' : 'NO ❌'}`);
  if ('f1' in t2.values) process.exitCode = 1;

  // Cleanup (cascade removes children).
  await db.from('timelines').delete().eq('id', TEST);
  console.log('[cleanup] throwaway timeline removed.');
  console.log(process.exitCode ? '\nRESULT: FAILURES ❌' : '\nRESULT: all checks passed ✅');
}

main().catch((e) => {
  console.error('verify failed:', e);
  process.exit(1);
});

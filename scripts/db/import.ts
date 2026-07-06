// Re-seed / refresh DB-backed timelines from their committed data/<id>.json.
// Default set = the timelines already present in the DB (so file-based examples
// stay out). Pass explicit ids to seed a new timeline. Run: npm run db:import
//   npm run db:import                         # refresh all DB timelines
//   npm run db:import -- acme/mein-plan     # seed/refresh one by id

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getServiceClient } from './client.ts';
import { listTimelines, replaceTimeline } from './timeline-repo.ts';
import type { TimelineFile } from '../../src/types';

const ROOT = process.cwd();

/** Give every item a stable id so it can be addressed individually. */
function ensureItemIds(file: TimelineFile): void {
  const used = new Set(file.items.map((i) => i.id).filter(Boolean) as string[]);
  let n = 1;
  for (const item of file.items) {
    if (item.id) continue;
    let cand = `i${n}`;
    while (used.has(cand)) cand = `i${++n}`;
    item.id = cand;
    used.add(cand);
  }
}

async function main() {
  const db = getServiceClient();
  if (!db) {
    console.error(
      '[import] Missing Supabase credentials. Set TIMELINES_SUPABASE_URL and\n' +
        '         TIMELINES_SUPABASE_SERVICE_KEY (in ~/_AGENTS/.env or .env.local).',
    );
    process.exit(1);
  }

  // Default: refresh the timelines already in the DB. Explicit ids seed new ones.
  const explicit = process.argv.slice(2);
  const ids = explicit.length ? explicit : (await listTimelines(db)).map((t) => t.id);
  if (ids.length === 0) {
    console.warn('[import] DB is empty — pass a timeline id to seed one, e.g. `npm run db:import -- <id>`.');
    return;
  }

  let count = 0;
  for (const id of ids) {
    const abs = join(ROOT, 'data', `${id}.json`);
    let file: TimelineFile;
    try {
      file = JSON.parse(await readFile(abs, 'utf8'));
    } catch (err) {
      console.warn(`[import] skip ${id}: cannot read data/${id}.json (${(err as Error).message})`);
      continue;
    }
    if (!Array.isArray(file.items)) {
      console.warn(`[import] skip ${id}: no items array`);
      continue;
    }
    ensureItemIds(file);
    try {
      await replaceTimeline(db, id, file);
      console.log(
        `[import] ${id} → ${file.items.length} items, ${file.groups?.length ?? 0} groups, ${file.phases?.length ?? 0} phases`,
      );
      count++;
    } catch (err) {
      console.error(`[import] FAILED ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`[import] done — ${count} timeline(s) imported.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Re-seed / refresh DB-backed timelines from their committed data/<id>.json.
// Default set = the timelines already present in the DB (so file-based examples
// stay out). Pass explicit ids to seed a new timeline. Run: npm run db:import
//   npm run db:import                         # refresh all DB timelines
//   npm run db:import -- acme/my-plan          # seed/refresh one by id

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRepoFromEnv, closeRepoFromEnv } from './repo-node.ts';
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
  const repo = resolveRepoFromEnv();
  if (!repo) {
    console.error(
      '[import] Missing DB connection. Set TIMELINES_DATABASE_URL (native postgres.js)\n' +
        '         or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY (supabase-js)\n' +
        '         (in ~/_AGENTS/.env or .env.local).',
    );
    process.exit(1);
  }

  // Default: refresh the timelines already in the DB. Explicit ids seed new ones.
  const explicit = process.argv.slice(2);
  const ids = explicit.length ? explicit : (await repo.listTimelines()).map((t) => t.id);
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
      await repo.replaceTimeline(id, file);
      console.log(
        `[import] ${id} → ${file.items.length} items, ${file.groups?.length ?? 0} groups, ${file.phases?.length ?? 0} phases`,
      );
      count++;
    } catch (err) {
      console.error(`[import] FAILED ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`[import] done — ${count} timeline(s) imported.`);
  // CLI script: close any pooled postgres.js connection so the process exits
  // (no-op on the supabase-js path). The "never end() in a handler" rule is
  // about the edge request path, not one-shot CLIs.
  await closeRepoFromEnv();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

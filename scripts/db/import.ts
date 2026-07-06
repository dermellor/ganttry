// One-time (and re-runnable) migration: loads the Sheet-backed timelines into
// Supabase via replaceTimeline. Only the timelines listed under `sheets` in
// timelines.config.json are DB-backed — file-based standalone timelines in
// data/ stay read-only static sources and are intentionally NOT imported.
//
// Source of each timeline's data is its committed data/<id>.json (the last
// sheet pull). Pass explicit ids to import a subset. Run: npm run db:import

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getServiceClient } from './client.js';
import { replaceTimeline } from './timeline-repo.js';
import type { TimelineFile } from '../../src/types';

const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, 'timelines.config.json');

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

async function sheetBackedIds(): Promise<string[]> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as {
      sheets?: { id: string }[];
    };
    return (cfg.sheets ?? []).map((s) => s.id);
  } catch {
    return [];
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

  const explicit = process.argv.slice(2);
  const ids = explicit.length ? explicit : await sheetBackedIds();
  if (ids.length === 0) {
    console.warn('[import] no sheet-backed timelines configured — nothing to import.');
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

// Which migrations have not been applied yet.
//
// The shared query behind two callers: `db:migrate --status` reports it, and the
// dev-server boot check aborts on it. Kept separate from migrate.ts so the check
// can ask the question without importing the code that answers it by *changing*
// the database.

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

// Resolved from this file's location, not process.cwd(): a check that runs on
// every dev start must not depend on which directory it was started from.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

export type MigrationState = {
  files: string[];
  applied: Map<string, string>;
  pending: string[];
  /** Applied files whose content changed since — the checksum no longer matches. */
  drifted: string[];
  /** True when the tracking table does not exist yet (nothing has ever been applied). */
  untracked: boolean;
};

/**
 * Reads the state without modifying anything — no `create table if not exists`,
 * which is why a missing tracking table is a *result* (`untracked`) rather than
 * something this function quietly fixes. A read-only check must not write.
 */
export async function readMigrationState(sql: Sql): Promise<MigrationState> {
  const files = await migrationFiles();

  let rows: { name: string; checksum: string }[] = [];
  let untracked = false;
  try {
    rows = (await sql`select name, checksum from schema_migrations`) as typeof rows;
  } catch (e) {
    // 42P01 = undefined_table. Any other error is a real problem and propagates.
    if ((e as { code?: string }).code === '42P01') untracked = true;
    else throw e;
  }

  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const pending: string[] = [];
  const drifted: string[] = [];
  for (const file of files) {
    const known = applied.get(file);
    if (known === undefined) {
      pending.push(file);
      continue;
    }
    if (known !== sha256(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))) drifted.push(file);
  }

  return { files, applied, pending, drifted, untracked };
}

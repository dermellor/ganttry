// Portable schema-migration runner (postgres.js). Works against ANY Postgres
// reachable via TIMELINES_DATABASE_URL — no Supabase CLI needed. Applies the
// SQL files in supabase/migrations/ in filename order, each in its own
// transaction, and records them in a `schema_migrations` tracking table so
// re-runs only apply what's pending.
//
//   npm run db:migrate            apply pending migrations
//   npm run db:migrate -- --status   list applied / pending, then exit
//   npm run db:migrate -- --baseline record ALL current files as applied
//                                    WITHOUT running them — for adopting a DB
//                                    that was already migrated by hand (our
//                                    live Supabase). Run once, then use plain
//                                    db:migrate going forward.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getSql } from './sql.ts';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function main() {
  const mode = process.argv.includes('--baseline')
    ? 'baseline'
    : process.argv.includes('--status')
      ? 'status'
      : 'apply';

  const sql = getSql();
  if (!sql) {
    console.error('FAIL: TIMELINES_DATABASE_URL not set — point it at your Postgres.');
    process.exit(2);
  }

  try {
    await sql`
      create table if not exists schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`;

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const appliedRows = (await sql`select name, checksum from schema_migrations`) as { name: string; checksum: string }[];
    const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));

    if (mode === 'status') {
      for (const f of files) console.log(`${applied.has(f) ? 'applied ' : 'pending '}  ${f}`);
      const pending = files.filter((f) => !applied.has(f)).length;
      console.log(`\n${files.length} migrations, ${pending} pending`);
      return;
    }

    if (mode === 'baseline') {
      let n = 0;
      for (const f of files) {
        if (applied.has(f)) continue;
        const checksum = sha256(await readFile(join(MIGRATIONS_DIR, f), 'utf8'));
        await sql`insert into schema_migrations (name, checksum) values (${f}, ${checksum}) on conflict (name) do nothing`;
        n++;
      }
      console.log(`baselined ${n} migration(s) as applied (not executed). ${applied.size + n} total tracked.`);
      return;
    }

    // apply pending
    let count = 0;
    for (const f of files) {
      const content = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
      const checksum = sha256(content);
      if (applied.has(f)) {
        if (applied.get(f) !== checksum) {
          console.warn(`WARN: ${f} already applied but its content changed since (checksum drift) — not re-run.`);
        }
        continue;
      }
      // Each migration in its own transaction: a failure rolls the file back
      // whole, and the tracking row is only written on success.
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`insert into schema_migrations (name, checksum) values (${f}, ${checksum})`;
      });
      console.log(`applied  ${f}`);
      count++;
    }
    console.log(count === 0 ? 'nothing pending — up to date.' : `done: ${count} migration(s) applied.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});

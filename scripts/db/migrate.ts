// Portable schema-migration runner (postgres.js). Works against ANY Postgres
// reachable via TIMELINES_MIGRATE_DATABASE_URL (falling back to
// TIMELINES_DATABASE_URL) — no Supabase CLI needed. A migration is DDL and the
// tracking table is not exposed through PostgREST, so this always needs a direct
// connection string, even on an instance whose app runs on supabase-js. Applies the
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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getMigrationSql, MIGRATE_URL_VAR } from './sql.ts';
import { MIGRATIONS_DIR, migrationFiles, readMigrationState, sha256 } from './pending.ts';

async function main() {
  const mode = process.argv.includes('--baseline')
    ? 'baseline'
    : process.argv.includes('--status')
      ? 'status'
      : 'apply';

  const sql = getMigrationSql();
  if (!sql) {
    console.error(
      `FAIL: no connection for schema work. Set ${MIGRATE_URL_VAR} (or TIMELINES_DATABASE_URL)\n` +
        `      to a Postgres connection string. On Supabase use the Supavisor pooler; the\n` +
        `      service key alone is not enough, because migrations are DDL.`,
    );
    process.exit(2);
  }

  try {
    await sql`
      create table if not exists schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`;

    const files = await migrationFiles();
    const state = await readMigrationState(sql);
    const applied = state.applied;

    if (mode === 'status') {
      for (const f of files) console.log(`${applied.has(f) ? 'applied ' : 'pending '}  ${f}`);
      console.log(`\n${files.length} migrations, ${state.pending.length} pending`);
      if (state.drifted.length) {
        console.log(`${state.drifted.length} applied file(s) changed since they ran: ${state.drifted.join(', ')}`);
      }
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

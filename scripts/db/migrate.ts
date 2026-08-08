// Portable schema-migration runner. Works against ANY Postgres reachable via
// TIMELINES_MIGRATE_DATABASE_URL (falling back to TIMELINES_DATABASE_URL) — no
// Supabase CLI needed. A migration is DDL and the tracking table is not exposed
// through PostgREST, so this always needs a direct connection string, even on an
// instance whose app runs on supabase-js.
//
//   npm run db:migrate                 apply pending migrations
//   npm run db:migrate -- --status     list applied / pending, then exit
//   npm run db:migrate -- --baseline   record ALL current files as applied WITHOUT
//                                      running them — for adopting a database that
//                                      was already migrated by hand. Run once, then
//                                      use plain db:migrate going forward.
//   npm run db:migrate -- --breaking   also apply the next *_breaking.sql (see below)
//   npm run db:migrate -- --allow-dirty  apply even with uncommitted migration files
//
// **Orchestration is umzug, the semantics are ours.** umzug supplies the ordering,
// the "what is pending" loop and the storage seam; it has no database knowledge, so
// the three things that matter here stay explicit and are NOT things umzug does for
// us:
//   - **checksums** — recorded per file, so an edit to an applied migration surfaces
//     as drift instead of silently diverging from what ran (./pending.ts).
//   - **one transaction per file, tracking row included** — see `up` below.
//   - **guardrails** — ./migration-rules.ts, applied before anything runs.
// The reason for a framework at all is shape, not features: the same three hooks
// (context / resolve / storage) fit a SQLite store and, later, a writable notes
// directory, so those get the same process without a second runner to maintain.
// For this project alone it is a lateral move.

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Umzug } from 'umzug';
import type { Sql } from 'postgres';
import { getMigrationSql, MIGRATE_URL_VAR } from './sql.ts';
import { MIGRATIONS_DIR, migrationFiles, readMigrationState, sha256 } from './pending.ts';
import { dirtyMigrationFiles, splitAtBreaking, validateMigrationNames } from './migration-rules.ts';

/**
 * Records a file as applied. Idempotent, because it is reached two ways: inside a
 * migration's own transaction (the normal path) and from `--baseline` (which
 * records without running). umzug also calls it through `storage.logMigration`
 * after a successful `up`, where the row already exists and this is a no-op.
 */
async function recordApplied(sql: Sql, name: string, content: string): Promise<void> {
  await sql`
    insert into schema_migrations (name, checksum)
    values (${name}, ${sha256(content)})
    on conflict (name) do nothing`;
}

function buildUmzug(sql: Sql) {
  return new Umzug<Sql>({
    migrations: {
      glob: ['*.sql', { cwd: MIGRATIONS_DIR }],
      resolve: ({ name, path }) => ({
        name,
        up: async () => {
          const content = await readFile(path as string, 'utf8');
          // One transaction per file, and the tracking row is written INSIDE it.
          // umzug's own contract would log the row after `up` returns, which leaves
          // a window where the DDL is committed and the row is not: the next run
          // then re-applies a migration that already ran. Writing both together
          // means a failure rolls back the schema change and the record as one.
          await sql.begin(async (tx) => {
            await tx.unsafe(content);
            await tx`insert into schema_migrations (name, checksum) values (${name}, ${sha256(content)})`;
          });
        },
      }),
    },
    // Wrapped in a thunk on purpose. umzug accepts either a context or a factory
    // and decides with `typeof context === 'function'` (umzug.js:330) — and a
    // postgres.js handle IS callable, because `sql(…)` is how you interpolate an
    // identifier. Passing it directly makes umzug call it as a factory, and
    // postgres.js answers with `NOT_TAGGED_CALL: Query not called as a tagged
    // template literal` before a single migration runs.
    context: () => sql,
    storage: {
      executed: async () => {
        const rows = (await sql`select name from schema_migrations order by name`) as { name: string }[];
        return rows.map((r) => r.name);
      },
      logMigration: async ({ name, path }) => {
        await recordApplied(sql, name, await readFile(path as string, 'utf8'));
      },
      unlogMigration: async ({ name }) => {
        await sql`delete from schema_migrations where name = ${name}`;
      },
    },
    // Our own output instead: umzug's default logger prints its event objects,
    // which reads nothing like the rest of this script.
    logger: undefined,
  });
}

/** Uncommitted migration files, or [] when this is not a git checkout. */
function uncommittedMigrations(): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', MIGRATIONS_DIR], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return dirtyMigrationFiles(out);
  } catch {
    return []; // not a git repo, or no git — not a reason to refuse
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--baseline') ? 'baseline' : argv.includes('--status') ? 'status' : 'apply';
  const allowBreaking = argv.includes('--breaking');
  const allowDirty = argv.includes('--allow-dirty');

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
    const files = await migrationFiles();

    // Guardrail: the set must be unambiguous before anything runs. Fatal for a
    // path that applies; --status is a read and still reports it.
    const nameProblems = validateMigrationNames(files);
    if (nameProblems.length) {
      const label = mode === 'status' ? 'WARN' : 'FAIL';
      console.error(`${label}: migration filenames are not well-formed:`);
      for (const p of nameProblems) console.error(`      - ${p}`);
      if (mode !== 'status') process.exit(2);
    }

    if (mode === 'status') {
      const state = await readMigrationState(sql);
      if (state.untracked) {
        console.log('no schema_migrations table — nothing recorded as applied.');
      }
      for (const f of files) console.log(`${state.applied.has(f) ? 'applied ' : 'pending '}  ${f}`);
      console.log(`\n${files.length} migrations, ${state.pending.length} pending`);
      if (state.drifted.length) {
        console.log(`${state.drifted.length} applied file(s) changed since they ran: ${state.drifted.join(', ')}`);
      }
      return;
    }

    await sql`
      create table if not exists schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`;

    const state = await readMigrationState(sql);

    if (mode === 'baseline') {
      let n = 0;
      for (const f of state.pending) {
        await recordApplied(sql, f, await readFile(join(MIGRATIONS_DIR, f), 'utf8'));
        n++;
      }
      console.log(`baselined ${n} migration(s) as applied (not executed). ${state.applied.size + n} total tracked.`);
      return;
    }

    // Guardrail: never apply a migration that is not committed. This database
    // would then carry a schema nobody else can reproduce, and amending the file
    // afterwards leaves a checksum that no longer matches what ran.
    if (!allowDirty) {
      const dirty = uncommittedMigrations();
      if (dirty.length) {
        console.error(
          `FAIL: uncommitted migration file(s):\n` +
            dirty.map((f) => `      - ${f}`).join('\n') +
            `\n      Commit them first, so this schema is reproducible from the repo.\n` +
            `      Local iteration against a throwaway database: --allow-dirty`,
        );
        process.exit(2);
      }
    }

    for (const f of state.drifted) {
      console.warn(`WARN: ${f} already applied but its content changed since (checksum drift) — not re-run.`);
    }

    if (state.pending.length === 0) {
      console.log('nothing pending — up to date.');
      return;
    }

    // Guardrail: a *_breaking.sql is sequenced by hand against a deploy, so it is
    // not swept up with the additive files. Exception: a database with nothing
    // applied yet has no running code to protect, so a fresh setup (db:reset, a
    // new self-host) applies the whole set in one go.
    const fresh = state.applied.size === 0;
    const { additive, breaking } =
      fresh || allowBreaking ? { additive: state.pending, breaking: null } : splitAtBreaking(state.pending);

    const umzug = buildUmzug(sql);
    umzug.on('migrated', ({ name }) => console.log(`applied  ${name}`));

    const target = breaking ? additive.at(-1) : state.pending.at(-1);
    if (target) await umzug.up({ to: target });

    const count = breaking ? additive.length : state.pending.length;
    console.log(count === 0 ? 'nothing applied.' : `done: ${count} migration(s) applied.`);

    if (breaking) {
      console.log(
        `\nSTOPPED before ${breaking}\n` +
          `  It is marked breaking: it drops or rewrites something the running code may\n` +
          `  still read. Sequence it by hand — deploy the code that stopped using the old\n` +
          `  shape first, then:\n\n` +
          `    npm run db:migrate -- --breaking`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});

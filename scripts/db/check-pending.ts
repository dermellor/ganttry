// Boot check: refuse to start the dev server against an out-of-date schema.
//
// The failure it prevents: pull a branch that adds a migration, run `npm run dev`,
// and the app talks to the old schema. It surfaces as
// `Could not find the table 'public.X' in the schema cache` — which reads like a
// code bug, so the next half hour goes into the wrong file.
//
// It **verifies, it never applies**. Applying stays a deliberate
// `npm run db:migrate`, because a migration is a schema change and should not
// happen as a side effect of starting a server.
//
//   npm run db:check     # exit 1 when migrations are pending
//   npm run db:check -- --quiet   # only speak up when something is wrong
//
// Silent no-op when no database is configured: a checkout serving only Markdown
// notes or data/*.json has no Postgres, and CI builds without credentials on
// purpose. A hard gate there would block contributors on a database they never
// use.

import { getMigrationSql, MIGRATE_URL_VAR } from './sql.ts';
import { getServiceClient } from './client.ts';
import { readMigrationState } from './pending.ts';
import { envValue } from './env.ts';

const quiet = process.argv.includes('--quiet');

function note(...args: unknown[]): void {
  if (!quiet) console.log(...args);
}

async function main(): Promise<void> {
  const sql = getMigrationSql();

  if (!sql) {
    // No direct connection. Two very different situations, and conflating them
    // would either nag people who have no database or hide a real gap.
    const supabaseConfigured = Boolean(getServiceClient());
    if (supabaseConfigured) {
      console.warn(
        `[db:check] skipped — a database is configured (supabase-js) but schema checks need a\n` +
          `           direct connection: migrations are DDL and the tracking table is not exposed\n` +
          `           through PostgREST. Set ${MIGRATE_URL_VAR} to a connection string to enable\n` +
          `           this check; it does not change which driver serves the app.`,
      );
      return; // a warning, not a failure: this setup cannot answer the question
    }
    note('[db:check] no database configured — nothing to check.');
    return;
  }

  const state = await readMigrationState(sql);

  if (state.untracked) {
    console.error(
      `[db:check] FAIL: no schema_migrations table in this database.\n` +
        `           Either nothing has been applied yet, or the database was migrated by hand.\n` +
        `             fresh database   → npm run db:migrate\n` +
        `             already migrated → npm run db:migrate -- --baseline   (records the\n` +
        `                                current files as applied WITHOUT running them)`,
    );
    process.exitCode = 1;
    return;
  }

  if (state.drifted.length) {
    // Not fatal: the file is already applied, so the schema is current. But the
    // committed SQL no longer matches what ran, which makes the history a lie.
    console.warn(
      `[db:check] WARN: ${state.drifted.length} applied migration(s) changed since they ran:\n` +
        state.drifted.map((f) => `           ${f}`).join('\n') +
        `\n           Editing an applied migration does not re-run it. Add a new file instead.`,
    );
  }

  if (state.pending.length) {
    console.error(
      `[db:check] FAIL: ${state.pending.length} migration(s) pending — the app would talk to an\n` +
        `           older schema than the code expects:\n` +
        state.pending.map((f) => `             ${f}`).join('\n') +
        `\n\n           Apply them:  npm run db:migrate`,
    );
    process.exitCode = 1;
    return;
  }

  note(`[db:check] ok — ${state.applied.size} migration(s) applied, none pending.`);
}

main()
  .catch((e) => {
    // A check must not be the reason a dev server refuses to start, so an
    // unreachable database warns rather than failing. Missing migrations are a
    // code/schema mismatch; an unreachable database is an environment problem the
    // developer will notice through the app itself.
    console.warn(
      `[db:check] skipped — could not reach the database` +
        `${envValue(MIGRATE_URL_VAR) ? ` via ${MIGRATE_URL_VAR}` : ''}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  })
  .finally(() => {
    // postgres.js keeps the event loop alive otherwise.
    process.exit(process.exitCode ?? 0);
  });

// A private database per test file.
//
// The DB-backed tests each rebuild the schema from the migration set, and
// `node --test` runs FILES concurrently. Sharing one database therefore means
// one file's `drop schema public cascade` lands in the middle of another's run,
// which surfaces as „policy already exists" or a missing table and reads like a
// broken migration rather than like two tests standing on each other.
//
// Separate schemas would not do: the migrations qualify everything with
// `public.`, so every file has to own its own database.
//
// Only ever reachable against a local host — the guard from `db:reset`, imported
// rather than restated, because this creates and drops databases.

import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIGRATIONS_DIR, migrationFiles } from './pending.ts';
import { isLocalUrl } from './local-url.ts';

export const TEST_URL_VAR = 'TIMELINES_TEST_DATABASE_URL';

/** The connection string tests run against, or undefined when none is configured. */
export function testDatabaseUrl(): string | undefined {
  return process.env[TEST_URL_VAR];
}

/** `skip` value for `node:test`: false when a database is configured, a reason otherwise. */
export function skipWithoutDatabase(): false | string {
  return testDatabaseUrl() ? false : `set ${TEST_URL_VAR} to a throwaway local Postgres`;
}

/**
 * Create (or recreate) a database named after the caller and hand back a handle
 * to it. `name` becomes `zeitlines_test_<name>`, so two files never collide.
 *
 * The caller closes the handle. The database is left behind on purpose: dropping
 * it at the end would race the next run's create, and a throwaway Postgres is
 * thrown away wholesale anyway.
 */
export async function freshTestDatabase(name: string): Promise<postgres.Sql> {
  const url = testDatabaseUrl();
  if (!url) throw new Error(`${TEST_URL_VAR} is not set`);
  if (!isLocalUrl(url)) throw new Error(`${TEST_URL_VAR} must point at a local database; this creates and drops databases`);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`test database name must be lower_snake_case: ${name}`);

  const dbName = `zeitlines_test_${name}`;
  // The maintenance connection must not be the one being dropped, and DROP
  // DATABASE refuses while anything is connected — hence its own short-lived
  // handle against the configured database.
  const admin = postgres(url, { prepare: false, max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`create database ${dbName}`);
  } finally {
    await admin.end();
  }

  const target = new URL(url);
  target.pathname = `/${dbName}`;
  return postgres(target.toString(), { prepare: false, max: 1 });
}

/** Apply the whole migration set, in filename order. */
export async function applyMigrations(sql: postgres.Sql, files?: string[]): Promise<void> {
  for (const file of files ?? (await migrationFiles())) {
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

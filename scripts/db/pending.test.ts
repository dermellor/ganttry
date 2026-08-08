// The states the boot check distinguishes, tested without a database.
//
// These were verified once by hand against a throwaway Postgres, which proved the
// happy path but leaves nothing behind that catches a regression. `readMigrationState`
// only needs something that answers one query, so a fake handle covers every branch
// — including the two that are easy to get wrong: a missing tracking table must be a
// *result* rather than an error, and an edited-after-applied file must count as drift
// rather than as pending.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { MIGRATIONS_DIR, migrationFiles, readMigrationState, sha256 } from './pending.ts';

/** Minimal stand-in for the postgres.js tagged-template handle. */
function fakeSql(rows: { name: string; checksum: string }[] | Error): Sql {
  return (() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))) as unknown as Sql;
}

function undefinedTable(): Error {
  return Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' });
}

async function realChecksums(): Promise<{ name: string; checksum: string }[]> {
  const files = await migrationFiles();
  return Promise.all(
    files.map(async (name) => ({
      name,
      checksum: sha256(await readFile(join(MIGRATIONS_DIR, name), 'utf8')),
    })),
  );
}

test('readMigrationState: an empty tracking table means everything is pending', async () => {
  const state = await readMigrationState(fakeSql([]));
  assert.equal(state.untracked, false);
  assert.deepEqual(state.pending, state.files);
  assert.deepEqual(state.drifted, []);
  assert.ok(state.files.length > 0, 'the repo should ship migrations');
});

test('readMigrationState: a missing tracking table is a result, not a throw', async () => {
  // The check must be able to report "nothing has ever been applied here" without
  // creating the table — a read-only check that writes is not read-only.
  const state = await readMigrationState(fakeSql(undefinedTable()));
  assert.equal(state.untracked, true);
  assert.equal(state.applied.size, 0);
});

test('readMigrationState: any other database error propagates', async () => {
  // Only 42P01 is interpreted. A permission error must not be silently reported as
  // "untracked", which would send the reader to `db:migrate` for the wrong reason.
  const boom = Object.assign(new Error('permission denied'), { code: '42501' });
  await assert.rejects(() => readMigrationState(fakeSql(boom)), /permission denied/);
});

test('readMigrationState: all files applied with matching checksums is clean', async () => {
  const state = await readMigrationState(fakeSql(await realChecksums()));
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.drifted, []);
  assert.equal(state.untracked, false);
  assert.equal(state.applied.size, state.files.length);
});

test('readMigrationState: an applied file edited afterwards counts as drift, not pending', async () => {
  const rows = await realChecksums();
  rows[0] = { name: rows[0].name, checksum: 'deadbeef' };
  const state = await readMigrationState(fakeSql(rows));
  assert.deepEqual(state.drifted, [rows[0].name]);
  assert.deepEqual(state.pending, [], 'a drifted file is applied, so it is not pending');
});

test('readMigrationState: a partially applied database reports only the rest', async () => {
  const all = await realChecksums();
  const state = await readMigrationState(fakeSql(all.slice(0, 2)));
  assert.deepEqual(state.pending, state.files.slice(2));
  assert.deepEqual(state.drifted, []);
});

test('readMigrationState: an applied row for a file that no longer exists is ignored', async () => {
  // A migration deleted from the tree leaves its tracking row behind. That is not
  // this check's problem: it reports on the files that exist.
  const rows = [...(await realChecksums()), { name: '9999_gone.sql', checksum: 'x' }];
  const state = await readMigrationState(fakeSql(rows));
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.drifted, []);
  assert.ok(!state.files.includes('9999_gone.sql'));
});

test('migrationFiles: only .sql, sorted, so order is filename order', async () => {
  const files = await migrationFiles();
  assert.ok(files.every((f) => f.endsWith('.sql')));
  assert.deepEqual(files, [...files].sort());
});

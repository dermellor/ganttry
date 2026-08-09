// What migration 0016 does to a database that already has people in it.
//
// The claim in its header is the whole reason it is safe to deploy on its own:
// applying it changes nothing, because every address already in the directory
// comes out an active editor. That claim is about DDL defaults, which is exactly
// the kind of thing reading the file cannot confirm — the constraint could be
// misspelled, the default could sit on the wrong column, and both would look
// right in a diff.
//
// So this runs the real migrations against a real Postgres. It SKIPS without one
// rather than failing: CI builds with no credentials on purpose (AGENTS.md → CI),
// and a checkout serving only `data/*.json` has no database to point it at.
//
//   npm run db:local:up
//   TIMELINES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npm test
//
// It runs against its OWN database, created by `freshTestDatabase`: `node --test`
// runs files concurrently, and two files rebuilding the same schema means one
// file's teardown lands in the middle of the other's run. That guard also refuses
// any host that is not local, since it creates and drops databases.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import postgres from 'postgres';
import { migrationFiles } from './pending.ts';
import { applyMigrations as apply, freshTestDatabase, skipWithoutDatabase } from './test-database.ts';

/**
 * Split the set at a migration: everything up to and including it, and the rest.
 *
 * A test that wants „the state before 0016" has to apply the two halves as
 * ranges. Re-applying from the first file each time is not idempotent — the
 * second pass dies on `create policy` from 0003, which reads as a broken
 * migration rather than as a test replaying half the set.
 */
function splitAt(files: string[], last: string): [string[], string[]] {
  const i = files.indexOf(last);
  if (i < 0) throw new Error(`splitAt: ${last} is not in the migration set`);
  return [files.slice(0, i + 1), files.slice(i + 1)];
}

async function freshSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe('drop schema if exists public cascade; create schema public;');
}

// One top-level test with awaited subtests, because both of them drop and
// rebuild the SAME schema. As two top-level tests they interleave, and the
// second one's rebuild lands in the middle of the first one's run — which
// surfaces as „policy already exists" and reads like a broken migration rather
// than like a test sharing state with its neighbour.
test('migration 0016', { skip: skipWithoutDatabase() }, async (t) => {
  await t.test('leaves every existing directory entry able to do what it could yesterday', async () => {
    const sql = await freshTestDatabase('membership_migration');
    try {
      const files = await migrationFiles();
      await freshSchema(sql);

      // The state an existing instance is in: everything up to the directory,
      // with people in it. Two rows, because 0015's backfill produces both
      // shapes — an address learned from edit attribution, and a named visitor.
      const [before, after] = splitAt(files, '0015_app_users.sql');
      await apply(sql, before);
      await sql`insert into app_users (email, name) values ('named@example.test', 'Named Person')`;
      await sql`insert into app_users (email) values ('address-only@example.test')`;

      // Only what follows, and 0016 has to be in it or this proves nothing.
      assert.ok(after.includes('0016_membership.sql'), '0016 must come after 0015');
      await apply(sql, after);

      const rows = await sql`select email, role, status, accepted_at from app_users order by email`;
      assert.equal(rows.length, 2, 'the migration must not drop or duplicate rows');
      for (const row of rows) {
        assert.equal(row.role, 'editor', `${row.email} keeps write access`);
        assert.equal(row.status, 'active', `${row.email} stays let in`);
        assert.equal(row.accepted_at, null, 'nobody is retroactively given an acceptance date');
      }
    } finally {
      await sql.end();
    }
  });

  await t.test('applies to an empty database, and the new constraints bite', async () => {
    const sql = await freshTestDatabase('membership_migration');
    try {
      const files = await migrationFiles();
      await freshSchema(sql);
      await apply(sql, files);

      await assert.rejects(
        () => sql`insert into app_users (email, role) values ('x@example.test', 'owner')`,
        /violates check constraint/,
        'a role outside our three has to be refused by the database, not only by src/access.ts',
      );
      await assert.rejects(
        () => sql`insert into app_users (email, status) values ('y@example.test', 'pending')`,
        /violates check constraint/,
        'same for a status outside the four',
      );

      // The partial unique index has to allow many NULLs (every accepted member
      // carries one) while keeping a live token pointing at exactly one row.
      await sql`insert into app_users (email) values ('a@example.test'), ('b@example.test')`;
      await sql`update app_users set invite_token_hash = 'hash-1' where email = 'a@example.test'`;
      await assert.rejects(
        () => sql`update app_users set invite_token_hash = 'hash-1' where email = 'b@example.test'`,
        /duplicate key value/,
        'one token must not resolve to two people',
      );
    } finally {
      await sql.end();
    }
  });
});

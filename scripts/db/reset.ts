// Drop the schema so the next `db:migrate` runs against an empty database.
//
// This is the destructive half of `npm run db:reset`, which chains
// reset → migrate → import (the seed). Kept as its own script precisely because it
// is the dangerous step: the chaining is visible in package.json instead of hidden
// behind one more flag here.
//
// **It refuses anything that is not a local database, with no override.** The whole
// point is a throwaway target you can rebuild in seconds; a flag that unlocks
// dropping a remote schema is a flag someone eventually passes by muscle memory
// against production. An operator who deliberately wants to wipe a hosted database
// has their provider's tooling for it, where the blast radius is stated on screen.

import postgres from 'postgres';
import { envValue } from './env.ts';
import { MIGRATE_URL_VAR } from './sql.ts';
import { isLocalUrl, urlHost } from './local-url.ts';

// The host rule lives in ./local-url.ts: this file runs on import (it is a
// script), so anything else needing the same answer cannot reach it here.
// Re-exported so existing importers of this module keep resolving them.
export { isLocalUrl, urlHost };

async function main() {
  const url = envValue(MIGRATE_URL_VAR) || envValue('TIMELINES_DATABASE_URL');
  if (!url) {
    console.error(
      `FAIL: no connection string. Set ${MIGRATE_URL_VAR} (or TIMELINES_DATABASE_URL) to a\n` +
        `      local Postgres. Start one with: npm run db:local:up`,
    );
    process.exit(2);
  }

  const host = urlHost(url);
  if (!isLocalUrl(url)) {
    console.error(
      `FAIL: refusing to drop the schema of a non-local database (host: ${host ?? 'unparseable'}).\n` +
        `      db:reset exists for a throwaway local database and has no override.\n` +
        `      Point ${MIGRATE_URL_VAR} at localhost, or use your provider's tooling.`,
    );
    process.exit(2);
  }

  const sql = postgres(url, { prepare: false });
  try {
    // `cascade` takes the tables, the triggers and the tracking table with it, so
    // the following db:migrate starts from nothing rather than from a half-state.
    await sql.unsafe(`
      drop schema if exists public cascade;
      create schema public;
      grant usage on schema public to public;
    `);
    console.log(`schema dropped and recreated on ${host}. Next: db:migrate, then the seed.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});

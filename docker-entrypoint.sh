#!/bin/sh
# Migrate, then serve.
#
# The migration runs here rather than being left to the operator because the
# guard that used to catch a forgotten one belongs to the dev server: `npm run
# dev` refuses to start with migrations pending, and `npm start` has no such
# check — it is a server, not a workflow. Running them on start makes the step
# unskippable, which is the whole point of the image.
#
# Fails loudly and stops: a container that serves against a schema older than
# the code is the failure this is meant to prevent, so there is no "continue
# anyway" path (see „Principle: no emergency or fallback data").
set -e

if [ -n "$TIMELINES_SKIP_MIGRATE" ]; then
  echo "[entrypoint] TIMELINES_SKIP_MIGRATE set — not touching the schema"
elif [ -n "$TIMELINES_DATABASE_URL" ] || [ -n "$TIMELINES_MIGRATE_DATABASE_URL" ]; then
  echo "[entrypoint] applying migrations"
  # The installed tsx, not `npx tsx`: npx would fetch a copy at container start,
  # which needs a registry the deployment may not reach and pins no version.
  ./node_modules/.bin/tsx scripts/db/migrate.ts
else
  # No database configured is a legitimate deployment: local sources only, served
  # read-only. Say so rather than failing on a migration that has no target.
  echo "[entrypoint] no database configured — serving local sources only"
fi

exec npm start

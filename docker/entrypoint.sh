#!/bin/sh
set -eu

# ---------------------------------------------------------------------------
# Makes `docker compose up` a single command, as the brief requires.
#
# Migrations and the seed run here rather than being a documented extra step,
# because a reviewer should get a working API from one command. Both are
# idempotent: `migrate deploy` applies only what is pending, and the seed upserts
# without ever rewriting a currency's precision -- so a restart is safe.
#
# Readiness is handled by retrying `migrate deploy` rather than by probing with
# pg_isready. Compose already gates this container on the database's health
# check, so the retry only covers the gap between "accepting connections" and
# "ready for our first statement" -- and it avoids installing a postgres client
# just to parse a URL that carries Prisma's own ?schema= parameter, which libpq
# rejects.
#
# Prisma is invoked directly rather than through `yarn prisma`. The container
# runs as an unprivileged user against a root-owned /app, and Yarn wants to write
# an install-state file on every invocation; calling the CLI's entry point skips
# the package manager entirely at runtime.
# ---------------------------------------------------------------------------

ATTEMPTS=${MIGRATE_ATTEMPTS:-30}

echo "entrypoint: applying migrations"
n=1
until node node_modules/prisma/build/index.js migrate deploy; do
  if [ "$n" -ge "$ATTEMPTS" ]; then
    echo "entrypoint: migrations failed after ${ATTEMPTS} attempts" >&2
    exit 1
  fi
  echo "entrypoint: database not ready yet (attempt ${n}/${ATTEMPTS}); retrying in 2s"
  n=$((n + 1))
  sleep 2
done

echo "entrypoint: seeding currencies and clearing accounts"
node dist/seed.js

echo "entrypoint: starting API"
exec "$@"

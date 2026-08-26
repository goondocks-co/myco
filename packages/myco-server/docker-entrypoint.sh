#!/bin/sh
# Migrate, then hand PID 1 to the server.
#
# The server refuses a volume whose schema is not current rather than migrating
# on the first request, so the volume is brought current here, before anything
# listens. `exec` replaces this shell so SIGTERM reaches the server directly and
# the drain the orchestrator asked for actually happens.
set -eu

if [ "${MYCO_SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "myco-server: MYCO_SKIP_MIGRATIONS=1, serving the volume as it stands" >&2
else
  echo "myco-server: applying migrations to ${MYCO_DATABASE}" >&2
  bun run /app/server.js --migrate-only
fi

exec "$@"

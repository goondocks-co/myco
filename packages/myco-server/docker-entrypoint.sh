#!/bin/sh
# Take the secrets as root, drop to the runtime user, migrate, then hand PID 1
# to the server.
#
# A Compose secret outside swarm is a bind mount of the operator's own file, so
# on a native daemon it arrives carrying that file's uid and 0600 — which the
# runtime user cannot read. The container therefore starts as root, copies each
# mounted secret into a directory of its own owned by the runtime user, points
# every `*_FILE` variable at the copy, and drops. Nothing after the drop runs
# privileged: the migration and the server both run as the runtime user, and the
# volume is that user's.
#
# The server refuses a volume whose schema is not current rather than migrating
# on the first request, so the volume is brought current here, before anything
# listens. `exec` replaces this shell so SIGTERM reaches the server directly and
# the drain the orchestrator asked for actually happens.
set -eu

RUNTIME_USER=myco
MOUNTED_SECRETS=/run/secrets
OWNED_SECRETS=/run/myco/secrets

# Copy every mounted secret to one the runtime user can read. A deployment that
# mounts none is served with none, and a `*_FILE` variable naming a file that is
# not there keeps the path it was given, so the server refuses it by name.
adopt_secrets() {
  [ -d "$MOUNTED_SECRETS" ] || return 0
  mkdir -p "$OWNED_SECRETS"
  chown "$RUNTIME_USER:$RUNTIME_USER" "$OWNED_SECRETS"
  chmod 0700 "$OWNED_SECRETS"

  for mounted in "$MOUNTED_SECRETS"/*; do
    [ -f "$mounted" ] || continue
    owned="$OWNED_SECRETS/$(basename "$mounted")"
    cat "$mounted" > "$owned"
    chown "$RUNTIME_USER:$RUNTIME_USER" "$owned"
    chmod 0400 "$owned"
  done

  for name in $(env | sed -n 's/^\([A-Za-z0-9_]*_FILE\)=.*/\1/p'); do
    eval "named=\${$name}"
    case "$named" in
      "$MOUNTED_SECRETS"/*)
        owned="$OWNED_SECRETS/$(basename "$named")"
        if [ -f "$owned" ]; then export "$name=$owned"; fi
        ;;
    esac
  done
}

# Everything below this line runs as the runtime user: this re-runs the script
# under it, and the second pass takes the branch nothing else does.
if [ "$(id -u)" = "0" ]; then
  if [ "${MYCO_ENTRYPOINT_DROPPED:-}" = "1" ]; then
    echo "myco-server: still root after dropping privileges; refusing to serve" >&2
    exit 1
  fi
  command -v setpriv >/dev/null 2>&1 || {
    echo "myco-server: setpriv is not in this image, and the container cannot drop privileges" >&2
    exit 1
  }
  adopt_secrets
  export MYCO_ENTRYPOINT_DROPPED=1
  exec setpriv --reuid="$RUNTIME_USER" --regid="$RUNTIME_USER" --init-groups "$0" "$@"
fi

if [ "${MYCO_SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "myco-server: MYCO_SKIP_MIGRATIONS=1, serving the volume as it stands" >&2
else
  echo "myco-server: applying migrations to ${MYCO_DATABASE}" >&2
  bun run /app/server.js --migrate-only
fi

exec "$@"

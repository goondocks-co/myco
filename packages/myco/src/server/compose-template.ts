/**
 * The Compose bundle `myco server create` materializes.
 *
 * A copy, not a read: the CLI compiles to a single binary with no package tree
 * beside it at runtime, so the file under `packages/myco-server/` cannot be
 * opened from a deployed install. `tests/server/compose-template-drift.test.ts`
 * holds the two byte-identical, and the condition-4 gate reads the file — so a
 * publish spec that loses its loopback qualifier fails there, and a template
 * that drifts from the file fails here.
 */

/**
 * How long the harness is given to finish the runs it holds when the stack
 * stops.
 *
 * Mirrors `ROLLOUT_WATCH_TIMEOUT_SECONDS` in `cloudflare-lifecycle.ts`, the
 * `rollout_active_grace_period` the Worker's container table carries, and the
 * largest budget in `TASK_RUN_TIMEOUT_SECONDS`
 * (`packages/myco-server/src/core/task-catalogue.ts`). This package ships to
 * operator machines and imports nothing from the server, so the number is
 * copied and held equal by `tests/server/cloudflare-lifecycle.test.ts`.
 *
 * On this target the grace is what spares a run inside its own budget: a verb
 * that takes the server down stops the harness on its own first, and every
 * runtime it holds finishes in this window with the server still serving.
 */
export const HARNESS_STOP_GRACE_SECONDS = 1800;

export const COMPOSE_TEMPLATE = `# Self-hosted Myco Deployment.
#
# Two services on one network namespace. Embedded SQLite on the mounted volume,
# and no separate database service.
#
# Every published port is loopback-qualified. \`\${MYCO_PORT}:\${MYCO_PORT}\` binds
# every interface on the host and the container receives no signal that it
# happened, so no runtime check inside it can tell the difference: this file is
# what decides it, and \`tests/myco-server/contract/compose-publish.test.ts\`
# fails when a published port loses its \`127.0.0.1:\` prefix.
#
# Remote access is an operator-run reverse proxy in front of this: HTTPS
# terminated there, MYCO_TRANSPORT=proxy, and the trusted hop count declared.
# The published port stays loopback either way, keeping the proxy-to-backend leg
# off the network.
#
# The harness holds the runtimes and shares the SERVER's network namespace, so
# the two reach each other over the loopback and neither publishes a port for
# it. Operate this stack through \`myco server\`, never one service on its own.
# Compose brings the namespace owner down FIRST, so a plain \`up\` or \`stop\` of
# the whole stack kills the server while the harness is still holding runs: the
# verbs stop the harness on its own first, which spends its grace with the
# server still serving. An out-of-band restart of the server container leaves
# the harness attached to a namespace that is gone, and it stays that way until
# the whole stack is restarted; the harness healthcheck reaches neither its own
# supervisor's namespace-mate nor the server then, and reports unhealthy.

services:
  server:
    image: ghcr.io/goondocks-co/myco-server:\${MYCO_VERSION:-latest}
    restart: unless-stopped

    ports:
      - "127.0.0.1:\${MYCO_PORT:-8787}:\${MYCO_PORT:-8787}"

    environment:
      MYCO_DATABASE: /data/myco.sqlite
      MYCO_BLOB_DIR: /data/blobs
      MYCO_PORT: \${MYCO_PORT:-8787}
      MYCO_TRANSPORT: \${MYCO_TRANSPORT:-loopback}
      # Published ports reach this namespace's eth0, never its loopback, so a
      # container binding the loopback literals answers nothing from the host.
      # The namespace plus the loopback-qualified \`ports:\` entry above supply
      # the restriction that a host process gets from binding loopback itself.
      # \`compose-publish.test.ts\` gates that pairing.
      MYCO_BIND: all
      # The address this Deployment is reached at, which the clock hands to the
      # work it schedules. Behind a reverse proxy it is the public address.
      MYCO_ORIGIN: \${MYCO_ORIGIN:-http://127.0.0.1:\${MYCO_PORT:-8787}}
      # How many runtimes may run at once. The dispatcher queues past it; the
      # harness enforces no second count.
      MYCO_FLEET: \${MYCO_FLEET:-4}
      # The harness, on the shared loopback. The launch endpoint spawns
      # processes with a caller-chosen environment, so it is authenticated with
      # the token file both services mount.
      MYCO_HARNESS: http://127.0.0.1:8080
      MYCO_HARNESS_TOKEN_FILE: /run/secrets/myco_harness_token
      # Source identity. \`socket\` for a deployment reached directly; \`proxy\`
      # additionally requires MYCO_TRUSTED_HEADER and MYCO_TRUSTED_HOPS. A
      # deployment declaring neither establishes no identity and serves only
      # health.
      MYCO_SOURCE_FROM: \${MYCO_SOURCE_FROM:-socket}
      MYCO_TRUSTED_HEADER: \${MYCO_TRUSTED_HEADER:-}
      MYCO_TRUSTED_HOPS: \${MYCO_TRUSTED_HOPS:-}
      # Sign-in: the client id is a value; every secret is read from the file
      # its \`*_FILE\` variable names, mounted under /run/secrets below.
      GITHUB_CLIENT_ID: \${GITHUB_CLIENT_ID:-}
      SECRET_WRAP_KEY_FILE: /run/secrets/myco_secret_wrap_key
      SESSION_SECRET_FILE: /run/secrets/myco_session_secret
      GITHUB_CLIENT_SECRET_FILE: /run/secrets/myco_github_client_secret

    # Compose secrets arrive as files under /run/secrets; the process reads each
    # from the path its \`*_FILE\` variable names, keeping the values out of
    # \`docker inspect\` and the shell history that \`environment:\` exposes.
    secrets:
      - myco_secret_wrap_key
      - myco_session_secret
      - myco_github_client_secret
      - myco_harness_token

    volumes:
      - myco-data:/data

    healthcheck:
      # Loopback literal, never the name: the Host allowlist refuses \`localhost\`
      # and a healthcheck using it would report a healthy container unhealthy.
      test: ["CMD", "curl", "-fsS", "-H", "Host: 127.0.0.1:\${MYCO_PORT:-8787}",
             "http://127.0.0.1:\${MYCO_PORT:-8787}/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

    # SIGTERM drains in-flight requests; the container is killed after this.
    stop_grace_period: 30s

    deploy:
      resources:
        limits:
          memory: \${MYCO_MEMORY_LIMIT:-2g}
        reservations:
          memory: 256m

    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  harness:
    image: ghcr.io/goondocks-co/myco-harness:\${MYCO_VERSION:-latest}
    # One long-lived supervisor that starts one runtime per run. The image's own
    # command runs a single runtime, which is what the hosted target starts one
    # container of per run.
    command: ["bun", "run", "supervisor.js"]
    restart: unless-stopped
    depends_on:
      - server

    # The server's namespace, not one of its own: the server reaches the
    # supervisor at 127.0.0.1:8080 and a runtime reaches the server at
    # 127.0.0.1:\${MYCO_PORT}, which the Host allowlist admits. Compose refuses
    # \`ports:\` and \`networks:\` on a service sharing another's namespace, and
    # this service declares neither. Compose also takes the namespace owner down
    # first, which is why the verbs stop this service on its own before they
    # touch the server.
    network_mode: "service:server"

    environment:
      MYCO_SUPERVISOR_PORT: 8080
      MYCO_HARNESS_TOKEN_FILE: /run/secrets/myco_harness_token
      MYCO_WORK_DIR: /work

    secrets:
      - myco_harness_token

    # A runtime gets its own directory under this one. On tmpfs: what a run
    # writes lives as long as the run and never reaches the volume. The mode is
    # world-writable with the sticky bit, which is what lets the image's
    # unprivileged user create its per-run directories.
    tmpfs: ["/work:mode=1777"]

    healthcheck:
      # Both halves of what makes this service useful: the supervisor answering
      # its own probe, and the SERVER answering over the shared loopback. A
      # wedged supervisor answers the second alone; a harness whose namespace
      # went away with an out-of-band restart of the server container answers
      # neither. \`/probe\` carries no token and discloses run ids alone.
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/probe && curl -fsS -H 'Host: 127.0.0.1:\${MYCO_PORT:-8787}' http://127.0.0.1:\${MYCO_PORT:-8787}/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

    # SIGTERM makes the supervisor refuse new launches and wait for the runtimes
    # it holds. The window covers the longest task budget, and the verbs spend
    # it while the server is still serving, so a run in flight when the stack is
    # updated finishes and posts its own ending.
    stop_grace_period: ${HARNESS_STOP_GRACE_SECONDS}s

    deploy:
      resources:
        limits:
          memory: \${MYCO_HARNESS_MEMORY_LIMIT:-4g}

    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  myco-data:

secrets:
  myco_secret_wrap_key:
    file: ./secrets/secret_wrap_key
  myco_session_secret:
    file: ./secrets/session_secret
  myco_github_client_secret:
    file: ./secrets/github_client_secret
  myco_harness_token:
    file: ./secrets/harness_token
`;

# Self-hosted Myco Deployment.
#
# Pinned to the same Bun the repository pins in `.bun-version`. The suite has
# already been bitten by engine divergence (JSC accepts a spread the V8 build
# throws on), so the container runs the engine CI ran.
#
# Built for linux/amd64 and linux/arm64. `npm run image:build` produces both;
# CI holds the manifest to exactly those two, since a Dockerfile that quietly
# stops building for one would pass every other job.

ARG BUN_VERSION=1.3.13

# --- build -----------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /build

# No install step: every import in packages/myco-server/src resolves to a
# builtin or a relative file, so the package has no npm dependency to fetch.
# `tests/myco-server/gates.test.ts` holds that property — shared source may not
# name a bare specifier — and this stage is what it buys.
COPY packages/myco-server/src ./src

RUN bun build src/platform/bun/server-main.ts \
      --target=bun \
      --outfile=/build/server.js

# --- dashboard -------------------------------------------------------------
# Built once, on the build host's own architecture: the output is static files
# and is identical for every target platform.
FROM --platform=$BUILDPLATFORM node:22-slim AS ui
WORKDIR /build/ui
COPY packages/myco-server/ui/package.json packages/myco-server/ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/myco-server/ui ./
RUN npx vite build

# --- runtime ---------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime

# curl backs the Compose healthcheck. Nothing else is added.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged. A container that never needs to write outside /data has no
# reason to run able to.
RUN groupadd --system --gid 10001 myco \
 && useradd --system --uid 10001 --gid myco --home /app --shell /usr/sbin/nologin myco

WORKDIR /app
COPY --from=build /build/server.js ./server.js
COPY --from=ui /build/ui/dist ./ui
COPY packages/myco-server/migrations ./migrations
COPY packages/myco-server/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# The volume the operator mounts. Owned by the runtime user so a first start on
# a fresh volume can create the database rather than failing on permissions.
RUN mkdir -p /data/blobs && chown -R myco:myco /data
VOLUME ["/data"]

USER myco

ENV MYCO_DATABASE=/data/myco.sqlite \
    MYCO_BLOB_DIR=/data/blobs \
    MYCO_UI_DIR=/app/ui \
    MYCO_PORT=8787 \
    MYCO_TRANSPORT=loopback

EXPOSE 8787

# The entrypoint migrates and then execs the server, so PID 1 is the server and
# SIGTERM reaches it directly rather than being absorbed by a shell.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "run", "/app/server.js"]

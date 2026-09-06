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

# --- dependencies ----------------------------------------------------------
# The server's runtime dependencies, resolved from the root lockfile so the
# image carries exactly what CI installs. Native vector dependencies are
# resolved on the target platform.
# `tests/myco-server/gates.test.ts` pins the declared set to what `src` imports;
# a second dependency is a decision there before it is one here.
FROM node:22-slim AS deps
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/myco/package.json packages/myco/
COPY packages/myco-darwin-arm64/package.json packages/myco-darwin-arm64/
COPY packages/myco-darwin-x64/package.json packages/myco-darwin-x64/
COPY packages/myco-deploy/package.json packages/myco-deploy/
COPY packages/myco-linux-arm64/package.json packages/myco-linux-arm64/
COPY packages/myco-linux-x64/package.json packages/myco-linux-x64/
COPY packages/myco-member/package.json packages/myco-member/
COPY packages/myco-server/package.json packages/myco-server/
COPY packages/myco-shared/package.json packages/myco-shared/
COPY packages/myco-team/package.json packages/myco-team/
COPY packages/myco-windows-x64/package.json packages/myco-windows-x64/
RUN npm ci --workspace=@goondocks/myco-server --omit=dev --ignore-scripts --no-audit --no-fund
RUN mkdir /runtime-modules && cp -R node_modules/sqlite-vec* /runtime-modules/

# --- build -----------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
COPY packages/myco-shared/package.json ./packages/myco-shared/package.json
COPY packages/myco-shared/src ./packages/myco-shared/src
COPY packages/myco-shared/scripts/build.mjs ./packages/myco-shared/scripts/build.mjs
COPY packages/myco-server/src ./src

RUN bun packages/myco-shared/scripts/build.mjs

RUN bun build src/platform/bun/server-main.ts \
      --target=bun \
      --external=sqlite-vec \
      --outfile=/build/server.js

# --- dashboard -------------------------------------------------------------
# Built once, on the build host's own architecture: the output is static files
# and is identical for every target platform.
FROM --platform=$BUILDPLATFORM node:22-slim AS ui
WORKDIR /build/ui
COPY packages/myco-server/ui/package.json packages/myco-server/ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/myco-server/ui ./
COPY packages/myco-server/src/read/search-types.ts /build/src/read/search-types.ts
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
COPY --from=deps /runtime-modules ./node_modules
COPY --from=ui /build/ui/dist ./ui
COPY packages/myco-server/migrations ./migrations
COPY packages/myco-server/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# The volume the operator mounts. Owned by the runtime user so a first start on
# a fresh volume can create the database rather than failing on permissions.
RUN mkdir -p /data/blobs && chown -R myco:myco /data
VOLUME ["/data"]

# No `USER` here, deliberately. A Compose secret outside swarm is a bind mount
# of the operator's own file and arrives owned by that file's uid at 0600, which
# uid 10001 cannot read on a native daemon. The entrypoint starts as root only
# to copy those secrets into a directory the runtime user owns, then drops with
# setpriv before it migrates or serves — so nothing that touches the volume, the
# network, or the secrets runs privileged. A `USER myco` added above the
# ENTRYPOINT would take the copy away and is refused by
# `tests/myco-server/contract/container-privileges.test.ts`.

ENV MYCO_DATABASE=/data/myco.sqlite \
    MYCO_BLOB_DIR=/data/blobs \
    MYCO_UI_DIR=/app/ui \
    MYCO_PORT=8787 \
    MYCO_TRANSPORT=loopback

EXPOSE 8787

# The entrypoint takes the secrets, drops to the runtime user, migrates, and
# then execs the server, so PID 1 is the server running unprivileged and SIGTERM
# reaches it directly rather than being absorbed by a shell.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "run", "/app/server.js"]

# The harness image: the lean runner entry and the supervisor that starts one
# runtime per run, each bundled to one file, plus the Claude Code CLI the
# harness adapter spawns. The Cloudflare container runs the entry directly, one
# container per run; the self-hosted stack overrides the command to run the
# supervisor, which spawns the entry beside it.
#
# Two accounts, and the difference is load-bearing. `bun` (uid 1000) owns the
# image and is what the Cloudflare container runs as. `runtime` (uid 10002)
# owns nothing and is what the supervisor drops each run's child to: the launch
# token is mounted in this filesystem, and a uid the host is unlikely to share
# is what keeps a mounted secret out of a run's reach. The CLI therefore lives
# outside either home, root-owned and readable by both.
#
# Cloudflare Containers run amd64; the platform builds/pulls accordingly.
# Build first:
#   npm run harness:bundle   (in packages/myco-server)
FROM oven/bun:1.3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/*
ENV HOME=/home/bun
# The installer writes a versioned executable under the installing user's home
# and links to it. Installing and moving it in ONE layer is what keeps one copy
# of it in the image: a move in a later layer leaves the original in the one
# below, and the executable is 215 MB.
RUN set -eu; \
  su bun -s /bin/sh -c 'curl -fsSL https://claude.ai/install.sh | bash'; \
  target="$(readlink -f /home/bun/.local/bin/claude)"; \
  install -d -m 0755 /opt/claude/bin; \
  mv "$target" /opt/claude/bin/claude; \
  chown root:root /opt/claude/bin/claude; \
  chmod 0755 /opt/claude/bin/claude; \
  ln -sfn /opt/claude/bin/claude /home/bun/.local/bin/claude; \
  groupadd --system --gid 10002 runtime; \
  useradd --system --uid 10002 --gid runtime --home /home/runtime --shell /usr/sbin/nologin runtime; \
  install -d -m 0755 -o runtime -g runtime /home/runtime
ENV PATH="/opt/claude/bin:/home/bun/.local/bin:${PATH}"
WORKDIR /app
COPY --chown=bun:bun entry.js .
COPY --chown=bun:bun supervisor.js .
COPY --chown=bun:bun definitions ./definitions
COPY --chown=bun:bun prompts ./prompts
EXPOSE 8080
USER bun
CMD ["bun", "run", "entry.js"]

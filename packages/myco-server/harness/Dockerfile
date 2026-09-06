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
# The runtime this image runs is the one the repository pins (`.bun-version`),
# which a gate holds; the server image takes its own from the same pin.
#
# Cloudflare Containers run amd64; the platform builds/pulls accordingly.
# Build first:
#   npm run harness:bundle   (in packages/myco-server)
ARG BUN_VERSION=1.3.13
FROM oven/bun:${BUN_VERSION}-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates util-linux git ripgrep \
  && rm -rf /var/lib/apt/lists/*
ENV HOME=/home/bun
# The installer writes a versioned executable under the installing user's home
# and links to it. It runs here as root into a scratch home, and the executable
# is moved out in the SAME layer: a move in a later layer leaves the original in
# the one below, and the executable is 215 MB. No account switch is involved,
# so the step does not depend on the base image's home ownership, which differs
# by architecture.
RUN set -eu; \
  HOME=/tmp/claude-install sh -c 'curl -fsSL https://claude.ai/install.sh | bash'; \
  target="$(readlink -f /tmp/claude-install/.local/bin/claude)"; \
  install -d -m 0755 /opt/claude/bin; \
  mv "$target" /opt/claude/bin/claude; \
  chown root:root /opt/claude/bin/claude; \
  chmod 0755 /opt/claude/bin/claude; \
  rm -rf /tmp/claude-install; \
  install -d -m 0755 -o bun -g bun /home/bun/.local/bin; \
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

# The harness image: the lean runner entry and the supervisor that starts one
# runtime per run, each bundled to one file, plus the Claude Code CLI the
# harness adapter spawns. The Cloudflare container runs the entry directly, one
# container per run; the self-hosted stack overrides the command to run the
# supervisor, which spawns the entry beside it. Runs as the image's
# non-root user — the CLI refuses permission-bypass under root. Cloudflare
# Containers run amd64; the platform builds/pulls accordingly. Build first:
#   npm run harness:bundle   (in packages/myco-server)
FROM oven/bun:1.3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
USER bun
ENV HOME=/home/bun
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/bun/.local/bin:${PATH}"
WORKDIR /app
COPY --chown=bun:bun entry.js .
COPY --chown=bun:bun supervisor.js .
COPY --chown=bun:bun definitions ./definitions
COPY --chown=bun:bun prompts ./prompts
EXPOSE 8080
CMD ["bun", "run", "entry.js"]

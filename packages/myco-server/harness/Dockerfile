# The harness container image: the lean runner entry bundled to one file,
# plus the Claude Code CLI the harness adapter spawns. Runs as the image's
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
COPY --chown=bun:bun definitions ./definitions
COPY --chown=bun:bun prompts ./prompts
EXPOSE 8080
CMD ["bun", "run", "entry.js"]

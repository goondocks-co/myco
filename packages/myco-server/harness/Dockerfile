# The harness container image: the lean runner entry bundled to one file,
# plus the Claude Code CLI the harness adapter spawns. Cloudflare Containers
# run amd64; the platform builds/pulls accordingly. Build `entry.js` first:
#   npm run harness:bundle   (in packages/myco-server)
FROM oven/bun:1.3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app
COPY entry.js .
COPY definitions ./definitions
EXPOSE 8080
CMD ["bun", "run", "entry.js"]

# The harness container image. This slice ships the probe application; the
# real harness entry replaces CMD in a later slice of #914. Cloudflare
# Containers run amd64; the platform builds/pulls accordingly.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY probe.ts .
EXPOSE 8080
CMD ["bun", "run", "probe.ts"]

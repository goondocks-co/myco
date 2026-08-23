---
name: myco:cloudflare-worker-infrastructure-lifecycle
description: >-
  Operate Myco's Cloudflare Workers: wrangler upgrade hardening, D1 export and
  inspection when a toolchain upgrade breaks it, and the cross-cutting gotchas
  that bite when deploying a Worker from this monorepo. Use when touching
  packages/myco-team/worker or packages/myco-server/worker, or running wrangler
  against either.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Cloudflare Worker Infrastructure Lifecycle

> **Scope note:** The legacy Cloudflare team-sync stack (D1/Vectorize deployment, the cloud
> MCP server that ran alongside it) is retired. Team functionality now lives in Team Host,
> built into the main `myco` binary — see `docs/team-host.md`. The old worker/CLI
> (`packages/myco-team`) is preserved in-repo, dormant, typecheck-only, and no longer
> published; do not deploy it or extend it for new work. This skill instead covers the one
> Cloudflare Worker packages in this monorepo: the team-sync worker
> (`packages/myco-team/worker`) and the 2.0 server (`packages/myco-server/worker`).

## Prerequisites

- Cloudflare account with Workers (D1 + KV bindings)
- Wrangler CLI installed and authenticated (`wrangler auth login`)
- `packages/myco-server/worker/wrangler.toml` and `packages/myco-team/worker/wrangler.toml`
  for the worker configs

## Procedure A: Wrangler Upgrade Hardening

These failure modes apply to any Cloudflare Worker package in this repo. None of it is
worker-specific; it's
general Wrangler/D1 operational knowledge worth keeping alongside the one worker still in
active (if dormant) maintenance.

### Failure Mode 1: D1 Export Hangs on Vector/Large Schemas

**Symptom**: `npx wrangler d1 export` hangs or times out on a D1 database with a large or
vector-adjacent schema.

**Recovery**:
```bash
# Export schema only, without data, to unblock inspection
npx wrangler d1 execute <db-name> --command=".schema" > schema-only.sql

# Or pin to a known-good Wrangler version temporarily
npm install wrangler@<last-known-good>
```

### Failure Mode 2: Cross-Target Install Requiring --force

**Symptom**: `npm ci` fails with a target architecture mismatch (common after a Node or
platform upgrade).

**Recovery**:
```bash
npm cache clean --force
rm -rf node_modules package-lock.json
npm install --force
```

### Failure Mode 3: Worker npm ci Timeout

**Symptom**: Worker builds time out during dependency installation in CI.

**Recovery**:
```bash
npm ci --timeout=300000 --frozen-lockfile
```

### Failure Mode 4: Release Artifact / Node Version Mismatch

**Symptom**: Wrangler rejects build artifacts produced with a different Node version than
the one it expects.

**Recovery**:
```bash
nvm use $(cat .nvmrc)
npm run build
npx wrangler deploy
```

### Failure Mode 5: Publish-from-Artifact Discipline

**Always publish from CI-built artifacts**, never from an uncommitted local build:

```bash
# WRONG
npm run build
npx wrangler deploy

# RIGHT
gh run download $RUN_ID --name worker-dist
npx wrangler deploy --assets ./dist
```

## Cross-Cutting Gotchas

**Wrangler version sensitivity.** Different Wrangler versions handle D1 exports, bindings,
and timeouts differently. Pin the version in the worker's `package.json`.

**D1 transaction limits.** D1 has a per-batch statement limit. Batch large operations:

```typescript
const chunks = batchOf1000(statements);
for (const chunk of chunks) {
  await db.batch(chunk.map((stmt) => db.prepare(stmt.sql).bind(...stmt.params)));
}
```

**Environment variables vs secrets.** Workers read plain vars from `wrangler.toml` `[vars]`,
but anything sensitive (tokens, keys) must go through `npx wrangler secret put` — never
inline a secret value in `wrangler.toml`.


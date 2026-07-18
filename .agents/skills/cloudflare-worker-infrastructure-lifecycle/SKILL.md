---
name: myco:cloudflare-worker-infrastructure-lifecycle
description: |
  Deploy, maintain, and operate Myco's Collective worker (packages/myco-collective) — the
  cross-project admin layer built on Cloudflare Workers, D1, and KV. Covers the worker's
  package structure, the `myco-collective` operator CLI (install/upgrade/status/add-project/
  rotate-tokens/destroy), D1/KV bindings, and the general Wrangler-upgrade failure modes
  that apply to any Cloudflare Worker package in this repo.
  Use this when touching packages/myco-collective/worker, running wrangler against it, or
  debugging its deploy/D1/KV behavior.
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
> Cloudflare Worker package that is still a real, maintained artifact: **Collective**
> (`packages/myco-collective`). Collective is itself dormant — not wired into the daemon,
> pending redesign against the Team Host architecture — but it still builds and still
> receives routine dependency updates, so its deploy/operate mechanics stay relevant to
> whoever maintains it.

## Prerequisites

- Cloudflare account with Workers (D1 + KV bindings)
- Wrangler CLI installed and authenticated (`wrangler auth login`)
- `packages/myco-collective/worker/wrangler.toml` for the worker config;
  `packages/myco-collective/src/cli.ts` for the operator CLI (`myco-collective`)

## Procedure A: Collective Worker Structure and Deployment

The Collective worker is a standalone package with three parts:

```
packages/myco-collective/
├── src/cli.ts         # myco-collective operator CLI (install/upgrade/status/add-project/rotate-tokens/destroy)
├── worker/
│   ├── src/           # Worker source: auth.ts, fanout.ts, index.ts, schema.ts, settings.ts, tools.ts
│   └── wrangler.toml  # D1 + KV bindings
└── ui/                 # Admin UI served as Worker assets
```

`wrangler.toml` bindings:
- `MYCO_COLLECTIVE_DB` (D1) — `projects`, `settings_overrides`, `collective_meta` tables
  (`worker/src/schema.ts`, applied via `initD1Schema`)
- `MYCO_SECRETS` (KV) — admin/MCP/worker bearer tokens (`worker/src/auth.ts`:
  `ADMIN_TOKEN_KEY`, `MCP_TOKEN_KEY`, `WORKER_TOKEN_KEY`)

Deploy and administer through the operator CLI, not raw `wrangler deploy` — it stages the
worker directory, substitutes the D1/KV resource IDs into a local copy of `wrangler.toml`,
and tracks local config under `~/.myco-collective/<name>/`:

```bash
myco-collective install [name]
myco-collective upgrade [name]
myco-collective status [name]
myco-collective add-project <name> <worker_url> <api_key> [collective_name]
myco-collective rotate-tokens [admin|mcp|all] [name]
myco-collective destroy [name]
```

**Status:** the package's own README says it plainly — dormant, no longer integrated with
the daemon, no new releases. Treat any Collective worker change as maintenance of existing
dormant infrastructure, not new feature development, unless a redesign has been explicitly
scoped and agreed.

## Procedure B: Wrangler Upgrade Hardening

These failure modes apply to any Cloudflare Worker package in this repo — Collective today;
historically also the retired team-sync worker. None of this is Collective-specific; it's
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

**Local build vs the published `myco-collective` binary.** `make dev-link` does not link the
operator CLIs — there is no `myco-collective-dev`. For local development and manual
operator-flow testing, build the package and invoke the dist entry directly from the repo
root:

```bash
npm run build -w @goondocks/myco-collective
node packages/myco-collective/dist/main.js status
```

The globally-installed `myco-collective` package binary is the separate (no-longer-updated)
production release path. Using the wrong one against a real deployment risks a silent
version mismatch.

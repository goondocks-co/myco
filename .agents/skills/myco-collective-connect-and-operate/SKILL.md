---
name: myco:myco-collective-connect-and-operate
description: |-
  Use this skill when bootstrapping a Myco Collective instance, connecting an
  existing project to a live Collective, managing admin token lifecycle,
  verifying Collective health and identity, using collective_* MCP tools,
  setting up the local dev proxy (make collective-ui-dev), enforcing design
  system compliance for Collective UI, or running the V1 integration gate
  checklist. Covers: CLI bootstrap, project connection and config scoping
  (home-scoped ~/.myco-collective/<name>/ vs project-scoped .myco/team/),
  admin token rotation across team workers, the deploy → build → upgrade → verify
  cycle, collective_* vs org_* MCP tool distinctions, Vite proxy setup, and
  integration gate. Activate even if the user only asks to "connect to
  Collective" or "check Collective status" without mentioning the full
  workflow.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Collective: Connect, Verify, and Operate

Myco Collective is the org-level intelligence layer: a Cloudflare Worker + D1 + Vectorize + KV deployment that federates knowledge across multiple projects and machines. This skill covers operational procedures after infrastructure is deployed — connecting projects, managing tokens, verifying correctness, using MCP tools, and maintaining the Collective UI design system. For Worker deployment mechanics (Wrangler, KV provisioning, wrangler.toml), see `cloudflare-worker-infrastructure-lifecycle`.

## Procedure 4: Verification Protocol

Run this sequence after every deploy, upgrade, or token change. **CRITICAL:** Run `make build` before any upgrade to ensure the compiled Collective UI bundle and Worker code are fresh.

```bash
# Step 0: Build the UI and Worker (MUST precede upgrade)
make build

# Step 1: CLI health check
myco collective status

# Step 2: HTTP health endpoint
curl https://<worker-url>/health

# Step 3: Identity verification (critical)
curl -H "Authorization: Bearer <token>" \
  https://<worker-url>/api/auth/verify
```

The `/api/auth/verify` response must include a deployment-specific name:

```json
{ "collective_name": "OSS Collective" }
```

If `collective_name` returns the generic `"Myco Collective"`, the Worker is running with default branding. The `COLLECTIVE_NAME` environment variable was not set, or the Worker predates the branding feature and needs an upgrade:

```bash
# Build first to compile fresh UI and Worker
make build

# Upgrade cycle
wrangler deploy
wrangler secret put COLLECTIVE_NAME   # enter "OSS Collective" (or your name)

# Re-verify — must see deployment-specific name
curl -H "Authorization: Bearer <token>" https://<worker-url>/api/auth/verify
```

**Deploy → build → upgrade → verify** is the required cycle. Running verify before the upgrade gives stale results from the cached Worker bundle. Running upgrade without `make build` deploys stale compiled assets.

## Cross-Cutting Gotchas

**`make build` must precede upgrade**: The upgrade deploys both the compiled Collective UI bundle and the Worker code. Running upgrade without `make build` first deploys stale compiled assets from a previous build. Always run `make build` immediately before `wrangler deploy`.

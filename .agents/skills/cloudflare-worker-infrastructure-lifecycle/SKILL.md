---
name: myco:cloudflare-worker-infrastructure-lifecycle
description: |
  Use when deploying, upgrading, or operating any Cloudflare Worker-backed
  service in Myco — the team-sync Worker, Cloud MCP Server, and Collective
  Worker. Covers: initial Worker deployment with KV namespace provisioning
  (idempotency pattern), Wrangler upgrade path engineering (5 documented
  failure modes), MCP auth token lifecycle and rotation via Workers KV,
  Collective Worker deployment with correct config scoping, D1 schema
  synchronization between local vault and Worker deployments, Collective
  operational procedures (verification protocol, identity checking, UI design
  system compliance), and operational safety patterns (cron validation, fanout
  timeouts, build script integrity, UI package distribution). Activate this
  skill even if the user doesn't explicitly mention Cloudflare — any task
  touching wrangler.toml, D1 bindings, Workers KV, or packages/myco-team or
  packages/myco-collective falls in this domain.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Cloudflare Worker Infrastructure Lifecycle

Myco uses three Cloudflare Worker services: the **team-sync Worker** (cross-machine session sync via D1 + Vectorize), the **Cloud MCP Server** (remote tool access for non-local agents), and the **Collective Worker** (org-level knowledge aggregation). All three share the same Wrangler deployment model, Workers KV auth pattern, and D1 migration behavior. Mistakes in these areas are expensive — wrong KV provisioning hard-fails upgrades, wrong config scoping makes tokens invisible to other projects, and silent build failures deploy stale artifacts.

## Prerequisites

- Cloudflare account with Workers, D1, Vectorize, and KV enabled
- `wrangler` CLI authenticated: `wrangler auth login`
- Node.js accessible via absolute path (see Cross-Cutting Gotchas #9 for nvm/volta)
- For Collective: admin token from the Collective operator, or generate one at first bootstrap
- Account ID available in `wrangler.toml` or via `wrangler whoami`

## Procedure A: Initial Worker Deployment and KV Provisioning

### 1. Create or get a KV namespace (idempotency pattern)

`wrangler kv namespace create` is **not idempotent** — a second call throws "already exists" and exits non-zero. Use this pattern wherever KV provisioning can run more than once:

```typescript
async function ensureKvNamespace(title: string): Promise<string> {
  try {
    const result = await runWrangler(['kv', 'namespace', 'create', title]);
    const match = result.stdout.match(/\"id\":\s*\"([^\"]+)\"/);
    if (!match) throw new Error('Could not parse KV namespace ID from create output');
    return match[1];
  } catch (err: any) {
    if (!err.stderr?.includes('already exists')) throw err;
    // Namespace exists — list and match by title
    const listResult = await runWrangler(['kv', 'namespace', 'list', '--json']);
    const namespaces: Array<{ id: string; title: string }> = JSON.parse(listResult.stdout);
    const ns = namespaces.find(n => n.title === title);
    if (!ns) throw new Error(`KV namespace \"${title}\" not found after \"already exists\" error`);
    return ns.id;
  }
}
```

Always capture both `stdout` **and** `stderr` from wrangler subprocesses — Wrangler writes progress and errors to stderr, so discarding it hides critical information.

### 2. Bind KV namespace in wrangler.toml

```toml
[[kv_namespaces]]
binding = "MCP_TOKENS"   # or AUTH_KV, COLLECTIVE_TOKENS, etc.
id = "<namespace-id>"
preview_id = "<preview-id>"  # optional for local dev
```

### 3. Provision D1 database

```bash
wrangler d1 create myco-team-db
```

```toml
[[d1_databases]]
binding = "DB"
database_name = "myco-team-db"
database_id = "<id-from-create-output>"
```

**D1 lazy migrations**: D1 migrations apply on the **first request after deploy**, not at deploy time. Do not assume the schema is ready immediately after `wrangler deploy`. Design for lazy `CREATE TABLE IF NOT EXISTS` or a health-check endpoint that triggers migration.

### 4. Provision Vectorize collection (team-sync only)

```bash
wrangler vectorize create myco-embeddings --dimensions=1536 --metric=cosine
```

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "myco-embeddings"
```

### 5. Deploy

```bash
npm install       # always run before first deploy; also required after dep changes
wrangler deploy
```

Add lifecycle markers to deployment scripts for log scannability:

```
[DEPLOY START] myco-team-sync
...
[DEPLOY COMPLETE] myco-team-sync
```

## Procedure B: Upgrading an Existing Worker

Worker upgrades have five documented failure modes. Address all five before shipping any upgrade path.

### Failure mode 1 — Wrangler stderr swallowed

All subprocess output (stdout AND stderr) must be captured and surfaced. Use this helper:

```typescript
async function runWrangler(
  args: string[],
  opts: { cwd?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('wrangler', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d; process.stdout.write(d); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d; process.stderr.write(d); });
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`wrangler exited ${code}`), { stdout, stderr }));
    });
  });
}
```

Wrap the full upgrade sequence with `[UPGRADE START]` / `[UPGRADE COMPLETE]` / `[UPGRADE FAILED]` markers.

### Failure mode 2 — KV namespace create non-idempotent

Covered in Procedure A. Always use `ensureKvNamespace()` — never bare `wrangler kv namespace create` in upgrade paths.

### Failure mode 3 — wrangler.toml overwrites or missing file handling

Copying fresh worker source over an existing directory with `fs.cpSync` will overwrite `wrangler.toml`, losing `compatibility_flags`, KV bindings, D1 bindings, and any post-deploy edits. Additionally, some worker packages may be missing `wrangler.toml` entirely and need creation.

**For existing wrangler.toml — read → parse → merge → write:**

```typescript
import { parse as parseToml, stringify as stringifyToml } from 'some-toml-library';

function mergeWranglerToml(sourcePath: string, targetPath: string) {
  const source = parseToml(fs.readFileSync(sourcePath, 'utf8')) as any;
  let target: any = {};
  
  // Handle case where target wrangler.toml might not exist
  if (fs.existsSync(targetPath)) {
    target = parseToml(fs.readFileSync(targetPath, 'utf8')) as any;
  }
  
  // Take runtime bindings and flags from target; code-level fields from source
  const merged = {
    ...source,
    ...target,
    kv_namespaces: target.kv_namespaces ?? source.kv_namespaces,
    d1_databases:  target.d1_databases  ?? source.d1_databases,
    vectorize:     target.vectorize     ?? source.vectorize,
    compatibility_flags: target.compatibility_flags ?? source.compatibility_flags,
    compatibility_date:  target.compatibility_date  ?? source.compatibility_date,
  };
  fs.writeFileSync(targetPath, stringifyToml(merged));
}
```

**For missing wrangler.toml — create with basic configuration:**

```typescript
function createWranglerToml(targetPath: string, workerName: string) {
  const basicConfig = {
    name: workerName,
    main: "src/worker.ts",
    compatibility_date: "2024-01-01",
    compatibility_flags: ["nodejs_compat"]
  };
  
  fs.writeFileSync(targetPath, stringifyToml(basicConfig));
}
```

Never use `fs.cpSync` on any directory containing `wrangler.toml`. Copy individual source files or explicitly exclude `wrangler.toml`.

### Failure mode 4 — Token/config values absent post-upgrade

Any value not explicitly threaded to the upgrade template renderer will vanish from the rendered output. Enumerate every value your template uses and verify each is gathered before rendering.

Cloud MCP upgrade checklist:
- `mcpToken` — read from existing KV or generate new
- Worker endpoint URL / `workerId`
- `accountId`
- D1 database ID
- `compatibility_flags`

### Failure mode 5 — Missing `ensureKvNamespace()` + `npm install` steps

Upgrade paths that skip `npm install` will fail silently if worker dependencies changed. Always include both:

```typescript
await runCommand('npm', ['install'], { cwd: workerDir });
const kvId = await ensureKvNamespace('myco-mcp-tokens');
// update wrangler.toml with kvId via mergeWranglerToml
await runWrangler(['deploy'], { cwd: workerDir });
```

## Procedure C: Auth Token Lifecycle and Rotation

### MCP token storage

MCP auth tokens live in a **Workers KV namespace**. Do NOT store them in:

- D1 `team_config` — eviction and migration timing make it unreliable for hot-path auth
- AES-256-GCM encrypted blobs — adds key-management complexity with no security benefit for server-side tokens

Write:
```typescript
await env.MCP_TOKENS.put('mcp-auth-token', token); // no TTL = permanent
```

Auth middleware read:
```typescript
const stored = await env.MCP_TOKENS.get('mcp-auth-token');
if (!stored || stored !== bearerToken) {
  return new Response('Unauthorized', { status: 401 });
}
```

### Token rotation

Rotation happens via the `/connect` endpoint (POST with new token). The endpoint:
1. Validates the caller's current token
2. Writes the new token to KV
3. Returns the new token to the caller
4. Propagates the new token to connected team workers

After rotation, update `.myco/team/config.json` with the new token so the local daemon reconnects.

### Collective admin token

Generated once at `myco collective create`, stored in `~/.myco-collective/<name>/config.json`. If missing or rotated, connected team workers will fail to authenticate against the Collective. Rotate with:

```bash
myco collective create --regenerate-token
```

This re-writes the home-scoped config and propagates the new token to connected workers.

## Procedure D: Collective Worker Deployment and Config Scoping

### Monorepo structure

```
packages/
  myco/               # core daemon + CLI
  myco-team/          # team-sync Worker
  myco-collective/    # Collective Worker
    src/
      worker.ts       # Cloudflare Worker entry
      fanout.ts       # project heartbeat fanout
    dist/
      ui/             # pre-built UI assets — ship this, NOT src/ui/
    wrangler.toml     # may need creation if missing during bootstrap
```

### Bootstrap (first deploy)

`myco collective create` is a **CLI-only bootstrap** operation — same pattern as `myco init`. It:

1. Generates admin token
2. Runs `ensureKvNamespace('myco-collective-tokens')`
3. Provisions D1 database
4. **Creates wrangler.toml if missing** with basic Worker configuration
5. Writes config to `~/.myco-collective/<name>/config.json` (home-scoped)
6. Runs `npm install && wrangler deploy`

**Critical bootstrap step**: Check if `packages/myco-collective/wrangler.toml` exists. If missing, create it with:

```toml
name = "myco-collective"
main = "src/worker.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "myco-collective-db"
database_id = "<id-from-create>"

[[kv_namespaces]]
binding = "COLLECTIVE_TOKENS"
id = "<namespace-id>"

[triggers]
crons = ["*/5 * * * *"]
```

**Config scoping rule**: Collective operator config MUST be home-scoped (`~/.myco-collective/<name>/config.json`), not project-scoped. The Collective serves multiple projects — storing its config under any one project's `.myco/` makes it invisible to every other project on the machine. Team operator config stays project-scoped (`.myco/team/config.json`) because it belongs to that project.

### Cron heartbeat — MUST be in wrangler.toml

Omitting the `[triggers]` block silently disables the scheduled job in production while appearing healthy in local dev (`wrangler dev --scheduled` simulates it regardless):

```toml
[triggers]
crons = ["*/5 * * * *"]
```

**Verify this block exists before every deploy.** A missing cron block produces no deploy-time error — the worker deploys successfully but the heartbeat never fires.

### UI package distribution

Ship only pre-built `dist/ui/` assets in the `myco-collective` npm package. Shipping `src/ui/` causes a 126 MB dev-dependency pull on global install and `--ignore-scripts` CI deployment failures (Vite builds as a postinstall script).

In `ensureUiBuild()`, short-circuit if pre-built assets exist:

```typescript
async function ensureUiBuild(workerDir: string) {
  const prebuilt = path.join(workerDir, 'dist', 'ui', 'index.html');
  if (fs.existsSync(prebuilt)) return; // pre-built assets present, skip build
  // ... run vite build ...
}
```

Add `src/ui/` to `.npmignore` and ensure `dist/ui/` is NOT in `.gitignore`.

## Procedure E: D1 Schema Management and Semantic Graph Impact

### Semantic Graph Retirement

As of 2026-04-18, Myco's semantic graph has been retired from the schema. This affects D1 schema synchronization between local vault and Worker deployments:

**Removed tables:**
- `semantic_entities`
- `semantic_entity_types`
- `entity_mentions`
- `semantic_relationships`

**Impact on Worker deployments:**
1. **Team-sync Worker**: No longer needs to sync semantic graph tables to D1
2. **Migration scripts**: Remove semantic graph CREATE TABLE statements from new D1 migrations
3. **Backfill operations**: Exclude semantic graph tables from BACKFILL_TABLES array

**Schema sync checklist post-retirement:**
- Verify D1 migration files don't reference semantic graph tables
- Update `BACKFILL_TABLES` to exclude retired tables (note: `entity_mentions` lacks `id` column so was already excluded)
- Remove semantic graph indexes from D1 schema files
- Update Worker-side queries to focus on lineage-only operations

### D1 Schema Synchronization

When deploying Workers that use D1, ensure local vault schema matches Worker D1 schema:

1. **Generate migration file** from local vault schema changes
2. **Apply to D1** via `wrangler d1 migrations apply`
3. **Verify schema alignment** via `wrangler d1 execute --command "SELECT name FROM sqlite_master WHERE type='table'"`

**Migration timing**: D1 migrations apply on first request after deploy, not at deploy time. Account for this in health checks and startup procedures.

## Procedure F: Collective Operational Procedures

### Verification Protocol

Run this sequence after every Collective deploy, upgrade, or token change. **CRITICAL:** Run `make build` before any upgrade to ensure the compiled Collective UI bundle and Worker code are fresh.

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

### MCP Tools and Local Dev Proxy

**collective_* vs org_* MCP tool distinctions:**
- `collective_*` tools operate on the Collective Worker (cross-project aggregation)
- `org_*` tools operate on local org-level data structures

**Local dev proxy setup:**
```bash
make collective-ui-dev
```

This starts a Vite dev server proxying to the live Collective Worker for API calls while serving local UI assets for hot-reload development.

**Design system compliance for Collective UI:**
- Follow the same Tactile Research design system as the main daemon UI
- Use consistent typography scales (Inter, JetBrains Mono, Fraunces)
- Maintain color palette alignment (sage, ochre, terracotta)
- Test responsive behavior across viewport sizes

### V1 Integration Gate Checklist

Before marking any Collective integration as production-ready:

1. **Auth flow verification**: Admin token rotation works end-to-end
2. **Heartbeat validation**: Cron triggers fire and fanout completes
3. **UI build integrity**: Pre-built assets ship without dev dependencies
4. **Identity branding**: `COLLECTIVE_NAME` displays correctly in verify endpoint
5. **Config scoping**: Home-scoped vs project-scoped config files in correct locations
6. **MCP tool surface**: All `collective_*` tools respond correctly
7. **Upgrade path testing**: Full deploy → build → upgrade → verify cycle

## Procedure G: Operational Safety Patterns

### Fanout timeout

`fanout.ts` makes outbound HTTP requests to each connected project worker. Without a per-project timeout, one hung project stalls the entire batch:

```typescript
const FANOUT_TIMEOUT_MS = 5_000;

async function pingProject(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FANOUT_TIMEOUT_MS);
  try {
    await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fan out in parallel — one failure must not block others
await Promise.allSettled(projectUrls.map(pingProject));
```

Use `Promise.allSettled`, not `Promise.all`.

### Build script integrity — remove `|| true`

`|| true` in build scripts swallows non-zero exit codes, deploying stale artifacts silently:

```json
// BAD — stale UI deploys on build failure:
"build": "vite build || true && wrangler deploy"

// GOOD — build failure aborts deploy:
"build": "vite build && wrangler deploy"
```

Audit all `package.json` scripts in `packages/myco-collective/` for `|| true` on build-critical commands and remove them.

### Node binary PATH in nested spawns

When a Myco daemon spawns a child that itself spawns `node` as a bare binary, the child shell may not inherit the user's PATH (especially under nvm or volta). The error is `env: node: No such file or directory`.

Fix — resolve from the running process:

```typescript
const nodeBin = process.execPath; // absolute path to the active Node binary
spawn(nodeBin, ['script.js'], { ... });

// Or inject the node directory into PATH:
spawn('node', ['script.js'], {
  env: {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  },
});
```

### Verify compatibility_flags after any wrangler.toml merge

Workers using Node.js built-ins require:

```toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-01-01"
```

A missing flag causes runtime errors on the first request, not at deploy time. Always verify this block is present after any merge or template render.

## Cross-Cutting Gotchas

| # | Gotcha | Fix |
|---|--------|-----|
| 1 | `wrangler kv namespace create` non-idempotent — fails on second run | Use `ensureKvNamespace()` with list-and-match fallback |
| 2 | D1 migrations run on first request, not at deploy time | Design for lazy migration; don't assume schema is ready immediately post-deploy |
| 3 | `fs.cpSync` overwrites `wrangler.toml`, losing bindings | Read-parse-merge-write pattern; never cpSync directories containing wrangler.toml |
| 4 | Cron `[triggers]` block omitted → silent heartbeat disable | Verify triggers block before every Collective deploy |
| 5 | `\|\|\ true` in build scripts → stale artifact deploys without error | Audit and remove from all build-critical scripts |
| 6 | Wrangler subprocess stderr discarded → errors invisible | Capture both stdout and stderr; re-emit during deployment |
| 7 | Collective config stored under `.myco/` → invisible to other projects | Use home-scoped `~/.myco-collective/<name>/config.json` |
| 8 | Token not threaded through upgrade template renderer → absent post-upgrade | Enumerate all tokens in upgrade checklist; pass each explicitly |
| 9 | `node` bare binary fails in nested spawns under nvm/volta | Use `process.execPath` or inject node's bin directory into PATH |
| 10 | Shipping `src/ui/` in npm package → 126 MB install + CI failure | Ship only `dist/ui/`; short-circuit `ensureUiBuild()` on pre-built assets |
| 11 | Semantic graph tables in D1 migrations after retirement | Remove semantic graph CREATE TABLE statements from new D1 migrations |
| 12 | `make build` not run before Collective upgrade → stale UI deploys | Always run `make build` immediately before `wrangler deploy` |
| 13 | Generic collective name in verify endpoint → branding not configured | Set `COLLECTIVE_NAME` environment variable via `wrangler secret put` |
| 14 | Missing `wrangler.toml` in packages/myco-collective/ → deployment failure | Create wrangler.toml with basic Worker config during bootstrap if missing |
| 15 | TOML parsing dependency removed from codebase → merge operations fail | Use alternative TOML library or implement basic TOML handling for wrangler.toml operations |
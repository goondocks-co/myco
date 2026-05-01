---
name: myco:cloudflare-worker-infrastructure-lifecycle
description: |
  Deploy, maintain, and operate Myco's multi-worker Cloudflare infrastructure including team sync D1/Vectorize deployment, cloud MCP server operations, collective worker configuration, Wrangler upgrade hardening, Workers KV auth token lifecycle, and D1 schema migration ordering. Use this for any Cloudflare Worker deployment, D1 database operations, MCP server management, multi-worker coordination, Wrangler CLI troubleshooting, or cross-worker infrastructure tasks, even if the user doesn't explicitly mention the full infrastructure scope.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Cloudflare Worker Infrastructure Lifecycle

This skill covers comprehensive procedures for deploying, maintaining, and operating Myco's multi-worker Cloudflare infrastructure. The infrastructure spans team sync (D1/Vectorize), cloud MCP server, collective workers, and cross-worker coordination with specific gotchas around Wrangler upgrades, schema migrations, and auth token lifecycle management.

## Prerequisites

- Cloudflare account with Workers Paid plan (required for D1 and Vectorize)
- Wrangler CLI installed and authenticated (`wrangler auth login`)
- Grove-based installation with global daemon (`~/.myco/groves/` architecture)
- For team sync: D1 database and Vectorize index provisioned
- For collective: Multi-org setup with proper scoping

## Procedure A: Team Sync D1/Vectorize Deployment

Deploy and maintain the team sync infrastructure with proper schema migration handling. The team sync worker lives in `packages/myco-team/` as a standalone package.

### Initial Deployment

```bash
# Navigate to team sync package
cd packages/myco-team

# Deploy with schema migration
npx wrangler deploy --config worker/wrangler.toml

# Verify D1 binding
npx wrangler d1 list
```

**Critical gotcha**: D1 schema migrations have **lazy execution behavior** — migrations apply on the first request to the worker, not at deploy time. This means deploy success doesn't guarantee schema correctness.

### Schema Migration Sequence

D1 migrations must follow strict DDL ordering to avoid constraint violations:

```sql
-- CORRECT: Add column first
ALTER TABLE notifications ADD COLUMN machine_id TEXT;

-- THEN create index
CREATE INDEX IF NOT EXISTS idx_notifications_machine_id 
ON notifications(machine_id);
```

**Never reverse this order** — creating an index on a non-existent column fails even with `IF NOT EXISTS`.

### Grove-Scoped Schema Sync

With Grove architecture, schema migrations affect both local groves and D1:

```typescript
// Grove-aware migration handling
export const MIGRATIONS: Migration[] = [
  { version: 9, migrate: (db) => migrateV8ToV9(db) },
  { version: 10, migrate: (db) => migrateV9ToV10(db) },
  // ..., now includes grove_id scoping
];
```

The global daemon manages schema consistency across groves. Each grove maintains its local schema version while coordinating with D1 for team sync.

### Debugging Schema Drift

When local grove and deployed D1 schemas diverge:

```bash
# Export deployed schema
npx wrangler d1 execute myco-team-sync --command=".schema" > deployed.sql

# Compare with local migrations
# Check CURRENT_SCHEMA_VERSION in packages/myco/src/db/schema-ddl.ts

# Force re-run migration (if idempotent)
npx wrangler d1 execute myco-team-sync --file=migration.sql
```

### Vectorize Sync and Metadata

Team sync uses Vectorize for semantic search across projects and groves:

```bash
# Check index status
npx wrangler vectorize get myco-embeddings

# Verify embedding sync with grove metadata
npx wrangler vectorize query myco-embeddings --vector="[0.1,0.2,...]" --top-k=5
```

Embeddings now include grove metadata for cross-grove filtering and project isolation. Ensure `grove_id` and `project_id` metadata are present for proper scoping.

### Backup and Restore Operations

```bash
# Export D1 for backup
npx wrangler d1 export myco-team-sync --output=backup-$(date +%Y%m%d).sql

# Restore from backup
npx wrangler d1 execute myco-team-sync --file=backup-20240423.sql
```

**Outbox management gotcha**: Sleep/deep sleep states don't flush the outbox. Check outbox table after significant operations:

```sql
SELECT COUNT(*) FROM outbox WHERE status = 'pending';
```

## Procedure B: Cloud MCP Server Operations

Deploy and maintain the cloud MCP server which runs **alongside** the team sync worker on the same Cloudflare Worker, not as a separate deployment. Grove architecture affects authentication and data scoping patterns.

### Integrated Deployment

The cloud MCP server is deployed automatically with team sync:

```bash
cd packages/myco-team
npx wrangler deploy --config worker/wrangler.toml

# Verify both services on same worker
curl https://your-team-worker.workers.dev/health
curl https://your-team-worker.workers.dev/mcp/call
```

The cloud MCP server exposes read-only Myco tools over authenticated Streamable HTTP:
- Discovery: `myco_search`, `myco_cortex`
- Entity reads: `myco_plans`, `myco_sessions`, `myco_skills`, `myco_spores`

`myco_search` results include stable IDs and `retrieve` hints. Follow those hints with the owning entity tool instead of using legacy recall-style retrieval.

### Grove-Aware Auth Token Lifecycle

Auth tokens are now grove-scoped and auto-distributed via Workers KV with AES-256-GCM encryption:

```bash
# Check current token in KV (now includes grove context)
npx wrangler kv:key get mcp_token --binding=MCP_AUTH

# Verify token hash in health endpoint
curl https://your-team-worker.workers.dev/health
# Look for mcp_token_hash field with grove scoping
```

### Token Rotation Detection

Global daemon manages token rotation across groves via `/health` mismatch patterns:

```json
{
  "status": "healthy",
  "mcp_token_hash": "abc123...",
  "grove_scope": "global",
  "timestamp": "2024-04-23T10:30:00Z"
}
```

When grove-local token hash ≠ health response hash, global daemon triggers re-call to `/connect`:

```bash
curl -X POST https://your-team-worker.workers.dev/connect \
  -H "Content-Type: application/json" \
  -d '{"grove_id": "user_primary", "machine_id": "local"}'
```

### Live Smoke Testing

After deployment, test each tool tier with grove scoping:

```bash
# Anonymous tier
curl "https://your-team-worker.workers.dev/mcp/call" \
  -d '{"method": "myco_search", "params": {"query": "test", "limit": 1}}'

# Authenticated tier (with grove-scoped token)
curl "https://your-team-worker.workers.dev/mcp/call" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "X-Grove-ID: user_primary" \
  -d '{"method": "myco_sessions", "params": {"limit": 1}}'
```

### Graceful Error Handling

The cloud MCP server includes graceful degradation with grove-aware error contexts:
- Database unavailable → 503 Service Unavailable
- Auth failure → 401 Unauthorized with grove retry guidance
- Grove isolation errors → 403 Forbidden with scoping details
- Tool errors → wrapped in MCP error response format

Monitor error rates via Cloudflare Analytics, segmented by grove context.

## Procedure C: Collective Worker Configuration

Configure multi-org settings scoping with proper config isolation for the collective infrastructure. Grove architecture changes isolation boundaries and scoping patterns.

### Multi-Grove Settings Hierarchy

Collective workers implement four-tier scoping with Grove architecture:
- **Personal**: User-level preferences (grove-scoped)
- **Grove**: Grove-specific configuration 
- **Project**: Project-specific configuration (within grove)
- **Team**: Organization-wide defaults

### Config Isolation Patterns

Each org gets isolated KV namespace with grove boundaries:

```toml
# wrangler.toml for collective worker
[[kv_namespaces]]
binding = "ORG_SETTINGS"
id = "org_12345_settings"
preview_id = "org_12345_settings_preview"

# Grove-aware namespace isolation
[[kv_namespaces]]
binding = "GROVE_SETTINGS"
id = "grove_settings"
preview_id = "grove_settings_preview"
```

### Cross-Grove Knowledge Sharing

Enable knowledge sharing between groves within an org, respecting grove boundaries:

```javascript
// In collective worker
const groveProjects = await GROVE_SETTINGS.list({prefix: `grove:${grove_id}:projects:`});
const sharedSpores = await Promise.all(
  groveProjects.keys.map(key => GROVE_SETTINGS.get(key.name))
);

// Enforce grove-based access controls
const userGroves = await getUserAuthorizedGroves(user_id);
const accessibleSpores = sharedSpores.filter(spore => 
  userGroves.includes(spore.grove_id)
);
```

Ensure proper access controls — only grove members can access grove-scoped knowledge, with org-level sharing requiring explicit permissions.

## Procedure D: Wrangler Upgrade Hardening

Handle the 5 common Wrangler upgrade failure modes with recovery procedures.

### Failure Mode 1: sqlite-vec Export Field Blocking

**Symptom**: `npx wrangler d1 export` hangs on vector-enabled D1 databases.

**Recovery**:
```bash
# Workaround: Export without vector fields
npx wrangler d1 execute myco-team-sync --command=".schema" > schema-only.sql

# Or downgrade temporarily
npm install wrangler@3.previous-version
```

### Failure Mode 2: Cross-Target Install Requiring --force

**Symptom**: `npm ci` fails with target architecture mismatch.

**Recovery**:
```bash
# Clear npm cache and force reinstall
npm cache clean --force
rm -rf node_modules package-lock.json
npm install --force wrangler@latest
```

### Failure Mode 3: Worker npm ci Timeout Patterns  

**Symptom**: Worker builds timeout during dependency installation in CI.

**Recovery**:
```bash
# Increase timeout and use frozen lockfile
npm ci --timeout=300000 --frozen-lockfile

# Or use alternative registry
npm ci --registry=https://registry.npmmirror.com/
```

### Failure Mode 4: Release Artifact Validation

**Symptom**: Wrangler rejects build artifacts from different Node versions.

**Recovery**:
```bash
# Rebuild with matching Node version
nvm use $(cat .nvmrc)
npm run build
npx wrangler deploy
```

### Failure Mode 5: Publish-from-Artifact Discipline

**Always publish from CI-built artifacts**, never from local builds:

```bash
# WRONG: Local build + publish
npm run build
npx wrangler deploy

# RIGHT: Download CI artifact + publish  
gh run download $RUN_ID --name worker-dist
npx wrangler deploy --assets ./dist
```

This prevents version skew between environments.

## Procedure E: Workers KV Auth Token Lifecycle

Manage auth token rotation, validation, and daemon re-call cycles across the infrastructure. Grove architecture introduces grove-scoped token management.

### Grove-Scoped Token Embedding in /connect Response

The `/connect` endpoint embeds tokens with grove context directly in JSON responses:

```json
{
  "mcp_server_url": "https://your-team-worker.workers.dev",
  "auth_token": "encrypted_token_here",
  "grove_id": "user_primary",
  "expires_at": "2024-04-30T10:30:00Z"
}
```

### Rotation Detection Patterns

Global daemon polls `/health` and compares `mcp_token_hash` across grove contexts:

```javascript
const healthResp = await fetch('/health');
const {mcp_token_hash, grove_scope} = await healthResp.json();

if (mcp_token_hash !== local_stored_hash || grove_scope !== local_grove_scope) {
  // Token rotated or grove scope changed, re-call /connect
  await refreshToken();
}
```

### mcp_token_hash Validation

The hash includes grove context for rotation detection without exposing grove topology:

```javascript
const tokenHash = crypto.subtle.digest('SHA-256', 
  new TextEncoder().encode(`${grove_id}:${raw_token}`)
);
```

### Grove-Aware Daemon Re-call Cycles

When token rotation is detected, global daemon should:

1. Call `/connect` with current `grove_id` and `machine_id`
2. Extract new token and grove scope from response  
3. Update grove-local storage with new token and hash
4. Retry failed MCP calls with new grove-scoped token
5. Resume normal operation for all groves

**Rate limiting**: Don't re-call `/connect` more than once per minute per grove to avoid token exhaustion.

## Procedure F: D1 Schema Migration Ordering

Ensure correct DDL sequence for schema changes that affect D1 databases. Grove architecture requires migration coordination across grove boundaries.

### Migration Version Management

Myco uses a version-based migration system in TypeScript with grove awareness:

```typescript
// In packages/myco/src/db/migrations.ts
export const MIGRATIONS: Migration[] = [
  { version: 9, migrate: migrateV8ToV9 },
  { version: 10, migrate: migrateV9ToV10 },
  { version: 11, migrate: migrateV10ToV11 }, // Grove migration
  { version: 12, migrate: migrateV11ToV12 },
];
```

### DDL Sequence Correctness

**Always** add columns before creating indexes on them, with grove-aware constraints:

```sql
-- Step 1: Add grove_id column for grove scoping
ALTER TABLE notifications ADD COLUMN grove_id TEXT;

-- Step 2: Backfill with appropriate grove context
UPDATE notifications SET grove_id = 'user_primary' WHERE grove_id IS NULL;

-- Step 3: Create index (separate transaction for D1)
CREATE INDEX IF NOT EXISTS idx_notifications_grove_id 
ON notifications(grove_id, machine_id);
```

### Migration Idempotency

Ensure migrations can be safely re-run across grove boundaries:

```sql
-- Good: Using IF NOT EXISTS with grove awareness
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS grove_id TEXT;

-- Good: Using conditional logic in TypeScript migration
if (!tableHasColumn(db, 'sessions', 'grove_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN grove_id TEXT');
  // Backfill grove context for existing sessions
  backfillGroveContext(db);
}
```

### Schema Convergence

Local grove schemas and D1 must stay synchronized across grove boundaries:

```bash
# After grove-local migration
myco daemon migrate

# Deploy to sync D1 with grove metadata
cd packages/myco-team
npx wrangler deploy --config worker/wrangler.toml

# Verify convergence across grove scopes
npx wrangler d1 execute myco-team-sync --command=".schema"
```

### Grove-Aware Backfill Safety Patterns

When adding grove-scoped constraints or indexes to existing data:

```sql
-- Safe: Add grove_id column first
ALTER TABLE spores ADD COLUMN grove_id TEXT;

-- Backfill with grove context from global daemon
UPDATE spores SET grove_id = 'user_primary' WHERE grove_id IS NULL;

-- Add grove-scoped constraints
CREATE INDEX idx_spores_grove_importance ON spores(grove_id, importance);
```

## Cross-Cutting Gotchas

### Wrangler Version Sensitivity

Different Wrangler versions handle D1 exports, bindings, and timeouts differently. Pin Wrangler version in package.json and CI:

```json
{
  "devDependencies": {
    "wrangler": "3.57.1"
  }
}
```

### Environment Variable Propagation

Workers inherit environment variables from wrangler.toml, but secrets must be set via `npx wrangler secret`:

```bash
# Secrets (encrypted, now grove-aware)
echo "secret_value" | npx wrangler secret put MCP_ENCRYPTION_KEY

# Check propagation with grove context
npx wrangler tail --format=pretty
```

### D1 Transaction Limits

D1 has strict transaction limits (1000 statements). Batch large operations with grove awareness:

```javascript
const chunks = batchOf1000(statements);
for (const chunk of chunks) {
  await db.batch(chunk.map(stmt => ({
    ...stmt,
    grove_id: current_grove_id
  })));
}
```

### Multi-Worker Coordination

When multiple workers share resources (D1, KV), use grove-aware optimistic locking:

```javascript
const version = await KV.get(`resource_version:${grove_id}`);
const result = await updateResource(data);
const success = await KV.put(`resource_version:${grove_id}`, version + 1, {
  metadata: {
    previous_version: version,
    grove_id: grove_id
  }
});

if (!success) {
  // Concurrent update, retry with grove context
  throw new ConflictError(`Resource updated by another worker in grove ${grove_id}`);
}
```

This prevents race conditions in multi-worker environments while maintaining grove isolation.

### Team Sync Package Structure

The team sync worker is a standalone npm package in `packages/myco-team/` with grove-aware routing:

```
packages/myco-team/
├── src/cli.ts          # myco-team CLI (grove-aware)
├── worker/
│   ├── src/            # Worker source code (grove routing)
│   ├── wrangler.toml   # Cloudflare configuration
│   └── package.json    # Worker dependencies
└── package.json        # CLI package
```

The cloud MCP server code is embedded within the worker source, not a separate deployment, and includes grove-scoped request routing.
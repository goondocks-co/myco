---
name: myco:cloudflare-worker-infrastructure-lifecycle
description: |
  Deploy, maintain, and operate Myco's multi-worker Cloudflare infrastructure including team sync D1/Vectorize deployment, cloud MCP server operations, collective worker configuration, Wrangler upgrade hardening, Workers KV auth token lifecycle, and D1 schema migration ordering. Use this for any Cloudflare Worker deployment, D1 database operations, MCP server management, multi-worker coordination, Wrangler CLI troubleshooting, or cross-worker infrastructure tasks, even if the user doesn't explicitly mention the full infrastructure scope.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Cloudflare Worker Infrastructure Lifecycle

This skill covers comprehensive procedures for deploying, maintaining, and operating Myco's multi-worker Cloudflare infrastructure. With Grove architecture, the infrastructure adapts to global daemon coordination while spanning team sync (D1/Vectorize), cloud MCP server, collective workers, and cross-worker coordination with specific gotchas around Wrangler upgrades, schema migrations, and auth token lifecycle management.

## Prerequisites

- Cloudflare account with Workers Paid plan (required for D1 and Vectorize)
- Wrangler CLI installed and authenticated (`wrangler auth login`)
- Grove-based installation with global daemon (`~/.myco/groves/` architecture) — **Grove installation is now required for team sync deployment**
- For team sync: D1 database and Vectorize index provisioned
- For collective: Multi-grove setup with proper scoping

## Procedure A: Team Sync D1/Vectorize Deployment

Deploy and maintain the team sync infrastructure with Grove-aware schema migration handling. The team sync worker lives in `packages/myco-team/` as a standalone package. **Grove installation is now mandatory** — team sync deployment cannot proceed without Grove architecture.

### Grove-Only Installation Requirement

**Critical requirement**: Team sync deployment requires Grove architecture:

```bash
# Verify Grove installation before team sync deployment
if [ ! -d "$HOME/.myco/groves" ]; then
  echo "Error: Team sync requires Grove installation"
  echo "Install Grove first: myco init --grove"
  exit 1
fi

# Check global daemon running with Grove coordination
myco daemon status --grove-coordination
```

Team sync is **only supported in Grove environments**. Legacy standalone installations cannot deploy team sync infrastructure.

### Initial Deployment

```bash
# Navigate to team sync package
cd packages/myco-team

# Deploy with grove-aware schema migration
npx wrangler deploy --config worker/wrangler.toml

# Verify D1 binding with grove context
npx wrangler d1 list
```

**Critical gotcha**: D1 schema migrations have **lazy execution behavior** — migrations apply on the first request to the worker, not at deploy time. With Grove architecture, this means grove-scoped migrations may execute at different times.

### Grove-Scoped Schema Migration Sequence

D1 migrations must follow strict DDL ordering with Grove architecture considerations:

```sql
-- CORRECT: Add grove_id column first for Grove scoping
ALTER TABLE notifications ADD COLUMN grove_id TEXT;

-- Backfill with grove context
UPDATE notifications SET grove_id = 'user_primary' WHERE grove_id IS NULL;

-- THEN create grove-scoped index
CREATE INDEX IF NOT EXISTS idx_notifications_grove_id
ON notifications(grove_id, machine_id);
```

**Never reverse this order** — creating an index on a non-existent column fails even with `IF NOT EXISTS`. Grove architecture requires grove_id scoping in most tables.

### Grove-Coordinated Schema Sync

With Grove architecture, schema migrations coordinate between global daemon and D1:

```typescript
// Grove-aware migration handling
export const MIGRATIONS: Migration[] = [
  { version: 9, migrate: (db) => migrateV8ToV9(db) },
  { version: 10, migrate: (db) => migrateV9ToV10(db) },
  { version: 11, migrate: (db) => migrateV10ToV11Grove(db) }, // Grove migration
  { version: 12, migrate: (db) => migrateV11ToV12(db) },
];
```

The global daemon manages schema consistency across groves while coordinating with D1 for team sync. Each grove maintains its local schema version while participating in grove-wide coordination.

### Debugging Grove Schema Drift

When grove-local and deployed D1 schemas diverge:

```bash
# Export deployed schema with grove context
npx wrangler d1 execute myco-team-sync --command=".schema" > deployed.sql

# Compare with grove-local migrations
# Check CURRENT_SCHEMA_VERSION in packages/myco/src/db/schema-ddl.ts

# Force re-run grove migration (if idempotent)
npx wrangler d1 execute myco-team-sync --file=grove-migration.sql
```

### Grove-Aware Vectorize Sync

Team sync uses Vectorize for semantic search with grove boundaries:

```bash
# Check index status with grove awareness
npx wrangler vectorize get myco-embeddings

# Verify embedding sync with grove metadata
npx wrangler vectorize query myco-embeddings \
  --vector="[0.1,0.2,...]" \
  --top-k=5 \
  --metadata-filter='{"grove_id": "user_primary"}'
```

Embeddings now include grove metadata for cross-grove filtering and project isolation. Global daemon coordinates embedding sync across groves while maintaining proper access boundaries.

### Grove Team Sync Visibility Metrics

Monitor team sync deployment with Grove-scoped visibility metrics:

```bash
# Check team sync health with Grove metrics
curl "https://your-team-worker.workers.dev/health" \
  -H "X-Grove-ID: user_primary"

# Response includes Grove visibility metrics
{
  "status": "healthy",
  "grove_id": "user_primary",
  "sync_status": "active",
  "last_sync_at": "2024-04-23T10:30:00Z",
  "pending_operations": 0,
  "grove_projects": ["proj_123", "proj_456"],
  "sync_metrics": {
    "outbox_queue_depth": 0,
    "last_successful_sync": "2024-04-23T10:28:15Z",
    "sync_failures_last_24h": 0,
    "grove_data_volume_mb": 145.2,
    "project_sync_status": {
      "proj_123": {"status": "active", "last_sync": "2024-04-23T10:28:15Z"},
      "proj_456": {"status": "active", "last_sync": "2024-04-23T10:27:45Z"}
    }
  }
}
```

**Enhanced visibility patterns**: Grove sync visibility now includes project-level sync status tracking, operational metrics for monitoring sync health, queue depth, failure rates, and data volume trends across grove projects.

### Grove-Coordinated Backup and Restore

```bash
# Export D1 with grove context
npx wrangler d1 export myco-team-sync --output=grove-backup-$(date +%Y%m%d).sql

# Restore with grove awareness
npx wrangler d1 execute myco-team-sync --file=grove-backup-20240423.sql
```

**Grove outbox management gotcha**: Global daemon coordination may leave pending outbox entries during grove transitions. Check outbox table after grove operations:

```sql
SELECT COUNT(*) FROM outbox WHERE status = 'pending' AND grove_id = 'user_primary';
```

## Procedure B: Cloud MCP Server Operations

Deploy and maintain the cloud MCP server with Grove authentication patterns. The server runs **alongside** the team sync worker on the same Cloudflare Worker, not as a separate deployment.

### Grove-Integrated Deployment

The cloud MCP server deploys automatically with team sync with grove awareness:

```bash
cd packages/myco-team
npx wrangler deploy --config worker/wrangler.toml

# Verify both services with grove support
curl https://your-team-worker.workers.dev/health
curl https://your-team-worker.workers.dev/mcp/call \
  -H "X-Grove-ID: user_primary"
```

The cloud MCP server exposes grove-scoped read-only Myco tools over authenticated Streamable HTTP:
- Discovery: `myco_search`, `myco_cortex` (grove-filtered results)
- Entity reads: `myco_plans`, `myco_sessions`, `myco_skills`, `myco_spores` (grove-scoped)

`myco_search` results include grove context and stable IDs with `retrieve` hints. Follow those hints with the owning entity tool for grove-appropriate access.

### Grove-Scoped Credential Management (Team Key vs MCP Access Token)

**Updated credential terminology** for Grove team sync:
- **Team Key**: Organization-level credential for team sync coordination (stored in organization settings)
- **MCP Access Token**: Grove-scoped token for cloud MCP server access (distributed via Workers KV)

```bash
# Check Team Key in organization settings (not grove-scoped)
curl https://your-team-worker.workers.dev/org/credentials \
  -H "Authorization: Bearer $TEAM_KEY"

# Check grove-scoped MCP Access Token in KV
npx wrangler kv:key get "mcp_token:user_primary" --binding=MCP_AUTH

# Verify token hash in health endpoint with grove context
curl https://your-team-worker.workers.dev/health
# Look for mcp_token_hash field with grove_id scoping
```

**Critical distinction**: Team Keys enable organization-wide coordination while MCP Access Tokens provide grove-scoped API access. **Team Key** is the preferred organizational-level credential name (replaces older "auth_token" terminology).

### Credential UX Improvements

**Enhanced credential management UX** for Grove deployments:

```bash
# Improved Team Key validation with clear error messages
curl https://your-team-worker.workers.dev/validate-team-key \
  -H "Authorization: Bearer $TEAM_KEY"

# Response includes actionable credential status
{
  "valid": false,
  "error_type": "expired_team_key",
  "message": "Team Key expired 3 days ago",
  "actions": {
    "renew_url": "https://app.myco.ai/org/settings/team-sync",
    "support_docs": "https://docs.myco.ai/grove/credentials",
    "estimated_downtime": "< 5 minutes after renewal"
  },
  "grove_impact": ["user_primary", "staging_grove"]
}
```

**Credential UX enhancements**:
- Clear error types (expired, invalid, missing permissions)
- Actionable renewal guidance with direct links
- Impact assessment showing affected groves
- Estimated resolution timeframes
- Support documentation links contextual to the error type

### Grove Token Rotation Detection

Global daemon manages token rotation across groves via `/health` grove-aware patterns:

```json
{
  "status": "healthy",
  "mcp_token_hash": "grove_abc123...",
  "grove_scope": "user_primary",
  "team_key_status": "active",
  "timestamp": "2024-04-23T10:30:00Z"
}
```

When grove-local token hash ≠ health response hash, global daemon triggers re-call to `/connect`:

```bash
curl -X POST https://your-team-worker.workers.dev/connect \
  -H "Content-Type: application/json" \
  -d '{
    "grove_id": "user_primary",
    "machine_id": "local",
    "global_daemon": true
  }'
```

### Grove-Aware Live Smoke Testing

Test each tool tier with grove scoping:

```bash
# Anonymous tier with grove context
curl "https://your-team-worker.workers.dev/mcp/call" \
  -H "X-Grove-ID: user_primary" \
  -d '{
    "method": "myco_search",
    "params": {"query": "test", "limit": 1}
  }'

# Authenticated tier with grove-scoped MCP Access Token
curl "https://your-team-worker.workers.dev/mcp/call" \
  -H "Authorization: Bearer $GROVE_MCP_ACCESS_TOKEN" \
  -H "X-Grove-ID: user_primary" \
  -d '{
    "method": "myco_sessions",
    "params": {"limit": 1}
  }'
```

### Grove-Aware Error Handling

The cloud MCP server includes graceful degradation with grove-specific error contexts:
- Database unavailable → 503 Service Unavailable
- Auth failure → 401 Unauthorized with grove retry guidance
- Grove isolation errors → 403 Forbidden with specific grove details
- Cross-grove access denied → 403 Forbidden with grove scope explanation
- Tool errors → wrapped in MCP error response format with grove context

Monitor error rates via Cloudflare Analytics, segmented by grove and access pattern.

## Procedure C: Collective Worker Configuration

Configure multi-grove settings scoping with proper config isolation for the collective infrastructure. Grove architecture changes isolation boundaries from organizations to grove-scoped hierarchies.

### Multi-Grove Settings Hierarchy

Collective workers implement grove-aware four-tier scoping:
- **Personal**: User-level preferences (grove-scoped)
- **Grove**: Grove-specific configuration
- **Project**: Project-specific configuration (within grove)
- **Team**: Organization-wide defaults (cross-grove when applicable)

### Multi-Project UI Switcher Integration

Grove collective workers now support **seamless multi-project UI switching** with grove-aware project context management:

```javascript
// Grove-aware project switcher in collective worker
const groveProjects = await GROVE_SETTINGS.list({
  prefix: `grove:${grove_id}:projects:`
});

// Enhanced project switcher UI integration
const projectSwitcher = {
  currentProject: await getCurrentGroveProject(grove_id),
  availableProjects: groveProjects.keys.map(key => ({
    id: key.metadata.project_id,
    name: key.metadata.project_name,
    grove_id: grove_id,
    url: `/projects/${key.metadata.project_id}`,
    lastAccessed: key.metadata.last_accessed_at,
    sessionCount: key.metadata.active_sessions,
    projectStatus: key.metadata.status, // active, paused, archived
    quickActions: key.metadata.quick_actions, // recent tasks, pinned workflows
    projectIcon: key.metadata.icon, // project type or custom icon
    collaboratorCount: key.metadata.collaborator_count
  })),
  switchUrl: `/api/grove/${grove_id}/switch-project`,
  preferences: {
    rememberLastProject: true,
    autoSwitchOnActivity: false,
    showInactiveProjects: true,
    projectSortOrder: 'last_accessed', // or 'name', 'activity'
    compactView: false
  },
  uiEnhancements: {
    keyboardShortcuts: true,
    projectPreview: true,
    quickSearch: true,
    recentProjects: 5,
    projectGrouping: true, // group by type, status, or activity
    batchOperations: true // multi-select for archive, pause operations
  }
};
```

**Enhanced UI integration patterns**:
- **Project status indicators**: Visual cues for active, paused, or archived projects
- **Quick actions**: Contextual shortcuts for recent tasks and pinned workflows  
- **Keyboard navigation**: Cmd/Ctrl+K project switcher with quick search
- **Project preview**: Hover preview showing recent activity and key metrics
- **Smart sorting**: Last accessed, activity level, or alphabetical project ordering
- **User preferences**: Configurable switcher behavior and display options
- **Project grouping**: Organize projects by type, status, or activity level
- **Batch operations**: Multi-select interface for bulk project management

### Grove Config Isolation Patterns

Each grove gets isolated KV namespace with grove boundaries:

```toml
# wrangler.toml for collective worker with grove support
[[kv_namespaces]]
binding = "GROVE_SETTINGS"
id = "grove_settings_production"
preview_id = "grove_settings_preview"

# Grove-scoped namespace isolation
[[kv_namespaces]]
binding = "CROSS_GROVE_SETTINGS"
id = "cross_grove_settings"
preview_id = "cross_grove_settings_preview"
```

### Cross-Grove Knowledge Sharing

Enable knowledge sharing between groves within an org, respecting grove boundaries:

```javascript
// In collective worker with grove awareness
const groveProjects = await GROVE_SETTINGS.list({
  prefix: `grove:${grove_id}:projects:`
});

const groveSpores = await Promise.all(
  groveProjects.keys.map(key => GROVE_SETTINGS.get(key.name))
);

// Enforce grove-based access controls
const userGroves = await getUserAuthorizedGroves(user_id);
const accessibleSpores = groveSpores.filter(spore =>
  userGroves.includes(spore.grove_id)
);

// Apply cross-grove sharing policies
const sharedSpores = accessibleSpores.filter(spore =>
  spore.sharing_policy === 'cross_grove' &&
  userHasCrossGroveAccess(user_id, spore.grove_id)
);
```

Ensure proper grove access controls — only grove members can access grove-scoped knowledge, with cross-grove sharing requiring explicit policies and global daemon coordination.

## Procedure D: Wrangler Upgrade Hardening

Handle the 5 common Wrangler upgrade failure modes with grove-aware recovery procedures.

### Failure Mode 1: sqlite-vec Export Field Blocking

**Symptom**: `npx wrangler d1 export` hangs on vector-enabled D1 databases with grove metadata.

**Recovery**:
```bash
# Workaround: Export schema without grove-specific vector fields
npx wrangler d1 execute myco-team-sync --command=".schema" > grove-schema-only.sql

# Or downgrade temporarily with grove coordination
npm install wrangler@3.previous-version
```

### Failure Mode 2: Cross-Target Install Requiring --force

**Symptom**: `npm ci` fails with target architecture mismatch in grove environments.

**Recovery**:
```bash
# Clear npm cache and force reinstall with grove context
npm cache clean --force
rm -rf node_modules package-lock.json
npm install --force wrangler@latest
```

### Failure Mode 3: Worker npm ci Timeout Patterns

**Symptom**: Worker builds timeout during dependency installation in grove CI environments.

**Recovery**:
```bash
# Increase timeout and use frozen lockfile with grove coordination
npm ci --timeout=300000 --frozen-lockfile

# Or use alternative registry for grove builds
npm ci --registry=https://registry.npmmirror.com/
```

### Failure Mode 4: Grove Release Artifact Validation

**Symptom**: Wrangler rejects build artifacts from different Node versions in grove deployments.

**Recovery**:
```bash
# Rebuild with matching Node version for grove consistency
nvm use $(cat .nvmrc)
npm run build
npx wrangler deploy --env grove-production
```

### Failure Mode 5: Grove Publish-from-Artifact Discipline

**Always publish from CI-built artifacts**, never from local builds in grove environments:

```bash
# WRONG: Local grove build + publish
npm run build
npx wrangler deploy --env grove

# RIGHT: Download CI artifact + grove publish
gh run download $RUN_ID --name grove-worker-dist
npx wrangler deploy --assets ./dist --env grove-production
```

This prevents version skew between grove environments and maintains consistency.

## Procedure E: Workers KV Auth Token Lifecycle

Manage grove-scoped auth token rotation, validation, and daemon re-call cycles across the infrastructure.

### Grove Token Embedding in /connect Response

The `/connect` endpoint embeds grove-scoped tokens directly in JSON responses:

```json
{
  "mcp_server_url": "https://your-team-worker.workers.dev",
  "mcp_access_token": "grove_encrypted_token_here",
  "team_key_status": "active",
  "grove_id": "user_primary",
  "expires_at": "2024-04-30T10:30:00Z",
  "global_daemon_scope": true
}
```

**Updated field naming**: `mcp_access_token` (was `auth_token`) for clarity with Team Key distinction.

### Grove Rotation Detection Patterns

Global daemon polls `/health` and compares `mcp_token_hash` across grove contexts:

```javascript
const healthResp = await fetch('/health', {
  headers: { 'X-Grove-ID': grove_id }
});
const {mcp_token_hash, grove_scope, team_key_status} = await healthResp.json();

if (mcp_token_hash !== local_grove_hash || grove_scope !== local_grove_id) {
  // Grove MCP Access Token rotated or scope changed, re-call /connect
  await refreshGroveMcpAccessToken(grove_id);
}

if (team_key_status !== 'active') {
  // Team Key needs attention at org level
  await notifyTeamKeyIssue();
}
```

### Grove mcp_token_hash Validation

The hash includes grove context for rotation detection without exposing grove topology:

```javascript
const groveTokenHash = crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(`${grove_id}:${global_daemon_id}:${mcp_access_token}`)
);
```

### Global Daemon Grove Re-call Cycles

When grove token rotation is detected, global daemon should:

1. Call `/connect` with current `grove_id` and `machine_id`
2. Extract new grove-scoped MCP Access Token and expiration from response
3. Update grove-local storage with new token and hash
4. Retry failed MCP calls with new grove-scoped token
5. Resume normal operation for affected grove
6. Coordinate token updates across other groves if necessary

**Grove rate limiting**: Don't re-call `/connect` more than once per minute per grove to avoid token exhaustion.

## Procedure F: D1 Schema Migration Ordering

Ensure correct DDL sequence for schema changes that affect D1 databases. Grove architecture requires migration coordination across grove boundaries and global daemon.

### Grove Migration Version Management

Myco uses a grove-aware version-based migration system in TypeScript:

```typescript
// In packages/myco/src/db/migrations.ts with grove support
export const MIGRATIONS: Migration[] = [
  { version: 9, migrate: migrateV8ToV9 },
  { version: 10, migrate: migrateV9ToV10 },
  { version: 11, migrate: migrateV10ToV11Grove }, // Grove migration
  { version: 12, migrate: migrateV11ToV12 },
];
```

### Grove DDL Sequence Correctness

**Always** add grove columns before creating grove-scoped indexes:

```sql
-- Step 1: Add grove_id column for grove scoping
ALTER TABLE notifications ADD COLUMN grove_id TEXT;

-- Step 2: Backfill with grove context from global daemon
UPDATE notifications SET grove_id = 'user_primary' WHERE grove_id IS NULL;

-- Step 3: Create grove-scoped index (separate transaction for D1)
CREATE INDEX IF NOT EXISTS idx_notifications_grove_machine
ON notifications(grove_id, machine_id);
```

### Grove Migration Idempotency

Ensure migrations can be safely re-run across grove boundaries:

```sql
-- Good: Using IF NOT EXISTS with grove awareness
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS grove_id TEXT;

-- Good: Using conditional logic in grove TypeScript migration
if (!tableHasColumn(db, 'sessions', 'grove_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN grove_id TEXT');
  // Backfill grove context for existing sessions
  await backfillGroveContext(db, globalDaemonState);
}
```

### Grove Schema Convergence

Grove-local schemas and D1 must stay synchronized across grove boundaries:

```bash
# After grove-local migration coordinated by global daemon
myco daemon migrate --grove user_primary

# Deploy to sync D1 with grove metadata
cd packages/myco-team
npx wrangler deploy --config worker/wrangler.toml

# Verify convergence across grove scopes
npx wrangler d1 execute myco-team-sync --command=".schema"
```

### Grove Backfill Safety Patterns

When adding grove-scoped constraints or indexes to existing data:

```sql
-- Safe: Add grove_id column first
ALTER TABLE spores ADD COLUMN grove_id TEXT;

-- Backfill with grove context from global daemon coordination
UPDATE spores SET grove_id = 'user_primary' WHERE grove_id IS NULL;

-- Add grove-scoped constraints
CREATE INDEX idx_spores_grove_importance ON spores(grove_id, importance);
```

## Cross-Cutting Gotchas

### Wrangler Version Sensitivity

Different Wrangler versions handle D1 exports, bindings, and timeouts differently. Pin Wrangler version in package.json and grove CI:

```json
{
  "devDependencies": {
    "wrangler": "3.57.1"
  }
}
```

### Grove Environment Variable Propagation

Workers inherit environment variables from wrangler.toml, but grove-scoped secrets must be set via `npx wrangler secret`:

```bash
# Grove-scoped secrets (encrypted)
echo "grove_secret_value" | npx wrangler secret put GROVE_MCP_KEY --env grove-production

# Check propagation with grove context
npx wrangler tail --format=pretty --env grove-production
```

### Grove D1 Transaction Limits

D1 has strict transaction limits (1000 statements). Batch large operations with grove awareness:

```javascript
const groveChunks = batchOf1000(statements);
for (const chunk of groveChunks) {
  await db.batch(chunk.map(stmt => ({
    ...stmt,
    grove_id: current_grove_id
  })));
}
```

### Multi-Worker Grove Coordination

When multiple workers share grove resources (D1, KV), use grove-aware optimistic locking:

```javascript
const groveVersion = await KV.get(`resource_version:${grove_id}`);
const result = await updateGroveResource(data, grove_id);
const success = await KV.put(`resource_version:${grove_id}`, groveVersion + 1, {
  metadata: {
    previous_version: groveVersion,
    grove_id: grove_id,
    global_daemon_id: global_daemon_id
  }
});

if (!success) {
  // Concurrent grove update, retry with coordination
  throw new GroveConflictError(`Resource updated by another worker in grove ${grove_id}`);
}
```

This prevents race conditions in multi-worker environments while maintaining grove isolation and global daemon coordination.

### Grove Team Sync Package Structure

The team sync worker is a standalone npm package in `packages/myco-team/` with grove-aware routing:

```
packages/myco-team/
├── src/cli.ts          # myco-team CLI (grove-aware)
├── worker/
│   ├── src/            # Worker source code (grove routing)
│   ├── wrangler.toml   # Cloudflare configuration (grove envs)
│   └── package.json    # Worker dependencies
└── package.json        # CLI package
```

The cloud MCP server code is embedded within the worker source with grove-scoped request routing and global daemon coordination, not as a separate deployment.
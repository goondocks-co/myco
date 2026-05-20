---
name: myco:grove-multi-tenant-architecture
description: |
  Comprehensive procedures for implementing and managing Myco's Grove multi-tenant architecture with request context management. Covers request context threading through transport boundaries, project identity binding via .myco/project.toml, multi-tenant database schema design, context enforcement across six layers, MCP transport unification, Grove registry management, and comprehensive importer architecture. Use when implementing multi-tenant features, setting up Grove projects, debugging context propagation issues, or ensuring request context isolation.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Grove Multi-Tenant Architecture and Request Context Management

Comprehensive guide for implementing Myco's Grove multi-tenant architecture, covering request context threading, project identity management, schema design, transport unification, and security patterns.

## Prerequisites

- Grove infrastructure is deployed and accessible
- Understanding of Myco's daemon architecture and MCP transport layer
- Database schema version 32+ for multi-tenant support
- Project-local .myco/ vault structure in place

## Procedure A: Request Context Threading Through Transport Boundaries

Implement request context extraction and propagation across all tool entry points.

### Context Structure

All requests carry a normalized context object:
```typescript
{ groveId, projectId, machineId }
```

### Transport-Specific Context Extraction

**CLI Transport** (`packages/myco/src/cli/tool.ts`):
```typescript
import { requestContextFromEnvironment } from '@myco/tools/request-context.js';

const requestContext = requestContextFromEnvironment(process.env, vaultDir);
const tools = createMycoTools(vaultDir, new DaemonClient(vaultDir), { requestContext });
```

**MCP Stdio Bridge** (via `myco mcp`):
```typescript
const requestContext = requestContextFromEnvironment(process.env, vaultDir);
const headers = requestContextHeaders(requestContext);
const mcpResponse = await daemonClient.mcp(headers);
```

### Tool Factory Integration

Thread context through `packages/myco/src/tools/index.ts`:
```typescript
export function createMycoTools(vaultDir: string, client: DaemonClient, options: MycoToolsOptions = {}): MycoTools {
  const requestContext = options.requestContext ?? resolveLegacyRequestContext(vaultDir);
  // All tools receive scoped context - enforces project_id isolation at tool level
}
```

## Procedure B: Project Identity Binding via .myco/project.toml

Establish project identity layer with Grove binding metadata.

### Project Identity File Structure

Create `.myco/project.toml` (committed to repo):
```toml
[project]
name = "my-project"
id = "proj_abc123"

[grove]
binding_id = "binding_def456"
default_grove_ref = "grove-production"
```

### Machine-Local Configuration

Maintain secrets in `.myco/config.yaml` (gitignored):
```yaml
machine:
  id: "machine_ghi789"
grove:
  access_token: "token_secret"
  endpoint: "https://grove.myco.dev"
```

### Project Discovery Logic

Use Grove paths infrastructure in `packages/myco/src/grove/paths.ts`:
```typescript
import { PROJECT_LOCAL_MANIFEST_FILENAME, resolveProjectVaultDir } from '../grove/paths.js';

function resolveProjectIdentity(workingDir: string) {
  const projectToml = path.join(workingDir, '.myco', PROJECT_LOCAL_MANIFEST_FILENAME);
  if (!fs.existsSync(projectToml)) {
    throw new Error('No project identity found - run myco init');
  }
  const config = parseToml(fs.readFileSync(projectToml, 'utf8'));
  return { projectId: config.project.id, groveBinding: config.grove.binding_id };
}
```

## Procedure C: Multi-Tenant Database Schema Design

Implement schema with identity scoping and null-safe indexes.

### Schema Structure with Project Scoping

From `packages/myco/src/db/schema-ddl.ts`, core tables include project_id:
```sql
CREATE TABLE sessions (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT,
    title                  TEXT,
    summary                TEXT,
    -- ...
);

CREATE TABLE spores (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT,
    project_id         TEXT,
    -- ...
);
```

### Import Boundary Enforcement

Set `embedded=0` on import boundaries to prevent cross-project leakage:
```typescript
await db.run(`INSERT INTO sessions (id, project_id, embedded, ...) VALUES (?, ?, 0, ...)`, [sessionId, targetProjectId, ...])
```

### Comprehensive Importer Architecture

Implement four-slice design with validated journal mappings in `packages/myco/src/grove/importer.ts`:
```typescript
async function importCoreRows(sourceDb: Database, targetDb: Database, projectId: string) {
  const journal = new ImportJournal();
  const sessions = await sourceDb.all('SELECT * FROM sessions');
  for (const session of sessions) {
    const newId = generateId();
    journal.mapSession(session.id, newId);
    await targetDb.run(`INSERT INTO sessions (id, project_id, title, summary, ...) VALUES (?, ?, ?, ?, ...)`, 
      [newId, projectId, session.title, session.summary, ...]);
  }
}
```

## Procedure D: Request Context Enforcement Across Six Layers

Implement comprehensive context isolation across all system layers.

### Layer 1: Tool Read Enforcement

Lock tool reads to project_id via `createMycoTools`:
```typescript
export function createMycoTools(vaultDir: string, client: DaemonClient, options: MycoToolsOptions = {}) {
  const requestContext = options.requestContext ?? resolveLegacyRequestContext(vaultDir);
  return {
    vault_sessions: async () => {
      return db.all('SELECT * FROM sessions WHERE project_id = ?', [requestContext.projectId]);
    }
  };
}
```

### Layer 3: Daemon Write Rejection

Reject cross-project write operations using `packages/myco/src/spores/write.ts`:
```typescript
import { rowProjectIdFromRequestContext, type MycoRequestContext } from '@myco/tools/request-context.js';

async function createSpore(data: SporeData, requestContext: MycoRequestContext) {
  if (data.session_id) {
    const session = await db.get('SELECT project_id FROM sessions WHERE id = ?', [data.session_id]);
    const expectedProjectId = rowProjectIdFromRequestContext(requestContext);
    if (session?.project_id !== expectedProjectId) {
      throw new Error(`Cross-project write denied: session ${data.session_id} not in project ${expectedProjectId}`);
    }
  }
  await db.run('INSERT INTO spores (..., project_id) VALUES (..., ?)', [...data, expectedProjectId]);
}
```

## Procedure E: MCP Transport Unification and Parity

Implement unified MCP architecture with global daemon and CLI fallback.

### Global Daemon MCP Endpoint

The MCP endpoint is served by the global daemon at `/mcp`:
```typescript
app.post('/mcp', async (req, res) => {
  const requestContext = requestContextFromHeaders(req.headers);
  // Route to appropriate MCP handler
});
```

### CLI MCP Command Integration

The `myco mcp` command bridges stdio MCP to the global daemon:
```typescript
// packages/myco/src/cli.ts
if (cmd === 'mcp') return (await import('./mcp/stdio-bridge.js')).main();
```

The stdio bridge connects to daemon:
```typescript
export async function main() {
  const vaultDir = resolveProjectVaultDir(process.cwd());
  const requestContext = requestContextFromEnvironment(process.env, vaultDir);
  const headers = requestContextHeaders(requestContext);
  const daemonClient = new DaemonClient(vaultDir);
  await daemonClient.bridgeStdioToMcp(headers);
}
```

## Procedure F: Grove Registry Management and Home Path Primitives

Implement standardized Grove paths and registry management with machine runtime support.

### Grove Home and Machine Runtime Primitives

Use Grove path constants from `packages/myco/src/grove/paths.ts`:
```typescript
export const MYCO_HOME_ENV = 'MYCO_HOME';
export const GROVES_DIRNAME = 'groves';
export const GROVE_REGISTRY_FILENAME = 'registry.yaml';
export const DAEMON_STATE_FILENAME = 'daemon.json';
export const SERVICE_DIRNAME = 'service';
export const SERVICE_DEV_DIRNAME = 'service-dev';

// Path resolution
const groveHome = resolveMycoHome();
const daemonStatePath = resolveServiceDaemonStatePath();
const runtimeDir = resolveMachineRuntimeDir(groveHome);
```

### Development Service Mode Management

Use development service mode primitives:
```typescript
import { SERVICE_DEV_DIRNAME, isDevServiceMode, setDevServiceMode } from '../grove/paths.js';

// Switch to development mode (service-dev/, port 19344)
function enableDevMode() {
  setDevServiceMode(true);
  console.log(`Switched to development service mode (${SERVICE_DEV_DIRNAME})`);
}
```

### Grove Registry Structure

Registry structure in `registry.yaml` (GROVE_REGISTRY_FILENAME):
```yaml
registry:
  version: "1.0"

groves:
  - id: "grove_abc123"
    name: "production"
    endpoint: "https://grove.myco.dev"
    status: "active"
```

## Procedure G: Security and Authorization Patterns

Implement security enforcement across Grove multi-tenant architecture.

### Multi-Tenant Request Context Validation

```javascript
const groveId = req.headers['x-myco-grove-id'];
const projectId = req.headers['x-myco-project-id'];

// Validate formats (prevent injection)
if (!/^grove_[0-9a-f]{32}$/.test(groveId)) {
  return res.status(400).json({ error: 'Invalid Grove ID format' });
}
if (!/^proj_[0-9a-f]{32}$/.test(projectId)) {
  return res.status(400).json({ error: 'Invalid Project ID format' });
}
```

### Grove Isolation Boundary Enforcement

```javascript
async function getGroveProjectData(groveId, projectId, resourceId) {
  const query = `SELECT * FROM resources WHERE grove_id = ? AND project_id = ? AND resource_id = ?`;
  return db.query(query, [groveId, projectId, resourceId]);
}
```

### Timing-Safe Authentication Comparisons

```javascript
async function validateGroveBearerToken(providedToken, groveId, projectId) {
  const expectedToken = await getGroveProjectToken(groveId, projectId);
  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedToken || '', 'utf8'),
    Buffer.from(expectedToken, 'utf8')
  );
  await new Promise(resolve => setTimeout(resolve, 10)); // Consistent delay
  return isValid;
}
```

## Procedure H: D1 Drift Reconciler Architecture and Daemon-Side Intelligence

**Critical update**: Implement daemon-side intelligence vs worker passive receiver principles:

### Daemon-Side Intelligence Principle

The daemon performs all intelligence operations while the worker acts as a passive data receiver:

```typescript
// Daemon-side drift detection and reconciliation logic
async function detectAndReconcileDrift(projectId: string, groveId: string) {
  const localVault = await loadLocalVault(projectId);
  const remoteState = await queryD1State(groveId, projectId);
  const driftAnalysis = analyzeDrift(localVault, remoteState);
  
  if (driftAnalysis.hasDrift) {
    const reconciliationPlan = createReconciliationPlan(driftAnalysis);
    await sendToWorker(groveId, {
      action: 'reconcile_drift',
      plan: reconciliationPlan,
      intelligence_metadata: { drift_type: driftAnalysis.type, confidence_score: driftAnalysis.confidence }
    });
  }
}

// Worker receives and applies reconciliation passively
async function workerReceiveDriftReconciliation(payload: DriftReconciliationPayload) {
  const { plan, intelligence_metadata } = payload;
  await applyReconciliationPlan(plan); // Passive application only
  console.log(`Applied drift reconciliation: ${intelligence_metadata.drift_type}`);
}
```

### Session-Scoped Tool Call Aggregation

**Critical update**: Implement session-scoped metrics with team-sync exclusion patterns:

```typescript
async function aggregateToolCallsForSession(sessionId: string, requestContext: MycoRequestContext) {
  const session = await db.get('SELECT project_id FROM sessions WHERE id = ?', [sessionId]);
  if (session.project_id !== requestContext.projectId) {
    throw new Error('Cross-project tool call aggregation denied');
  }
  
  const toolCalls = await db.all(`
    SELECT tool_name, COUNT(*) as call_count 
    FROM tool_usage_log 
    WHERE session_id = ? AND project_id = ?
    GROUP BY tool_name
  `, [sessionId, requestContext.projectId]);
  
  const metrics = {
    sessionId,
    projectId: requestContext.projectId,
    toolCallCounts: Object.fromEntries(toolCalls.map(tc => [tc.tool_name, tc.call_count])),
    excludeFromTeamSync: true // Always exclude sensitive metrics
  };
  
  await db.run(`
    INSERT INTO session_metrics (session_id, project_id, metrics_data, exclude_team_sync)
    VALUES (?, ?, ?, 1)
  `, [sessionId, requestContext.projectId, JSON.stringify(metrics), 1]);
  
  return metrics;
}
```

### Process Identity Check Before Schema Mutations

**Critical update**: Enforce daemon startup ordering with process identity validation:

```typescript
async function validateProcessIdentityBeforeMutation(operation: string) {
  const daemonStatePath = resolveServiceDaemonStatePath();
  if (!fs.existsSync(daemonStatePath)) {
    throw new Error(`Cannot perform ${operation}: daemon identity not established`);
  }
  
  const daemonState = JSON.parse(fs.readFileSync(daemonStatePath, 'utf8'));
  
  // Verify process is still running
  try {
    process.kill(daemonState.pid, 0);
  } catch (error) {
    throw new Error(`Daemon process ${daemonState.pid} not running - cannot perform schema mutations`);
  }
  
  // Verify startup ordering: minimum uptime required
  const uptimeMs = Date.now() - daemonState.startedAt;
  if (uptimeMs < 5000) {
    throw new Error(`Daemon startup incomplete (uptime: ${uptimeMs}ms) - deferring schema mutations`);
  }
  
  const currentSchemaVersion = await getCurrentSchemaVersion();
  if (daemonState.schemaVersion !== currentSchemaVersion) {
    throw new Error(`Schema version mismatch: daemon=${daemonState.schemaVersion}, current=${currentSchemaVersion}`);
  }
}

// Apply to all schema mutation operations
async function createTable(ddl: string) {
  await validateProcessIdentityBeforeMutation('CREATE TABLE');
  return db.run(ddl);
}
```

## Cross-Cutting Gotchas

**Global Daemon MCP Context**: Post-PR #208, all MCP requests route through the global daemon. Ensure context headers are properly threaded from CLI environment to daemon MCP endpoint to avoid "no project context" errors.

**Context Propagation Gaps**: Always verify context is threaded through new transport paths. Missing context headers cause requests to fail with "no project context" errors.

**Import Journal Consistency**: The import journal must map ALL foreign key relationships. Partial mappings cause referential integrity violations in the target database.

**Project Identity Race Conditions**: Always resolve project identity from `.myco/project.toml` before attempting any scoped operations. Don't cache project identity across requests.

**Schema Version Dependencies**: Multi-tenant features require schema v32+. Check schema version before attempting scoped queries to avoid column not found errors.

**Grove Registry Corruption**: Malformed Grove registry files cause CLI commands to fail silently. Always validate registry structure on load. Use `GROVE_REGISTRY_FILENAME` constant for consistent path resolution.

**CLI-to-Daemon MCP Bridge**: The `myco mcp` command is the bridge point between stdio MCP clients and the global daemon. Context extraction failures here break agent tool access.

**Machine Runtime Path Resolution**: Use machine runtime path primitives (`resolveMachineRuntimeDir`, `resolveMachineRuntimeCommandPath`) for operations requiring machine-local runtime state. Direct path construction bypasses Grove home resolution.

**Registry File Format Drift**: Always use YAML format for Grove registry files to match the `GROVE_REGISTRY_FILENAME` constant. TOML format usage causes parsing errors.

**Development Service Mode Isolation**: Development mode (`SERVICE_DEV_DIRNAME`, port 19344) is isolated from production mode (`SERVICE_DIRNAME`, port 20915). Always use `isDevServiceMode()` to check current mode before path resolution.

**Grove Secret File Permissions Reset**: File permissions on Grove-scoped `.myco/secrets.env` can be reset by git operations. Always verify permissions after deployment.

**Cross-Grove Session Pollution**: Session storage can leak data between Groves if session keys don't include Grove and Project IDs. Always prefix session keys with both identifiers.

**D1 Worker Intelligence Violation**: The worker must remain a passive receiver for all D1 operations. Implementing analysis or decision-making in the worker violates the daemon-side intelligence principle and creates architectural inconsistencies.

**Tool Call Metrics Team Sync Leakage**: Session-scoped tool call aggregation metrics contain sensitive usage patterns and must be excluded from team sync. Always set `exclude_team_sync: true` for tool usage metrics to prevent cross-project data leakage.

**Schema Mutation Without Process Identity**: Performing database schema mutations without daemon process identity validation creates race conditions. Always validate daemon PID, uptime, and schema version before any CREATE TABLE, ALTER TABLE, or DROP TABLE operations.
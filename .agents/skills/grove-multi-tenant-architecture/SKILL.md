---
name: myco:grove-multi-tenant-architecture
description: Comprehensive procedures for implementing and managing Myco's Grove multi-tenant architecture with request context management. Covers request context threading through transport boundaries, project identity binding via .myco/project.toml, multi-tenant database schema design, context enforcement across six layers, MCP transport unification, Grove registry management, and comprehensive importer architecture. Use when implementing multi-tenant features, setting up Grove projects, debugging context propagation issues, or ensuring request context isolation.
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

## Procedure B: Project Identity Binding via .myco/project.toml and Config Resolution

Establish project identity layer with Grove binding metadata and understand config scope inheritance.

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

### loadMergedConfig Auto-Resolution from Project Manifest

**Critical update**: `loadMergedConfig()` automatically resolves Grove identity from the current project's `.myco/project.toml`, eliminating the need for explicit Grove parameter passing at call sites.

**Old pattern:**
```typescript
// Caller had to explicitly provide Grove context
const groveId = resolveGroveIdFromEnvironment();
const config = await loadMergedConfig(projectPath, { groveId });
```

**New pattern:**
```typescript
// loadMergedConfig auto-resolves Grove from project.toml binding_id
const config = await loadMergedConfig(projectPath);
```

**Three call-site rethreading** impact:
- CLI bootstrap in `packages/myco/src/cli/tool.ts` — removed explicit Grove resolution
- Config API handler in `packages/myco/src/daemon/api/config.ts` — simplified Grove discovery

**Migration**: If you have existing code that explicitly passes Grove context to `loadMergedConfig()`, remove the explicit `{ groveId }` parameter. The function now resolves it from the project manifest.

### Embedding and Agent Configuration Fields Now Grove-Scoped

**Critical scope boundary change**: Embedding and agent configuration fields have been promoted from project-scoped to Grove-scoped. These settings control system-wide behavior uniform across all projects in a Grove; individual project overrides are no longer supported.

**Automatic migration**: Running `myco update` automatically lifts these fields to Grove tier. After migration, settings are read from Grove config and apply uniformly to all projects. If you need per-project overrides, coordinate through Grove configuration.

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

### Graceful-Empty vs Fail-Loud Helper Pattern

Choose the right project-ID helper based on whether the route requires a bound project:

- **`rowProjectIdFromRequestContext(context)`** — returns `null` when no project is bound; safe for dual-mode endpoints where project context is optional (e.g., observability tools that degrade gracefully without a project).
- **`requireProjectId(context, label)`** — throws with a descriptive label if no project is bound; use when a missing project would produce corrupt or misrouted data (e.g., saving plans, cortex lookups, strict tenant CRUD).

The label argument appears in error messages, so make it descriptive. Never use `rowProjectIdFromRequestContext` on strict tenant CRUD — a null project_id silently writes daemon-anchor rows instead of failing loudly.

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

### Grove-Ownership and Migration Walker Safety

When implementing project migration, bulk deletion, or Grove-wide operations, be aware of scope filtering requirements in `packages/myco/src/grove/migration-walker.ts`. The migration walker traverses ALL Groves by default unless explicitly filtered by `currentDaemonVariant` served_by constraints. Always validate the daemon's served_by scope before executing walkers.

### myco remove --purge Blast Radius

The `myco remove --purge` command performs a registered-project walk that affects ALL projects served by the current daemon variant, then deletes `~/.myco/` itself — it is the machine-wide teardown and prompts for confirmation (`--yes` to skip). There is no partial scope flag: to limit removal to one project, use `myco remove --project <root>` (add `--remove-vault` to also delete that project's `.myco/`).

## Procedure G: Security and Authorization Patterns

Implement security enforcement across Grove multi-tenant architecture.

### Tenancy Authority — The Single Sanctioned Resolver

`packages/myco/src/grove/project-tenancy.ts` is THE authority for answering "what grove/team owns this project." Never inline project-to-grove resolution ad hoc; always go through this module. Key exports:

- **`resolveProjectTenancy(projectId)`** — returns `{ project, grove, team }`. Throws `ProjectGroveMissingError` if the project has no resolvable grove.
- **`memberProjectIdsForGrove(groveId)`** — returns the project IDs that are team members in a given grove. Use this (not `machineHasAnyTeam()`) for per-grove team-sync scope decisions.
- **`machineHasAnyTeam()`** — machine-level boolean: has this machine joined ANY team at all. Use only for machine-level routing, never for per-project membership gating.
- **`assertAssignableProject(projectId)`** — use at team-assignment write boundaries to confirm the project has a valid grove before writing membership.
- **`ProjectGroveMissingError`** — every project belongs to exactly one grove. A grove-less project is a loud failure, never a silent "global" fallback.

**Why this matters:** Bypassing this module and using `machineHasAnyTeam()` for per-project outbox scoping can flood a non-member grove with phantom `team_outbox` rows. The authority centralizes the grove-membership check so there is only one place to get it wrong.

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

## Procedure H: D1 Drift Reconciler Architecture and Daemon-Side Intelligence

**Critical update**: Implement daemon-side intelligence vs worker passive receiver principles.

### Daemon-Side Intelligence Principle

The daemon performs all intelligence operations (drift detection, reconciliation planning) while the worker acts as a passive data receiver that applies plans. Implementing analysis or decision-making in the worker violates this principle and creates architectural inconsistencies.

### Session-Scoped Tool Call Aggregation

Session-scoped tool call aggregation metrics contain sensitive usage patterns and must be excluded from team sync. Always set `exclude_team_sync: true` for tool usage metrics to prevent cross-project data leakage.

### Process Identity Check Before Schema Mutations

Validate daemon PID, uptime, and schema version before any CREATE TABLE, ALTER TABLE, or DROP TABLE operations. Performing schema mutations without process identity validation creates race conditions during daemon startup.

## Cross-Cutting Gotchas

**Global Daemon MCP Context**: All MCP requests route through the global daemon. Ensure context headers are properly threaded from CLI environment to daemon MCP endpoint to avoid "no project context" errors.

**Context Propagation Gaps**: Always verify context is threaded through new transport paths. Missing context headers cause requests to fail with "no project context" errors.

**Import Journal Consistency**: The import journal must map ALL foreign key relationships. Partial mappings cause referential integrity violations in the target database.

**Project Identity Race Conditions**: Always resolve project identity from `.myco/project.toml` before attempting any scoped operations. Don't cache project identity across requests.

**Schema Version Dependencies**: Multi-tenant features require schema v32+. Check schema version before attempting scoped queries to avoid column not found errors.

**Grove Registry Corruption**: Malformed Grove registry files cause CLI commands to fail silently. Always validate registry structure on load. Use `GROVE_REGISTRY_FILENAME` constant for consistent path resolution.

**CLI-to-Daemon MCP Bridge**: The `myco mcp` command is the bridge point between stdio MCP clients and the global daemon. Context extraction failures here break agent tool access.

**Machine Runtime Path Resolution**: Use machine runtime path primitives (`resolveMachineRuntimeDir`, `resolveMachineRuntimeCommandPath`) for operations requiring machine-local runtime state. Direct path construction bypasses Grove home resolution.

**Development Service Mode Isolation**: Development mode (`SERVICE_DEV_DIRNAME`, port 19344) is isolated from production mode (`SERVICE_DIRNAME`, port 20915). Always use `isDevServiceMode()` to check current mode before path resolution.

**Cross-Grove Session Pollution**: Session storage can leak data between Groves if session keys don't include Grove and Project IDs. Always prefix session keys with both identifiers.

**D1 Worker Intelligence Violation**: The worker must remain a passive receiver for all D1 operations. Implementing analysis or decision-making in the worker violates the daemon-side intelligence principle and creates architectural inconsistencies.

**loadMergedConfig Grove Auto-Resolution**: `loadMergedConfig()` automatically resolves Grove from project manifest. If you receive "Grove not found" errors, check that `.myco/project.toml` contains a valid `grove.binding_id` field. Do not pass explicit Grove context to `loadMergedConfig()` — the function ignores it.

**Migration Walker Grove Filtering**: The migration walker in `packages/myco/src/grove/migration-walker.ts` traverses ALL Groves unless explicitly scoped by `currentDaemonVariant` served_by constraints. Always validate the daemon's served_by scope before executing walkers.

**Capture ignore list is machine-scoped only**: The machine-scoped capture ignore list (checked by `isProjectRootIgnored` in `packages/myco/src/hooks/vault-gate.ts`) silently bypasses projects at the vault gate — no error, no telemetry. There is no per-project or per-Grove override; the machine config setting applies globally.

**Capability architecture uses a single fail-closed predicate**: `capabilityEnabled(config, capId)` in `packages/myco/src/config/capabilities.ts` is the sole gate for all capability checks — do NOT add per-subsystem runtime gate-checks in handlers. Unloadable config returns `false` (fail-closed). The `CAPABILITIES` map owns which config leaf controls each capability and which scheduled tasks are governed. Add new capabilities there, not inline in handlers.

**Capture-only mode has hidden active subsystems**: Disabling most capabilities still leaves title-summary, embedding-reconcile, and canopy-inject running in the background. These subsystems consume LLM credits and CPU even when the project appears to be in passive capture-only mode. Budget accordingly and audit which capabilities are truly gated before assuming quiet operation.

**Phantom project_id at daemon bootstrap**: The daemon bootstraps with a phantom vault before any project is registered (`packages/myco/src/daemon/main.ts` greenfield mode). Rows with `project_id IS NULL` belong to this daemon anchor exclusively — they are NOT legacy rows. `buildVaultFallbackOrGlobal` in `packages/myco/src/grove/request-context.ts` returns the daemon-global context when no project is bound; the strict `buildVaultFallback` variant throws. Use the global variant only in routes where an unbound daemon context is explicitly valid.

**Machine-level routes use action-scope, not tenantRoute**: Routes that operate across all Groves (backup, database vacuum, global dispatch) use `actionScopeKey` from `packages/myco/src/daemon/api/action-scope.ts` for deduplication, not `tenantRoute`. Using `tenantRoute` on machine-level routes fails with missing-project errors on callers that legitimately have no project context. The scoped-dispatch module (`packages/myco/src/daemon/api/scoped-dispatch.ts`) enforces the all-groves confirmation gate automatically.

**Capture-only config materialization bug**: A prior bug caused `saveConfig` to write machine-scoped defaults into the committed project config tier when called from capture-only mode; the vault-gate hot path also bypassed the archived-project refusal check. If a project stuck in capture-only mode shows unexpected config entries, check for materialized defaults from this regression. Fix: call `saveConfig` only after verifying the project is not in archived/capture-only state.

**Never bypass the tenancy authority for per-project team decisions**: `machineHasAnyTeam()` in `packages/myco/src/grove/project-tenancy.ts` answers "has this machine joined ANY team" — it is NOT a per-project gate. Using it for per-project outbox scoping can flood a non-member grove with phantom rows. Always use `memberProjectIdsForGrove(groveId)` to determine which projects in a grove are actually team members, and `resolveProjectTenancy(projectId)` to determine a specific project's grove and team context.

**Team Sync v10 two-registry split — the team registry is NOT the placement authority**: Two distinct registries govern two distinct scopes. The team registry (at `<MYCO_HOME>/teams/<team>/`) is the authority for team identity and project-to-team membership by project_id only — it does NOT determine which grove a project is locally registered in. The grove-projects placement registry (at `<MYCO_HOME>/groves/<grove>/`, managed by the tenancy authority module — see Procedure G) is authoritative for which projects belong to which grove locally. The `grove_id` stored in team configuration is a portability hint only; it was treated as authoritative in v9, causing phantom badge counts and incorrect cross-Grove routing. In v10+, the tenancy authority always consults the current MYCO_HOME Grove registry (not the team config's `grove_id`) — reconcile is a no-op for any project not registered in the current home. In code comments, use "current MYCO_HOME Grove registry" (not "dev/prod coexistence") when describing this scope boundary.

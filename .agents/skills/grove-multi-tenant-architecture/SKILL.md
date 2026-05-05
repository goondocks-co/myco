---
name: myco:grove-multi-tenant-architecture
description: |
  Comprehensive procedures for implementing and managing Myco's Grove multi-tenant architecture with request context management. Covers request context threading through transport boundaries, project identity binding via .myco/project.toml, multi-tenant database schema design, context enforcement across six layers, MCP transport unification, Grove registry management, and comprehensive importer architecture. Use when implementing multi-tenant features, setting up Grove projects, debugging context propagation issues, or ensuring request context isolation.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Grove Multi-Tenant Architecture and Request Context Management

Comprehensive guide for implementing Myco's Grove multi-tenant architecture, covering request context threading, project identity management, schema design, and transport unification. Use this when setting up new Grove projects, implementing multi-tenant features, or debugging context isolation issues.

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

**CLI Transport (`packages/myco/src/cli/tool.ts`)**:
Extract from environment variables and daemon client:
```typescript
import { requestContextFromEnvironment } from '@myco/tools/request-context.js';

const requestContext = requestContextFromEnvironment(process.env, vaultDir);
const tools = createMycoTools(vaultDir, new DaemonClient(vaultDir), { requestContext });
```

**MCP Stdio Bridge (via `myco mcp`)**:
Context propagated through CLI command to daemon:
```typescript
// Context passed from CLI environment to MCP bridge
const requestContext = requestContextFromEnvironment(process.env, vaultDir);
const headers = requestContextHeaders(requestContext);

// MCP bridge connects to global daemon with context headers
const mcpResponse = await daemonClient.mcp(headers);
```

### Tool Factory Integration

Thread context through `packages/myco/src/tools/index.ts` factory:
```typescript
export function createMycoTools(vaultDir: string, client: DaemonClient, options: MycoToolsOptions = {}): MycoTools {
  const requestContext = options.requestContext ?? resolveLegacyRequestContext(vaultDir);

  // All tools receive scoped context
  // Enforces project_id isolation at tool level
}
```

### Global Daemon Context Wiring

Ensure context propagation in global daemon calls:
```typescript
// All daemon client calls include context headers
const response = await fetch('/api/endpoint', {
  headers: requestContextHeaders(requestContext)
})
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
import { PROJECT_MANIFEST_FILENAME, resolveProjectVaultDir } from '../grove/paths.js';

function resolveProjectIdentity(workingDir: string) {
  const projectToml = path.join(workingDir, '.myco', PROJECT_MANIFEST_FILENAME);
  if (!fs.existsSync(projectToml)) {
    throw new Error('No project identity found - run myco init');
  }

  const config = parseToml(fs.readFileSync(projectToml, 'utf8'));
  return {
    projectId: config.project.id,
    groveBinding: config.grove.binding_id
  };
}
```

### CLI Integration

Support project creation and Grove binding via `packages/myco/src/cli/init.ts`:
```typescript
import { resolveGrove, registerProjectInGrove } from '../grove/registry.js';

// Initialize new project with Grove binding
const groveRef = parseStringFlag(args, '--grove');
const grove = resolveGrove(groveRef ?? existingProjectManifest?.grove?.slug);

registerProjectInGrove(grove.id, {
  groveSlug: grove.slug,
  groveBindingId: existingProjectManifest?.grove?.binding_id,
});
```

CLI commands:
```bash
# Initialize new project with Grove binding
myco init --project "my-project" --grove "grove-production"

# List available Groves
myco grove list

# Switch Grove binding
myco grove use "grove-staging"
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

CREATE TABLE prompt_batches (
    id                     TEXT PRIMARY KEY,
    session_id             TEXT NOT NULL,
    project_id             TEXT,
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
// During import operations
await db.run(`
  INSERT INTO sessions (id, project_id, embedded, ...)
  VALUES (?, ?, 0, ...)
`, [sessionId, targetProjectId, ...])
```

### Comprehensive Importer Architecture

Implement four-slice design with validated journal mappings in `packages/myco/src/grove/importer.ts`:

**Slice 1: Core Rows**
```typescript
async function importCoreRows(sourceDb: Database, targetDb: Database, projectId: string) {
  const journal = new ImportJournal();

  // Import sessions with project scoping
  const sessions = await sourceDb.all('SELECT * FROM sessions');
  for (const session of sessions) {
    const newId = generateId();
    journal.mapSession(session.id, newId);

    await targetDb.run(`
      INSERT INTO sessions (id, project_id, title, summary, ...)
      VALUES (?, ?, ?, ?, ...)
    `, [newId, projectId, session.title, session.summary, ...]);
  }
}
```

**Slice 2: Attachments/Artifacts**
```typescript
async function importAttachments(journal: ImportJournal, targetDb: Database) {
  // Import with journal-mapped foreign keys
  for (const [oldSessionId, newSessionId] of journal.sessionMappings) {
    // Import attachments with remapped session references
  }
}
```

**Slice 3: Semantic State**
```typescript
async function importSemanticState(journal: ImportJournal, targetDb: Database) {
  // Import embeddings and semantic relationships
  // Maintain consistency with remapped IDs
}
```

**Slice 4: Spores/Lineage**
```typescript
async function importSporesAndLineage(journal: ImportJournal, targetDb: Database) {
  // Import observations with lineage preservation
  // Use journal mappings for all foreign key references
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
      // Only return sessions for requestContext.projectId
      return db.all('SELECT * FROM sessions WHERE project_id = ?', [requestContext.projectId]);
    }
  };
}
```

### Layer 2: Daemon Read Filtering

Filter all daemon reads by project_id:
```typescript
class DaemonQueryService {
  async getSessions(projectId: string) {
    // All queries include project_id filter
    return this.db.all('SELECT * FROM sessions WHERE project_id = ?', [projectId]);
  }
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

  // Proceed with scoped write
  await db.run('INSERT INTO spores (..., project_id) VALUES (..., ?)', [...data, expectedProjectId]);
}
```

### Layer 4: Hook Transport Context

Send context headers from all hook transports:
```typescript
// In hook implementations
const headers = {
  'x-grove-id': process.env.MYCO_GROVE_ID,
  'x-project-id': process.env.MYCO_PROJECT_ID,
  'x-machine-id': process.env.MYCO_MACHINE_ID
};
```

### Layer 5: Transport Parity Verification

Ensure consistent context handling across transports:
```typescript
function verifyTransportParity(requestContext1: MycoRequestContext, requestContext2: MycoRequestContext) {
  if (requestContext1.projectId !== requestContext2.projectId) {
    throw new Error('Transport context mismatch');
  }
}
```

### Layer 6: Agent Runtime Scoping

Scope agent runtime across digest/cortex/instructions/tools:
```typescript
class AgentRuntime {
  constructor(private requestContext: MycoRequestContext) {}

  async runDigestTask() {
    // All agent operations scoped to requestContext.projectId
    const tools = createMycoTools(vaultDir, client, { requestContext: this.requestContext });
    // ... digest logic
  }
}
```

## Procedure E: MCP Transport Unification and Parity

Implement unified MCP architecture with global daemon and CLI fallback.

### Global Daemon MCP Endpoint

The MCP endpoint is served by the global daemon at `/mcp`:
```typescript
// Global daemon serves MCP protocol
app.post('/mcp', async (req, res) => {
  // Process MCP requests with context headers
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
// packages/myco/src/mcp/stdio-bridge.ts
export async function main() {
  const vaultDir = resolveProjectVaultDir(process.cwd());
  const requestContext = requestContextFromEnvironment(process.env, vaultDir);

  // Connect to global daemon MCP endpoint with context headers
  const headers = requestContextHeaders(requestContext);
  const daemonClient = new DaemonClient(vaultDir);
  await daemonClient.bridgeStdioToMcp(headers);
}
```

### Transport-Agnostic Tool Definitions

Define tools once in `packages/myco/src/tools/index.ts`, use across transports:
```typescript
const toolDefinitions = {
  vault_sessions: {
    schema: { /* JSON schema */ },
    implementation: async (params, requestContext) => {
      // Single implementation for all transports
    }
  }
};
```

### Parity Gate Enforcement

Verify consistent behavior across CLI and MCP transports:
```typescript
class TransportParityGate {
  async verifyToolBehavior(toolName: string, params: any, expectedContext: MycoRequestContext) {
    // Test both CLI and MCP paths return identical results
    const cliResult = await this.executeViaCli(toolName, params);
    const mcpResult = await this.executeViaMcp(toolName, params, expectedContext);

    if (!deepEqual(cliResult, mcpResult)) {
      throw new Error(`Transport parity violation for ${toolName}`);
    }
  }
}
```

## Procedure F: Grove Registry Management and Home Path Primitives

Implement standardized Grove paths and registry management.

### Grove Home Primitives

Use Grove path constants from `packages/myco/src/grove/paths.ts`:
```typescript
export const MYCO_HOME_ENV = 'MYCO_HOME';
export const GROVES_DIRNAME = 'groves';
export const GROVE_METADATA_FILENAME = 'grove.toml';
export const GROVE_CONFIG_FILENAME = 'grove.yaml';
export const GROVE_PROJECTS_FILENAME = 'projects.toml';
export const GROVE_ROOTS_FILENAME = 'roots.toml';

// Resolve Grove directories
const groveHome = resolveMycoHome();
const grovesDir = resolveGrovesDir(groveHome);
const groveDir = resolveGroveDir(groveId, groveHome);
```

### Grove Registry Structure

Maintain Grove metadata in `grove.toml` files:
```toml
[grove]
id = "grove_abc123"
name = "production"
endpoint = "https://grove.myco.dev"
status = "active"

[projects]
# Project bindings managed in projects.toml
```

### CLI Surface Implementation

Use Grove registry functions from `packages/myco/src/grove/registry.ts`:
```typescript
import { resolveGrove, findRegisteredProjectByBinding, registerProjectInGrove } from '../grove/registry.js';

// Grove Discovery
async function listGroves() {
  // Implementation in registry.ts
  const groves = await loadAvailableGroves();
  return groves.map(g => ({
    id: g.id,
    name: g.name,
    endpoint: g.endpoint,
    status: g.status
  }));
}

// Grove Selection
async function useGrove(nameOrId: string) {
  const grove = resolveGrove(nameOrId);
  // Update default Grove binding
}
```

**CLI commands**:
```bash
# List available Groves
myco grove list

# Create new Grove
myco grove create --name "development" --endpoint "https://grove-dev.myco.dev"

# Switch Grove binding
myco grove use "development"

# Project initialization with Grove binding
myco init --project "my-project" --grove "production"
```

### Grove Discovery Logic

Implement Grove resolution:
```typescript
async function resolveGrove(nameOrId?: string): Promise<GroveRecord> {
  const availableGroves = await loadAvailableGroves();

  if (!nameOrId) {
    // Use default Grove from current project or global config
    const defaultGrove = await getDefaultGrove();
    if (!defaultGrove) throw new Error('No default Grove configured');
    return defaultGrove;
  }

  // Find by name or ID
  const grove = availableGroves.find(g => g.name === nameOrId || g.id === nameOrId);
  if (!grove) throw new Error(`Grove not found: ${nameOrId}`);

  return grove;
}
```

## Cross-Cutting Gotchas

**Global Daemon MCP Context**: Post-PR #208, all MCP requests route through the global daemon. Ensure context headers are properly threaded from CLI environment to daemon MCP endpoint to avoid "no project context" errors.

**Context Propagation Gaps**: Always verify context is threaded through new transport paths. Missing context headers cause requests to fail with "no project context" errors.

**Import Journal Consistency**: The import journal must map ALL foreign key relationships. Partial mappings cause referential integrity violations in the target database.

**Project Identity Race Conditions**: Always resolve project identity from `.myco/project.toml` before attempting any scoped operations. Don't cache project identity across requests.

**Schema Version Dependencies**: Multi-tenant features require schema v32+. Check schema version before attempting scoped queries to avoid column not found errors.

**Transport Parity Testing**: When adding new tools or modifying context handling, test both HTTP MCP and CLI transports to ensure consistent behavior with the global daemon architecture.

**Grove Registry Corruption**: Malformed Grove registry files cause CLI commands to fail silently. Always validate registry structure on load and provide helpful error messages.

**CLI-to-Daemon MCP Bridge**: The `myco mcp` command is the bridge point between stdio MCP clients and the global daemon. Any context extraction failures here break agent tool access.
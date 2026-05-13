---
name: myco:grove-multi-tenant-architecture
description: |
  Comprehensive procedures for implementing and managing Myco's Grove multi-tenant architecture with request context management. Covers request context threading through transport boundaries, project identity binding via .myco/project.toml, multi-tenant database schema design, context enforcement across six layers, MCP transport unification, Grove registry management, and comprehensive importer architecture. Use when implementing multi-tenant features, setting up Grove projects, debugging context propagation issues, or ensuring request context isolation.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Grove Multi-Tenant Architecture and Request Context Management

Comprehensive guide for implementing Myco's Grove multi-tenant architecture, covering request context threading, project identity management, schema design, transport unification, and security patterns. Use this when setting up new Grove projects, implementing multi-tenant features, or debugging context isolation issues.

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
```typescript
import { requestContextFromEnvironment } from '@myco/tools/request-context.js';

const requestContext = requestContextFromEnvironment(process.env, vaultDir);
const tools = createMycoTools(vaultDir, new DaemonClient(vaultDir), { requestContext });
```

**MCP Stdio Bridge (via `myco mcp`)**:
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

# Grove-only installation (no local vault)
myco init --grove-only --grove "grove-production"
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

## Procedure F: Grove Registry Management and Home Path Primitives

Implement standardized Grove paths and registry management with comprehensive machine runtime support and development service mode coordination.

### Grove Home and Machine Runtime Primitives

Use Grove path constants from `packages/myco/src/grove/paths.ts`:
```typescript
export const MYCO_HOME_ENV = 'MYCO_HOME';
export const GROVES_DIRNAME = 'groves';
export const GROVE_METADATA_FILENAME = 'grove.toml';
export const GROVE_CONFIG_FILENAME = 'grove.toml';  // Standardized to TOML
export const GROVE_PROJECTS_FILENAME = 'projects.toml';
export const GROVE_ROOTS_FILENAME = 'roots.toml';
export const GROVE_REGISTRY_DIRNAME = 'registry';
export const GROVE_REGISTRY_FILENAME = 'registry.toml';
export const DAEMON_STATE_FILENAME = 'daemon.json';
export const SERVICE_DIRNAME = 'service';
export const SERVICE_DEV_DIRNAME = 'service-dev';
export const PROJECT_LOCAL_MANIFEST_FILENAME = 'project.toml';

// Resolve Grove directories and service paths
const groveHome = resolveMycoHome();
const grovesDir = resolveGrovesDir(groveHome);
const groveDir = resolveGroveDir(groveId, groveHome);
const groveRegistryPath = resolveGroveRegistryPath(groveHome);
const daemonStatePath = resolveServiceDaemonStatePath();

// Machine runtime path resolution for runtime state management
const runtimeDir = resolveMachineRuntimeDir(groveHome);
const runtimeTmpDir = resolveMachineRuntimeTmpDir(groveHome);
const runtimeCommandPath = resolveMachineRuntimeCommandPath(groveHome, commandName);
```

### Development Service Mode Management

Use development service mode primitives for distinguishing between production and development daemon environments:
```typescript
import { SERVICE_DEV_DIRNAME, isDevServiceMode, pathsEquivalent, setDevServiceMode } from '../grove/paths.js';

// Check current service mode
function checkServiceMode(): boolean {
  return isDevServiceMode();
}

// Switch to development mode (service-dev/, port 19344)
function enableDevMode() {
  setDevServiceMode(true);
  console.log(`Switched to development service mode (${SERVICE_DEV_DIRNAME})`);
}

// Switch to production mode (service/, port 20915)
function enableProdMode() {
  setDevServiceMode(false);
  console.log('Switched to production service mode');
}

// Path equivalence validation across service modes
function validateServicePaths(path1: string, path2: string): boolean {
  return pathsEquivalent(path1, path2);
}
```

### Daemon Service Boundary Architecture

Implement service boundary management with development and production daemon coordination:

1. **Service directory resolution**:
```typescript
import { resolveServiceDir, resolveServiceDirName } from '../grove/paths.js';

// Resolve service directory based on current mode
const serviceDir = resolveServiceDir(groveHome);
const serviceDirName = resolveServiceDirName(); // 'service' or 'service-dev'

// Service-aware daemon state management
const daemonStatePath = resolveServiceDaemonStatePath();
```

2. **Service mode coordination**:
```typescript
// Development service boundary (port 19344, service-dev/)
if (isDevServiceMode()) {
  const devServiceDir = path.join(groveHome, SERVICE_DEV_DIRNAME);
  const devPort = 19344;
  const devDaemonState = path.join(devServiceDir, DAEMON_STATE_FILENAME);
}

// Production service boundary (port 20915, service/)
else {
  const prodServiceDir = path.join(groveHome, SERVICE_DIRNAME);
  const prodPort = 20915;
  const prodDaemonState = path.join(prodServiceDir, DAEMON_STATE_FILENAME);
}
```

**Service boundary isolation patterns**:
- **Port isolation**: Dev (19344) vs prod (20915) ports prevent conflicts
- **State isolation**: Separate daemon.json files per service mode
- **Path isolation**: service-dev/ vs service/ directories for complete separation
- **Mode switching**: setDevServiceMode() for runtime mode changes
- **Equivalence checking**: pathsEquivalent() for cross-mode path validation

### Grove Registry Structure

Maintain Grove metadata in `grove.toml` files and centralized registry using `GROVE_REGISTRY_FILENAME`:
```toml
# Individual grove.toml (GROVE_METADATA_FILENAME)
[grove]
id = "grove_abc123"
name = "production"
endpoint = "https://grove.myco.dev"
status = "active"

[projects]
# Project bindings managed in projects.toml
```

Registry structure in `registry.toml` (GROVE_REGISTRY_FILENAME):
```toml
[registry]
version = "1.0"

[[groves]]
id = "grove_abc123"
name = "production"
endpoint = "https://grove.myco.dev"
status = "active"
created_at = "2026-05-01T12:00:00Z"
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

// Grove Selection with machine runtime path support
async function useGrove(nameOrId: string) {
  const grove = resolveGrove(nameOrId);
  
  // Setup machine runtime for Grove operations
  const groveHome = resolveMycoHome();
  await setupMachineRuntime(groveHome);
  
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

# Grove-only installation (no local daemon)
myco init --grove-only --grove "production"

# Development mode commands
myco dev-mode enable   # Switch to service-dev/
myco dev-mode disable  # Switch to service/
myco dev-mode status   # Check current mode
```

## Procedure G: Security and Authorization Patterns

Implement security enforcement across Grove multi-tenant architecture with proper authentication, authorization, and tenant isolation.

### Multi-Tenant Request Context Validation

Secure authentication header processing and Grove ID validation:

```javascript
// Extract x-myco-* headers with strict validation for Grove context
const groveId = req.headers['x-myco-grove-id'];
const projectId = req.headers['x-myco-project-id'];
const bearerToken = req.headers['authorization']?.replace('Bearer ', '');

if (!groveId || !projectId || !bearerToken) {
  return res.status(401).json({ error: 'Missing authentication headers' });
}

// Validate Grove ID format (prevent injection)
if (!/^grove_[0-9a-f]{32}$/.test(groveId)) {
  return res.status(400).json({ error: 'Invalid Grove ID format' });
}

// Validate project ID format
if (!/^proj_[0-9a-f]{32}$/.test(projectId)) {
  return res.status(400).json({ error: 'Invalid Project ID format' });
}

// Create isolated request context with Grove and project scope
const requestContext = {
  groveId,
  projectId,
  userId: null,  // Set after token validation
  permissions: [],
  isolationLevel: 'grove',
  binding: null  // Set after Grove binding validation
};
```

### File Permission Hardening

Secure Grove-scoped configuration files with proper permissions:

```bash
# Set restrictive permissions on Grove project secrets file
chmod 0o600 .myco/secrets.env

# Verify permissions across all projects in Grove
find ~/.myco/groves/grove_*/projects/*/.myco/ -name "secrets.env" -exec ls -la {} \;
```

Update gitignore patterns for Grove-sensitive files:
```gitignore
# Add to .gitignore for Grove multi-project architecture
.myco/secrets.env
.myco/vault.db
.myco/vault.db-*
.myco/grove.toml
~/.myco/groves/
*.pem
*.key
auth-tokens.json
grove-binding.json
```

### Grove Isolation Boundary Enforcement

Ensure proper tenant isolation and prevent cross-Grove data access:

```javascript
// Prefix database queries with Grove and Project ID
async function getGroveProjectData(groveId, projectId, resourceId) {
  // Always scope queries to the requesting Grove and project
  const query = `
    SELECT * FROM resources 
    WHERE grove_id = ? AND project_id = ? AND resource_id = ?
  `;
  return db.query(query, [groveId, projectId, resourceId]);
}

// Check if operation crosses Grove or project boundaries
function validateGroveProjectAccess(requestGrove, requestProject, targetGrove, targetProject) {
  if (requestGrove !== targetGrove) {
    throw new Error(`Cross-Grove access denied: ${requestGrove} -> ${targetGrove}`);
  }
  if (requestProject !== targetProject) {
    throw new Error(`Cross-project access denied: ${requestProject} -> ${targetProject}`);
  }
}
```

### Path Validation for Filesystem Operations

Prevent directory traversal within Grove project boundaries:

```javascript
function sanitizeGrovePath(userPath, groveId, projectId) {
  // Get Grove project base directory
  const groveProjectRoot = getGroveProjectPath(groveId, projectId);
  
  // Resolve relative paths and check Grove boundaries
  const resolvedPath = path.resolve(groveProjectRoot, userPath);
  const normalizedBase = path.resolve(groveProjectRoot);
  
  // Ensure resolved path is within Grove project directory
  if (!resolvedPath.startsWith(normalizedBase + path.sep)) {
    throw new Error('Grove path traversal attempt detected');
  }
  
  return resolvedPath;
}
```

### Timing-Safe Authentication Comparisons

Implement constant-time comparisons to prevent timing oracle attacks:

```javascript
const crypto = require('crypto');

function timingSafeEqual(a, b) {
  // Ensure strings are same length (pad if necessary)
  const maxLength = Math.max(a.length, b.length);
  const normalizedA = a.padEnd(maxLength, '\0');
  const normalizedB = b.padEnd(maxLength, '\0');
  
  // Use Node.js built-in timing-safe comparison
  return crypto.timingSafeEqual(
    Buffer.from(normalizedA, 'utf8'),
    Buffer.from(normalizedB, 'utf8')
  );
}

async function validateGroveBearerToken(providedToken, groveId, projectId) {
  // Get expected token for Grove/project combination
  const expectedToken = await getGroveProjectToken(groveId, projectId);
  
  // Always perform full validation even if obviously invalid
  const isValid = timingSafeEqual(providedToken || '', expectedToken);
  
  // Add consistent delay to prevent timing analysis
  const minDelay = 10; // milliseconds
  await new Promise(resolve => setTimeout(resolve, minDelay));
  
  return isValid;
}
```

## Cross-Cutting Gotchas

**Global Daemon MCP Context**: Post-PR #208, all MCP requests route through the global daemon. Ensure context headers are properly threaded from CLI environment to daemon MCP endpoint to avoid "no project context" errors.

**Context Propagation Gaps**: Always verify context is threaded through new transport paths. Missing context headers cause requests to fail with "no project context" errors.

**Import Journal Consistency**: The import journal must map ALL foreign key relationships. Partial mappings cause referential integrity violations in the target database.

**Project Identity Race Conditions**: Always resolve project identity from `.myco/project.toml` before attempting any scoped operations. Don't cache project identity across requests.

**Schema Version Dependencies**: Multi-tenant features require schema v32+. Check schema version before attempting scoped queries to avoid column not found errors.

**Transport Parity Testing**: When adding new tools or modifying context handling, test both HTTP MCP and CLI transports to ensure consistent behavior with the global daemon architecture.

**Grove Registry Corruption**: Malformed Grove registry files cause CLI commands to fail silently. Always validate registry structure on load and provide helpful error messages. Use `GROVE_REGISTRY_FILENAME` constant for consistent path resolution.

**CLI-to-Daemon MCP Bridge**: The `myco mcp` command is the bridge point between stdio MCP clients and the global daemon. Any context extraction failures here break agent tool access.

**Grove-Only Mode State Management**: When running in Grove-only mode (no local daemon), ensure all state paths resolve correctly using `resolveServiceDaemonStatePath()` to prevent file not found errors during UI initialization.

**Machine Runtime Path Resolution**: Use machine runtime path primitives (`resolveMachineRuntimeDir`, `resolveMachineRuntimeCommandPath`, `resolveMachineRuntimeTmpDir`) for any operations requiring machine-local runtime state. Direct path construction bypasses Grove home resolution and causes path inconsistencies across environments.

**Registry File Format Drift**: Always use TOML format for Grove registry files (`registry.toml`, `grove.toml`, `projects.toml`). YAML format usage in Grove contexts causes parsing errors and registry corruption.

**Development Service Mode Isolation**: The development service mode (`SERVICE_DEV_DIRNAME`, port 19344) is isolated from production service mode (`SERVICE_DIRNAME`, port 20915). Always use `isDevServiceMode()` to check current mode before path resolution. Hardcoded service directory references bypass mode switching and cause service discovery failures.

**Path Equivalence in Multi-Mode Environments**: Use `pathsEquivalent()` for path comparisons across development and production service modes. String equality comparisons fail when paths reference different service directories that resolve to the same logical location.

**Service Boundary Confusion**: Service directory resolution (`resolveServiceDir`) must account for current service mode. Direct path construction to 'service/' bypasses development mode and causes daemon state file conflicts.

**Grove Secret File Permissions Reset**: File permissions on Grove-scoped `.myco/secrets.env` can be reset by git operations or deployment scripts. Always verify permissions after deployment and include Grove-scoped permission checks in startup validation.

**Grove ID Case Sensitivity**: Grove IDs are case-sensitive in the database but may be normalized differently in headers. Always use consistent casing (lowercase) and validate format before database operations across all Grove contexts.

**Path Traversal in Grove Project Imports**: Node.js `require()` statements with relative paths can be exploited for directory traversal across Grove boundaries. Use absolute paths or validated relative paths for dynamic imports within Grove projects.

**Timing Attack via Grove Error Messages**: Different error messages for "Grove not found" vs "invalid Grove token" can leak timing information. Use generic error messages and consistent processing times for all Grove authentication failures.

**Cross-Grove Session Pollution**: Session storage can accidentally leak data between Groves if session keys don't include Grove and Project IDs. Always prefix session keys with both Grove ID and Project ID to ensure proper isolation.

**Grove Binding Validation Bypass**: Grove binding IDs must be validated against the Grove registration table, not just the request headers. Attackers may attempt to spoof binding IDs to bypass Grove isolation boundaries.

**Grove Registration State Races**: Grove registration status can change during request processing. Always re-validate Grove registration status before performing sensitive operations, especially file system access.
---
name: myco:collective-backend-development
description: |
  Procedures for developing and operating the Myco Collective's server-side infrastructure: extending Worker API endpoints, designing D1 data structures for org-level aggregation, implementing fan-out operations with per-project timeouts, applying capability negotiation protocols, managing home-scoped operator configuration, and verifying OSS worker health. Use this skill when adding new Collective features, debugging cross-project operations, or implementing org-level policies, even if the user doesn't explicitly mention "Collective backend" or "server-side architecture".
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Collective Backend Development

The Myco Collective is a cloud-deployed MDM/compliance infrastructure that provides settings override and cross-project knowledge capabilities. The backend runs entirely on Cloudflare (Worker + D1 + Vectorize + KV) and follows a three-package monorepo architecture with independent deployment lifecycles.

## Prerequisites

- Cloudflare account with Worker, D1, and KV access
- Wrangler CLI configured with appropriate credentials  
- Collective deployed via `myco-collective create --name <collective-name>`
- Understanding of the three-package structure: `packages/myco`, `packages/myco-team`, `packages/myco-collective`
- Home-scoped operator config at `~/.myco-collective/<name>/config.json`

## Procedure 1: Extending the Collective Worker API

Add new API endpoints to `packages/myco-collective/worker/src/index.ts` for cross-project operations.

### Route Wiring Pattern

```typescript
// In packages/myco-collective/worker/src/index.ts
app.get('/api/new-feature/:project_id', async (c) => {
  // 1. Extract and validate auth
  const authResult = await validateAdminAuth(c);
  if (!authResult.success) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // 2. Apply per-project scoping invariants
  const projectId = c.req.param('project_id');
  const project = await getProject(c.env.COLLECTIVE_D1, projectId);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // 3. Implement the business logic
  const result = await processNewFeature(project, c.req.query());
  
  return c.json(result);
});
```

### Authentication with Admin Tokens

All Collective endpoints require bearer auth using the admin token stored in KV:

```typescript
async function validateAdminAuth(c: Context): Promise<{success: boolean}> {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { success: false };
  }
  
  const token = authHeader.slice(7);
  const storedToken = await c.env.COLLECTIVE_KV.get('admin_token');
  return { success: token === storedToken };
}
```

### Per-Project Scoping Invariants

- Always validate the project exists in the registry before processing
- Include project metadata (URL, API key) in fan-out operations
- Log all cross-project operations with project context for audit trails
- Apply capability negotiation before routing to ensure compatibility

## Procedure 2: Designing Org-Level D1 Data Architecture  

Create D1 tables for org-level aggregation data, distinct from team D1 vault schemas.

### Design Principles

The Collective D1 stores **org-level aggregation data only**. Audit data, sessions, spores, and skills remain in team D1. The Collective queries team workers on-demand rather than duplicating data.

```sql
-- Project registry (core table)
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  worker_url TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  capabilities TEXT NOT NULL, -- JSON array
  last_heartbeat INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Capability negotiation state
CREATE TABLE capability_flags (
  project_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  supported BOOLEAN NOT NULL DEFAULT FALSE,
  version_detected TEXT,
  last_checked INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (project_id, capability),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Admin audit log
CREATE TABLE admin_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  target_project_id TEXT,
  details TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  created_by TEXT NOT NULL
);
```

### Lazy Migration Behavior

D1 migrations run automatically on worker startup. Migration logic is implemented in `packages/myco-collective/worker/src/schema.ts`. Use defensive SQL that handles both fresh deploys and existing instances:

```typescript
// In packages/myco-collective/worker/src/schema.ts
export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        -- ... fields
      );
      CREATE INDEX IF NOT EXISTS idx_projects_heartbeat 
        ON projects(last_heartbeat);
    `
  }
];
```

### Distinguishing Team D1 vs Collective D1

- **Team D1**: Per-project vault data (sessions, spores, skills, digest). One D1 instance per team.
- **Collective D1**: Org-level registry, capability state, admin audit. One D1 instance per collective.

Never replicate team vault data into Collective D1. Query team workers on-demand via fan-out operations.

## Procedure 3: Implementing Fan-out Operations

Broadcast operations to all registered team workers with per-project timeouts and fail-open semantics.

### Fan-out Architecture Pattern

```typescript
// In packages/myco-collective/worker/src/fanout.ts
interface FanoutRequest {
  endpoint: string;
  method: 'GET' | 'POST';
  body?: any;
  timeout?: number; // defaults to 5000ms
}

export async function fanoutToProjects(
  db: D1Database,
  request: FanoutRequest,
  projectFilter?: (project: Project) => boolean
): Promise<FanoutResult[]> {
  const projects = await getProjects(db);
  const filteredProjects = projectFilter 
    ? projects.filter(projectFilter)
    : projects;

  // Use Promise.allSettled for fail-open semantics
  const promises = filteredProjects.map(project => 
    fanoutToProject(project, request)
  );

  const results = await Promise.allSettled(promises);
  
  return results.map((result, index) => ({
    project: filteredProjects[index],
    success: result.status === 'fulfilled',
    data: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? result.reason.message : null
  }));
}

async function fanoutToProject(
  project: Project, 
  request: FanoutRequest
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, request.timeout || 5000);

  try {
    const response = await fetch(`${project.worker_url}${request.endpoint}`, {
      method: request.method,
      headers: {
        'Authorization': `Bearer ${project.api_key}`,
        'Content-Type': 'application/json'
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
```

### Per-Project Timeout Requirements

Each project request gets an independent timeout (default 5s) to prevent a single hung project from stalling the entire batch. Use `Promise.allSettled` instead of `Promise.all` so partial results can be returned even when some projects fail.

### Capability Filtering Pre-Dispatch

Apply capability negotiation before fan-out to avoid sending requests to workers that don't support the operation:

```typescript
// Only fan-out to projects that support the required capability
const supportsSearch = (project: Project) => 
  project.capabilities.includes('collective_search');

const searchResults = await fanoutToProjects(db, {
  endpoint: '/api/search',
  method: 'POST',
  body: { query: 'authentication patterns' }
}, supportsSearch);
```

## Procedure 4: Implementing Capability Negotiation Protocol

Gate new Collective features on team worker version and capability support with safe degradation.

### Capability Handshake on Connect

When a team worker connects to a collective, exchange capability information:

```typescript
// In packages/myco-team/worker/src/collective-sync.ts
export async function registerWithCollective(
  collectiveUrl: string,
  projectId: string,
  apiKey: string
): Promise<RegistrationResult> {
  const capabilities = getLocalCapabilities(); // ['search', 'audit', 'mcp']
  const version = getPackageVersion();

  const response = await fetch(`${collectiveUrl}/api/projects/${projectId}/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      capabilities,
      version,
      worker_url: getWorkerUrl()
    })
  });

  if (!response.ok) {
    throw new Error(`Registration failed: ${response.statusText}`);
  }

  return await response.json();
}

function getLocalCapabilities(): string[] {
  // Return capabilities supported by current package version
  const capabilities = ['basic', 'heartbeat'];
  
  if (supportsSemanticSearch()) {
    capabilities.push('search');
  }
  
  if (supportsMcpBridge()) {
    capabilities.push('mcp');
  }
  
  return capabilities;
}
```

### Safe Degradation Pattern

Features activate only when both sides share a capability. Older packages continue working but don't participate in missing features:

```typescript
// In packages/myco-collective/worker/src/capabilities.ts
export async function checkProjectCapability(
  db: D1Database,
  projectId: string, 
  capability: string
): Promise<boolean> {
  const result = await db.prepare(`
    SELECT supported FROM capability_flags 
    WHERE project_id = ? AND capability = ?
  `).bind(projectId, capability).first();

  return result?.supported === true;
}

// Only include projects that support the feature
export async function getCapableProjects(
  db: D1Database,
  capability: string
): Promise<Project[]> {
  const projects = await db.prepare(`
    SELECT p.* FROM projects p
    JOIN capability_flags cf ON p.id = cf.project_id
    WHERE cf.capability = ? AND cf.supported = true
  `).bind(capability).all();

  return projects.results;
}
```

### `capability_flags` Handshake

Store negotiated capabilities in D1 and refresh periodically:

```typescript
export async function updateProjectCapabilities(
  db: D1Database,
  projectId: string,
  capabilities: string[],
  version: string
): Promise<void> {
  // Remove old capability flags
  await db.prepare(`
    DELETE FROM capability_flags WHERE project_id = ?
  `).bind(projectId).run();

  // Insert new capability flags
  for (const capability of capabilities) {
    await db.prepare(`
      INSERT INTO capability_flags (project_id, capability, supported, version_detected)
      VALUES (?, ?, true, ?)
    `).bind(projectId, capability, version).run();
  }
}
```

## Procedure 5: Managing Home-Scoped Operator Config

Configure collective operator settings in home directory, separate from project-scoped `myco.yaml`.

### Why Home-Scoping is Mandatory

A Collective serves multiple projects on one machine. Config must be scoped to the operator (user), not any individual project. Home-scoping ensures:

- Config survives project deletion
- Multiple projects can reference the same collective
- Credentials are machine-local, not committed to git
- Separation of concerns between project settings (`myco.yaml`) and operator identity

### Config File Structure

```typescript
// ~/.myco-collective/<collective-name>/config.json
interface CollectiveOperatorConfig {
  collective_id: string;
  worker_url: string;
  admin_token: string;  // Never in myco.yaml
  created_at: string;
  last_token_rotation?: string;
}

// .myco/team/config.json (per-project)
interface TeamCollectiveConfig {
  collective_enabled: boolean;
  collective_id: string;
  collective_url: string;
  api_key: string; // From .myco/secrets.env
}
```

### Reading Home-Scoped Config

```typescript
// In packages/myco-collective/src/config.ts
import { homedir } from 'os';
import { join } from 'path';

export function getCollectiveConfigPath(collectiveName: string): string {
  return join(homedir(), '.myco-collective', collectiveName, 'config.json');
}

export async function loadCollectiveConfig(
  collectiveName: string
): Promise<CollectiveOperatorConfig> {
  const configPath = getCollectiveConfigPath(collectiveName);
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Collective config not found: ${configPath}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  // Validate required fields
  if (!config.collective_id || !config.admin_token) {
    throw new Error('Invalid collective config: missing required fields');
  }

  return config;
}
```

### Secure Credential Storage

- Set file permissions to `0o600` (owner read/write only)
- Display credentials once at install time with instructions to store in secrets manager
- Support credential recovery via `rotate-tokens` command

```typescript
export async function writeCollectiveConfig(
  collectiveName: string,
  config: CollectiveOperatorConfig
): Promise<void> {
  const configPath = getCollectiveConfigPath(collectiveName);
  const configDir = dirname(configPath);
  
  // Ensure directory exists with secure permissions
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  
  // Write config with secure permissions
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  
  console.log(`Collective config written to: ${configPath}`);
  console.log('Save these credentials in your secrets manager (1Password, etc.)');
}
```

## Procedure 6: Verifying OSS Worker Health and MCP Tools

Verify collective functionality through health checks and MCP tool registration patterns.

### OSS Worker Health Verification Workflow

```bash
# 1. Build the worker to catch compile errors
cd packages/myco-collective
npm run build

# 2. Upgrade the OSS collective (or your test collective)
myco-collective upgrade oss

# 3. Check status and health endpoint
myco-collective status oss
curl https://oss.goondocks.workers.dev/health

# 4. Verify collective_name appears in health response
curl -s https://oss.goondocks.workers.dev/health | jq '.collective_name'
```

Expected health response format:

```json
{
  "status": "ok",
  "collective_name": "oss",
  "version": "1.0.0",
  "capabilities": ["search", "audit", "mcp"],
  "projects_count": 3,
  "last_heartbeat": "2024-04-19T10:30:00Z"
}
```

### `collective_*` MCP Tool Registration

When collective-connected, the local Myco MCP server enables collective tools. These tools are NOT on the cloud Worker.

```typescript
// In packages/myco/src/mcp/server.ts
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const teamStatus = await client.get('/api/team/status');
  const collectiveEnabled = Boolean(teamStatus.ok && teamStatus.data?.collective_connected);
  return {
    tools: collectiveEnabled ? [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS] : TOOL_DEFINITIONS,
  };
});
```

### Collective Tool Implementation Pattern

```typescript
// In packages/myco/src/tools/collective-search.ts
export async function collective_search(
  query: string,
  project?: string
): Promise<CollectiveSearchResult> {
  const collectiveConfig = loadTeamCollectiveConfig();
  
  if (!collectiveConfig.enabled) {
    throw new Error('Collective tools require collective connection');
  }

  // Route through team worker to collective
  const response = await fetch('/api/collective/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, project })
  });

  if (!response.ok) {
    throw new Error(`Collective search failed: ${response.statusText}`);
  }

  return await response.json();
}
```

### Routing Flow: Local Tools → Team Worker → Collective

The collective tools on the local MCP server are proxy tools. The actual logic lives in the team worker, which routes to the collective:

1. Agent calls `collective_search` on local MCP server
2. Local MCP server forwards to team worker `/api/collective/search`  
3. Team worker forwards to collective worker `/api/search`
4. Results flow back through the chain

This routing model ensures collective features work natively without requiring agents to manage multiple MCP connections.

## Procedure 7: Quality Gate Integration for Worker Packages

Ensure nested Cloudflare worker packages are included in Myco's main quality gate to catch build and lint failures early.

### Worker Package Quality Gate Setup

The nested worker packages in `packages/myco-team/worker` and `packages/myco-collective/worker` have independent `package.json` files and must be included in the root repository quality gate:

```bash
# Root package.json lint script must include worker checks
npm run check --prefix packages/myco-team/worker
npm run check --prefix packages/myco-collective/worker
```

### Makefile Integration Pattern

Update the root `Makefile` to include worker package builds:

```makefile
build: build-core build-workers

build-workers:
	cd packages/myco-team/worker && npm run build
	cd packages/myco-collective/worker && npm run build
	
lint: lint-core lint-workers

lint-workers:
	cd packages/myco-team/worker && npm run check
	cd packages/myco-collective/worker && npm run check
```

### Common Worker Package Failures

Worker packages can hide failures that only surface when explicitly checked:

- **Stale TypeScript casts**: Vectorize metadata type changes require manual cast updates
- **Import resolution**: Worker bundles have different module resolution than the main package
- **Environment binding types**: Cloudflare environment bindings drift with wrangler updates
- **Build target mismatches**: Worker builds target different JavaScript versions

### CI Integration

Ensure GitHub Actions includes worker package verification:

```yaml
- name: Test worker packages
  run: |
    npm run check --prefix packages/myco-team/worker
    npm run check --prefix packages/myco-collective/worker
    npm run build --prefix packages/myco-team/worker  
    npm run build --prefix packages/myco-collective/worker
```

## Cross-Cutting Gotchas

### Silent Failure Patterns

The Collective V1 CE review identified critical patterns where failures appear as successes:

- **Cron misconfiguration**: Missing `[triggers]` block in `wrangler.toml` makes scheduled handlers dead code
- **Token rotation gaps**: New tokens don't propagate to team workers, causing silent 401s while UI shows "connected"
- **Fan-out stalls**: Missing per-project timeouts in `Promise.all` cause entire batches to hang
- **Build script masking**: `|| true` in deploy scripts hides deployment failures
- **Binary ENOENT**: Missing binaries exit 0 instead of failing loudly
- **Quality gate gaps**: Nested worker packages outside main lint checks hide TypeScript and build failures

Always prefer loud failures over silent success. If something went wrong, the system should make it obvious.

### Vectorize Metadata Cast Gotcha

The `packages/myco-collective/worker/src/index.ts` file contains Vectorize query code that requires manual maintenance when Cloudflare updates the Vectorize TypeScript definitions. Common failure:

```typescript
// This cast becomes stale when Vectorize metadata schema changes
const results = response.matches.map(match => ({
  id: match.id,
  score: match.score,
  metadata: match.metadata as MycoVectorMetadata  // <-- Stale cast
}));
```

When the quality gate reports Vectorize TypeScript errors:

1. Check the actual Vectorize metadata schema in Cloudflare docs
2. Update the `MycoVectorMetadata` interface to match
3. Verify the cast is still safe or replace with proper type guards

### Config Scope Boundaries

- **Project config** (`myco.yaml`): Committed to git, shared by team
- **Runtime state** (`.myco/`): Local only, not committed
- **Team collective config** (`.myco/team/config.json`): Per-project collective connection
- **Operator collective config** (`~/.myco-collective/<name>/config.json`): Per-machine collective admin access

Never mix these boundaries. Credentials belong in home-scoped config or `.myco/secrets.env`, never in `myco.yaml`.

### Fan-out Best Practices

- Use `Promise.allSettled` instead of `Promise.all` for fail-open semantics
- Apply capability filtering before dispatch to avoid sending unsupported requests
- Set conservative per-project timeouts (5s default) to prevent stalls
- Surface errors explicitly rather than collapsing to empty results
- Log all cross-project operations with full context for debugging

### Package Boundary Enforcement

The three-package structure (`myco`, `myco-team`, `myco-collective`) must be respected:

- **Core package** (`packages/myco`): Local daemon, MCP server, project intelligence  
- **Team package** (`packages/myco-team`): Team sync, D1 bridge, collective routing
- **Collective package** (`packages/myco-collective`): Cross-project fan-out, admin UI

Avoid circular dependencies. Use package aliases in tests (`@goondocks/myco`) to ensure boundaries are real.
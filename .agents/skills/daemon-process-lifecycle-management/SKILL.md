---
name: myco:daemon-process-lifecycle-management
description: |
  Comprehensive procedures for managing Myco daemon process lifecycle including
  startup robustness, unified eviction and restart workflows, process identity
  management, multi-instance coordination, health checking, update application,
  npm package upgrade handling, daemon binary version mismatch detection, and
  resource cleanup. Covers operational daemon management patterns from
  auto-spawn and migration tasks through SIGTERM/SIGKILL sequences to port
  release verification and cross-runtime coordination. Use when starting,
  restarting, updating, or coordinating daemon processes, even if the user
  doesn't explicitly ask for daemon lifecycle management.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon Process Lifecycle and Eviction Management

Myco daemon processes require careful lifecycle management to ensure reliable operation across restarts, updates, and multi-instance scenarios. With Grove architecture, the daemon operates as a global system service managing multiple groves and projects through centralized coordination patterns.

## Prerequisites

- Myco Grove installation with global daemon (`~/.myco/groves/` architecture)
- Understanding of process signals (SIGTERM, SIGKILL) and port management
- Access to global daemon state in `~/.myco/daemon.json`
- Basic knowledge of process discovery and PID validation concepts
- Understanding of grove-scoped resource management
- **Hub package no longer required** — global daemon replaces Hub functionality

## Procedure A: Daemon Startup and Robustness

### Global Daemon Auto-Spawn via DaemonClient

Grove architecture uses a global daemon that manages all projects through centralized `DaemonClient`:

```typescript
// Global daemon spawn - manages all groves
await spawnDaemon();
```

**Global startup sequence:**
1. **Check global daemon health** via `/health` endpoint on global port
2. **Validate ~/.myco/daemon.json** - ensure PID exists and matches running process
3. **Spawn if needed** - 3-second coalesce window deduplicates spawn attempts across projects
4. **Execute migration tasks** from registry on successful startup
5. **Update ~/.myco/daemon.json** with new PID, port, and binary path
6. **Initialize grove coordination** - scan for existing groves and projects
7. **Initialize Grove runtime cache** with bounded LRU management

### NPM Package Upgrade Binary Version Mismatch Detection

**Critical issue**: `npm install -g @goondocks/myco@latest` doesn't restart daemon, causing stale binary to serve incorrect responses.

```bash
# Detect binary version mismatch after npm upgrade
RUNNING_VERSION=$(curl -s http://localhost:$(jq -r '.port' ~/.myco/daemon.json)/health | jq -r '.version' 2>/dev/null || echo "unknown")
INSTALLED_VERSION=$(myco --version 2>/dev/null | grep -o 'v[0-9.]\+' || echo "unknown")

if [ "$RUNNING_VERSION" != "unknown" ] && [ "$INSTALLED_VERSION" != "unknown" ]; then
  if [ "$RUNNING_VERSION" != "$INSTALLED_VERSION" ]; then
    echo "Binary version mismatch detected:"
    echo "  Running daemon: $RUNNING_VERSION"  
    echo "  Installed binary: $INSTALLED_VERSION"
    echo "  Restarting daemon to sync versions..."
    
    # Force daemon restart to pickup new binary
    myco daemon restart --force-version-sync
  fi
fi
```

**NPM upgrade detection pattern:**
```typescript
// Detect when npm install changed the global binary
async function detectNpmUpgradeVersionMismatch(): Promise<boolean> {
  const runningVersion = await getDaemonVersion();
  const installedBinaryVersion = await getInstalledBinaryVersion();
  
  if (runningVersion && installedBinaryVersion && 
      runningVersion !== installedBinaryVersion) {
    console.warn('NPM upgrade detected - binary version mismatch', {
      running: runningVersion,
      installed: installedBinaryVersion
    });
    return true;
  }
  
  return false;
}

// Check on daemon health requests - catch HTML vs JSON response mismatch
async function validateDaemonResponseFormat(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('text/html') && response.url.includes('/health')) {
    throw new Error('Daemon serving HTML instead of JSON - likely binary version mismatch from npm upgrade');
  }
}
```

**Trigger points**: Context switch requests returning HTML instead of JSON, health check format inconsistencies, CLI commands failing with unexpected response formats, post-npm-install automatic validation.

### Grove Runtime Cache Architecture

```typescript
// Bounded LRU cache with pin/unpin safety
class GroveRuntimeCache {
  private static readonly MAX_CACHE_SIZE = 100;
  private static readonly CACHE_TTL_MS = 300000; // 5 minutes
  
  // Tier 1: Pinned handles (never evicted)
  private pinnedHandles = new Map<string, CachedHandle>();
  
  // Tier 2: Recently used handles (LRU eviction)  
  private lruCache = new LRU<string, CachedHandle>(this.MAX_CACHE_SIZE);
  
  // Pin critical handles to prevent eviction
  pinHandle(groveId: string, handle: CachedHandle): void {
    this.pinnedHandles.set(groveId, handle);
    this.lruCache.delete(groveId); // Remove from LRU if present
  }
  
  // Unpin handle (moves to LRU tier if still valid)
  unpinHandle(groveId: string): void {
    const handle = this.pinnedHandles.get(groveId);
    if (handle && !this.isExpired(handle)) {
      this.lruCache.set(groveId, handle);
    }
    this.pinnedHandles.delete(groveId);
  }
}
```

**Cache safety mechanisms**: Bounded eviction (100 entries), pin protection for critical handles, TTL expiration (5 minutes), re-resolution on demand.

### Grove Boundary Violation Prevention

**Critical pattern**: Prevent grove boundary violations in `forEachGrove()` operations:

```typescript
// WRONG: Grove boundary violation pattern
async function dangerousGroveOperation() {
  await forEachGrove(async (grove) => {
    // Calling external grove binding inside grove iteration
    const binding = await resolveProjectGroveBinding(grove.projectId); // BOUNDARY VIOLATION
    await grove.manifestOperations(binding); // May corrupt manifests
  });
}

// RIGHT: Resolve bindings before grove iteration
async function safeGroveOperation() {
  // Collect all grove contexts first
  const groveContexts = [];
  await forEachGrove(async (grove) => {
    groveContexts.push({ grove: grove, projectId: grove.projectId });
  });
  
  // Resolve bindings outside of grove iteration
  for (const context of groveContexts) {
    const binding = await resolveProjectGroveBinding(context.projectId);
    await context.grove.manifestOperations(binding); // Safe - proper ownership
  }
}
```

**Grove boundary violation symptoms**: Manifest corruption during multi-grove operations, ownership gaps in grove-specific resources, race conditions in grove state management.

**Prevention pattern**: Always resolve external bindings outside of `forEachGrove()` iterations to maintain proper grove ownership boundaries.

## Procedure B: Unified Eviction and Restart

### Centralized Global Daemon Eviction

All restart paths use global daemon eviction through centralized management:

```typescript
// Standard global daemon eviction
await daemonClient.stopGlobalDaemon({
  gracePeriodMs: 5000,
  waitForExit: true,
  verifyPortRelease: true,
  coordinated: true // Notify all connected groves
});
```

### SIGTERM → SIGKILL Sequence

**Global daemon eviction flow:**
1. **Send grove notifications** - inform all connected projects of pending shutdown
2. **Send SIGTERM** to global daemon process for graceful shutdown
3. **Wait grace period** (default 5 seconds) for grove coordination completion
4. **Send SIGKILL** if process still running after grace period
5. **Verify global port release** to prevent port collision on restart
6. **Clean up ~/.myco/daemon.json** once process confirmed terminated

```bash
# Manual global daemon eviction
DAEMON_PID=$(jq -r '.pid' ~/.myco/daemon.json)
kill -TERM $DAEMON_PID
sleep 5
if kill -0 $DAEMON_PID 2>/dev/null; then
  kill -KILL $DAEMON_PID
fi
```

### Grove-Coordinated Restart Paths

**Common global restart triggers**: `myco restart` CLI command, global daemon health reconciliation, system update application, cross-grove health-check fallback recovery, global version-sync operations, Hub removal cleanup, **MCP bridge reconnect failures**.

All use the same grove-aware eviction → spawn cycle for consistency.

### Four Daemon Restart Failure Modes and Mitigations

**Critical wisdom**: Daemon restarts during active sessions trigger four distinct failure modes that require different recovery patterns:

#### Mode 1: Parallel Spawn Race (Multiple Daemons Launch Simultaneously)
**Symptoms**: Multiple daemon processes, port conflict errors, inconsistent daemon.json state
**Mitigation**: 3-second coalesce window in spawn logic, atomic daemon.json updates, process discovery verification

#### Mode 2: Port Binding Collision (Previous Process Holds Port)
**Symptoms**: "Port already in use" errors, new daemon fails to start, stale process detection
**Mitigation**: SIGTERM → SIGKILL sequence with port release verification, process cleanup before spawn

#### Mode 3: Stale Process Lingering (Old Daemon Orphaned)
**Symptoms**: Healthy new daemon but stale processes consuming resources, confusion in process discovery
**Mitigation**: PID validation via kill -0, cleanup of orphaned processes, daemon.json reconciliation

#### Mode 4: MCP Bridge Reconnect Failure (Session Tool Loss)
**Symptoms**: Agent sessions lose MCP tool access, "myco_remember" and vault tools fail, session must be restarted
**Recovery patterns**:
- **Session restart required** - MCP bridge cannot auto-reconnect after daemon restart
- **Detection**: Tool calls return connection errors, MCP stdio bridge reports broken pipe
- **User mitigation**: Close and reopen agent session to spawn fresh MCP bridge
- **Development workaround**: Use CLI fallbacks (`myco spore` commands) until session restart

```typescript
// MCP Bridge Health Check for Restart Detection
async function detectMcpBridgeHealth(): Promise<{ healthy: boolean; reason?: string }> {
  try {
    // Test basic MCP tool connectivity
    const response = await mcpClient.call('myco_vault_state', {});
    return { healthy: true };
  } catch (error) {
    if (error.message.includes('connection') || error.message.includes('pipe')) {
      return { 
        healthy: false, 
        reason: 'MCP bridge connection lost - daemon likely restarted, session restart required'
      };
    }
    return { healthy: false, reason: error.message };
  }
}
```

**MCP Bridge Failure Detection Signals**: Tool calls failing with connection errors, stdio bridge reporting broken pipe, MCP child process exit without restart capability, agent harness losing vault access mid-session.

**Critical limitation**: Unlike daemon process restart which is automatic, MCP bridge reconnect requires manual session restart due to stdio bridge architecture constraints.

## Procedure C: Process Identity and State Management

### ~/.myco/daemon.json as Global Authority

```json
{
  "pid": 12345,
  "port": 3721,
  "binaryPath": "/usr/local/bin/myco",
  "startedAt": "2026-04-27T10:30:00.000Z",
  "version": "0.15.0",
  "groves": ["user_primary", "work_grove"],
  "groveCoordination": true,
  "hubMigrated": true
}
```

**New fields**: `hubMigrated` indicates Hub state migrated to global daemon, `groveCoordination` indicates grove-aware coordination is active.

### Global PID Validation Patterns

```bash
# Check if global daemon PID is running
DAEMON_PID=$(jq -r '.pid' ~/.myco/daemon.json)
if ! kill -0 $DAEMON_PID 2>/dev/null; then
  echo "Stale global daemon.json - PID $DAEMON_PID not running"
  rm ~/.myco/daemon.json
fi
```

### Global Port Binding Verification

```bash
DAEMON_PORT=$(jq -r '.port' ~/.myco/daemon.json)
if ! lsof -i :$DAEMON_PORT >/dev/null 2>&1; then
  echo "Global daemon not listening on port $DAEMON_PORT"
  # Trigger global restart or cleanup
fi
```

## Procedure D: Multi-Instance Coordination

### Multi-Tenant Single-Port vs Per-Vault Port Design

**Critical architecture decision**: Choose between single-port multi-tenant vs per-vault port allocation:

```typescript
// Pattern A: Single-port multi-tenant design (recommended)
async function singlePortMultiTenant(): Promise<number> {
  const GLOBAL_DAEMON_PORT = 3721; // Fixed global port
  
  // All groves share single daemon port with request routing
  app.use('/api/:groveId/*', (req, res, next) => {
    req.groveContext = resolveGroveFromPath(req.params.groveId);
    next();
  });
  
  return GLOBAL_DAEMON_PORT;
}

// Pattern B: Per-vault hash-based ports (problematic with multi-tenant)
async function derivePortFromVaultPath(vaultPath: string): Promise<number> {
  const hash = crypto.createHash('md5').update(vaultPath).digest('hex');
  const port = 3700 + (parseInt(hash.substring(0, 4), 16) % 100);
  
  // ISSUE: Conflicts with single-port design expectations
  return port;
}
```

**Port allocation conflict resolution**: Prefer single-port multi-tenant (one global port 3721 with grove routing), deprecate per-vault ports (hash-based port derivation conflicts with multi-tenant expectations), migrate existing per-vault port allocations to single global port with grove headers.

### Global Process Discovery

```typescript
// Find global daemon processes
const globalPorts = [3720, 3721, 3722]; // Global daemon port range
const listeningPids = findPidsListeningOn(globalPorts);

// Cross-reference with global daemon state
const activeGlobalDaemons = listeningPids.map(pid =>
  findGlobalDaemonStateByPid(pid)
).filter(Boolean);
```

### Global Daemon Conflict Resolution

When multiple global daemons detected:
1. **Identify conflicting global processes** via port scanning and ~/.myco/daemon.json comparison
2. **Determine primary global daemon** (newest, healthiest, or machine-preferred)
3. **Check for Hub processes** and migrate state to global daemon if needed
4. **Gracefully evict secondary global daemons** with grove coordination
5. **Update ~/.myco/daemon.json** to reflect resolved global state

## Procedure E: Health Checking and Recovery

### Liveness vs Readiness Probe Split

**Critical architecture**: Formalize daemon health checking into two distinct endpoints following Kubernetes liveness/readiness probe pattern:

```typescript
// 1. /health — Raw Liveness Probe
app.get('/health', (req, res) => {
  // Returns immediately with process-level liveness signal
  // No routed request, no DB scoping, no context validation
  res.json({
    status: 'alive',
    version: process.env.npm_package_version,
    pid: process.pid,
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// 2. /ready — Routed Readiness Probe  
app.get('/ready', async (req, res) => {
  // Full readiness check with request context validation
  try {
    // Validate request context propagation
    const groveId = req.headers['x-grove-id'] || 'default';
    
    // Test database connectivity
    await validateDatabaseConnection(groveId);
    
    // Test grove coordination
    await validateGroveCoordination(groveId);
    
    // Test critical services
    await validateCriticalServices(groveId);
    
    res.json({
      status: 'ready',
      grove: groveId,
      checks: {
        database: 'ok',
        groveCoordination: 'ok', 
        criticalServices: 'ok'
      },
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      error: error.message,
      timestamp: Date.now()
    });
  }
});
```

### Session Freshness Check with Tool-Use Activity Detection

**Critical fix**: Session freshness checks must account for tool-use activity during long agentic turns:

```typescript
// WRONG: Missing tool-use activity in freshness calculation
function getSessionLastActivity(session: Session): number {
  // Only checks explicit user/assistant messages
  return Math.max(
    session.lastUserMessage?.timestamp || 0,
    session.lastAssistantMessage?.timestamp || 0
  );
}

// RIGHT: Include tool-use activity for accurate freshness
function getSessionLastActivityComplete(session: Session): number {
  const messageActivity = Math.max(
    session.lastUserMessage?.timestamp || 0,
    session.lastAssistantMessage?.timestamp || 0
  );
  
  // Include tool-use activity during long agentic turns
  const toolActivity = session.activities
    ?.filter(a => a.type === 'tool_use')
    ?.reduce((latest, activity) => Math.max(latest, activity.timestamp), 0) || 0;
  
  return Math.max(messageActivity, toolActivity);
}

// Session freshness check with tool-use awareness
async function isSessionFresh(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  const lastActivity = getSessionLastActivityComplete(session);
  const staleBefore = Date.now() - (30 * 60 * 1000); // 30 minutes
  
  return lastActivity > staleBefore;
}
```

**Session freshness bug symptoms**: Sessions marked stale during active agentic workflows, premature session termination in long-running agent tasks, health checks missing ongoing tool-use activity.

### Dual-Probe Health Validation

```bash
# Liveness check — fast process health
DAEMON_PORT=$(jq -r '.port' ~/.myco/daemon.json)
if curl -f -s "http://localhost:$DAEMON_PORT/health" >/dev/null; then
  echo "Daemon process alive"
else
  echo "Daemon process dead - triggering restart"
  myco daemon restart
fi

# Readiness check — full service validation
GROVE_ID="default"
if curl -f -s -H "x-grove-id: $GROVE_ID" "http://localhost:$DAEMON_PORT/ready" >/dev/null; then
  echo "Daemon ready for requests"
else
  echo "Daemon not ready - investigating service issues"
  # Continue with detailed diagnostics
fi
```

### Grove-Aware Recovery Workflows

**Global daemon recovery workflow:**
1. **Attempt liveness ping** (`/health`) with reasonable timeout
2. **Attempt readiness ping** (`/ready`) with grove context
3. **Check global process existence** if liveness ping fails
4. **Validate global port binding** if process exists
5. **Check for Hub process interference** and migrate if needed
6. **Coordinate grove notification** before eviction
7. **Evict and restart global daemon** if unresponsive
8. **Re-establish grove connections** after restart

## Procedure F: Update Application Workflow

### Global Daemon Replacement During Updates

**Grove-coordinated update sequence:**
1. **Download and validate** new global daemon binary
2. **Check for Hub dependency removal** in new version
3. **Coordinate with all groves** - notify of pending global restart
4. **Graceful eviction** of global daemon with grove coordination
5. **Migrate Hub state** if upgrading from Hub-dependent version
6. **Apply update** and install new binary
7. **Spawn updated global daemon** with preserved grove configuration
8. **Execute migration tasks** for new version across groves
9. **Re-establish grove connections** and validate successful startup
10. **Clean up Hub artifacts** after successful migration

### Grove State Preservation

**Critical state to preserve**: Active grove connections and coordination state, per-grove configuration and preferences, cross-grove shared resources and locks, global daemon coordination metadata, Hub migration status and migrated configuration.

```bash
# Pre-update global state capture
myco daemon snapshot --output ~/.myco/pre-update-snapshot.json --include-groves --include-hub-migration

# Post-update state restoration with grove coordination
myco daemon restore --input ~/.myco/pre-update-snapshot.json --coordinate-groves --verify-hub-migration
```

## Procedure G: Multi-Environment Isolation and Grove Ownership

### Grove Ownership Enforcement

Implement ownership filtering and validation to prevent cross-Grove mutations:

```typescript
// Add ownership validation to Grove iteration
forEachGrove((grove) => {
  if (grove.served_by !== currentDaemonVariant) {
    return; // Skip groves not owned by this daemon
  }
  // Proceed with grove operations
});

// Ownership validation function
async function validateOwnership(grove: Grove, operation: string): Promise<void> {
  const currentVariant = daemonVariant(daemonStateDir);
  if (grove.served_by !== currentVariant) {
    throw new Error(`Cannot ${operation} grove ${grove.id}: owned by ${grove.served_by}, not ${currentVariant}`);
  }
}
```

**Ownership validation patterns:**
- Ensure every Grove has a `served_by` field matching its daemon variant (`'service'` or `'service-dev'`)
- Validate variant consistency during Grove loading
- Reject operations on Groves with mismatched ownership using `validateOwnership()`

### Scope-Aware Daemon Operations

Implement daemon-scope-aware operations that respect ownership boundaries:

```typescript
async function resolveAfterRepair(grove: Grove) {
  // Add ownership gate using validateOwnership()
  await validateOwnership(grove, 'repair');
  // Proceed with repair operation
}
```

**Ownership gates in shared code paths:**
- Add ownership checks to vault mutation operations using `validateOwnership()`
- Validate scope before database writes  
- Prevent dogfood daemons from mutating production vaults

## Cross-Cutting Gotchas

### Global Daemon Race Conditions

**Grove coordination race gotcha**: When restarting global daemon, always coordinate grove shutdown before eviction. Starting immediately without grove coordination can cause grove connection interruption, orphaned grove processes, resource contention.

**Prevention**: Use `coordinated: true` in eviction calls and verify grove notification completion.

### Grove Cache Performance

**Grove runtime cache gotcha**: Always use pin/unpin mechanisms for handles that must persist across operations:

```typescript
// Wrong - critical handle may be evicted mid-operation
const handle = await groveCache.getHandle(groveId);
await longRunningOperation(handle); // Handle may be evicted during this

// Right - pin handle for operation duration
const handle = await groveCache.getHandle(groveId);
groveCache.pinHandle(groveId, handle);
try {
  await longRunningOperation(handle);
} finally {
  groveCache.unpinHandle(groveId); // Moves to LRU tier
}
```

### MCP Bridge Session Dependencies

**MCP bridge restart gotcha**: Unlike daemon processes that restart automatically, MCP bridges require manual session restart:

```typescript
// Wrong - assuming MCP bridge auto-reconnects after daemon restart
async function handleDaemonRestart() {
  await restartDaemon();
  // MCP bridge connection lost - tool calls will fail
  await mcpClient.call('myco_vault_state', {}); // This will fail
}

// Right - detect MCP bridge health and guide user to restart session
async function handleMcpBridgeFailure() {
  const bridgeHealth = await detectMcpBridgeHealth();
  if (!bridgeHealth.healthy && bridgeHealth.reason?.includes('connection lost')) {
    console.warn('MCP bridge connection lost - session restart required');
    console.log('Please close and reopen your agent session to restore MCP tool access');
    return { requiresSessionRestart: true };
  }
}
```

### Grove Ownership and Multi-Environment Coordination

**Always validate Grove ownership** using `validateOwnership()` before any mutation operation - shared code paths can easily bypass scope boundaries

**Service directory isolation** requires careful path management - ensure environment-specific directories are properly isolated

**Request context propagation gaps** - any database query path without request context creates potential cross-project data leakage in multi-tenant environments. All DB operations must validate and include project scoping to prevent query leaks across project boundaries
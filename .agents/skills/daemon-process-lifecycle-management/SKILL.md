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

### Version-Specific Migration Constant Patterns

**Migration constant-freeze pattern for version-gated migrations:**

```typescript
// Version-specific migration blocks with constant values
const SCHEMA_V8_MIGRATION_CONSTANTS = Object.freeze({
  NOTIFICATION_TABLE_SCHEMA: `
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `,
  MIGRATION_BATCH_SIZE: 1000,
  TARGET_VERSION: '0.15.0'
});

async function executeSchemaV8Migration(): Promise<void> {
  // Use frozen constants to prevent runtime modification
  await db.exec(SCHEMA_V8_MIGRATION_CONSTANTS.NOTIFICATION_TABLE_SCHEMA);
  
  // Process in fixed batch sizes
  let processed = 0;
  while (processed < totalRecords) {
    await processBatch(SCHEMA_V8_MIGRATION_CONSTANTS.MIGRATION_BATCH_SIZE);
    processed += SCHEMA_V8_MIGRATION_CONSTANTS.MIGRATION_BATCH_SIZE;
  }
}
```

**Constant-freeze benefits**: Runtime immutability, version consistency, debugging reliability, rollback safety.

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

### Machine-Scoped Runtime Command Architecture

```typescript
// Machine-scoped runtime command handling
const MACHINE_RUNTIME_COMMAND_PATH = path.join(os.homedir(), '.myco', 'runtime.command');

// Reading machine runtime command
const runtimeCommand = fs.readFileSync(MACHINE_RUNTIME_COMMAND_PATH, 'utf-8').trim();
```

**Machine runtime patterns**: Location `~/.myco/runtime.command`, provides consistent runtime across all groves, eliminates grove-specific complexity.

### Configuration Performance Optimization

**Critical performance issue**: Avoid TOML re-parsing on every HTTP request:

```typescript
// WRONG: Parse TOML on every request (grove coordination race)
app.use((req, res, next) => {
  const config = parseMycoToml(projectRoot); // Heavy operation on every request
  req.groveConfig = config;
  next();
});

// RIGHT: Cache parsed TOML with invalidation
const configCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

app.use((req, res, next) => {
  const projectRoot = getProjectRoot(req);
  const cacheKey = `${projectRoot}:myco.yaml`;
  const cached = configCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    req.groveConfig = cached.config;
    return next();
  }

  // Parse and cache with timestamp
  const config = parseMycoToml(projectRoot);
  configCache.set(cacheKey, { config, timestamp: Date.now() });
  req.groveConfig = config;
  next();
});
```

**Performance gotcha**: Re-parsing TOML on every HTTP request causes grove coordination races and degrades daemon responsiveness.

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

**Common global restart triggers**: `myco restart` CLI command, global daemon health reconciliation, system update application, cross-grove health-check fallback recovery, global version-sync operations, Hub removal cleanup.

All use the same grove-aware eviction → spawn cycle for consistency.

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

**Fix pattern**: Always include tool-use activity timestamps in session freshness calculations to properly handle long agentic turns.

### Global Daemon Health Validation

```bash
# Global daemon HTTP health check
DAEMON_PORT=$(jq -r '.port' ~/.myco/daemon.json)
if curl -f -s "http://localhost:$DAEMON_PORT/health" >/dev/null; then
  echo "Global daemon healthy"
else
  echo "Global daemon unhealthy - triggering recovery"
fi
```

### Grove-Aware Recovery Workflows

**Global daemon recovery workflow:**
1. **Attempt global health ping** with reasonable timeout
2. **Check global process existence** if health ping fails
3. **Validate global port binding** if process exists
4. **Check for Hub process interference** and migrate if needed
5. **Coordinate grove notification** before eviction
6. **Evict and restart global daemon** if unresponsive
7. **Re-establish grove connections** after restart

### Grove Responsiveness Monitoring

```typescript
const startTime = Date.now();
const response = await fetch(`http://localhost:${globalPort}/health`);
const responseTime = Date.now() - startTime;

if (responseTime > GLOBAL_SLOW_RESPONSE_THRESHOLD) {
  // Global daemon degraded - may need restart with grove coordination
  
  // Check if TOML parsing is causing slowdown
  if (responseTime > TOML_PARSING_THRESHOLD) {
    console.warn('Possible TOML re-parsing performance issue detected');
    await optimizeConfigCaching();
  }
}
```

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

### Hub Removal Migration During Updates

```bash
# Update workflow with Hub cleanup
if myco daemon check-hub-dependency --version-target "$NEW_VERSION"; then
  echo "New version removes Hub dependency - preparing migration"
  
  # Capture Hub state before update
  myco daemon export-hub-state --output ~/.myco/hub-migration.json
  
  # Update with Hub migration
  myco daemon update --migrate-hub --hub-state ~/.myco/hub-migration.json
  
  # Verify Hub removal
  myco daemon verify-hub-removal
fi
```

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

### Global State Synchronization

**Grove state drift detection**: Always validate grove state consistency with global daemon:

```bash
# Wrong - trusting global daemon state blindly
kill $(jq -r '.pid' ~/.myco/daemon.json)

# Correct - validate grove coordination first
DAEMON_PID=$(jq -r '.pid' ~/.myco/daemon.json)
if [ "$(jq -r '.groveCoordination' ~/.myco/daemon.json)" = "true" ]; then
  # Coordinate grove shutdown first
  myco daemon coordinate-shutdown
fi
kill -TERM $DAEMON_PID
```

### Hub Migration State Tracking

**Hub removal gotcha**: Always verify Hub migration completion before removing Hub artifacts:

```bash
# Wrong - remove Hub without verification
rm -rf ~/.myco/hub

# Right - verify migration first
if [ "$(jq -r '.hubMigrated' ~/.myco/daemon.json)" = "true" ]; then
  rm -rf ~/.myco/hub
else
  echo "Hub migration not complete - preserving Hub artifacts"
fi
```

**Additional gotchas**: Global daemon port scanning must account for grove-specific coordination requirements. Machine runtime preference compatibility with global daemon version-sync operations prevents infinite restart loops. The global daemon state must stay synchronized with grove-specific configuration to prevent coordination failures.
---
name: myco:daemon-process-lifecycle-management
description: |
  Comprehensive procedures for managing Myco daemon process lifecycle including
  startup robustness, unified eviction and restart workflows, process identity
  management, multi-instance coordination, health checking, update application,
  and resource cleanup. Covers operational daemon management patterns from
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

**Hub removal impact**: The global daemon now handles all coordination directly — no separate Hub package installation or management required.

### Grove Runtime Cache Architecture

The daemon maintains a three-layer cache system for efficient Grove operation:

```typescript
// Bounded LRU cache with pin/unpin safety
class GroveRuntimeCache {
  private static readonly MAX_CACHE_SIZE = 100;
  private static readonly CACHE_TTL_MS = 300000; // 5 minutes
  
  // Tier 1: Pinned handles (never evicted)
  private pinnedHandles = new Map<string, CachedHandle>();
  
  // Tier 2: Recently used handles (LRU eviction)
  private lruCache = new LRU<string, CachedHandle>(this.MAX_CACHE_SIZE);
  
  // Tier 3: On-demand resolution
  async getGroveHandle(groveId: string, projectId?: string): Promise<CachedHandle> {
    // Check pinned first
    if (this.pinnedHandles.has(groveId)) {
      return this.pinnedHandles.get(groveId)!;
    }
    
    // Check LRU cache
    let handle = this.lruCache.get(groveId);
    if (handle && !this.isExpired(handle)) {
      return handle;
    }
    
    // Resolve on-demand with pin safety
    handle = await this.resolveGroveHandle(groveId, projectId);
    this.lruCache.set(groveId, handle);
    return handle;
  }
  
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

**Cache safety mechanisms:**
- **Bounded eviction**: LRU cache limited to 100 entries prevents memory exhaustion
- **Pin protection**: Critical grove handles pinned to prevent eviction during active use
- **TTL expiration**: 5-minute TTL ensures stale handles are re-resolved
- **Re-resolution on demand**: Cache misses trigger fresh grove handle creation

### Migration Tasks Registry

The global daemon maintains a unified `migration_tasks` table across all groves:

```sql
-- Check completed migrations globally
SELECT task_name, grove_id, completed_at FROM migration_tasks;
```

**Global migration execution pattern:**
- Tasks run automatically on global daemon startup
- Each task executes once per grove where applicable
- Failed tasks can be retried by removing the completion record
- Critical for schema updates and grove-wide configuration migrations

### Grove Runtime Command Coordination

Grove architecture centralizes runtime dispatch through the global daemon:

```typescript
// Grove-aware runtime command handling
import { GROVE_RUNTIME_COMMAND_FILENAME } from '../constants';

// Reading grove runtime command
const groveRuntimePath = path.join(groveDir, GROVE_RUNTIME_COMMAND_FILENAME);
const runtimeCommand = fs.readFileSync(groveRuntimePath, 'utf-8').trim();

// Global daemon coordinates runtime across groves
```

**Grove runtime patterns:**
- **Location**: `~/.myco/groves/<grove>/runtime.command`
- **Content**: PATH command name or absolute path to replayable Myco launcher
- **Purpose**: Enables per-grove runtime customization while maintaining global daemon coordination
- **Lifecycle**: Written by grove init/update flows, read by global daemon for grove-specific operations
- **Coordination**: Global daemon validates runtime compatibility across groves

### Cross-Grove Runtime Coordination

Global daemon manages runtime compatibility across multiple groves:

```bash
# Global daemon binary coordination
GLOBAL_DAEMON_BIN=$(jq -r '.binaryPath' ~/.myco/daemon.json)

# Per-grove runtime validation
for grove in ~/.myco/groves/*/; do
  GROVE_RUNTIME=$(cat "$grove/runtime.command" 2>/dev/null || echo "")
  if [ "$GROVE_RUNTIME" != "$GLOBAL_DAEMON_BIN" ] && [ -n "$GROVE_RUNTIME" ]; then
    echo "Grove runtime mismatch in $(basename $grove)"
    # Global daemon handles grove-specific runtime coordination
  fi
done
```

This prevents conflicts between grove-specific runtimes while maintaining global daemon authority.

### Version-Sync Loop Prevention

Guard against restart loops in grove-aware global daemon:

```typescript
// Global daemon version-sync with grove awareness
if (currentVersion !== runningVersion) {
  // Check grove-specific runtime compatibility
  for (const grove of managedGroves) {
    const groveRuntime = readGroveRuntimeCommand(grove.path);
    const expectedBinary = resolveGroveRuntimeCommand(grove, currentVersion);

    if (groveRuntime && expectedBinary !== groveRuntime) {
      // Step aside for grove-specific runtime
      return { action: 'step_aside', reason: 'grove_runtime_mismatch', grove: grove.id };
    }
  }

  // Safe to restart for global version sync
  await gracefulGlobalRestart();
}
```

**Critical invariant**: Global daemon coordinates runtime across groves but respects grove-specific runtime preferences when present.

### Global Daemon Configuration Performance Optimization

**Critical performance issue**: Avoid TOML re-parsing on every HTTP request in grove coordination:

```typescript
// WRONG: Parse TOML on every request (grove coordination race)
app.use((req, res, next) => {
  const config = parseMycoToml(projectRoot); // Heavy operation on every request
  req.groveConfig = config;
  next();
});

// RIGHT: Cache parsed TOML with invalidation (grove performance pattern)
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

**Performance gotcha**: Re-parsing TOML on every HTTP request causes grove coordination races and degrades daemon responsiveness. Cache parsed configs with TTL invalidation.

### Request-Context Grove Handling

Handle grove request context efficiently in global daemon:

```typescript
// Grove request context extraction with error handling
function extractGroveContext(req: Request): GroveContext {
  const groveId = req.headers['x-grove-id'];
  const projectId = req.headers['x-project-id'];

  if (!groveId) {
    // Default to primary grove for backward compatibility
    return { groveId: 'user_primary', projectId: null };
  }

  // Validate grove exists and is accessible
  const grove = getAuthorizedGrove(groveId, req.auth);
  if (!grove) {
    throw new GroveAccessError(`Grove ${groveId} not accessible`);
  }

  return { groveId, projectId, grove };
}

// Use grove context efficiently
app.use('/api', (req, res, next) => {
  try {
    req.groveContext = extractGroveContext(req);
    next();
  } catch (error) {
    if (error instanceof GroveAccessError) {
      return res.status(403).json({ error: error.message });
    }
    throw error;
  }
});
```

**Grove context gotcha**: Always validate grove access permissions and provide fallback to primary grove for requests without grove headers.

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

**Global eviction coordination pattern**: Centralizes daemon termination with grove notification, ensuring graceful shutdown of grove-specific resources and connections.

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

**Common global restart triggers:**
- `myco restart` CLI command (affects all groves)
- Global daemon health reconciliation
- System update application with grove coordination
- Cross-grove health-check fallback recovery
- Global version-sync operations
- **Hub removal cleanup** (migrate Hub state to global daemon)

All use the same grove-aware eviction → spawn cycle for consistency.

### Hub Package Cleanup During Restart

**Hub removal procedure** during daemon restart:

```bash
# Check for legacy Hub installation during restart
if [ -d "$HOME/.myco/hub" ]; then
  echo "Migrating Hub state to global daemon..."
  
  # Migrate Hub configuration to global daemon
  if [ -f "$HOME/.myco/hub/config.json" ]; then
    myco daemon migrate-hub-config --source "$HOME/.myco/hub/config.json"
  fi
  
  # Clean up Hub artifacts after migration
  rm -rf "$HOME/.myco/hub"
  echo "Hub cleanup complete - global daemon now handles all coordination"
fi
```

**Hub replacement impact**: Global daemon now provides all Hub functionality directly — no separate Hub process or package management required.

## Procedure C: Process Identity and State Management

### ~/.myco/daemon.json as Global Authority

The `~/.myco/daemon.json` file serves as the authoritative record for global daemon state:

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

**New fields after Hub removal**:
- `hubMigrated`: Boolean indicating Hub state was successfully migrated to global daemon
- `groveCoordination`: Indicates grove-aware coordination is active

### Global PID Validation Patterns

Before interacting with global daemon, validate the global PID:

```bash
# Check if global daemon PID is running
DAEMON_PID=$(jq -r '.pid' ~/.myco/daemon.json)
if ! kill -0 $DAEMON_PID 2>/dev/null; then
  echo "Stale global daemon.json - PID $DAEMON_PID not running"
  rm ~/.myco/daemon.json
fi
```

### Global Port Binding Verification

Confirm global daemon is listening on the expected port:

```bash
DAEMON_PORT=$(jq -r '.port' ~/.myco/daemon.json)
if ! lsof -i :$DAEMON_PORT >/dev/null 2>&1; then
  echo "Global daemon not listening on port $DAEMON_PORT"
  # Trigger global restart or cleanup
fi
```

### Binary Path and Grove Coordination

Track global daemon binary with grove compatibility:

```typescript
const globalBinary = await getGlobalDaemonBinaryPath();
const daemonBinary = globalDaemonState.binaryPath;

if (globalBinary !== daemonBinary && globalDaemonHealthy) {
  // Global runtime change detected - coordinate grove handoff
  await coordinateGlobalRuntimeTransition();
}
```

### Hub Migration Status Tracking

Track Hub-to-global-daemon migration status:

```typescript
// Check if Hub migration completed
const daemonState = JSON.parse(fs.readFileSync('~/.myco/daemon.json', 'utf-8'));
if (!daemonState.hubMigrated) {
  // Trigger Hub state migration
  await migrateHubToGlobalDaemon();
  
  // Update daemon state
  daemonState.hubMigrated = true;
  fs.writeFileSync('~/.myco/daemon.json', JSON.stringify(daemonState, null, 2));
}
```

### Grove Runtime Coordination Patterns

Coordinate global daemon with grove-specific runtime preferences:

```typescript
// Validate grove runtime consistency with global daemon
const globalDaemonBinary = globalDaemonState.binaryPath;

for (const grove of managedGroves) {
  const groveRuntime = readGroveRuntimeCommand(grove.path);

  if (groveRuntime && groveRuntime !== globalDaemonBinary) {
    console.warn('Grove runtime preference detected', {
      grove: grove.id,
      groveRuntime: groveRuntime,
      globalDaemon: globalDaemonBinary
    });

    // Respect grove preference while maintaining global coordination
    await coordinateGroveRuntime(grove, groveRuntime);
  }
}
```

## Procedure D: Multi-Instance Coordination

### Global Process Discovery

Use `findPidsListeningOn()` for global daemon discovery:

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
2. **Determine primary global daemon** (newest, healthiest, or grove-preferred)
3. **Check for Hub processes** and migrate state to global daemon if needed
4. **Gracefully evict secondary global daemons** with grove coordination
5. **Update ~/.myco/daemon.json** to reflect resolved global state

### Global Port Allocation

**Global daemon port allocation:**
```typescript
async function allocateGlobalPort(basePort: number = 3720): Promise<number> {
  for (let port = basePort; port < basePort + 10; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error('No free ports for global daemon');
}
```

### Grove Registration with Global Daemon

Coordinate grove registration with global daemon:

```typescript
// Register grove with global daemon on initialization
async function registerGroveWithGlobalDaemon(groveState: GroveState) {
  await globalDaemonClient.registerGrove({
    groveId: groveState.id,
    projectPaths: groveState.projects,
    capabilities: ['ui', 'mcp', 'agents'],
    runtimePreference: groveState.runtimeCommand
  });
}

// Deregister grove on removal
process.on('SIGTERM', async () => {
  for (const grove of managedGroves) {
    await globalDaemonClient.deregisterGrove(grove.id);
  }
});
```

### Legacy Hub Process Detection and Migration

Detect and migrate legacy Hub processes:

```typescript
// Check for running Hub processes during global daemon startup
const hubPids = findPidsListeningOn([3700, 3701]); // Legacy Hub ports
if (hubPids.length > 0) {
  console.log('Legacy Hub processes detected - migrating to global daemon');
  
  for (const hubPid of hubPids) {
    // Migrate Hub state before termination
    await migrateHubState(hubPid);
    
    // Gracefully terminate Hub process
    process.kill(hubPid, 'SIGTERM');
    setTimeout(() => {
      if (processExists(hubPid)) {
        process.kill(hubPid, 'SIGKILL');
      }
    }, 5000);
  }
}
```

## Procedure E: Health Checking and Recovery

### Global Daemon Health Validation

Standard global daemon health check:

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

### Global Health Monitoring

**Grove-coordinated health monitoring:**
- Periodic global health checks with grove status aggregation
- Grove-specific health validation before critical operations
- Automatic recovery with grove re-coordination
- Grove-aware exponential backoff for restart attempts
- **Hub-free health validation** (no Hub process dependency)

### Grove Responsiveness Monitoring

Monitor global daemon responsiveness across groves:

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

**Performance monitoring**: Track request response times to detect TOML re-parsing performance issues.

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

**Critical state to preserve across global updates:**
- Active grove connections and coordination state
- Per-grove configuration and preferences
- Cross-grove shared resources and locks
- Global daemon coordination metadata
- **Hub migration status** and migrated configuration

```bash
# Pre-update global state capture
myco daemon snapshot --output ~/.myco/pre-update-snapshot.json --include-groves --include-hub-migration

# Post-update state restoration with grove coordination
myco daemon restore --input ~/.myco/pre-update-snapshot.json --coordinate-groves --verify-hub-migration
```

### Hub Removal Migration During Updates

Handle Hub package removal during version updates:

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

### Grove-Wide Migration Execution

Global updates may require grove-wide migrations:

```typescript
// Grove-aware migration tasks in global daemon startup
const pendingMigrations = await getGlobalPendingMigrations();
for (const migration of pendingMigrations) {
  // Check if migration includes Hub cleanup
  if (migration.type === 'hub_removal') {
    await executeHubRemovalMigration();
  }
  
  for (const grove of managedGroves) {
    await executeGroveMigration(migration, grove);
    await markGroveMigrationComplete(migration, grove);
  }
}
```

## Cross-Cutting Gotchas

### Global Daemon Race Conditions

**Grove coordination race gotcha:** When restarting global daemon, always coordinate grove shutdown before eviction. Starting immediately without grove coordination can cause:
- Grove connection interruption and data loss
- Orphaned grove processes waiting for global daemon
- Resource contention between old and new global daemon

**Prevention:** Use `coordinated: true` in eviction calls and verify grove notification completion.

### Grove Cache Performance

**Grove runtime cache gotcha:** Always use pin/unpin mechanisms for handles that must persist across operations:

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

**Grove state drift detection:** Always validate grove state consistency with global daemon:

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

### Grove Resource Cleanup

**Global resource management:** Ensure grove resources are properly cleaned during global daemon shutdown:

```typescript
process.on('SIGTERM', async () => {
  // Clean up grove-specific resources
  for (const grove of managedGroves) {
    await grove.cleanup();
  }
  
  // Clean up Hub migration artifacts if present
  if (await hasHubArtifacts()) {
    await cleanupHubArtifacts();
  }
  
  await database.close();
  await server.close();
  process.exit(0);
});
```

### TOML Configuration Performance

**TOML re-parsing gotcha:** Avoid parsing TOML files on every HTTP request in grove coordination:

```typescript
// Wrong - causes grove coordination races
const config = parseMycoToml(projectRoot); // Every request

// Right - cache with TTL invalidation
const cachedConfig = await getConfigWithCache(projectRoot, 30000);
```

**Performance impact**: TOML re-parsing on every request degrades daemon responsiveness and causes grove coordination timing issues.

### Grove-Global Runtime Coordination

**Runtime compatibility pitfalls:** When detecting global runtime changes, account for grove-specific preferences:

```bash
# Resolve grove runtime preferences for global coordination
GLOBAL_BIN=$(readlink -f $(jq -r '.binaryPath' ~/.myco/daemon.json))
for grove_runtime in ~/.myco/groves/*/runtime.command; do
  if [ -f "$grove_runtime" ]; then
    GROVE_BIN=$(readlink -f $(cat "$grove_runtime"))
    if [ "$GLOBAL_BIN" != "$GROVE_BIN" ]; then
      echo "Grove runtime preference detected: $(dirname $grove_runtime)"
    fi
  fi
done
```

### Hub Migration State Tracking

**Hub removal gotcha:** Always verify Hub migration completion before removing Hub artifacts:

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

**Grove coordination scope:** Global daemon port scanning must account for grove-specific coordination requirements and avoid interfering with grove-local processes.

**Global Version-Sync Hazard:** Prevent infinite restart loops by ensuring grove runtime preferences are compatible with global daemon version-sync operations. Grove-global mismatches cause coordination failures and version-sync instability.

**Grove State Synchronization:** The global daemon state (`.myco/daemon.json`) must stay synchronized with grove-specific configuration. Drift between global and grove state can cause coordination failures and health check inconsistencies.

**Hub Dependency Removal:** Global daemon now handles all Hub functionality directly. Legacy Hub processes must be detected, migrated, and cleaned up during daemon lifecycle management to prevent port conflicts and state inconsistencies.
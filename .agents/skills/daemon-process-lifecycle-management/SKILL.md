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

All use the same grove-aware eviction → spawn cycle for consistency.

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
  "groveCoordination": true
}
```

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
3. **Gracefully evict secondary global daemons** with grove coordination
4. **Update ~/.myco/daemon.json** to reflect resolved global state

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
4. **Coordinate grove notification** before eviction
5. **Evict and restart global daemon** if unresponsive
6. **Re-establish grove connections** after restart

### Global Health Monitoring

**Grove-coordinated health monitoring:**
- Periodic global health checks with grove status aggregation
- Grove-specific health validation before critical operations
- Automatic recovery with grove re-coordination
- Grove-aware exponential backoff for restart attempts

### Grove Responsiveness Monitoring

Monitor global daemon responsiveness across groves:

```typescript
const startTime = Date.now();
const response = await fetch(`http://localhost:${globalPort}/health`);
const responseTime = Date.now() - startTime;

if (responseTime > GLOBAL_SLOW_RESPONSE_THRESHOLD) {
  // Global daemon degraded - may need restart with grove coordination
}
```

## Procedure F: Update Application Workflow

### Global Daemon Replacement During Updates

**Grove-coordinated update sequence:**
1. **Download and validate** new global daemon binary
2. **Coordinate with all groves** - notify of pending global restart
3. **Graceful eviction** of global daemon with grove coordination
4. **Apply update** and install new binary
5. **Spawn updated global daemon** with preserved grove configuration
6. **Execute migration tasks** for new version across groves
7. **Re-establish grove connections** and validate successful startup

### Grove State Preservation

**Critical state to preserve across global updates:**
- Active grove connections and coordination state
- Per-grove configuration and preferences
- Cross-grove shared resources and locks
- Global daemon coordination metadata

```bash
# Pre-update global state capture
myco daemon snapshot --output ~/.myco/pre-update-snapshot.json --include-groves

# Post-update state restoration with grove coordination
myco daemon restore --input ~/.myco/pre-update-snapshot.json --coordinate-groves
```

### Grove-Wide Migration Execution

Global updates may require grove-wide migrations:

```typescript
// Grove-aware migration tasks in global daemon startup
const pendingMigrations = await getGlobalPendingMigrations();
for (const migration of pendingMigrations) {
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
  await database.close();
  await server.close();
  process.exit(0);
});
```

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

**Grove coordination scope:** Global daemon port scanning must account for grove-specific coordination requirements and avoid interfering with grove-local processes.

**Global Version-Sync Hazard:** Prevent infinite restart loops by ensuring grove runtime preferences are compatible with global daemon version-sync operations. Grove-global mismatches cause coordination failures and version-sync instability.

**Grove State Synchronization:** The global daemon state (`.myco/daemon.json`) must stay synchronized with grove-specific configuration. Drift between global and grove state can cause coordination failures and health check inconsistencies.
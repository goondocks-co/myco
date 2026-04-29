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

Myco daemon processes require careful lifecycle management to ensure reliable operation across restarts, updates, and multi-instance scenarios. This skill covers operational procedures for daemon startup, eviction, restart, and coordination workflows that prevent race conditions, port conflicts, and resource leaks.

## Prerequisites

- Myco project with daemon functionality configured
- Understanding of process signals (SIGTERM, SIGKILL) and port management
- Access to `.myco/daemon.json` and daemon control files
- Basic knowledge of process discovery and PID validation concepts

## Procedure A: Daemon Startup and Robustness

### Auto-Spawn Patterns via DaemonClient

All hooks automatically spawn the daemon through centralized `DaemonClient`:

```typescript
// When daemon.json missing or daemon unhealthy
await spawnDaemon();
```

**Startup sequence:**
1. **Check daemon health** via `/health` endpoint ping
2. **Validate daemon.json** - ensure PID exists and matches running process
3. **Spawn if needed** - 3-second coalesce window deduplicates spawn attempts
4. **Execute migration tasks** from registry on successful startup
5. **Update daemon.json** with new PID, port, and binary path

### Migration Tasks Registry

The daemon maintains a `migration_tasks` table as a ledger for one-time operations:

```sql
-- Check completed migrations
SELECT task_name, completed_at FROM migration_tasks;
```

**Migration execution pattern:**
- Tasks run automatically on daemon startup
- Each task executes once and records completion
- Failed tasks can be retried by removing the completion record
- Critical for schema updates and configuration migrations

### Runtime Command File Management

Runtime dispatch is pinned by `.myco/runtime.command` when a project needs
something other than the machine-global `myco` lookup:

```typescript
// Constants for runtime command handling
import { PROJECT_RUNTIME_COMMAND_FILENAME } from '../constants';

// Reading runtime command
const runtimeCommandPath = path.join(vaultDir, PROJECT_RUNTIME_COMMAND_FILENAME);
const runtimeCommand = fs.readFileSync(runtimeCommandPath, 'utf-8').trim();

// Missing file means "fall back to the installed myco binary".
```

**Runtime command file patterns:**
- **Location**: `.myco/runtime.command` (via `PROJECT_RUNTIME_COMMAND_FILENAME`)
- **Content**: PATH command name or absolute path to a replayable Myco launcher
- **Purpose**: Lets project-local, dogfood, and managed runtimes be relaunched consistently
- **Lifecycle**: Written by install/update/dev-link flows, read by daemon/hub/update operations
- **Guardrail**: Absence is valid; never replace a missing file with `process.execPath` (`node`/`bun` is not a replayable `myco daemon` command)

### Cross-Runtime Takeover Guard

When binary paths change but daemon remains healthy, implement graceful handoff:

```bash
# Current daemon binary
CURRENT_BIN=$(jq -r '.binaryPath' .myco/daemon.json)

# Runtime command from file
RUNTIME_CMD=$(cat .myco/runtime.command 2>/dev/null || echo "")

# New binary path
NEW_BIN=$(which myco)

if [ "$CURRENT_BIN" != "$NEW_BIN" ] && [ "$RUNTIME_CMD" != "$NEW_BIN" ] && daemon_healthy; then
  echo "Different runtime detected - stepping aside for takeover"
  # Let new binary handle the transition
fi
```

This prevents conflicts between Node and Bun runtimes or different Myco installations.

### Version-Sync Loop Prevention

Guard against restart loops caused by runtime command dispatch mismatches:

```typescript
// Version-sync must validate dispatch contract invariant
if (currentVersion !== runningVersion) {
  // Check if runtime.command is either absent or matches the expected binary
  const expectedBinary = resolveRuntimeCommand(currentVersion);
  const runningBinary = daemonState.binaryPath;
  const runtimeCommandBinary = readRuntimeCommand(vaultDir);

  if (expectedBinary !== runningBinary || (runtimeCommandBinary && expectedBinary !== runtimeCommandBinary)) {
    // Step aside - different binary should handle this version
    return { action: 'step_aside', reason: 'dispatch_contract_mismatch' };
  }

  // Safe to restart for version sync
  await gracefulRestart();
}
```

**Critical invariant**: When present, the runtime command file must point at the same replayable Myco runtime family as the binary performing version-sync operations. A missing runtime command is valid and should fall back to machine install discovery; a generic JS runtime is not valid.

## Procedure B: Unified Eviction and Restart

### Centralized Eviction Management

All restart paths use consistent eviction patterns through daemon management functions:

```typescript
// Standard eviction through daemon client
await daemonClient.stopDaemon({
  gracePeriodMs: 5000,
  waitForExit: true,
  verifyPortRelease: true
});
```

**Eviction coordination pattern**: Centralizes all daemon termination logic to ensure consistent SIGTERM/SIGKILL sequences, port cleanup, and daemon.json management across restart triggers.

### SIGTERM → SIGKILL Sequence

**Standard eviction flow:**
1. **Send SIGTERM** to daemon process for graceful shutdown
2. **Wait grace period** (default 5 seconds) for process to exit
3. **Send SIGKILL** if process still running after grace period
4. **Verify port release** to prevent port collision on restart
5. **Clean up daemon.json** once process confirmed terminated

```bash
# Manual eviction example
DAEMON_PID=$(jq -r '.pid' .myco/daemon.json)
kill -TERM $DAEMON_PID
sleep 5
if kill -0 $DAEMON_PID 2>/dev/null; then
  kill -KILL $DAEMON_PID
fi
```

### Restart Path Integration

**Common restart triggers:**
- `myco restart` CLI command
- Daemon startup reconciliation (when unhealthy daemon detected)
- Update application with daemon respawn
- Health-check fallback recovery
- Version-sync operations (with loop prevention)

All use the same eviction → spawn cycle to ensure consistency.

## Procedure C: Process Identity and State Management

### daemon.json as Authoritative Record

The `.myco/daemon.json` file serves as the single source of truth for daemon state:

```json
{
  "pid": 12345,
  "port": 3721,
  "binaryPath": "/usr/local/bin/myco",
  "startedAt": "2026-04-27T10:30:00.000Z",
  "version": "0.15.0"
}
```

### PID Validation Patterns

Before interacting with a daemon, validate the PID:

```bash
# Check if PID from daemon.json is actually running
DAEMON_PID=$(jq -r '.pid' .myco/daemon.json)
if ! kill -0 $DAEMON_PID 2>/dev/null; then
  echo "Stale daemon.json - PID $DAEMON_PID not running"
  rm .myco/daemon.json
fi
```

### Port Binding Verification

Confirm the daemon is actually listening on the expected port:

```bash
DAEMON_PORT=$(jq -r '.port' .myco/daemon.json)
if ! lsof -i :$DAEMON_PORT >/dev/null 2>&1; then
  echo "Daemon not listening on port $DAEMON_PORT"
  # Trigger restart or cleanup
fi
```

### Binary Path Tracking

Track binary path changes for runtime migration detection:

```typescript
const currentBinary = await getCurrentBinaryPath();
const daemonBinary = daemonState.binaryPath;

if (currentBinary !== daemonBinary && daemonHealthy) {
  // Runtime change detected - coordinate handoff
  await coordinateRuntimeTransition();
}
```

### Runtime Command Coordination

Coordinate between daemon.json binaryPath and runtime.command file without manufacturing pins:

```typescript
// Validate runtime command consistency
const daemonBinary = daemonState.binaryPath;
const runtimeCommand = readRuntimeCommand(vaultDir);

if (daemonBinary !== runtimeCommand) {
  console.warn('Runtime command mismatch detected', {
    daemon: daemonBinary,
    runtime: runtimeCommand
  });

  // Do not auto-write process.execPath here. Missing runtime.command is valid,
  // and generic runtimes such as node/bun are not replayable Myco commands.
  return { action: 'step_aside', reason: 'runtime_command_mismatch' };
}
```

## Procedure D: Multi-Instance Coordination

### Process Discovery

Use `findPidsListeningOn()` to discover daemon processes:

```typescript
// Find all processes listening on specific ports
const listeningPids = findPidsListeningOn([3720, 3721, 3722]);

// Cross-reference with known daemon states
const activeDaemons = listeningPids.map(pid =>
  findDaemonStateByPid(pid)
).filter(Boolean);
```

### Daemon Conflict Resolution

When multiple daemons detected for same vault:

1. **Identify conflicting processes** via port scanning and daemon.json comparison
2. **Determine primary daemon** (newest, healthiest, or user-specified)
3. **Gracefully evict secondary daemons** using standard eviction sequence
4. **Update daemon.json** to reflect resolved state

### Port Allocation Strategies

**Sequential port allocation:**
```typescript
async function allocatePort(basePort: number = 3720): Promise<number> {
  for (let port = basePort; port < basePort + 10; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error('No free ports in range');
}
```

**Graceful handoff pattern:**
- New daemon starts on different port
- Validates startup and health
- Old daemon gracefully shuts down
- New daemon can optionally move to standard port

### Hub Registration and Coordination

Coordinate daemon registration with hub instances for multi-project scenarios:

```typescript
// Register daemon with hub on startup
async function registerWithHub(daemonState: DaemonState) {
  if (hubDetected()) {
    await hubClient.registerDaemon({
      projectId: projectConfig.id,
      port: daemonState.port,
      version: daemonState.version,
      capabilities: ['ui', 'mcp', 'agents']
    });
  }
}

// Deregister on shutdown
process.on('SIGTERM', async () => {
  if (hubDetected()) {
    await hubClient.deregisterDaemon(projectConfig.id);
  }
});
```

## Procedure E: Health Checking and Recovery

### Health Validation via /health Endpoint

Standard health check pattern:

```bash
# HTTP health check
DAEMON_PORT=$(jq -r '.port' .myco/daemon.json)
if curl -f -s "http://localhost:$DAEMON_PORT/health" >/dev/null; then
  echo "Daemon healthy"
else
  echo "Daemon unhealthy - triggering recovery"
fi
```

### Unhealthy Daemon Recovery

**Recovery workflow:**
1. **Attempt health ping** with reasonable timeout (2-3 seconds)
2. **Check process existence** if health ping fails
3. **Validate port binding** if process exists
4. **Evict and restart** if daemon unresponsive but process running
5. **Clean spawn** if no process found

### Automatic Restart Triggers

**Health monitoring integration:**
- Periodic health checks during high-activity periods
- Health validation before critical operations
- Automatic recovery on consecutive health failures
- Exponential backoff for restart attempts to prevent tight loops

### Responsiveness Monitoring

Beyond basic health checks, monitor daemon responsiveness:

```typescript
const startTime = Date.now();
const response = await fetch(`http://localhost:${port}/health`);
const responseTime = Date.now() - startTime;

if (responseTime > SLOW_RESPONSE_THRESHOLD) {
  // Consider daemon degraded - may need restart
}
```

## Procedure F: Update Application Workflow

### Safe Daemon Replacement During Updates

**Update coordination sequence:**
1. **Download and validate** new daemon binary
2. **Coordinate with running sessions** - warn of pending restart
3. **Graceful eviction** of current daemon
4. **Apply update** and install new binary
5. **Spawn updated daemon** with preserved configuration
6. **Execute migration tasks** for new version
7. **Validate successful startup** before completing update

### State Preservation Across Updates

**Critical state to preserve:**
- Active session connections and state
- In-progress operations and their context
- Configuration and preferences
- Database state and transaction integrity

```bash
# Pre-update state capture
myco daemon snapshot --output .myco/pre-update-snapshot.json

# Post-update state restoration
myco daemon restore --input .myco/pre-update-snapshot.json
```

### Migration Task Execution

New versions may require data migrations or configuration updates:

```typescript
// Migration tasks run automatically on daemon startup
const pendingMigrations = await getPendingMigrations();
for (const migration of pendingMigrations) {
  await executeMigration(migration);
  await markMigrationComplete(migration);
}
```

## Cross-Cutting Gotchas

### Race Conditions and Port Conflicts

**Double-daemon restart gotcha:** When restarting a daemon, always wait for the old process to fully exit before starting the new one. Starting immediately can cause:
- Port binding conflicts (new daemon can't bind to old port)
- Orphaned PID files pointing to wrong process
- Resource contention between old and new processes

**Prevention:** Use `waitForExit: true` in eviction calls and verify port release.

### Orphaned PID Issues

**Stale daemon.json detection:** Always validate that the PID in daemon.json corresponds to an actual running daemon process:

```bash
# Wrong - trusting daemon.json blindly
kill $(jq -r '.pid' .myco/daemon.json)

# Correct - validate PID first
DAEMON_PID=$(jq -r '.pid' .myco/daemon.json)
if kill -0 $DAEMON_PID 2>/dev/null; then
  kill -TERM $DAEMON_PID
else
  echo "Stale PID - cleaning up daemon.json"
  rm .myco/daemon.json
fi
```

### Resource Cleanup Patterns

**Database connection management:** Ensure database connections are properly closed during daemon shutdown to prevent connection pool exhaustion:

```typescript
process.on('SIGTERM', async () => {
  await database.close();
  await server.close();
  process.exit(0);
});
```

**Temporary file cleanup:** Clean up temporary files and resources on abnormal termination:

```typescript
// Register cleanup handlers
process.on('exit', cleanupResources);
process.on('SIGINT', cleanupResources);
process.on('SIGTERM', cleanupResources);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  cleanupResources();
  process.exit(1);
});
```

### Multi-Instance Coordination Pitfalls

**Runtime detection accuracy:** When detecting runtime changes (Node vs Bun), ensure binary path comparison accounts for symlinks and PATH resolution:

```bash
# Resolve symlinks for accurate comparison
CURRENT_BIN=$(readlink -f $(jq -r '.binaryPath' .myco/daemon.json))
NEW_BIN=$(readlink -f $(which myco))
```

**Port scanning scope:** When scanning for daemon processes, use appropriate port ranges and timeouts to avoid false positives from other applications using nearby ports.

**Version-Sync Loop Hazard:** Prevent infinite restart loops by ensuring `runtime.command` in configuration matches the binary performing version-sync operations. Mismatches cause each restart to hand control to a different binary, creating an endless cycle.

**Runtime Command File Synchronization:** The runtime command file (`.myco/runtime.command`) must stay synchronized with daemon.json binaryPath. Drift between these two sources can cause update coordination failures and version-sync instability. Always validate consistency and repair mismatches during daemon health checks.

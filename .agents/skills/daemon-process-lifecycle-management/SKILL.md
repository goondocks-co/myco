---
name: myco:daemon-process-lifecycle-management
description: >
  Comprehensive procedures for managing Myco daemon process lifecycle including
  startup robustness, unified eviction and restart workflows, process identity
  management, multi-instance coordination, health checking, update application,
  npm package upgrade handling, daemon binary version mismatch detection,
  event-loop safety patterns, lag monitoring, yield points, and resource cleanup.
  Covers operational daemon management patterns from auto-spawn and migration tasks
  through SIGTERM/SIGKILL sequences to port release verification, cross-runtime
  coordination, and event loop responsiveness protection. Use when starting,
  restarting, updating, or coordinating daemon processes, even if the user
  doesn't explicitly ask for daemon lifecycle management.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon Process Lifecycle and Eviction Management

Myco daemon processes require careful lifecycle management to ensure reliable operation across restarts, updates, and multi-instance scenarios. With Grove architecture, the daemon operates as a global system service managing multiple groves and projects through centralized coordination patterns.

## Prerequisites

- Myco Grove installation with global daemon (~/.myco/groves/ architecture)
- Understanding of process signals (SIGTERM, SIGKILL) and port management
- Access to global daemon state in ~/.myco/daemon.json
- Basic knowledge of process discovery and PID validation concepts
- Understanding of grove-scoped resource management
- Hub package no longer required — global daemon replaces Hub functionality
- Understanding of Node.js event loop fundamentals (libuv, microtasks vs macrotasks)
- Access to daemon codebase in packages/myco/src/daemon/
- Familiarity with async/await patterns and AbortController usage

## Procedure A: Daemon Startup and Robustness

### Service-Aware Daemon Control via launchd Integration

**Critical architecture**: Grove's launchd service installer (PR #267) creates a permanent service (co.goondocks.myco-dev) with KeepAlive=true. This fundamentally changes daemon control from direct process management to service-aware coordination:

```typescript
// Service-Aware Daemon Control - Three Unified Code Paths
async function serviceAwareDaemonControl(action: 'start' | 'restart' | 'stop'): Promise<void> {
  const serviceId = 'co.goondocks.myco-dev';
  
  switch (action) {
    case 'start':
      await execAsync(`launchctl start ${serviceId}`);
      break;
    case 'restart':
      await execAsync(`launchctl stop ${serviceId}`);
      await delay(1000);
      await execAsync(`launchctl start ${serviceId}`);
      break;
    case 'stop':
      await execAsync(`launchctl stop ${serviceId}`);
      break;
  }
}
```

### Global Daemon Auto-Spawn via DaemonClient

Grove architecture uses a global daemon that manages all projects through centralized DaemonClient:

**Global startup sequence:**
1. Check global daemon health via /health endpoint on global port
2. Validate ~/.myco/daemon.json - ensure PID exists and matches running process
3. Spawn if needed - 3-second coalesce window deduplicates spawn attempts across projects
4. Execute migration tasks from registry on successful startup
5. Update ~/.myco/daemon.json with new PID, port, and binary path
6. Initialize grove coordination - scan for existing groves and projects
7. Initialize Grove runtime cache with bounded LRU management

### Three-Tier Daemon Discovery and Self-Reconciliation Pattern

**Critical discovery** (v0.27.17): The daemon's initialization must follow three distinct tiers to prevent resource conflicts and enable safe cleanup of stale process records:

1. **Tier 1 — Process discovery and feasibility check**: Before allocating port or lock, check if an existing daemon is alive
   ```typescript
   const existingDaemon = await checkForExistingDaemon(); // kill -0 probe
   if (existingDaemon?.healthy) {
     logger.info('Healthy daemon already running, stepping aside');
     return { shouldStepAside: true }; // Step aside, don't contend
   }
   ```

2. **Tier 2 — Port claim and exclusive lock acquisition**: After confirming no healthy daemon, claim the port and acquire lock before any expensive operations
   ```typescript
   const port = await claimPort(20915); // Fail fast if port contested
   if (!port.claimed) {
     throw new Error(`Port 20915 already in use, cannot proceed`);
   }
   const lock = await db.acquireLock('daemon-startup'); // Serialize startups
   ```

3. **Tier 3 — Expensive database operations and initialization**: Only after Tier 1 and Tier 2 are satisfied, perform schema migrations and FTS rebuilds
   ```typescript
   await migrateDatabaseSchema(); // Safe from conflicts now
   await initializePowerManager();
   ```

**Why the order matters**: Reversing this causes "database is locked" errors. If you rebuild FTS before claiming the port, multiple daemon instances can attempt FTS simultaneously, deadlocking the database.

### Self-Reconciliation Interval Pattern

**New operational pattern** (v0.27.17): Daemon must periodically reconcile its own state and detect stale process records:

```typescript
// Run every 5 minutes during daemon operation
async function runDaemonSelfReconciliation() {
  const daemonRecord = JSON.parse(fs.readFileSync('~/.myco/daemon.json', 'utf-8'));
  
  // Check: Does the recorded PID still exist?
  try {
    process.kill(daemonRecord.pid, 0); // No-op signal probe
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Recorded PID is dead - reconcile by updating record
      logger.warn(`Daemon record points to dead PID ${daemonRecord.pid}, reconciling...`);
      daemonRecord.pid = process.pid;
      fs.writeFileSync('~/.myco/daemon.json', JSON.stringify(daemonRecord, null, 2));
    }
  }
  
  // Check: Is the recorded port what we're actually using?
  const actualPort = server.address().port;
  if (daemonRecord.port !== actualPort) {
    logger.warn(`Port mismatch in daemon record, reconciling...`);
    daemonRecord.port = actualPort;
    fs.writeFileSync('~/.myco/daemon.json', JSON.stringify(daemonRecord, null, 2));
  }
}
```

Schedule this to run continuously:
```typescript
setInterval(runDaemonSelfReconciliation, 5 * 60 * 1000); // Every 5 minutes
```

### NPM Package Upgrade Binary Version Mismatch Detection

**Critical issue**: npm install -g @goondocks/myco@latest doesn't restart daemon, causing stale binary to serve incorrect responses.

```bash
# Detect binary version mismatch after npm upgrade
RUNNING_VERSION=$(curl -s http://localhost:$(jq -r '.port' ~/.myco/daemon.json)/health | jq -r '.version' 2>/dev/null || echo "unknown")
INSTALLED_VERSION=$(myco --version 2>/dev/null | grep -o 'v[0-9.]\+' || echo "unknown")

if [ "$RUNNING_VERSION" != "unknown" ] && [ "$INSTALLED_VERSION" != "unknown" ]; then
  if [ "$RUNNING_VERSION" != "$INSTALLED_VERSION" ]; then
    echo "Binary version mismatch detected - restarting daemon to sync versions..."
    myco daemon restart --force-version-sync
  fi
fi
```

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
  
  pinHandle(groveId: string, handle: CachedHandle): void {
    this.pinnedHandles.set(groveId, handle);
    this.lruCache.delete(groveId);
  }
  
  unpinHandle(groveId: string): void {
    const handle = this.pinnedHandles.get(groveId);
    if (handle && !this.isExpired(handle)) {
      this.lruCache.set(groveId, handle);
    }
    this.pinnedHandles.delete(groveId);
  }
}
```

### Grove Boundary Violation Prevention

**Critical pattern**: Prevent grove boundary violations in forEachGrove() operations:

```typescript
// WRONG: Grove boundary violation pattern
async function dangerousGroveOperation() {
  await forEachGrove(async (grove) => {
    const binding = await resolveProjectGroveBinding(grove.projectId); // BOUNDARY VIOLATION
    await grove.manifestOperations(binding);
  });
}

// RIGHT: Resolve bindings before grove iteration
async function safeGroveOperation() {
  const groveContexts = [];
  await forEachGrove(async (grove) => {
    groveContexts.push({ grove: grove, projectId: grove.projectId });
  });
  
  for (const context of groveContexts) {
    const binding = await resolveProjectGroveBinding(context.projectId);
    await context.grove.manifestOperations(binding); // Safe - proper ownership
  }
}
```

## Procedure B: Unified Eviction and Restart

### Service-Aware Eviction with launchd Coordination

With launchd service management, eviction must coordinate with the service to prevent double-spawning:

```typescript
// Service-aware daemon eviction
async function serviceAwareDaemonEviction(): Promise<void> {
  const serviceId = 'co.goondocks.myco-dev';
  
  // 1. Notify groves of pending shutdown
  await notifyGrovesShutdown();
  
  // 2. Stop via launchd (prevents automatic respawn)
  await execAsync(`launchctl stop ${serviceId}`);
  
  // 3. Verify process termination
  const daemonState = JSON.parse(fs.readFileSync('~/.myco/daemon.json', 'utf8'));
  if (daemonState.pid && isProcessRunning(daemonState.pid)) {
    process.kill(daemonState.pid, 'SIGKILL');
  }
  
  // 4. Clean up daemon.json
  fs.unlinkSync('~/.myco/daemon.json');
}
```

### SIGTERM → SIGKILL Sequence

**Global daemon eviction flow:**
1. Send grove notifications - inform all connected projects of pending shutdown
2. Send SIGTERM to global daemon process for graceful shutdown
3. Wait grace period (default 5 seconds) for grove coordination completion
4. Send SIGKILL if process still running after grace period
5. Verify global port release to prevent port collision on restart
6. Clean up ~/.myco/daemon.json once process confirmed terminated

### Five Daemon Restart Failure Modes and Mitigations (All Resolved)

**Critical wisdom**: Daemon restarts during active sessions trigger five distinct failure modes that now have comprehensive mitigations:

#### Mode 1: Parallel Spawn Race (Multiple Daemons Launch Simultaneously)
**Symptoms**: Multiple daemon processes, port conflict errors, inconsistent daemon.json state
**Mitigation**: 3-second coalesce window in spawn logic, atomic daemon.json updates, process discovery verification

#### Mode 2: Port Binding Collision (Previous Process Holds Port)
**Symptoms**: "Port already in use" errors, new daemon fails to start, stale process detection
**Mitigation**: SIGTERM → SIGKILL sequence with port release verification, process cleanup before spawn

#### Mode 3: Stale Process Lingering (Old Daemon Orphaned)
**Symptoms**: Healthy new daemon but stale processes consuming resources, confusion in process discovery
**Mitigation**: PID validation via kill -0, cleanup of orphaned processes, daemon.json reconciliation

#### Mode 4: MCP Bridge Reconnect Failure (Session Tool Loss) — **RESOLVED**
**Resolution**: MCP stdio bridge now includes automatic daemon-restart recovery with indefinite reconnect capability

```typescript
// MCP Bridge Auto-Recovery (v0.27.11+)
class McpStdioBridge {
  private static readonly DAEMON_HEARTBEAT_INTERVAL_MS = 5000;
  
  async startDaemonHeartbeat(): Promise<void> {
    setInterval(async () => {
      try {
        await this.checkDaemonHealth();
      } catch (error) {
        console.log('Daemon unreachable - attempting reconnect...');
        await this.attemptReconnect();
      }
    }, this.DAEMON_HEARTBEAT_INTERVAL_MS);
  }
  
  async attemptReconnect(): Promise<void> {
    const newDaemonState = await this.readDaemonState();
    this.daemonPort = newDaemonState.port;
    await this.validateMcpConnection();
    console.log('MCP bridge reconnected successfully');
  }
}
```

#### Mode 5: Self-Update Double-Respawn Race (launchd + Manual Spawn Conflict) — **RESOLVED**
**Resolution pattern**:
```typescript
// Self-update with service-aware coordination
async function selfUpdateWithServiceCoordination(): Promise<void> {
  const serviceId = 'co.goondocks.myco-dev';
  
  // 1. Disable automatic respawn during update
  await execAsync(`launchctl unload -w ~/Library/LaunchAgents/${serviceId}.plist`);
  
  // 2. Stop daemon manually (no respawn)
  await stopDaemonDirect();
  
  // 3. Apply update
  await applyBinaryUpdate();
  
  // 4. Re-enable service and start
  await execAsync(`launchctl load -w ~/Library/LaunchAgents/${serviceId}.plist`);
  await execAsync(`launchctl start ${serviceId}`);
}
```

(Rest of content continues as in original skill...)

## Cross-Cutting Gotchas

### Three-Tier Startup Ordering

**Tier ordering gotcha**: The three-tier startup discovery pattern (process check → port claim → expensive ops) must be strictly maintained. Reordering causes FTS rebuild races and "database is locked" errors. Always check for existing daemon and claim port BEFORE migrations.
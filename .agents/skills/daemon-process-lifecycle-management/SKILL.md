---
name: myco:daemon-process-lifecycle-management
description: |
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

- Myco Grove installation with global daemon (`~/.myco/groves/` architecture)
- Understanding of process signals (SIGTERM, SIGKILL) and port management
- Access to global daemon state in `~/.myco/daemon.json`
- Basic knowledge of process discovery and PID validation concepts
- Understanding of grove-scoped resource management
- **Hub package no longer required** — global daemon replaces Hub functionality
- Understanding of Node.js event loop fundamentals (libuv, microtasks vs macrotasks)
- Access to daemon codebase in `packages/myco/src/daemon/`
- Familiarity with async/await patterns and AbortController usage

## Procedure A: Daemon Startup and Robustness

### Service-Aware Daemon Control via launchd Integration

**Critical architecture**: Grove's launchd service installer (PR #267) creates a permanent service (`co.goondocks.myco-dev`) with `KeepAlive=true`. This fundamentally changes daemon control from direct process management to service-aware coordination:

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

Grove architecture uses a global daemon that manages all projects through centralized `DaemonClient`:

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

**Critical pattern**: Prevent grove boundary violations in `forEachGrove()` operations:

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
1. **Send grove notifications** - inform all connected projects of pending shutdown
2. **Send SIGTERM** to global daemon process for graceful shutdown
3. **Wait grace period** (default 5 seconds) for grove coordination completion
4. **Send SIGKILL** if process still running after grace period
5. **Verify global port release** to prevent port collision on restart
6. **Clean up ~/.myco/daemon.json** once process confirmed terminated

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

### Global PID Validation Patterns

```bash
# Check if global daemon PID is running
DAEMON_PID=$(jq -r '.pid' ~/.myco/daemon.json)
if ! kill -0 $DAEMON_PID 2>/dev/null; then
  echo "Stale global daemon.json - PID $DAEMON_PID not running"
  rm ~/.myco/daemon.json
fi
```

## Procedure D: Multi-Instance Coordination

### Multi-Tenant Single-Port vs Per-Vault Port Design

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
  try {
    const groveId = req.headers['x-grove-id'] || 'default';
    
    await validateDatabaseConnection(groveId);
    await validateGroveCoordination(groveId);
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
  
  const toolActivity = session.activities
    ?.filter(a => a.type === 'tool_use')
    ?.reduce((latest, activity) => Math.max(latest, activity.timestamp), 0) || 0;
  
  return Math.max(messageActivity, toolActivity);
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

## Procedure G: Multi-Environment Isolation and Grove Ownership

### Grove Ownership Enforcement

```typescript
// Ownership validation function
async function validateOwnership(grove: Grove, operation: string): Promise<void> {
  const currentVariant = daemonVariant(daemonStateDir);
  if (grove.served_by !== currentVariant) {
    throw new Error(`Cannot ${operation} grove ${grove.id}: owned by ${grove.served_by}, not ${currentVariant}`);
  }
}

// Add ownership validation to Grove iteration
forEachGrove((grove) => {
  if (grove.served_by !== currentDaemonVariant) {
    return; // Skip groves not owned by this daemon
  }
  // Proceed with grove operations
});
```

## Procedure H: Event Loop Safety and Responsiveness

### Event Loop Lag Monitoring

Set up always-on observability to detect when the event loop becomes unresponsive:

```typescript
export class EventLoopLagProbe {
  private intervalMs: number;
  private warnThresholdMs: number;
  private timerId: NodeJS.Timeout | null = null;
  private stats = { peakLag: 0, stallCount: 0 };

  constructor(intervalMs = 250, warnThresholdMs = 500) {
    this.intervalMs = intervalMs;
    this.warnThresholdMs = warnThresholdMs;
  }

  start() {
    this.scheduleNext();
  }

  private scheduleNext() {
    const start = Date.now();
    this.timerId = setTimeout(() => {
      const lag = Date.now() - start - this.intervalMs;
      if (lag > this.warnThresholdMs) {
        logger.warn('daemon.lag', { lagMs: lag });
        this.stats.stallCount++;
      }
      this.stats.peakLag = Math.max(this.stats.peakLag, lag);
      this.scheduleNext();
    }, this.intervalMs);
  }

  stop() {
    if (this.timerId) clearTimeout(this.timerId);
  }

  getStats() { return { ...this.stats }; }
}
```

**Wire into daemon lifecycle** in `main.ts`:
```typescript
const lagProbe = new EventLoopLagProbe();
lagProbe.start();
// In shutdown handler: lagProbe.stop();
```

### Instrumented Fetch with Yield Points

Create fetch wrappers that prevent blocking I/O from starving the event loop:

```typescript
export function createInstrumentedFetch(options: {
  component: string;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
}): FetchLike {
  const { component, headersTimeoutMs = 60000, idleTimeoutMs = 30000 } = options;
  
  return async function instrumentedFetch(input, init) {
    const requestId = crypto.randomUUID().slice(0, 8);
    const url = typeof input === 'string' ? input : input.url;
    logger.debug('fetch.start', { component, requestId, url: redactUrl(url) });

    const composedSignal = composeAbortSignals([
      AbortSignal.timeout(headersTimeoutMs),
      createIdleWatchdog(idleTimeoutMs),
      init?.signal
    ]);

    const response = await fetch(input, { ...init, signal: composedSignal });
    
    // Wrap body to yield between chunks
    if (response.body) {
      response.body = wrapBodyWithYields(response.body, requestId, component);
    }

    return response;
  };
}

function wrapBodyWithYields(body: ReadableStream, requestId: string, component: string) {
  return new ReadableStream({
    start(controller) {
      const reader = body.getReader();
      let chunkCount = 0;

      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            logger.debug('fetch.complete', { component, requestId, chunkCount });
            return;
          }
          chunkCount++;
          controller.enqueue(value);
          
          // Yield to libuv between chunks
          setImmediate(pump);
        }).catch(error => {
          controller.error(error);
          logger.warn('fetch.abort', { component, requestId, error: error.message });
        });
      }
      pump();
    }
  });
}
```

### Strategic Yield Points

Insert strategic yield points in sync-heavy async operations:

```typescript
// Between processing waves
async function processInWaves<T>(items: T[], waveSize: number, processor: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += waveSize) {
    const wave = items.slice(i, i + waveSize);
    await Promise.allSettled(wave.map(processor));
    
    // Yield between waves to allow timers/I/O to fire
    await new Promise(resolve => setImmediate(resolve));
  }
}

// In message stream consumption
for await (const message of messageStream) {
  await processMessage(message);
  await new Promise(resolve => setImmediate(resolve)); // Prevent microtask saturation
}
```

**Critical locations in Myco daemon:**
- `agent/harness/claude.ts:117` - Claude SDK message stream consumption
- `phase-loop.ts:680` - Between wave processing
- `openai-local-mcp.ts:64` - After MCP tool handler calls
- `release-provenance/reconcile.ts` - Per row, per ref, every 32 commits

### Event Loop Starvation Diagnosis

**Systematic approach to identify blocking issues:**

1. **Reproduce the starvation**:
   ```bash
   # Set up concurrent /health probing
   watch -n 0.1 'curl -w "%{time_total}s\n" -s localhost:8080/health' &
   # Run suspected operation and look for timeout/latency spikes
   ```

2. **Use profiling to identify hot paths**:
   ```bash
   # macOS: Sample the process during starvation
   sudo sample $(pgrep -f myco-daemon) 10 -file daemon-profile.txt
   ```

3. **Check existing observability**:
   - Look for `daemon.lag` warnings in logs during starvation window
   - Check fetch instrumentation logs for stuck requests
   - Verify component correlation (claude-sdk, release-provenance)

### Event-Loop-Aware Graceful Shutdown

Prevent shutdown hangs that block daemon restarts:

```typescript
async function runShutdown(signal: string) {
  logger.info('daemon.shutdown.start', { signal });
  
  // Drain in-flight work with timeout
  await inflightRuns.drain(30000); // 30s grace period
  
  // Fast shutdown - replace long keep-alive drain
  server.closeIdleConnections();
  await Promise.race([
    server.stop(),
    new Promise(resolve => setTimeout(resolve, 100)) // 100ms max wait
  ]);
  
  logger.info('daemon.shutdown.complete');
}
```

### Responsiveness Testing

Build verification that ensures changes don't introduce new starvation:

```typescript
test('daemon maintains responsiveness during heavy async work', async () => {
  // Start loopback HTTP server for /health simulation
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    }
  });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const heavyWork = simulateHeavyAsyncWork();
  
  // Probe /health throughout the work
  const probeResults = [];
  const probeInterval = setInterval(async () => {
    const start = Date.now();
    try {
      await fetch(`http://localhost:${port}/health`);
      probeResults.push(Date.now() - start);
    } catch (error) {
      probeResults.push(Infinity); // Timeout/error
    }
  }, 100);

  await heavyWork;
  clearInterval(probeInterval);
  
  // Assert max latency < 200ms
  const maxLatency = Math.max(...probeResults);
  expect(maxLatency).toBeLessThan(200);
});
```

## Cross-Cutting Gotchas

### Service-Aware Operations

**launchd coordination gotcha**: Always coordinate with launchd service when managing daemon lifecycle to prevent double-spawning. Use service-aware control functions that coordinate with launchd.

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

### Event Loop Management

**Microtask vs macrotask confusion**: `setImmediate` yields to libuv (timers, I/O), but `Promise.resolve().then(...)` stays in microtasks. Use `setImmediate` for true yields.

**AbortSignal composition**: When adding timeouts to existing AbortSignal-aware APIs, compose signals rather than replacing them. Watch for deadlocks where `reader.read()` doesn't observe AbortSignals directly.

**Yield point granularity**: Too frequent yields hurt performance; too sparse yields don't help responsiveness. Start with logical boundaries (end of message processing, end of row processing) and measure.

**Profiling misdirection**: `posix_spawn` storms in profiles often come from sync shellouts (`runGit`) rather than the async operation you're investigating. Follow the call stacks carefully.

**Shutdown composition**: Multiple large timeout budgets in sequence (30s + 60s) can surprise developers expecting quick restart cycles. Consider fast-shutdown paths for development.

### Grove Ownership and Multi-Environment Coordination

**Always validate Grove ownership** using `validateOwnership()` before any mutation operation - shared code paths can easily bypass scope boundaries

**Request context propagation gaps** - any database query path without request context creates potential cross-project data leakage. All DB operations must validate and include project scoping.
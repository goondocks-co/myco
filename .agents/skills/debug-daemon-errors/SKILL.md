---
name: myco:debug-daemon-errors
description: |
  Use this skill whenever the Myco daemon is misbehaving — even if the user doesn't explicitly ask for a debugging procedure. Activates for: daemon process crashes, uncaught exceptions, FK constraint violations, PowerManager jobs not firing, scheduler starvation, outbox drain loops, duplicate or phantom sessions, executor tasks that silently succeed or stall, and any log output from the daemon's core subsystems (PowerManager, SQLite, outbox, session lifecycle, phased executor). This is the cross-cutting playbook for investigating, tracing, and surgically fixing daemon-layer bugs — distinct from debugging agent task YAML, schema migrations, or outbox architecture design.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Debug Production Daemon Errors

The Myco daemon is a long-running process that hosts multiple subsystems: a PowerManager job scheduler, SQLite-backed state, an outbox drain loop, session lifecycle tracking, and a phased task executor. Bugs in each subsystem have distinct failure signatures and require different surgical fixes. This skill teaches you how to identify which subsystem is implicated, trace to the root cause, apply a minimal fix, and prevent regression.

## Prerequisites

- Daemon is running (or you have daemon logs from a failed run)
- You have access to the SQLite vault at `.myco/myco.db`
- You can restart the daemon process to confirm a fix

---

## Step 1 — Read the Logs Before Touching Code

Daemon logs are the ground truth. Before forming any hypothesis, capture the exact sequence of events.

```bash
# Tail live daemon output
myco daemon:logs --follow

# Or inspect the log file directly
cat ~/.myco/daemon.log | tail -200
```

Look for the **first anomalous line**, not just the error message. Record:
- The timestamp of the first unexpected event
- The subsystem prefix in the log line (e.g., `[PowerManager]`, `[Outbox]`, `[Session]`, `[Executor]`)
- Whether the error is a hard crash, a silent return, or a loop

**Pitfall:** Don't jump to fixing based on the exception message alone. `FOREIGN KEY constraint failed` looks like a schema bug but is almost always a deletion order problem.

---

## Step 2 — Map the Error to Its Subsystem

Each daemon subsystem has a distinct failure signature:

| Subsystem | Failure Signature |
|-----------|-------------------|
| **PowerManager** | A registered job stops firing after initial runs; scheduler log goes quiet |
| **SQLite FK cascade** | `FOREIGN KEY constraint failed` on delete; orphaned child rows after parent deletion |
| **Outbox drain** | Drain runs on every tick but the same records never leave; loop visible in logs |
| **Session lifecycle** | Two sessions created for one conversation; session ID missing mid-run |
| **Session maintenance** | Active sessions vanish mid-run; sessions deleted with no explicit error |
| **Executor (phased tasks)** | Task status transitions to `complete` or `failed` silently; no error thrown |
| **Timeout cascade failure** | Task shows *"process aborted by user"* when no user action occurred |
| **Self-mutation discipline** | Daemon corrupts its own state during normal operations; daemon.json becomes invalid after restart |
| **Daemon restart/reconciliation** | PID conflicts, EPERM errors, MCP bridge indefinite reconnect loops |
| **Daemon startup ordering** | "Database is locked" errors during startup due to FTS rebuild before port-claim |

---

## Step 3 — Trace the Root Cause (Subsystem Playbooks)

### PowerManager — Scheduler Starvation

**Trace:** Check whether `scheduleNextRun` is called after inserting new work.

**Fix pattern:**
```typescript
await db.insert(workTable).values(newWork);
scheduler.wake(); // ensure this exists in every insert path
```

### SQLite FK Cascade — Wrong Deletion Order

**Trace:** SQLite enforces FK constraints at statement time. Check the schema for `REFERENCES parent_table(id)` relationships.

**Fix pattern:** Always delete children before parents:
```typescript
await db.transaction(async (tx) => {
  await tx.delete(childTable).where(eq(childTable.parentId, id));
  await tx.delete(parentTable).where(eq(parentTable.id, id));
});
```

#### deleteSessionCascade — Complex FK Cascade Patterns

The `deleteSessionCascade` function demonstrates the most complex FK scenario. **Correct delete order:**
```typescript
// activities → attachments → plans → skill_usage → resolution_events → graph_edges → spores → prompt_batches → sessions
```

**Extension checklist:** When adding tables with session FKs:
1. Add the new table delete to `deleteSessionCascade` in correct FK order
2. Update the return type to include the new table count
3. Add regression test that creates FK links to verify cascade delete works

### Session Maintenance — Over-Aggressive Dead-Session Cleanup

**Problem:** `findDeadSessionIds()` may delete real sessions due to two bugs:
1. `DEAD_SESSION_MAX_PROMPTS` threshold too high
2. Missing `status != 'active'` filter

**Fix pattern:**
```typescript
const DEAD_SESSION_MAX_PROMPTS = 0; // only truly empty sessions qualify

export function findDeadSessionIds(registeredSessionIds: string[]): string[] {
  return db.select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        lte(sessions.promptCount, DEAD_SESSION_MAX_PROMPTS),
        ne(sessions.status, 'active'),          // required guard
        notInArray(sessions.id, registeredSessionIds),
      )
    );
}
```

### Executor — Phase Transition Under Dead AbortController

**Problem:** Phase 1 times out and calls `abort()`, then phase 2 runs with the same (dead) `AbortController`.

**Fix pattern:** Create fresh `AbortController` for each phase:
```typescript
for (const phase of task.phases) {
  const phaseController = new AbortController();  // Fresh per phase
  const phaseTimeout = setTimeout(() => phaseController.abort(), config.phaseTimeoutSeconds * 1000);

  try {
    const result = await runPhase(phase, phaseController);
    clearTimeout(phaseTimeout);
    return result;
  } catch (err) {
    clearTimeout(phaseTimeout);
    if (err.name === 'AbortError') {
      logger.warn(`Phase ${phase.name} timeout after ${config.phaseTimeoutSeconds}s`);
      continue; // Try next phase with fresh controller
    }
    throw err;
  }
}
```

### Executor — Status Swallowing

**Problem:** Executor catches exceptions and records `complete` instead of `failed`.

**Fix pattern:** Never record `complete` in a `catch` block:
```typescript
try {
  const result = await runPhase(task, phase);
  await markComplete(task.id, result);
} catch (err) {
  await markFailed(task.id, err.message);
  logger.error('[Executor] Phase failed', { taskId: task.id, err });
  throw err;
}
```

### Daemon Startup Ordering — FTS Rebuild Before Port-Claim Bug

**Problem:** The daemon's "step-aside if a healthy sibling is alive" check fires after `ensureSelfInstalledAsService` and after schema migration (including FTS rebuild). This ordering allows an orphan daemon to perform expensive FTS rebuild operations while another daemon instance is starting, leading to "database is locked" errors.

**Root cause sequence:**
1. Daemon A starts and begins schema migration including FTS rebuild
2. Daemon B starts and also begins schema migration including FTS rebuild  
3. Both daemons hold database locks during FTS operations
4. Daemon A reaches port-claim and finds port 20915 occupied
5. Daemon A should step aside but has already performed expensive FTS work
6. Result: "database is locked" errors and wasted computation

**Fix pattern:** Move the port-claim check before expensive database operations:
```typescript
// In src/daemon/main.ts - CORRECTED startup order
export async function startDaemon(opts: StartDaemonOptions) {
  // 1. FIRST: Check if we should step aside for existing healthy daemon
  const existingDaemon = await checkForExistingDaemon();
  if (existingDaemon?.healthy) {
    logger.info('Healthy daemon already running, stepping aside');
    return { shouldStepAside: true, existingPid: existingDaemon.pid };
  }

  // 2. SECOND: Claim port early to prevent other daemon startup attempts
  const port = await claimPort(opts.port || 20915);
  if (!port.claimed) {
    throw new Error(`Port ${opts.port} claimed by another process during startup`);
  }

  // 3. THIRD: Now safe to perform expensive database operations
  await ensureSelfInstalledAsService(opts);
  await migrateDatabaseSchema(); // Includes FTS rebuild - now safe from conflicts
  
  // 4. Continue with normal startup...
  const powerManager = await initializePowerManager();
  // ... rest of startup
}

// Port claim should be atomic and fail fast
async function claimPort(port: number): Promise<{ claimed: boolean; conflictPid?: number }> {
  try {
    const server = await createServer().listen(port);
    return { claimed: true, server };
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const conflictPid = await findProcessUsingPort(port);
      return { claimed: false, conflictPid };
    }
    throw err;
  }
}
```

**Diagnostic pattern for startup ordering bugs:**
```bash
# Look for this failure signature in logs
grep -B 10 -A 5 "database is locked" ~/.myco/daemon.log
grep -B 5 -A 5 "FTS.*rebuild\|FTS.*index" ~/.myco/daemon.log

# Check for multiple daemon startup attempts
grep -E "Starting daemon|Port.*already in use|Stepping aside" ~/.myco/daemon.log | tail -20
```

**Prevention pattern:** Always check for resource conflicts before expensive operations:
```typescript
// Pattern: check-then-claim-then-work, not work-then-check
async function expensiveStartupOperation() {
  // 1. Check if we should proceed
  const shouldProceed = await checkPreconditions();
  if (!shouldProceed) return;

  // 2. Claim exclusive access to shared resources  
  const lock = await claimExclusiveLock();
  if (!lock.acquired) throw new Error('Resource conflict');

  // 3. Now safe to do expensive work
  await performExpensiveWork();
}
```

---

## Step 4 — Daemon Restart and PID Reconciliation Failures

### EPERM Livelock in reconcileExistingDaemon

**Problem:** When daemon restart encounters an existing daemon.json with a stale PID, `reconcileExistingDaemon` can enter an EPERM livelock where repeated `process.kill(pid, 0)` calls fail with EPERM but the function keeps retrying without resolution.

**Root cause:** The kill-probe doesn't distinguish between "process doesn't exist" (ESRCH, safe to proceed) and "process exists but we can't signal it" (EPERM, uncertain state).

**Fix pattern:** Treat EPERM as "uncertain" and escalate to user decision rather than looping:
```typescript
export async function reconcileExistingDaemon(existingRecord: DaemonRecord): Promise<'cleared' | 'escalate'> {
  try {
    // Probe with kill signal 0 (no-op probe)
    process.kill(existingRecord.pid, 0);
    // If we get here, process exists and we can signal it
    logger.info(`Found existing daemon process ${existingRecord.pid}, attempting clean shutdown`);
    process.kill(existingRecord.pid, 'SIGTERM');
    await waitForProcessExit(existingRecord.pid, { timeoutMs: 10000 });
    return 'cleared';
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process doesn't exist, safe to clear the record
      logger.info(`Daemon record points to non-existent process ${existingRecord.pid}, clearing stale record`);
      return 'cleared';
    } else if (err.code === 'EPERM') {
      // Process may exist but we can't signal it - escalate to user
      logger.warn(`Cannot signal existing daemon process ${existingRecord.pid} (EPERM). Manual intervention required.`);
      console.error(`Existing daemon process ${existingRecord.pid} is running but not accessible.`);
      console.error(`Please manually stop the process or run: sudo kill ${existingRecord.pid}`);
      return 'escalate';
    } else {
      throw err; // Unexpected error
    }
  }
}
```

### daemon.json Deletion Via Third-Contender Reconciliation: ownerPid Guard Fix

**Problem:** During concurrent daemon startup, a third-contender scenario can occur where:
1. Two daemons (A and B) start concurrently
2. Daemon A finds daemon.json with pid X
3. Daemon A signals pid X (kills it)
4. Daemon B independently kills the same pid X
5. Both A and B attempt to delete daemon.json, creating a race

This causes spurious "no daemon found" errors during restart even when processes are coordinating cleanly.

**Root cause:** `removeDaemonState()` doesn't verify that the process being killed actually owned daemon.json before deletion.

**Fix pattern:** Verify ownerPid before deletion:

```typescript
// In packages/myco/src/daemon/service-state.ts
export async function removeDaemonState(
  currentDaemonRecord: DaemonRecord
): Promise<{ deleted: boolean; reason?: string }> {
  const daemonJsonPath = ServicePaths.getDaemonJsonPath();
  
  // Critical: Only delete if the PID we own matches what's in daemon.json
  // This prevents third-contender race where daemon B deletes A's daemon.json
  const existingRecord = await readDaemonJson();
  
  if (existingRecord && existingRecord.ownerPid !== currentDaemonRecord.ownerPid) {
    // Another daemon owns this daemon.json, don't touch it
    logger.warn(`daemon.json owned by different process (${existingRecord.ownerPid}), skipping deletion`);
    return { deleted: false, reason: 'owned-by-different-process' };
  }

  try {
    await fs.promises.unlink(daemonJsonPath);
    logger.info(`Removed daemon.json at ${daemonJsonPath}`);
    return { deleted: true };
  } catch (err) {
    if ((err as any).code === 'ENOENT') {
      // Already deleted by another contender, that's fine
      logger.info(`daemon.json already missing (deleted by concurrent process)`);
      return { deleted: true, reason: 'already-deleted' };
    }
    throw err;
  }
}

// Ensure ownerPid is set when creating daemon.json
export async function createDaemonRecord(): Promise<DaemonRecord> {
  return {
    id: generateId(),
    pid: process.pid,
    ownerPid: process.pid,  // Critical: track which process owns this record
    port: config.port,
    createdAt: Date.now(),
    healthyAt: Date.now()
  };
}
```

### Daemon Restart Failure Mode 4 — MCP Bridge Indefinite Reconnect

**Problem:** During daemon restart, if the MCP bridge connection fails to establish cleanly, it can enter an indefinite reconnect loop where the daemon appears to start successfully but the bridge never becomes functional.

**Diagnosis patterns:**
```bash
# Look for these log patterns indicating Mode 4 failure:
grep -A 5 -B 5 "MCP bridge.*reconnect" ~/.myco/daemon.log
grep "bridge.*timeout\|bridge.*failed" ~/.myco/daemon.log | tail -20
```

**Typical Mode 4 signature:**
```
[MCP] Bridge connection attempt 1 failed: connect ECONNREFUSED 127.0.0.1:3456
[MCP] Bridge connection attempt 2 failed: connect ECONNREFUSED 127.0.0.1:3456
[MCP] Bridge connection attempt 3 failed: connect ECONNREFUSED 127.0.0.1:3456
[MCP] Bridge reconnect exponential backoff, next attempt in 8000ms
[MCP] Bridge connection attempt 4 failed: connect ECONNREFUSED 127.0.0.1:3456
```

**Resolution procedure:**
```typescript
export async function resolveMcpBridgeLoopMode4() {
  // Step 1: Stop daemon cleanly to break the reconnect loop
  await stopDaemonProcess({ force: false, timeoutMs: 15000 });
  
  // Step 2: Clean any stale MCP bridge state
  await cleanupMcpBridgeState();
  
  // Step 3: Restart with bridge connection verification
  const startResult = await startDaemonWithBridgeVerification();
  
  if (!startResult.bridgeHealthy) {
    throw new Error('Daemon started but MCP bridge failed verification. Check daemon port conflicts.');
  }
  
  return startResult;
}

async function startDaemonWithBridgeVerification(): Promise<{ pid: number; bridgeHealthy: boolean }> {
  const daemon = await startDaemonProcess();
  
  // Wait for bridge to establish or timeout
  const bridgeHealthy = await waitForMcpBridgeReady({
    timeoutMs: 10000,
    healthCheckInterval: 500
  });
  
  return { pid: daemon.pid, bridgeHealthy };
}

async function waitForMcpBridgeReady({ timeoutMs, healthCheckInterval }: { timeoutMs: number; healthCheckInterval: number }): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Test bridge connectivity with a minimal request
      const response = await fetch('http://127.0.0.1:3456/mcp/health', { 
        timeout: 2000,
        headers: { 'X-Bridge-Health-Check': '1' }
      });
      
      if (response.ok) {
        logger.info('[MCP] Bridge health check passed');
        return true;
      }
    } catch (err) {
      // Bridge not ready yet, continue waiting
    }
    
    await new Promise(resolve => setTimeout(resolve, healthCheckInterval));
  }
  
  logger.warn('[MCP] Bridge health check timed out');
  return false;
}
```

**Prevention:** Always verify MCP bridge health after daemon restart before declaring the restart successful.

---

## Step 5 — Write the Regression Test First

Write a test that fails with the current code. This confirms you've identified the root cause.

Tests for daemon subsystems live in:
- `tests/daemon/` — unit tests for individual subsystem functions
- `tests/integration/` — integration tests that spin up the daemon

---

## Step 6 — Apply the Fix and Verify

1. Apply the minimal surgical fix
2. Run the targeted test first: confirm it goes green
3. Run full test suite: `npm test`
4. Restart daemon and smoke-test: `myco daemon:restart`

**Pitfall:** Resist refactoring while fixing. Make minimal changes that address the root cause.

---

## Step 7 — Diagnostic Logging for Session Type Disambiguation

**When:** Investigating phantom sessions or parent-child session relationships.

### Session Type Logging Strategy

```typescript
function createSessionWithDiagnostics(payload: SessionPayload) {
  const sessionType = payload.parentSessionId ? 'sub-agent' : 'user-fork';
  const context = {
    sessionId: payload.id,
    sessionType,
    parentId: payload.parentSessionId || null,
    source: payload.source || 'unknown',
    timestamp: new Date().toISOString(),
  };

  logger.info(`[Session:Create] ${sessionType} session`, context);
}
```

### Hook Payload Diagnostic Enhancement

```typescript
function processSessionHook(payload: any) {
  logger.debug(`[Hook:Session] Raw payload received`, { 
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString()
  });

  // Check for duplicate processing
  const recentSession = getSessionCreatedWithinSeconds(payload.id, 10);
  if (recentSession) {
    logger.warn(`[Hook:Session] Duplicate session creation attempt`, {
      sessionId: payload.id,
      timeDelta: Date.now() - recentSession.created_at
    });
    return;
  }
}
```

---

## Step 8 — Daemon Restart Resilience Patterns

**When:** Daemon crashes or restarts unexpectedly, leaving tasks/sessions in inconsistent states.

### Task Recovery After Restart

```typescript
export async function recoverInterruptedTasks() {
  const interruptedTasks = await db.select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ['running', 'starting']),
        lt(tasks.updated_at, sql`datetime('now', '-5 minutes')`)
      )
    );

  for (const task of interruptedTasks) {
    await db.update(tasks)
      .set({ 
        status: 'pending', 
        updated_at: new Date(),
        restartCount: (task.restartCount || 0) + 1 
      })
      .where(eq(tasks.id, task.id));
  }
}
```

### Session and Outbox Recovery

```typescript
// Clean up sessions marked active but daemon wasn't running
export async function cleanupStaleActiveSessions() {
  const staleActiveSessions = await db.select()
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'active'),
        lt(sessions.updated_at, sql`datetime('now', '-30 minutes')`)
      )
    );

  for (const session of staleActiveSessions) {
    const status = session.promptCount > 0 ? 'complete' : 'abandoned';
    await db.update(sessions)
      .set({ status, updated_at: new Date() })
      .where(eq(sessions.id, session.id));
  }
}
```

---

## Step 9 — Self-Mutation Discipline: DaemonStateAuthority + Intent + Reconciliation

**When:** Daemon operations that modify Myco's own state, configuration, or process identity create inconsistencies.

### The DaemonStateAuthority Pattern: Structural Invariant Enforcement

**Core Pattern:** Rather than documenting a discipline-based rule ("don't touch daemon.json outside this module"), make the invariant **structural** through a single capability module that is the ONLY place in the codebase that mutates daemon.json.

**Problem it solves:** The production codebase previously had discipline-based documentation ("never call fs.unlinkSync on daemon.json except in shutdown"), but discipline erodes over time. Contributors added mutation sites that weren't caught until runtime. The structural approach is immune to this class of bugs.

**Implementation:**

```typescript
// packages/myco/src/daemon/daemon-state-authority.ts
// This module makes the invariant structural:
//   1. It is the ONLY module that calls fs.unlinkSync (or variants) on daemon.json
//   2. The CI test gate verifies no other module imports fs.unlinkSync/unlink on the daemon path
//   3. Branded types (DaemonStateToken) prevent accidental daemon.json mutations elsewhere

export type DaemonStateToken = Brand<'DaemonStateToken', {}>;

/**
 * Daemon state authority — the only place that can delete daemon.json.
 * All other modules must import from this module if they need mutation capability.
 */
export class DaemonStateAuthority {
  /**
   * Only this method modifies daemon.json. Branded return type ensures
   * other modules cannot accidently acquire the capability elsewhere.
   */
  static async acquireToken(): Promise<DaemonStateToken> {
    return { __brand: 'DaemonStateToken' } as DaemonStateToken;
  }

  /**
   * Atomic replace of daemon.json with ownerPid guard.
   * Prevents third-contender race where daemon B deletes daemon A's record.
   */
  static async atomicReplace(
    newRecord: DaemonRecord,
    token: DaemonStateToken
  ): Promise<void> {
    // Verify token (compiler ensures it came from acquireToken)
    if (!token || !token.__brand) {
      throw new Error('Invalid DaemonStateToken: unauthorized daemon.json mutation');
    }

    const daemonJsonPath = ServicePaths.getDaemonJsonPath();
    const tempPath = `${daemonJsonPath}.tmp.${Date.now()}`;

    // Write to temp file first
    const serialized = JSON.stringify(newRecord, null, 2);
    await fs.promises.writeFile(tempPath, serialized, { mode: 0o600 });

    // Atomic rename
    await fs.promises.rename(tempPath, daemonJsonPath);
  }

  /**
   * Remove daemon.json with ownerPid verification.
   */
  static async removeDaemonState(
    currentPid: number,
    token: DaemonStateToken
  ): Promise<{ deleted: boolean; reason?: string }> {
    if (!token || !token.__brand) {
      throw new Error('Invalid DaemonStateToken: unauthorized daemon.json mutation');
    }

    const daemonJsonPath = ServicePaths.getDaemonJsonPath();
    const existingRecord = await readDaemonJson();

    if (existingRecord && existingRecord.ownerPid !== currentPid) {
      logger.warn(`daemon.json owned by different process, skipping deletion`);
      return { deleted: false, reason: 'owned-by-different-process' };
    }

    try {
      await fs.promises.unlink(daemonJsonPath);
      return { deleted: true };
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        return { deleted: true, reason: 'already-deleted' };
      }
      throw err;
    }
  }
}
```

### Usage Pattern: Intent + Reconciliation via Authority

```typescript
// In daemon startup/shutdown code
export async function startDaemonWithIntentPattern() {
  // Step 1: Acquire the structural token
  const token = await DaemonStateAuthority.acquireToken();

  // Step 2: Declare intent by creating daemon.json
  const daemonRecord = {
    id: generateId(),
    pid: process.pid,
    ownerPid: process.pid,  // ownerPid guard for third-contender protection
    port: config.port,
    createdAt: Date.now()
  };

  await DaemonStateAuthority.atomicReplace(daemonRecord, token);

  // Step 3: Continue with daemon startup
  // If any error occurs after this point, the next daemon startup
  // will see daemon.json and attempt to reconcile
}

export async function shutdownDaemonWithIntentPattern(token: DaemonStateToken) {
  // Step 1: Clean internal state
  await performCleanShutdown();

  // Step 2: Remove daemon.json (structural authority enforces only we can do this)
  const result = await DaemonStateAuthority.removeDaemonState(process.pid, token);
  
  if (!result.deleted) {
    logger.warn(`Could not remove daemon.json: ${result.reason}`);
  }

  process.exit(0);
}
```

### CI Test Gate: Verify Structural Invariant

```typescript
// In tests/invariant/daemon-state-authority.test.ts
describe('DaemonStateAuthority Invariant', () => {
  it('should be the ONLY module calling fs.unlinkSync on daemon.json paths', async () => {
    const sourceFiles = await glob('src/**/*.ts', { ignore: 'src/daemon/daemon-state-authority.ts' });
    
    for (const file of sourceFiles) {
      const content = await fs.promises.readFile(file, 'utf-8');
      
      // Scan for direct fs.unlinkSync/unlink calls on daemon paths
      const forbiddenPatterns = [
        /fs\.unlinkSync\s*\(\s*.*daemon\.json/,
        /fs\.promises\.unlink\s*\(\s*.*daemon\.json/,
      ];
      
      for (const pattern of forbiddenPatterns) {
        expect(content).not.toMatch(pattern);
      }
    }
  });
});
```

### Gotchas in Self-Mutation Discipline

**Token escaping gotcha:** The branded type prevents accidental mutation, but a malicious module could still import DaemonStateAuthority. Use the CI test gate to catch this.

**ownerPid race gotcha:** Even with the DaemonStateAuthority pattern, verify ownerPid before deleting to prevent third-contender races. The guard is the critical safeguard against concurrent startup scenarios.

**Backup and recovery gotcha:** The self-mutation discipline pattern works best when combined with daemon restart resilience — always have recovery code ready in case daemon.json gets corrupted.

---

## Step 10 — Advanced Daemon Startup Ordering Diagnostics

**When:** Investigating startup failures related to resource conflicts, database locks, or multi-instance coordination.

### Startup Ordering Failure Mode Detection

```bash
# Detect startup ordering conflicts (FTS rebuild before port-claim)
grep -E "FTS.*rebuild|database.*locked|Port.*already" ~/.myco/daemon.log | head -20

# Timeline analysis for multi-instance startup attempts  
awk '/Starting daemon|Port|FTS|database.*locked/ {print $1" "$2" "$0}' ~/.myco/daemon.log | tail -30

# Check for abandoned startup operations
ps aux | grep myco | grep -v grep
lsof | grep myco | grep -E "(db|socket|lock)"
```

### Startup Resource Conflict Resolution

```typescript
export async function resolveStartupResourceConflicts() {
  // 1. Detect and resolve database lock conflicts
  const dbLocks = await detectDatabaseLocks();
  if (dbLocks.length > 0) {
    logger.warn('Database locks detected during startup', { locks: dbLocks });
    await resolveDatabaseLockConflicts(dbLocks);
  }

  // 2. Detect and resolve port conflicts  
  const portConflicts = await detectPortConflicts();
  if (portConflicts.length > 0) {
    logger.warn('Port conflicts detected during startup', { conflicts: portConflicts });
    await resolvePortConflicts(portConflicts);
  }

  // 3. Clean up orphaned startup attempts
  await cleanupOrphanedStartupAttempts();
}
```

---

## Step 11 — Quick Reference — Error to Fix Map

| Error / Symptom | Likely Cause | Fix |
|----------------|--------------|-----|
| `FOREIGN KEY constraint failed` on delete | Wrong deletion order | Delete children before parents |
| Job registered but never fires | Scheduler not woken after insert | Call `scheduler.wake()` after inserting work |
| Two sessions for one conversation | No duplicate guard on session insert | Check for existing session ID before insert |
| Sessions vanish mid-run, no explicit error | `findDeadSessionIds()` too aggressive | Set `DEAD_SESSION_MAX_PROMPTS = 0`; add `status != 'active'` filter |
| Task shows "process aborted by user" without user action | Phase timeout, next phase runs under dead AbortController | Create fresh `AbortController` for each phase |
| Task status = `complete`, no output | Exception swallowed in executor | Separate success path from catch block; mark failed on error |
| Daemon restart leaves tasks in `running` status | Process interrupted during task execution | Reset interrupted tasks to `pending` with restart count |
| "No daemon" false positive during restart | Race condition in daemon.json lifecycle | Apply intent + reconciliation: supervisor manages daemon.json |
| Daemon state corruption after config updates | Non-atomic configuration changes with no rollback | Use intent + reconciliation for config updates with validation |
| Process identity drift after daemon updates | Self-mutation during update process | Supervisor-owned lifecycle: external supervisor manages updates |
| EPERM livelock during daemon restart | `reconcileExistingDaemon` loops on permission error | Distinguish ESRCH from EPERM; escalate EPERM to user intervention |
| MCP bridge indefinite reconnect loop | Mode 4 restart failure - bridge never establishes | Stop daemon, clean bridge state, restart with bridge health verification |
| "Database is locked" during startup | FTS rebuild before port-claim allows orphan operations | Move port-claim check before expensive database operations |
| Multiple startup attempts with resource conflicts | Startup ordering allows collision between instances | Use coordination locks and resource conflict detection before expensive operations |
| daemon.json deleted during restart | Third-contender race in concurrent startup | Use DaemonStateAuthority with ownerPid guard in removeDaemonState |
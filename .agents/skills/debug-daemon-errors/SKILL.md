---
name: myco:debug-daemon-errors
description: "Use this skill whenever the Myco daemon is misbehaving — even if the user doesn't explicitly ask for a debugging procedure. Activates for: daemon process crashes, uncaught exceptions, FK constraint violations, PowerManager jobs not firing, scheduler starvation, outbox drain loops, duplicate or phantom sessions, executor tasks that silently succeed or stall, and any log output from the daemon's core subsystems (PowerManager, SQLite, outbox, session lifecycle, phased executor). This is the cross-cutting playbook for investigating, tracing, and surgically fixing daemon-layer bugs — distinct from debugging agent task YAML, schema migrations, or outbox architecture design."
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Debug Production Daemon Errors

The Myco daemon is a long-running process that hosts multiple subsystems: a JobRunner-based scheduler, SQLite-backed state, an outbox drain loop, session lifecycle tracking, and a phased task executor. Bugs in each subsystem have distinct failure signatures and require different surgical fixes. This skill teaches you how to identify which subsystem is implicated, trace to the root cause, apply a minimal fix, and prevent regression.

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
- The subsystem prefix in the log line (e.g., `[JobRunner]`, `[Outbox]`, `[Session]`, `[Executor]`)
- Whether the error is a hard crash, a silent return, or a loop

**Pitfall:** Don't jump to fixing based on the exception message alone. `FOREIGN KEY constraint failed` looks like a schema bug but is almost always a deletion order problem.

---

## Step 2 — Map the Error to Its Subsystem

Each daemon subsystem has a distinct failure signature:

| Subsystem | Failure Signature |
|-----------|-------------------|
| **JobRunner/Scheduler** | A registered job stops firing; wrong `kind` field causes two-lane starvation, or `runIn` states don't match current power state |
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

### JobRunner — Job Starvation (Two-Lane Scheduler)

**Trace:** Check the job's `kind` field. The JobRunner implements two-lane fair scheduling separating `'drain'` (time-sensitive: embedding, outbox) and `'housekeeping'` (background maintenance) jobs. When both lanes are contended, each is capped at `concurrency-1` slots. A job registered with the wrong `kind` may lose slots it needs, or a housekeeping job can appear to stall when drain jobs are busy.

**Fix pattern:** Set `kind: 'drain'` for time-sensitive jobs; `kind: 'housekeeping'` for background maintenance:
```typescript
runner.register({
  name: POWER_JOB_NAMES.YOUR_JOB,
  kind: 'drain',       // ensures fair-share slot even when housekeeping is running
  runIn: ['active', 'idle', 'sleep'],
  fn: yourJobFn,
});
```

Also verify `runIn` includes all power states where the job should fire — a job registered only for `['active']` won't run in `'idle'` or `'sleep'` states.

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
        ne(sessions.status, 'active'),
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
      continue;
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

**Fix pattern:** Move the port-claim check before expensive database operations.

---

## Step 4 — Daemon Restart and PID Reconciliation Failures

### EPERM Livelock in reconcileExistingDaemon with Binary Masquerade Detection

**Problem:** When daemon restart encounters an existing daemon.json with a stale PID, `reconcileExistingDaemon` can enter an EPERM livelock where repeated `process.kill(pid, 0)` calls fail with EPERM but the function keeps retrying without resolution.

**Root cause:** The kill-probe doesn't distinguish between "process doesn't exist" (ESRCH, safe to proceed) and "process exists but we can't signal it" (EPERM, uncertain state). Additionally, EPERM can occur when the PID is reused by a different unrelated process, masquerading as the old daemon.

**Diagnosis — Binary Masquerade Cross-Check:**

Before escalating to user intervention, verify whether the process holding the PID is actually a Myco daemon. Read `/proc/[pid]/cmdline` and check for myco daemon markers (command contains 'myco' plus daemon start patterns).

**Fix pattern:** Treat EPERM with binary cross-check:
- If the PID holds a Myco daemon: escalate to user for manual intervention
- If the PID was reused by an unrelated process: safe to clear the stale record

This prevents false EPERM escalations when PIDs are recycled by unrelated processes.

### lifecycle-lock.ts — Atomic Truncation for Process-Scoped Locks

**New knowledge:** The lifecycle-lock module implements process-scoped file locks using atomic truncation to signal lock release. This pattern is critical for daemon restart safety.

**Pattern:** Use `fs.ftruncateSync(fd, 0)` to atomically signal lock release to other processes.

This pattern prevents race conditions during daemon shutdown where a restarting daemon might pick up an old lock.

### daemon.json Deletion Via Third-Contender Reconciliation: ownerPid Guard Fix

**Problem:** During concurrent daemon startup, a third-contender scenario can occur where both daemons A and B attempt to delete daemon.json, creating a race condition.

**Root cause:** `removeDaemonState()` doesn't verify that the process being killed actually owned daemon.json before deletion.

**Fix pattern:** Verify ownerPid before deletion to prevent third-contender races where daemon B deletes daemon A's record. Ensure daemon.json creation sets ownerPid = process.pid, and removal checks ownerPid equality before unlink.

### Daemon Restart Failure Mode 4 — MCP Bridge Indefinite Reconnect

**Problem:** During daemon restart, if the MCP bridge connection fails to establish cleanly, it can enter an indefinite reconnect loop where the daemon appears to start successfully but the bridge never becomes functional.

**Diagnosis patterns:**
```bash
# Look for these log patterns indicating Mode 4 failure:
grep -A 5 -B 5 "MCP bridge.*reconnect" ~/.myco/daemon.log
grep "bridge.*timeout|bridge.*failed" ~/.myco/daemon.log | tail -20
```

**Typical Mode 4 signature:**
```
[MCP] Bridge connection attempt 1 failed: connect ECONNREFUSED 127.0.0.1:3456
[MCP] Bridge connection attempt 2 failed: connect ECONNREFUSED 127.0.0.1:3456
[MCP] Bridge connection attempt 3 failed: connect ECONNREFUSED 127.0.0.1:3456
[MCP] Bridge reconnect exponential backoff, next attempt in 8000ms
```

**Resolution procedure:**
1. Stop daemon cleanly to break the reconnect loop
2. Clean any stale MCP bridge state
3. Restart with bridge connection verification before declaring restart successful

**Prevention:** Always verify MCP bridge health after daemon restart using health check endpoint.

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

### The DaemonStateAuthority Pattern: Structural Invariant Enforcement (6-Phase Refactor)

**Core Pattern:** Rather than documenting a discipline-based rule ("don't touch daemon.json outside this module"), make the invariant **structural** through a single capability module that is the ONLY place in the codebase that mutates daemon.json.

**Problem it solves:** The production codebase previously had discipline-based documentation ("never call fs.unlinkSync on daemon.json except in shutdown"), but discipline erodes over time. Contributors added mutation sites that weren't caught until runtime. The structural approach is immune to this class of bugs.

**Six-Phase Refactor (7-Method API):**

The refactored DaemonStateAuthority now exposes a complete 6-phase lifecycle with mandatory intent tracking and structured logging:

```typescript
// Phase 1: Token (capability proof) — acquireToken()
// Phase 2: Write operations (create, update) — read(), write()
// Phase 3: Conditional mutation (write-or-touch) — writeOrTouch()
// Phase 4: Atomic succession (replace) — replace()
// Phase 5: Safe deletion (delete-if-owned) — deleteIfOwnedBy()
// Phase 6: Cleanup (delete-for-uninstall, delete-if-malformed) — deleteIfMalformed(), deleteForUninstall()
```

All mutations require mandatory reason parameters with structured logging (kind=daemon.state-mutation) for audit trail.

### Usage Pattern: Intent + Reconciliation via Authority

1. Acquire the structural token via `DaemonStateAuthority.acquireToken()`
2. Declare intent by writing daemon.json with structured reason (kind + details)
3. Continue with daemon startup — if any error occurs, next startup will see daemon.json and reconcile

### Gotchas in Self-Mutation Discipline

**Token escaping gotcha:** The branded type prevents accidental mutation, but a malicious module could still import DaemonStateAuthority. Use the CI test gate to catch this.

**ownerPid race gotcha:** Even with the DaemonStateAuthority pattern, verify ownerPid before deleting to prevent third-contender races. The guard is the critical safeguard against concurrent startup scenarios.

**Backup and recovery gotcha:** The self-mutation discipline pattern works best when combined with daemon restart resilience — always have recovery code ready in case daemon.json gets corrupted.

---

## Step 10 — Advanced Daemon Startup Ordering Diagnostics

**When:** Investigating startup failures related to resource conflicts, database locks, or multi-instance coordination.

### Four-Sources-of-Truth Diagnostic Table

When troubleshooting daemon restart failures, consult this table of the four independent daemon state sources:

| State Source | Location | Authority | Consistency Guarantee | Failure Mode |
|--------------|----------|-----------|----------------------|--------------| 
| **daemon.json** | ~/.myco/daemon.json | Daemon self (intent-based) | Atomic write via temp-file rename; ownerPid prevents third-contender race | Stale PID; malformed JSON; third-contender deletion race |
| **Process list** | /proc/[pid]/stat (Unix) or tasklist (Windows) | OS kernel | Real-time; immediate on kill | Race: process exits between check and reconciliation |
| **Port claim** | Port 20915 (TCP socket) | OS kernel | Atomic on listen(); owner identifies PID | Port stuck in TIME_WAIT after unclean shutdown; EADDRINUSE false positive |
| **Lifecycle lock** | ~/.myco/lifecycle.lock (file descriptor) | Daemon file-based lock | Process-scoped; released on fd close or ftruncate | Lock held by zombie process; fd leaks in crash scenarios |

**Reconciliation Strategy:**

When daemon.json exists but daemon won't start, check these four sources in order. If all four agree (process gone, port free, lock free, JSON stale), safe to clear daemon.json and start fresh.

---

## Step 11 — Quick Reference — Error to Fix Map

| Error / Symptom | Likely Cause | Fix |
|----------------|--------------|-----|
| `FOREIGN KEY constraint failed` on delete | Wrong deletion order | Delete children before parents |
| Job registered but never fires | Wrong `kind` for two-lane scheduler, or `runIn` excludes current power state | Set `kind: 'drain'` for time-sensitive jobs; verify `runIn` includes relevant power states |
| Two sessions for one conversation | No duplicate guard on session insert | Check for existing session ID before insert |
| Sessions vanish mid-run, no explicit error | `findDeadSessionIds()` too aggressive | Set `DEAD_SESSION_MAX_PROMPTS = 0`; add `status != 'active'` filter |
| Task shows "process aborted by user" without user action | Phase timeout, next phase runs under dead AbortController | Create fresh `AbortController` for each phase |
| Task status = `complete`, no output | Exception swallowed in executor | Separate success path from catch block; mark failed on error |
| Daemon restart leaves tasks in `running` status | Process interrupted during task execution | Reset interrupted tasks to `pending` with restart count |
| "No daemon" false positive during restart | Race condition in daemon.json lifecycle | Apply intent + reconciliation: use DaemonStateAuthority |
| Daemon state corruption after config updates | Non-atomic configuration changes with no rollback | Use intent + reconciliation for config updates with validation |
| Process identity drift after daemon updates | Self-mutation during update process | Supervisor-owned lifecycle: external supervisor manages updates |
| EPERM livelock during daemon restart | `reconcileExistingDaemon` loops on permission error | Distinguish ESRCH from EPERM; cross-check binary with cmdline; escalate EPERM if myco daemon confirmed |
| MCP bridge indefinite reconnect loop | Mode 4 restart failure - bridge never establishes | Stop daemon, clean bridge state, restart with bridge health verification |
| "Database is locked" during startup | FTS rebuild before port-claim allows orphan operations | Move port-claim check before expensive database operations |
| Multiple startup attempts with resource conflicts | Startup ordering allows collision between instances | Use coordination locks and resource conflict detection before expensive operations |
| daemon.json deleted during restart | Third-contender race in concurrent startup | Use DaemonStateAuthority.deleteIfOwnedBy() with ownerPid guard |

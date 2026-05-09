---
name: myco:debug-daemon-errors
description: >
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

Look for the **first anomalous line**, not just the error message. The error is often a symptom thrown several steps after the actual cause. Record:
- The timestamp of the first unexpected event
- The subsystem prefix in the log line (e.g., `[PowerManager]`, `[Outbox]`, `[Session]`, `[Executor]`)
- Whether the error is a hard crash, a silent return, or a loop

**Pitfall:** Don't jump to fixing based on the exception message alone. `FOREIGN KEY constraint failed` looks like a schema bug but is almost always a deletion order problem. `Task completed` with no output is a status-swallowing bug in the executor, not a task configuration issue.

---

## Step 2 — Map the Error to Its Subsystem

Each daemon subsystem has a distinct failure signature:

| Subsystem | Failure Signature |
|-----------|-------------------|
| **PowerManager** | A registered job stops firing after initial runs; scheduler log goes quiet; work is inserted but nothing picks it up |
| **SQLite FK cascade** | `FOREIGN KEY constraint failed` on delete; or orphaned child rows after parent deletion |
| **Outbox drain** | Drain runs on every tick but the same records never leave; loop visible in logs with no progress |
| **Session lifecycle** | Two sessions created for one conversation; session ID missing mid-run; `sessionStart` fires twice |
| **Session maintenance** | Active sessions vanish mid-run; sessions deleted with no explicit error; real sessions treated as dead |
| **Executor (phased tasks)** | Task status transitions to `complete` or `failed` silently; no error thrown; output is empty |
| **Timeout cascade failure** | Task shows *"Claude Code process aborted by user"* or similar abort messages when no user action occurred; executor timeout in one phase affects subsequent phases |
| **Grove import/migration** | FK violations during Grove data import; database initialization errors during Grove setup; validation failures during Grove activation; tiered migration failures across Grove data layers |

Map your log output to one of these categories. If you're unsure, search the daemon source for the log prefix:

```bash
# Find where a log line originates
grep -rn "your log text here" packages/myco/src/daemon/
```

---

## Step 3 — Trace the Root Cause (Subsystem Playbooks)

### PowerManager — Scheduler Starvation

The scheduler wakes on a timer OR when work is inserted. If new work is inserted but the scheduler doesn't wake, the job starves until the next timer tick (which may be minutes away).

**Trace:** Check whether `scheduleNextRun` or the equivalent wake signal is called immediately after inserting the new work row. If the insert happens in a code path that doesn't call the wake signal, the scheduler won't pick it up until the next interval.

**Fix pattern:**
```typescript
// After inserting work, explicitly wake the scheduler
await db.insert(workTable).values(newWork);
scheduler.wake(); // <-- ensure this exists in every insert path
```

Search for all places that insert into the work/job table and confirm each one wakes the scheduler:
```bash
grep -rn "insert.*work\|insert.*job\|insert.*task" packages/myco/src/daemon/ --include="*.ts"
```

---

### SQLite FK Cascade — Wrong Deletion Order

SQLite enforces FK constraints at statement time, not transaction commit time. If you delete a parent row before its child rows, the constraint fires immediately even inside a transaction.

**Trace:** Identify the parent–child relationship from the error. Check the schema:
```bash
sqlite3 .myco/myco.db ".schema"
```

Look for `REFERENCES parent_table(id)` on the table mentioned in the error.

**Fix pattern:** Always delete children before parents, in the same transaction:
```typescript
await db.transaction(async (tx) => {
  await tx.delete(childTable).where(eq(childTable.parentId, id));
  await tx.delete(parentTable).where(eq(parentTable.id, id));
});
```

**Pitfall:** If there are multiple levels of FK nesting (grandchild → child → parent), delete from the leaf up. Draw the dependency tree before writing the delete sequence.

### Grove Import/Migration FK Violations

Grove import operations commonly trigger FK constraint violations when importing data with cross-references. The patterns above apply, but Grove import has additional considerations:

**Grove-specific trace:** Check if the FK violation occurs during batch import operations where related records are inserted in separate phases. Grove import may insert parent records first, then attempt to reference them before the transaction commits, or vice versa.

**Grove import fix pattern:**
```typescript
// Import in dependency order, within transactions
await db.transaction(async (tx) => {
  // 1. Import all parent entities first
  await importProjects(tx, groveData.projects);
  // 2. Import child entities that reference parents
  await importSessions(tx, groveData.sessions);
  // 3. Import leaf entities last
  await importSpores(tx, groveData.spores);
});
```

### Grove Migration Tiered Testing Strategy

Grove migration introduces tiered testing patterns that can expose daemon subsystem issues at different migration phases:

**Tiered smoke testing pattern for Grove migration:**

1. **Phase 1: Local validation** - Test migration logic against local Grove data without affecting live systems
2. **Phase 2: Staging Grove import** - Test full Grove data import against staging environment 
3. **Phase 3: Production Grove activation** - Test Grove activation procedures against production data

**Grove migration debugging checklist:**
- Database schema compatibility between Grove versions
- FK constraint violations during tiered data import
- Validation failures at each migration phase
- Cross-Grove resource conflicts during activation
- Performance degradation during large Grove data imports

**Grove migration error patterns:**
```bash
# Check for Grove-specific migration errors
grep -rn "Grove.*migration\|tiered.*test\|Grove.*activation" ~/.myco/daemon.log

# Validate Grove data consistency after import
sqlite3 .myco/myco.db "
SELECT 'projects' as table_name, COUNT(*) as count FROM projects
UNION ALL
SELECT 'sessions' as table_name, COUNT(*) as count FROM sessions  
UNION ALL
SELECT 'spores' as table_name, COUNT(*) as count FROM spores;
"
```

---

### Outbox Drain — Backfill Loop

If the outbox drain processes a record, marks it as sent, but then the same record re-appears on the next tick, look for a backfill path that resets the status without a guard.

**Trace:** Add a temporary log before the status update to confirm whether the record is being re-inserted or re-flagged:
```bash
grep -rn "approved_at\|outbox.*status\|drain.*update" packages/myco/src/daemon/ --include="*.ts"
```

**Fix pattern:** Guard the status transition so it only applies on first promotion:
```typescript
// Only set approved_at if it hasn't been set yet
if (!record.approved_at) {
  await db.update(outbox)
    .set({ approved_at: new Date() })
    .where(eq(outbox.id, record.id));
}
```

Without this guard, any backfill or re-survey will reset `approved_at` on records already processed, causing them to drain again.

---

### Session Lifecycle — Re-entrancy / Phantom Sessions

If a second session is created for the same conversation, look for a code path that creates a session without checking whether one already exists for the incoming session ID.

**Trace:** Search for all session creation sites:
```bash
grep -rn "createSession\|insertSession\|sessions.*insert" packages/myco/src/daemon/ --include="*.ts"
```

For each creation site, check whether it guards against duplicates:
```typescript
// Bad — no guard
const session = await db.insert(sessions).values({ id: incomingId, ... });

// Good — check first
const existing = await db.select().from(sessions).where(eq(sessions.id, incomingId)).get();
if (!existing) {
  await db.insert(sessions).values({ id: incomingId, ... });
}
```

The session ID (from the hook payload) is the source of truth. If the hook fires twice for the same session, the second fire should be a no-op, not a second insert.

#### OpenCode Sub-Agent vs User Fork Detection

**When:** Investigating phantom sessions that appear to be duplicates but have different parentID values, particularly when OpenCode sub-agents vs user forks are creating sessions through the same hook.

OpenCode can create sessions in two scenarios:
1. **Sub-agent spawn**: OpenCode creates a child session under an existing user session (`parentID` references the user session)
2. **User fork**: User directly invokes OpenCode through the web interface (`parentID` is null, session appears independent)

**Diagnostic pattern:**
```bash
# Query sessions with parentID relationships
sqlite3 .myco/myco.db "
SELECT id, parentId, title, status, created_at 
FROM sessions 
WHERE parentId IS NOT NULL 
ORDER BY created_at DESC 
LIMIT 20;"

# Check for sessions created within seconds of each other
sqlite3 .myco/myco.db "
SELECT s1.id as session1, s2.id as session2, 
       s1.parentId as parent1, s2.parentId as parent2,
       s1.created_at, s2.created_at
FROM sessions s1, sessions s2 
WHERE abs(strftime('%s', s1.created_at) - strftime('%s', s2.created_at)) < 10
  AND s1.id != s2.id 
ORDER BY s1.created_at DESC;"
```

---

### Session Maintenance — Over-Aggressive Dead-Session Cleanup

If real, in-progress sessions vanish mid-run with no explicit error, the session maintenance job's `findDeadSessionIds()` may be deleting them.

This failure mode has two independent compounding bugs (spore `1cf8bbc9`):

1. **`DEAD_SESSION_MAX_PROMPTS` threshold too high** — if set to `1`, any session with ≤1 prompt is eligible for deletion. A legitimate session that has started but only received one prompt is wiped. The correct value is `0`: only sessions with zero prompts are truly dead (they were registered but never sent any content).

2. **Missing `status != 'active'` filter** — `findDeadSessionIds()` ran against ALL sessions regardless of status. An active, in-progress session with few prompts could be selected. The filter must exclude any session where `status = 'active'`.

**Trace:** Check `packages/myco/src/daemon/jobs/session-maintenance.ts` (or equivalent) for both issues:
```bash
grep -rn "DEAD_SESSION_MAX_PROMPTS\|findDeadSessionIds\|status.*active" packages/myco/src/daemon/ --include="*.ts"
```

**Fix pattern:**
```typescript
// In constants.ts or the maintenance job
const DEAD_SESSION_MAX_PROMPTS = 0; // only truly empty sessions qualify

// In findDeadSessionIds()
export function findDeadSessionIds(registeredSessionIds: string[]): string[] {
  return db.select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        lte(sessions.promptCount, DEAD_SESSION_MAX_PROMPTS),
        ne(sessions.status, 'active'),          // <-- required guard
        notInArray(sessions.id, registeredSessionIds),
      )
    )
    .all()
    .map(r => r.id);
}
```

**Pitfall:** Both bugs must be fixed together. Fixing only the threshold (setting it to `0`) still leaves the `status` gap — a real session with zero prompts that is actively registered but not yet in `registeredSessionIds` can still be deleted. Fixing only the `status` filter still allows sessions with `prompt_count = 1` to be deleted if `DEAD_SESSION_MAX_PROMPTS = 1`. Always apply both guards.

---

### Executor — Phase Transition Under Dead AbortController

If a task shows a misleading error like *"Claude Code process aborted by user"* when no user abort occurred, the root cause is a timeout in an earlier phase that leaves a later phase running under an already-aborted `AbortController`. This can occur at **both the phase level and the task level**.

**Sequence (Phase-Level Timeout):**
1. Phase 1 starts and begins polling Claude Code.
2. After N minutes (the `phaseTimeoutSeconds` limit), phase 1 times out and calls `abort()` on the shared `AbortController`.
3. Phase 1 transitions to phase 2 (assuming the task allows fallback phases).
4. Phase 2 starts with the same `AbortController`, which is already aborted.
5. Any fetch or stream in phase 2 using the AbortController immediately throws `AbortError`.
6. The error is recorded as a user abort when it was actually a timeout in the prior phase.

**Sequence (Task-Level Timeout):**
1. The task executor has a separate timeout (e.g., `taskMaxDurationSeconds`) that spans all phases.
2. Phase 1 runs and completes normally.
3. Phase 2 begins and does work, but the task-level timeout fires partway through.
4. The task-level timeout calls `abort()` on the shared `AbortController`.
5. Phase 2's ongoing work throws `AbortError` and records a user abort when it was actually a task timeout.

**Trace:** Check the executor's phase runner and task orchestrator for timeout handling:
```bash
grep -rn "phaseTimeoutSeconds\|taskMaxDurationSeconds\|AbortController\|phase.*transition" packages/myco/src/agent/ --include="*.ts"
```

Look for:
- Whether `AbortController` is created per-phase or reused across phases
- Whether the timeout calls `abort()` on the controller
- Whether phase 2 begins with a fresh controller or inherits the prior phase's
- Whether a task-level timeout also exists and where it calls abort

**Fix pattern:** Create a new `AbortController` for each phase:
```typescript
for (const phase of task.phases) {
  const phaseController = new AbortController();  // Fresh controller per phase
  const phaseTimeout = setTimeout(() => {
    phaseController.abort();
  }, config.phaseTimeoutSeconds * 1000);

  try {
    const result = await runPhase(phase, phaseController);
    clearTimeout(phaseTimeout);
    return result; // Success — don't try next phase
  } catch (err) {
    clearTimeout(phaseTimeout);
    if (err.name === 'AbortError') {
      // Timeout in THIS phase — log it specifically
      logger.warn(`[Executor] Phase ${phase.name} timeout after ${config.phaseTimeoutSeconds}s`);
      continue; // Try next phase with a fresh controller
    }
    throw err;
  }
}
```

**Task-level timeout handling:**
```typescript
// Create one timeout for the entire task at the orchestrator level
const taskController = new AbortController();
const taskTimeout = setTimeout(() => {
  taskController.abort();
  logger.warn(`[Executor] Task ${task.id} timeout after ${config.taskMaxDurationSeconds}s`);
}, config.taskMaxDurationSeconds * 1000);

try {
  // Pass the task-level controller to each phase runner; they may wrap in phase-level controllers
  const result = await runAllPhases(task, taskController);
  return result;
} finally {
  clearTimeout(taskTimeout);
}
```

**Pitfall:** Reusing the same `AbortController` across phases creates a trap — the second phase inherits an already-triggered abort from the first, making the error message lie about which phase timed out. Task-level timeouts must also use a separate guard to distinguish task timeout from phase timeout.

---

### Executor — AbortController Wiring Gaps in Single-Query Tasks

**When:** Single-query tasks run indefinitely despite `timeoutSeconds` being configured in agent config. This is distinct from the phased executor timeout cascade above — the issue is that timeout signals never reach the execution layer at all.

**Symptom:** Long-running single-query tasks (like skill generation) that should timeout after N minutes continue running for hours with no termination mechanism.

**Root Cause:** The `executeSingleQuery` entry point lacks timeout signal wiring. While phased tasks properly pass `AbortController` signals through the executor pipeline, single-query execution bypasses this and connects directly to the SDK without timeout enforcement.

**Trace:** Check timeout signal flow in single-query execution:
```bash
grep -rn "executeSingleQuery\|timeoutSeconds\|AbortController" packages/myco/src/agent/ --include="*.ts"
```

Look for:
- Whether `timeoutSeconds` from agent config reaches the SDK call
- Whether `executeSingleQuery` creates or receives an `AbortController`
- Whether the SDK runtime receives timeout signals in single-query mode

**Fix pattern:** Wire timeout signals through the single-query execution path:
```typescript
// In single-query executor
export async function executeSingleQuery(
  runtime: Runtime,
  query: string,
  options: { timeoutSeconds?: number }
) {
  const controller = new AbortController();
  
  // Set up timeout if configured
  let timeoutId: NodeJS.Timeout | undefined;
  if (options.timeoutSeconds) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, options.timeoutSeconds * 1000);
  }

  try {
    // Pass abort signal to runtime
    const result = await runtime.execute(query, {
      signal: controller.signal
    });
    
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
```

**Gotcha:** This requires parallel fixes in both the executor layer (creating the controller) AND the runtime layer (honoring the signal). Missing either piece leaves timeouts non-functional.

---

### Executor — Status Swallowing

If an executor task transitions to a terminal status (`complete`, `failed`) without producing output or logging an error, the executor is catching an exception and recording "success" rather than propagating the failure.

**Trace:** Find the executor's task runner loop and look for broad `try/catch` blocks that swallow errors:
```bash
grep -rn "catch\|status.*complete\|status.*failed" packages/myco/src/agent/ --include="*.ts"
```

**Fix pattern:** Distinguish between expected task completion and unexpected errors. Never record `complete` inside a `catch` block unless you're explicitly handling a known-recoverable error:
```typescript
try {
  const result = await runPhase(task, phase);
  await markComplete(task.id, result);
} catch (err) {
  // Don't swallow — mark failed and surface the error
  await markFailed(task.id, err.message);
  logger.error('[Executor] Phase failed', { taskId: task.id, err });
  throw err; // re-throw if the outer loop should also know
}
```

---

### Grove Import/Migration — Database Initialization Patterns

**When:** Grove import or activation fails during database initialization, typically manifesting as FK violations, schema mismatches, or validation errors during Grove setup.

**Common Grove DB scenarios:**
1. **Import validation failures**: Grove data doesn't match expected schema during import
2. **Cross-Grove ID conflicts**: Importing a Grove with IDs that conflict with existing local data
3. **Partial import state**: Import operation interrupted mid-transaction, leaving Grove in inconsistent state

**Grove diagnostic pattern:**
```bash
# Check Grove import/activation logs
grep -rn "Grove\|grove\|import\|activation" ~/.myco/daemon.log

# Validate Grove registry state
myco grove list
cat .myco/project.toml  # Check binding_id

# Check for partial import artifacts
sqlite3 .myco/myco.db "
SELECT COUNT(*) as total_sessions, 
       COUNT(DISTINCT machine_id) as machine_count,
       MIN(created_at) as earliest_session,
       MAX(created_at) as latest_session
FROM sessions;"
```

**Grove import fix patterns:**
- Always run Grove import within a transaction that can roll back on failure
- Validate Grove data schema before attempting import
- Use proper ID mapping for cross-Grove imports to avoid conflicts
- Implement idempotent import operations that can safely retry

---

## Step 4 — Write the Regression Test First

Before applying the fix, write a test that fails with the current code. This confirms you've correctly identified the root cause and gives you a green signal to trust after the fix.

Tests for daemon subsystems live in:
- `tests/daemon/` — unit tests for individual subsystem functions
- `tests/integration/` — integration tests that spin up the daemon

Write the smallest test that reproduces the failure. For FK violations, this is usually an in-memory SQLite test. For scheduler starvation, mock the wake signal and assert it's called.

---

## Step 5 — Apply the Fix and Verify

1. Apply the minimal surgical fix — change only what's needed to address the root cause.
2. Run the targeted test first: confirm it goes green.
3. Run the full test suite:
   ```bash
   npm test
   ```
4. Restart the daemon and smoke-test the affected subsystem:
   ```bash
   myco daemon:restart
   myco daemon:logs --follow
   ```
5. Confirm no adjacent regressions in the log output.

**Pitfall:** Resist the urge to refactor while fixing. The goal is a minimal change that surgically addresses the root cause. Larger refactors should be separate commits with their own test coverage.

---

## Step 6 — Diagnostic Logging for Session Type Disambiguation

**When:** Adding logging to distinguish between different session creation scenarios, especially when investigating phantom session bugs or parent-child session relationships.

### Session Type Logging Strategy

Implement structured logging that captures session creation context and relationships:

```typescript
// Enhanced session creation logging
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
  
  if (payload.parentSessionId) {
    logger.info(`[Session:Hierarchy] Sub-agent spawned under parent`, {
      childId: payload.id,
      parentId: payload.parentSessionId,
      relationship: 'parent->child'
    });
  }
}
```

### Hook Payload Diagnostic Enhancement

Add payload validation and logging at the hook entry point:

```typescript
// In hook processor
function processSessionHook(payload: any) {
  // Log the raw payload for debugging
  logger.debug(`[Hook:Session] Raw payload received`, { 
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString()
  });

  // Validate payload structure
  const validation = validateSessionPayload(payload);
  if (!validation.valid) {
    logger.warn(`[Hook:Session] Invalid payload structure`, {
      errors: validation.errors,
      payload
    });
    return;
  }

  // Check for duplicate processing within a short window
  const recentSession = getSessionCreatedWithinSeconds(payload.id, 10);
  if (recentSession) {
    logger.warn(`[Hook:Session] Duplicate session creation attempt`, {
      sessionId: payload.id,
      previousCreation: recentSession.created_at,
      timeDelta: Date.now() - recentSession.created_at
    });
    return;
  }
}
```

**Usage:** Enable these diagnostics temporarily when investigating session-related bugs. The structured logging helps distinguish between legitimate sub-agent spawns, user forks, and true phantom duplicates.

---

## Step 7 — Daemon Restart Resilience Patterns

**When:** The daemon crashes or restarts unexpectedly, leaving tasks, sessions, or jobs in inconsistent states. Common scenarios include process termination during task execution, database locks from interrupted transactions, and orphaned state after unclean shutdowns.

### Task Recovery After Restart

Implement recovery patterns for tasks interrupted mid-execution:

```typescript
// During daemon startup, identify tasks that were interrupted
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
    logger.warn(`[Recovery] Found interrupted task`, {
      taskId: task.id,
      status: task.status,
      lastUpdate: task.updated_at
    });

    // Reset to pending for retry, or mark failed based on business logic
    await db.update(tasks)
      .set({ 
        status: 'pending', 
        updated_at: new Date(),
        restartCount: (task.restartCount || 0) + 1 
      })
      .where(eq(tasks.id, task.id));
  }
  
  logger.info(`[Recovery] Reset ${interruptedTasks.length} interrupted tasks`);
}
```

### Session and Outbox Recovery

Clean up sessions and outbox entries left in inconsistent states:

```typescript
// Clean up sessions that were marked active but daemon wasn't running
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
    // Transition to terminal based on content
    const status = session.promptCount > 0 ? 'complete' : 'abandoned';
    await db.update(sessions)
      .set({ status, updated_at: new Date() })
      .where(eq(sessions.id, session.id));
  }
  
  logger.info(`[Recovery] Cleaned up ${staleActiveSessions.length} stale active sessions`);
}

// Reset outbox entries that were being drained during shutdown
export async function resetProcessingOutboxEntries() {
  const processingEntries = await db.select()
    .from(outbox)
    .where(
      and(
        eq(outbox.status, 'processing'),
        lt(outbox.updated_at, sql`datetime('now', '-10 minutes')`)
      )
    );

  for (const entry of processingEntries) {
    await db.update(outbox)
      .set({ 
        status: 'pending',
        retryCount: (entry.retryCount || 0) + 1,
        updated_at: new Date()
      })
      .where(eq(outbox.id, entry.id));
  }

  logger.info(`[Recovery] Reset ${processingEntries.length} processing outbox entries`);
}
```

### Database Lock Recovery and Startup Orchestration

Handle SQLite locks and coordinate recovery procedures:

```typescript
// Check for database locks and attempt recovery
export async function recoverDatabaseLocks() {
  try {
    await db.select().from(sessions).limit(1).get();
    logger.info(`[Recovery] Database accessible`);
  } catch (err) {
    if (err.message.includes('database is locked')) {
      logger.warn(`[Recovery] Database locked, attempting recovery`);
      await db.$client.close();
      await new Promise(resolve => setTimeout(resolve, 2000));
      await initializeDatabase();
      logger.info(`[Recovery] Database lock recovered`);
    } else {
      throw err;
    }
  }
}

// Main recovery function called during daemon startup
export async function performStartupRecovery() {
  const startTime = Date.now();
  logger.info(`[Recovery] Starting daemon recovery procedures`);

  try {
    await recoverDatabaseLocks();
    await recoverInterruptedTasks();
    await cleanupStaleActiveSessions();
    await resetProcessingOutboxEntries();
    await restartJobSchedulers();
    
    const duration = Date.now() - startTime;
    logger.info(`[Recovery] Completed daemon recovery in ${duration}ms`);
  } catch (err) {
    logger.error(`[Recovery] Daemon recovery failed`, { error: err.message });
    throw err;
  }
}
```

**Usage:** Call `performStartupRecovery()` during daemon initialization to restore consistent state after unclean shutdowns.

---

## Quick Reference — Error to Fix Map

| Error / Symptom | Likely Cause | Fix |
|----------------|--------------|-----|
| `FOREIGN KEY constraint failed` on delete | Wrong deletion order | Delete children before parents |
| Job registered but never fires | Scheduler not woken after insert | Call `scheduler.wake()` after inserting work |
| Outbox drain loops without progress | Missing `approved_at` guard | Guard status transitions to set value only once |
| Two sessions for one conversation | No duplicate guard on session insert | Check for existing session ID before insert |
| Sessions vanish mid-run, no explicit error | `findDeadSessionIds()` too aggressive | Set `DEAD_SESSION_MAX_PROMPTS = 0`; add `status != 'active'` filter |
| Task shows "process aborted by user" without user action | **Phase-level OR task-level timeout** — one phase times out, next phase runs under dead AbortController (spore `1f76ffdd`) | Create fresh `AbortController` for each phase; don't reuse across phases; distinguish task-level timeout from phase timeout in error logging |
| Single-query tasks run indefinitely despite timeout config | `executeSingleQuery` missing timeout signal wiring | Wire `AbortController` from `timeoutSeconds` config through to SDK runtime |
| Task status = `complete`, no output | Exception swallowed in executor | Separate success path from catch block; mark failed on error |
| Phantom sessions with different parentID values | OpenCode sub-agent vs user fork confusion | Use diagnostic logging to distinguish session creation context; validate parentID references |
| Sessions created within seconds but unclear relationship | Missing session type context in logs | Implement structured session creation logging with type classification |
| Daemon restart leaves tasks in `running` status | Process interrupted during task execution | Implement task recovery: reset interrupted tasks to `pending` with restart count |
| Database locked after restart | SQLite locks from interrupted transactions | Force close connections, wait for locks to clear, reinitialize |
| Sessions stuck in `active` status after restart | Daemon shutdown during session processing | Cleanup stale active sessions: transition to `complete` or `abandoned` based on content |
| Outbox entries stuck in `processing` status | Daemon shutdown during outbox drain | Reset processing entries to `pending` with incremented retry count |
| Grove import FK violations during activation | Wrong import order or cross-Grove ID conflicts | Import in dependency order within transactions; validate schema; implement idempotent operations |
| Grove migration fails at tiered testing phases | Phase-specific validation or data import failures | Use tiered testing strategy: local validation → staging import → production activation; validate at each tier |
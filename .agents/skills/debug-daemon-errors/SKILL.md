---
name: myco:debug-daemon-errors
description: "Use this skill whenever the Myco daemon is misbehaving — even if the user doesn't explicitly ask for a debugging procedure. Activates for: daemon process crashes, uncaught exceptions, FK constraint violations, PowerManager jobs not firing, scheduler starvation, outbox drain loops, duplicate or phantom sessions, executor tasks that silently succeed or stall, and any log output from the daemon's core subsystems (PowerManager, SQLite, outbox, session lifecycle, phased executor). This is the cross-cutting playbook for investigating, tracing, and surgically solutioning daemon-layer bugs — distinct from debugging agent task YAML, schema migrations, or outbox architecture design."
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Debug Production Daemon Errors

The Myco daemon is a long-running process that hosts multiple subsystems: a JobRunner-based scheduler, SQLite-backed state, an outbox drain loop, session lifecycle tracking, and a phased task executor. Bugs in each subsystem have distinct failure signatures and require different surgical solutiones. This skill teaches you how to identify which subsystem is implicated, trace to the root cause, apply a minimal solution, and prevent regression.

## Prerequisites

- Daemon is running (or you have daemon logs from a failed run)
- You have access to the SQLite vault at `.myco/myco.db`
- You can restart the daemon process to confirm a solution

---

## Step 1 — Read the Logs Before Touching Code

Daemon logs are the ground truth. Before forming any hypothesis, capture the exact sequence of events.

```bash
# Tail live daemon output
myco daemon:logs --follow

# Or inspect the log file directly
cat ~/.myco/daemon.log | tail -200

# For hook invocation and launcher-level failures (missing hook output, status discrepancies):
cat ~/.myco/logs/launcher.log | tail -100
```

Look for the **first anomalous line**, not just the error message. Record:
- The timestamp of the first unexpected event
- The subsystem presolution in the log line (e.g., `[JobRunner]`, `[Outbox]`, `[Session]`, `[Executor]`)
- Whether the error is a hard crash, a silent return, or a loop

**Caution:** Be wary of misleading exception messages, like `FOREIGN KEY constraint failed`. Often, these indicate deletion order problems rather than a schema issue.

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
| **Scheduler task-config resolution** | Task stays disabled after grove tier config flips it on, or a grove config change never reaches a running task; config was compiled once at registration instead of per-tick/per-project |
| **Host membership registry** | One corrupt host directory under `~/.myco-team/hosts/` throws during registry enumeration; an unguarded reconcile call at boot let that single corrupt file kill the whole daemon |

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

### Scheduler — Cold-Project Starvation Masquerading as Embedding Backlog

**Problem:** A backlog of `canopy-describe` catch-up work on a cold (long-inactive) project can look identical in symptoms to an embedding-provider backlog: pending items pile up and never drain, keeping the daemon pinned awake. The two have different fixes and misdiagnosing one as the other wastes a debugging pass.

**Trace:** Check whether the stalled task has `runWhenCold: true` in its YAML (see `packages/myco/src/agent/definitions/tasks/canopy-describe.yaml`) and whether the project is past the cold-project inactivity threshold (`context.isProjectCold(scope)` in `packages/myco/src/daemon/task-scheduler.ts`). The cold gate is task-aware: cold projects skip every task **except** those marked `runWhenCold` — catch-up/backlog-draining tasks must keep running on cold projects or their pending-hold pins the daemon awake on work the gate itself refuses to run.

**Related guard:** `projectRuntimeIsForeign()` (`packages/myco/src/daemon/update-checker.ts`, used in `packages/myco/src/daemon/task-scheduling.ts` and `packages/myco/src/daemon/jobs/canopy-scan.ts`) additionally skips canopy scanning when the project's on-disk runtime doesn't match the daemon's own — a second, independent reason a canopy task can appear stalled that is not an embedding-provider issue.

**Fix pattern:** Set `runWhenCold: true` only on tasks whose backlog must drain regardless of session recency (catch-up/embedding-adjacent work); leave knowledge-generating tasks cold-gated. Don't add ad hoc cold-project exceptions elsewhere — the single `isProjectCold` + `runWhenCold` gate in `packages/myco/src/daemon/task-scheduler.ts` is the source of truth.

### Scheduler — Task Config Not Grove-Scoped (Stale Bootstrap Memo)

**Problem:** The daemon scheduler compiled task schedules once using the daemon bootstrap config object at registration time. Any task whose YAML default was `enabled: false` was never compiled into the schedule, so later enabling it via a project's grove tier config had no effect — the task simply never re-registered. A related variant used a single-slot config memo to cache the grove config load at registration, so subsequent changes to grove tier config (e.g. re-enabling a task) never propagated between ticks.

**Trace:** Confirm the task's schedule was compiled once at daemon boot rather than being re-resolved per project/tick. Check for any single-slot cache/memo of grove config sitting between the scheduler and `loadMergedConfig()`.

**Fix pattern:** Schedule config must come only from the task YAML plus the current project's grove tier config, resolved per iteration — not memoized once at registration. Do not keep a bootstrap/no-context config path as a fallback; production scheduling always has project iteration context.

### PowerManager — Liveness Signaling Unified Around One Mechanism (Deep Sleep Despite Activity)

**Problem (historical):** `packages/myco/src/daemon/event-dispatch.ts` used to call `powerManager.recordActivity()` only for `event.type === 'user_prompt'`, so tool use, subagent activity, and capture events never re-armed the activity timer. A long agent turn with no new user prompt could let the daemon fall into deep sleep despite active session work.

**Fix — Power Assertions redesign:** activity liveness is no longer event-gated. `packages/myco/src/daemon/server.ts` classifies every inbound HTTP request via `classifyRequest(headers, pathname)` into `probe` / `interaction` / `passive`:
- `PROBE_PATHS = new Set(['/health', '/ready', '/api/power'])` are unconditionally `probe` — they can never signify work.
- Fail-open: an unclassified request counts as `interaction` (a stray poller keeps the daemon awake and shows up as a named holder in the power inventory; the alternative — losing liveness silently — is the worse failure).
- The power-state-reporting route belongs in that probe set, not interaction, because it *reports* the activity clock — classifying it as interaction would make reading the power state reset the value being read (`idle_ms: 0` every sample). This is the general lesson: an observer must never be inside the system it observes.

**providesHold fail-safe direction:** `JobRunner.providesHold()` and `PowerManager.currentAssertions()` (`packages/myco/src/daemon/power.ts`) apply the same fail-safe rule — a probe that throws/cannot answer produces a `sleep`-depth assertion rather than nothing. A probe that cannot answer is not evidence there is nothing to do, and sleeping stops the drains, so the safe direction on probe failure is staying out of deep sleep.

### File Locking — withFileLockSync Nested-Acquire Self-Deadlock

**Problem:** `withFileLockSync()` (`packages/myco/src/utils/lifecycle-lock.ts`) takes a `lockPath` and a callback, opens the lock file, and calls `flock(fd, LOCK_EX)` with **no `LOCK_NB` and no timeout** — it blocks indefinitely waiting for the lock. If code running inside that callback (directly or via a nested call chain) calls `withFileLockSync()` again on the **same** `lockPath`, the second call blocks forever waiting for a lock the first call already holds on the same process/thread — a self-deadlock, not contention between processes.

**Where this is reachable:** Not just deliberate operator/CLI code paths — any per-request code path that transitively calls into a lock-protected function from inside another lock-protected function on the same lock file can trigger it (e.g. project-lease or config-mutation helpers called from within another locked section).

**Fix pattern:** Never call `withFileLockSync()` on a lock path that may already be held by an enclosing call on the same call stack. Keep locked sections leaf-level (no calls to other lock-acquiring helpers inside the callback), or refactor the inner operation to a lock-free variant that the outer holder can call directly.

### Host Registry — Quarantine Corrupt Host Membership Instead of Crashing

**Problem:** One loose-permission or malformed file under `~/.myco-team/hosts/<hostId>/` caused `reconcileHostRollbackBearers()` (`packages/myco/src/host/registry.ts`) to run unguarded at boot. Every registry enumeration threw `HostJoinStateCorruptError` on the first bad host directory and aborted the whole enumeration loop — a single corrupt file had daemon-wide blast radius and could keep the daemon from booting at all.

**Fix pattern:** `readHostMembershipSnapshotsFromEntriesUnlocked()` now catches `HostJoinStateCorruptError` per-entry inside the enumeration loop, pushes the failure into a `quarantined: QuarantinedHostMembership[]` array (readable via `quarantinedHostMemberships()`), and continues to the next entry — the corrupt host fails closed (its membership just doesn't load) while every other host and the daemon boot proceed normally. Non-`HostJoinStateCorruptError` exceptions still propagate.

```typescript
try {
  const snapshot = readHostMembershipSnapshotUnlocked(entry.name);
  if (snapshot) results.push(snapshot);
} catch (error) {
  if (!(error instanceof HostJoinStateCorruptError)) throw error;
  quarantined.push({ hostId: entry.name, detail: error.message });
}
```

**Lesson:** Any enumeration loop over independently-owned directory entries (hosts, projects, groves) should isolate per-entry corruption instead of letting one bad entry abort the whole loop — especially one that runs at boot.

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

**Fix pattern:** Never record `complete` in a `catch` block — always propagate failures to the error path.

### Daemon Initialization Sequence — Port-Claim Before FTS

**Issue:** Performing schema tasks such as FTS rebuilds before securing the port-claim can lead to "database is locked" errors, especially with concurrent daemon startups.

**Solution:** Ensure port claim checks precede resource-intensive database tasks to prevent unintentional process interference.

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

1. Apply the minimal surgical solution
2. Run the targeted test first: confirm it goes green
3. Run full test suite: `npm test`
4. Restart daemon and smoke-test: `myco daemon:restart`

**Pitfall:** Resist refactoring while solutioning. Make minimal changes that address the root cause.

---

## Step 7 — Diagnostic Logging for Session Type Disambiguation

**When:** Investigating phantom sessions or parent-child session relationships.

### Session Type Logging Strategy

Log the session type, parent ID, and source at creation time with structured fields so log filtering by `sessionType` reveals the full lineage of phantom session bugs.

### Hook Payload Diagnostic Enhancement

Add a duplicate-detection guard at hook processing time — check for a session with the same ID created within the last 10 seconds and emit a structured warning if found. This surfaces hook double-fire without requiring a schema change.

### Phantom / Split / Recovered-Empty Session Root Causes

Three independent capture defects can all present as "phantom" or duplicate sessions. Diagnose which one you're looking at before picking a fix — they don't share a solution:

1. **Session splitting at compaction** — Claude Code (1M-context builds) rolls a conversation into a NEW session id + transcript file when it auto-compacts ("This session is being continued from a previous conversation..."). This is a client-side session-identity change, not a capture bug — do not try to force session continuity across it.
2. **Injection-only phantom sessions** — A symbiont launch that fires `SessionStart` but exits before any prompt still receives a Cortex/spores injection; the injection activity forces `ensureOpenBatch` to fabricate a RECOVERED-sentinel batch, producing a visible 1-prompt session with no transcript. Fixed by `packages/myco/src/daemon/phantom-reaper.ts`: `findPhantomCandidates()` (session-maintenance sweep) and the SessionEnd-time reap both delete exactly this class — every batch RECOVERED-kind, every activity `myco:inject_%`-origin, and no resolvable transcript — through `deleteSessionCascade` (the only session deletion path), tombstoned so buffer replay can't resurrect the row.
3. **Stale-sweep false completion** — `completeStaleActiveSessions()` (`packages/myco/src/daemon/jobs/session-maintenance.ts`) used to judge freshness from `prompt_batches.started_at` alone, so a session running many tool calls under one long open batch (e.g. a 60+ minute agent turn with no new user prompt) got swept mid-flight. Fixed by also considering `MAX(activities.timestamp)`: a session is only stale once BOTH the last prompt and the last activity are past the threshold.
4. **Mid-session fork reissues the session id** — Claude Code's `SessionStart` with `source: "fork"` reissues a brand-new session id mid-conversation (distinct from compaction and from a fresh session). Myco previously had no fork concept, so a fork showed up as an orphaned split: records under the old id stop and a new id starts with no lineage link. The manifest schema (`packages/myco/src/symbionts/manifest-schema.ts`) declares this per-agent via an optional `sessionContinuation` (`parentSessionIdPath` + `defaultReason`) — declaring it enables the miner's session-lineage stitch for that agent; an agent that never reissues an id leaves it absent so a foreign transcript can never write bogus lineage. The stitch uses **positional boundary detection, not per-record trust**: the predecessor is the LAST divergent id in the file (a transcript carried through several continuations holds every ancestor, and only the last is the immediate parent), and a record whose value equals the session being mined marks no continuation (keeps in-place compaction from reading as a rollover). `markers` label *why* a continuation happened without influencing which parent is chosen — deliberately not precedence-ordered, so a fork of an already-compacted session still reports the immediate parent, not the pre-compact grandparent. The transcript path must arrive (via the hook payload, not manifest discovery) before this boundary can even be computed — see `ensureTranscriptPath()` in `packages/myco/src/daemon/session-lifecycle.ts`.

**Verification gotcha:** offline transcript-replay validation is necessary but not sufficient for hook-driven capture bugs like this one — it can confirm the stitch logic against a static transcript but can't exercise the live hook sequencing (event ordering, transcript-path arrival timing) that only a real forked session reproduces. Always follow an offline replay pass with a live smoke test (actually trigger a fork and confirm lineage in the vault) before declaring a session-lineage fix verified.

---

## Step 8 — Daemon Restart Resilience Patterns

**When:** Daemon crashes or restarts unexpectedly, leaving tasks/sessions in inconsistent states.

### Task Recovery After Restart

On startup, query for tasks in `running` or `starting` status older than 5 minutes and reset them to `pending` with an incremented `restartCount`. This prevents tasks from being permanently stuck after an unclean shutdown.

### Session and Outbox Recovery

On startup, query for sessions in `active` status with `updated_at` older than 30 minutes. Mark them `complete` if they have prompts, or `abandoned` if empty. This prevents ghost-active sessions from blocking new session creation.

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

**Shared-dependency mutation seam (beyond daemon.json):** The single-authority discipline generalizes past `DaemonStateAuthority`. Daemon-wide dependency bundles handed to many per-project consumers — e.g. `CanopyRunnerSharedDeps` in `packages/myco/src/daemon/jobs/canopy-scan.ts`, injected as a shared field into every per-project `CanopyDeltaScanRunner` — are an implicit shared-mutation seam: any consumer that treats a field on the shared object as local, mutable state (instead of read-only shared config) leaks that mutation across every other project sharing the same reference. Same fix shape as Step 9: pick one owner for writes to the shared object and have all consumers read only.

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
| Task stays disabled/stale after grove tier config change | Scheduler compiled config once at registration (bootstrap config or single-slot memo) instead of per-tick | Resolve schedule config from task YAML + current project's grove tier config on each iteration; remove memoization |
| Cold-project task backlog never drains, daemon pinned awake | Task lacks `runWhenCold: true` so `isProjectCold` gate skips it entirely | Mark catch-up/backlog-draining tasks (e.g. canopy-describe) `runWhenCold: true`; keep knowledge-generating tasks cold-gated |
| Nested `withFileLockSync()` call on the same lock path hangs forever | No `LOCK_NB`/timeout — inner call blocks waiting for a lock the outer call already holds | Never call a lock-acquiring helper from inside another locked section on the same lock path |
| Cortex injection silently stops working | cortex.enabled: false override in machine-local config | Inspect the machine-local local.yaml (gitignored) in the project's .myco/ directory before touching code — this override is only logged at debug level |
| Daemon enters deep sleep despite active session work (long tool-use turn, no new user prompt) | Activity only recorded on `user_prompt` events (fixed) — verify liveness now flows through `classifyRequest()` in `packages/myco/src/daemon/server.ts`, not event-type gating | Confirm `/health`, `/ready`, and the power-state route are in `PROBE_PATHS`; a probe/assertion-source failure must fail toward staying awake (`providesHold`/`currentAssertions`), never toward silently allowing sleep |
| Headless daemon can't resolve/auth the Claude Code CLI on a serving box (ssh/nohup, Parallels VM) | Daemon inherits a bare PATH missing `~/.local/bin`, and/or runs without an unlocked login keychain session so CLI credential lookups fail | Ensure the daemon's spawn environment sources the login shell PATH (or sets it explicitly) and that the headless session has an unlocked keychain before the CLI is invoked |
| MCP client sees stalled/mismatched responses across the CLI, stdio bridge, or an SDK client | Response envelope wasn't echoing the request id | Fix at the shared envelope layer (the single choke point all MCP clients pass through) rather than patching each call site |
| Daemon crashes/won't boot over one corrupt host directory | `reconcileHostRollbackBearers()` ran unguarded; first `HostJoinStateCorruptError` aborted the whole registry enumeration | Catch per-entry inside the enumeration loop, push to `quarantined`; inspect via `quarantinedHostMemberships()` |
| Session appears duplicated/phantom after a long turn or client compaction | One of four distinct defects: client-side compaction split, injection-only phantom (no transcript), stale-sweep false completion, or a mid-session fork reissuing the session id | Disambiguate first (see Step 7), then apply the matching fix — they are not interchangeable |
| Forked session shows as orphaned split with no lineage link | Agent's manifest lacks `sessionContinuation`, or the transcript path hadn't arrived yet when the boundary was computed | Declare `sessionContinuation` (`parentSessionIdPath`+`defaultReason`) in the agent manifest; verify with a live smoke test, not just offline replay |

---

## Cross-Cutting Gotchas

**Use named constants and shared utilities, not magic literals or local latches.** When solutioning daemon handlers, resist the urge to add a local variable or inline numeric constant. Extract the value to `packages/myco/src/constants.ts` or a shared utility module. Magic literals in daemon code spread quickly and create silent inconsistencies between subsystems.

**Audit existing config before adding new policy machinery.** Before building a new guard, threshold, or gate, check whether the behavior is already configurable via existing config keys (e.g., thresholds in `packages/myco/src/constants.ts`, scoped flags in myco.yaml). Adding redundant policy machinery creates conflicting sources of truth and makes future debugging harder.

**Check the machine-local config first when injection goes silent.** The gitignored local.yaml in the project's .myco/ directory can contain a cortex.enabled: false override that silences all cortex injection machine-wide. This override is only logged at debug level, making it invisible in normal daemon output. When cortex injection stops working with no obvious error, read that file before modifying any code.

**Never run `make dev-link` from a worktree.** `make dev-link` writes the project-scoped runtime pin pointing at the worktree binary, crossing the isolation boundary and routing the dev daemon through an unexpected binary path. Use `make dev-link-worktree` inside a worktree when per-worktree routing is needed; reserve `make dev-link` for the primary project root only.

**Stale template bundle after launcher edits.** `packages/myco/src/symbionts/templates.generated.ts` is auto-generated by `packages/myco/scripts/gen-templates.mjs` from template source files (including the hook/MCP launcher templates deployed to `~/.myco/launcher.cjs` and `~/.myco/mcp-launcher.cjs`). Editing a launcher template source without re-running `packages/myco/scripts/gen-templates.mjs` leaves the generated bundle stale — `tests/symbionts/templates-generated-sync.test.ts` and `tests/symbionts/codegen-drift.test.ts` catch this in CI, but a local dev loop can silently run against the old bundle. Run `packages/myco/scripts/gen-templates.mjs` (or `--check` to verify) after any launcher template change.

**Stale `packages/myco/src/ui-assets.generated.ts` deploy footgun.** This generated file backs the dashboard UI and is tracked in git — it must be deliberately regenerated (via `packages/myco/scripts/gen-ui-assets.ts`) and committed in any PR that changes the dashboard UI. CI's check job and a bare `build:binary` both consume the checked-in generated file rather than performing a fresh build, so a daemon serving a stale dashboard after a UI PR merge is usually this file falling out of sync, not a daemon runtime bug.

**Cross-variant artifact thrash.** When prod and dev daemon variants are both active (e.g., a dev-linked daemon running alongside a global install), their periodic update cycles can overwrite each other's shared machine-scoped launcher artifacts. Symptom: daemon unexpectedly switches to a different variant without user action, or hook output routes through the wrong binary. Diagnose with `ps aux | grep myco` to confirm which binary the daemon process is actually running, then check dev-link status. If both variants are stomping on each other, pin one variant's update schedule or stop the non-primary variant.

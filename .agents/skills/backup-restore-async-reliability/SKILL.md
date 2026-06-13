---
name: myco:backup-restore-async-reliability
description: |
  Activate this skill when working on the Myco backup/restore subsystem —
  including restore UX changes, async job architecture, daemon thread safety,
  or concurrency correctness in restore operations — even if the user doesn't
  explicitly ask about reliability or async patterns. Covers four major
  procedures: (1) restructuring the restore UI around a modal-based guided
  flow, (2) offloading long-running DB operations to a child process + async
  job registry, (3) parsing dump header metadata for preview without SQL
  execution, and (4) hardening the job registry against temp-path collisions
  and memory leaks.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Backup/Restore Async Architecture and Reliability

The Myco backup/restore subsystem handles SQLite dumps that can reach 800 MB+. These operations must never block the daemon's single main thread. This skill covers the full domain: restore UX design, async job execution, preview correctness, and concurrency safety — all grounded in PR #459 (session `86244e62`).

## Prerequisites

- The daemon runs in a single-threaded event loop; any blocking call in a request handler wedges all other endpoints.
- Backup files are SQLite dump format with per-table header comments (`-- Table: X (N rows)`).
- Key files: `packages/myco/src/backup/restore-runner.ts`, `packages/myco/src/backup/restore-jobs.ts`, and the daemon HTTP handlers for `/api/restore` and `/api/restore/preview` (`packages/myco/src/daemon/api/backup.ts`).

## Procedure A: Restore UX — Modal-Based Guided Flow

**Problem shape:** Showing a long backup list (22+ items: ~14 daily + ~8 weekly) inline in Settings causes the preview to render off-screen with no visual feedback. The confirmation step is bolted on after the fact rather than built into the flow.

**Design principle:** Separate two distinct user intents with distinct UI surfaces.

| Surface | User intent | Contents |
|---|---|---|
| Settings → Backup (inline) | "Are my backups healthy?" | Last backup timestamp, total count, "Backup Now" button — **no list** |
| "Restore" button → Modal | "I need to restore" | Guided flow: (1) pick a backup, (2) preview its contents, (3) confirm and restore with progress |

**Why the modal wins over inline alternatives:**
- Preview is always visible — the modal overlays the page; no scrolling required regardless of list length.
- Preview → Restore is a natural in-modal sequence: review contents *first*, then confirm. The confirmation step is built into the flow, not appended.
- Matches the user mental model: routine health checks (inline) vs. deliberate recovery action (modal).

**Rejected alternative:** Inline dropdown/accordion to collapse the backup list. Still buries the preview at scroll position — same failure mode, more complexity.

## Procedure B: Preview Endpoint — Parse Header Metadata, Never Execute SQL

**Root cause of the deadlock:** Both `/api/restore/preview` and `/api/restore` originally called `db.exec(entireDumpContents)` synchronously on the daemon's main thread. On an 800 MB dump, `db.exec` runs the full savepoint — 5+ minutes of blocking. All other HTTP endpoints queue behind it and time out. The daemon is NOT crashed; it is wedged.

**Preview does not need SQL execution.** The dump format records per-table row counts in header comments:

```
-- Table: sessions (1042 rows)
-- Table: prompt_batches (8837 rows)
-- Table: spores (949 rows)
```

The regex used to extract these is in `packages/myco/src/backup/engine.ts`:
```typescript
const TABLE_COUNT_REGEX = /-- Table:\s+(\w+)\s+\((\d+)\s+rows?\)/;
```

**Correct preview implementation:**
1. Open the backup file (stream or read line by line).
2. Scan for `-- Table: X (N rows)` header comments using `TABLE_COUNT_REGEX`.
3. Return structured metadata: table names, row counts, total size, backup date from filename or header.
4. Close file. Zero SQL executed.

**Never call `db.exec()` on a full dump in a preview path.** Even on a 20 MB dump it is wasteful; on an 800 MB dump it is a daemon wedge with no user-visible feedback.

**Signal:** If the UI shows no loading state and the button appears to do nothing, the first suspect is a synchronous `db.exec()` blocking the daemon before any response is sent.

## Procedure C: Async Job + Polling Pattern for Restore Execution

Synchronous HTTP is never appropriate for multi-hundred-MB SQL operations on the daemon's single thread. The correct architecture is three layers.

### Layer 1 — Initiate: Return Immediately

```
POST /api/restore
Body: { backupPath: "/path/to/backup.sql" }

Response (≈17ms, HTTP 202): { job_id: "restore-1-1234567890", status: "running", file_name: "..." }
```

The handler (`handleRestore` in `packages/myco/src/daemon/api/backup.ts`):
1. Validates the backup path exists and is readable.
2. Calls `restoreJobs.start({ groveId, fileName, dbPath, backupPath })`.
3. Returns `{ job_id, status: "running" }` immediately — does not await the child.

### Layer 2 — Execute: Child Process (`myco __restore-backup`)

The restore work runs in a hidden subcommand:

```bash
myco __restore-backup <dbPath> <backupPath> <outPath>
```

- `__` prefix signals an internal implementation command — intentionally excluded from user-facing help output.
- Spawned from `restoreViaChild()` in `packages/myco/src/backup/restore-runner.ts` using `spawn(process.execPath, ['__restore-backup', params.dbPath, params.backupPath, outPath])`.
- The child executes `db.exec(fullDump)` in isolation; the daemon event loop remains fully responsive.
- On completion, the child writes a result JSON to `outPath`:
  ```json
  { "restored": 14605, "skipped": 0 }
  ```
  On error: `{ "error": "message" }`
- **Results go to `outPath`, NOT stdout.** Any `console.log` or logging in the child process corrupts stdout; the daemon reads `outPath` on the poll cycle.

### Layer 3 — Poll: Status Endpoint

```
GET /api/restore/status?job_id=restore-1-1234567890

Running:  { job_id: "...", status: "running", file_name: "..." }
Done:     { job_id: "...", status: "done", result: { restored: 14605, skipped: 0 }, ... }
Error:    { job_id: "...", status: "error", error: "...", ... }
```

- Client polls at 1–2 second intervals.
- UI transitions: `"Restoring…"` → `"Restored N records, skipped M duplicates"` (or error state).
- Handler `handleRestoreStatus` in `packages/myco/src/daemon/api/backup.ts` reads job state from `RestoreJobRegistry.get(jobId)`.

**Why not streaming/WebSocket:** The response shape is binary (success/count), not progressive. Short-interval polling is simpler, sufficient, and requires no persistent connection management.

**Verified performance:**
- 20 MB backup: POST → running → done in ~2 seconds.
- 800 MB backup: daemon fully responsive throughout (8 health checks passed during restore); idempotent merge produces `restored=0 skipped=14605` — correct behavior.

**Design principle:** Any daemon operation executing a multi-hundred-MB SQL dump MUST use the child-process + async job pattern. Never block the daemon event loop for operations over ~1 second.

## Procedure D: Hardening the Job Registry

Two reliability bugs were found during code review of PR #459. Both are addressed in the current implementation in `packages/myco/src/backup/restore-jobs.ts`.

### D1 — Temp Path Collision (`restore-runner.ts`)

**Bug:** Temp result paths named `myco-restore-${process.pid}-${Date.now()}.json` are not unique across concurrent restores. `process.pid` is the single daemon PID, not the child's. Two restores on different Groves that spawn in the same millisecond share the same path — one child overwrites the other's JSON. The polling caller reads the wrong restore's result counts or crashes on a parse error.

**Why concurrent restores happen:** `RestoreJobRegistry` correctly permits one running job *per Grove*, so two different Groves can restore concurrently.

**Fix:** Add a per-call monotonic counter (`restoreSeq`) at module scope in `restore-runner.ts`:

```typescript
// Module scope — resets on daemon restart, guarantees uniqueness within lifetime
let restoreSeq = 0;

// When constructing the temp result path:
restoreSeq += 1;
const outPath = path.join(
  os.tmpdir(),
  `myco-restore-${process.pid}-${Date.now()}-${restoreSeq}.json`
);
```

The counter resets on daemon restart, which is acceptable — it guarantees uniqueness within any single daemon process lifetime.

### D2 — Unbounded Job Registry Memory Leak (`restore-jobs.ts`)

**Bug:** Finished restore jobs are never evicted from `RestoreJobRegistry`'s internal `Map`. Over a long-lived daemon, every restore operation accumulates an entry indefinitely — a slow memory leak and a source of stale state on status polls.

**Fix:** Evict finished jobs past their retention window on each `start()` call. In `restore-jobs.ts`:

```typescript
const FINISHED_JOB_RETENTION_MS = 30 * 60_000; // 30 minutes

private evictFinished(): void {
  const cutoff = this.now() - FINISHED_JOB_RETENTION_MS;
  for (const [id, job] of this.jobs) {
    if (job.status !== 'running' && (job.finished_at ?? job.started_at) < cutoff) {
      this.jobs.delete(id);
    }
  }
}

start(params: StartRestoreParams): RestoreJob {
  this.evictFinished(); // ← evict before starting a new job
  // ...
}
```

The registry correctly guards against concurrent running jobs per Grove (`runningForGrove()` check); the cleanup path for *completed* jobs completes the lifecycle.

**Add a test** covering eviction behavior when introducing this fix.

## Cross-Cutting Gotchas

**No UI loading state = silent wedge.** The original bug was invisible to users because no loading indicator existed. Whenever restore or preview is async, the UI must show a progress state from the moment the POST returns until the poll resolves. A button that appears to do nothing after clicking is indistinguishable from a wedged daemon without feedback.

**`db.exec()` is always dangerous on the main thread.** Any `db.exec()` call with content larger than a few KB risks blocking the daemon. If you find a `db.exec()` call in a request handler path, treat it as a bug candidate regardless of expected file size — dump files grow over time.

**Hidden subcommands (`myco __`) are internal contracts.** They are not part of the public CLI surface and may change without a migration path. Do not document them in user-facing help or rely on them from external tooling.

**Result files must go to `outPath`, not stdout.** Daemon logging, debug output, or any `console.log` in the child process will corrupt stdout. Always write structured results to the temp file path passed as an argument.

**Idempotent restores produce non-zero `skipped` counts.** A fully idempotent merge against an identical database correctly produces `restored=0 skipped=N`. This is expected behavior, not a failure.

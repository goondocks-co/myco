---
name: myco:author-and-debug-agent-pipeline-tasks
description: >
  How to author, configure, and debug Myco agent pipeline tasks —
  covering task YAML anatomy (phases, schedule, dependsOn, preCondition),
  the taskOverrides scalar-drop gotcha, the skipPriorContext hallucination
  trap, timeout wiring, concurrency guard behavior, LLM data-fidelity
  failure patterns, turn budget exhaustion, and fault-tolerance patterns.
  Use this skill when creating a new task YAML, adding schedule blocks,
  debugging a task that silently aborts or returns wrong data, or wiring
  phase dependencies. Apply it even if the user doesn't explicitly ask
  about task authoring — if they're modifying anything in
  src/agent/tasks/, src/agent/executor.ts, or
  src/daemon/task-scheduler.ts, this skill applies.
managed_by: myco
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - MultiEdit
---

# Authoring and Debugging Myco Agent Pipeline Tasks

## Prerequisites

- Understand the Myco agent pipeline: a phased executor that runs
  Claude-based tasks on a schedule or on-demand
- Task definitions live in `src/agent/tasks/<task-name>.yaml`
- The executor lives in `src/agent/executor.ts`
- The scheduler lives in `src/daemon/task-scheduler.ts`

---

## Part 1: Task YAML Anatomy

### Minimal task structure

```yaml
name: my-task
description: What this task does
schedule: "0 */6 * * *"   # cron; omit for on-demand-only tasks
timeout: 120               # seconds per phase (default: 60)
phases:
  - name: gather
    prompt: |
      <your prompt here>
  - name: process
    dependsOn: gather
    prompt: |
      <your prompt here>
```

### Key fields

| Field | Notes |
|---|---|
| `schedule` | Standard cron expression. Omit entirely for manual-only tasks. |
| `timeout` | Per-phase wall-clock limit. Keep under 180s for interactive tasks. |
| `dependsOn` | Phase name(s) whose output is available as context. |
| `preCondition` | SQL or JS expression; if falsy, task skips cleanly. |
| `skipPriorContext` | **See gotcha below.** Default false — leave it that way. |

### taskOverrides scalar-drop gotcha

`taskOverrides` in `myco.yaml` is a YAML mapping. If you override a
scalar field (e.g., `schedule`) alongside a block field (e.g., `phases`),
YAML merge rules silently drop the scalar. **Always override the full
`phases` block or nothing from it.** Symptom: your schedule change
appears in config but the task still runs on the old cron.

### skipPriorContext hallucination trap

Setting `skipPriorContext: true` prevents the executor from injecting
previous-phase outputs as context. This sounds like a token-saver, but in
practice the LLM hallucinates plausible-looking but fabricated content
when it lacks grounding. **Leave `skipPriorContext` at its default
(false)** unless you have a specific, tested reason to isolate a phase.

---

## Part 2: Concurrency Guard — Task-Type Keying

The pipeline executor has a concurrency guard that prevents duplicate
runs. **Critical behavior:** the guard is keyed on **task type** (task
name), not on `agent_id`. This means:

- Two different tasks (e.g., `skill-survey` and `skill-evolve`) **can**
  run concurrently — they have different task types.
- A second instance of the **same** task is blocked while the first is
  running.

### Debugging: "Run Now" appears to do nothing

If a manual "Run Now" trigger appears to silently do nothing:

1. Check whether a **scheduled run of the same task** is currently
   executing. The concurrency guard will drop the manual trigger without
   logging a visible error.
2. Wait for the scheduled run to complete, then retry.
3. If the task is stuck (not making progress), check `task_runs` in the
   DB — look for a run with `status = 'running'` and a stale `started_at`.
   A stuck run may need manual cleanup.

**The fix applied (2026-03-29):** Guard was previously keyed on
`agent_id`, which blocked ALL simultaneous tasks — any running scheduled
task silently dropped every other manual trigger. It now correctly keys on
task type. If you're on an older version and see this symptom, upgrade
the executor.

---

## Part 3: LLM Data-Fidelity Patterns

When a task phase asks an LLM to read from or write to the DB, three
failure modes are common.

### 3a. Gather phase idempotency — check both fields

If your gather phase is supposed to skip rows that have already been
processed, the idempotency check must cover **both** the linkage field
AND the status field:

```sql
-- WRONG: misses rows that were generated but not yet linked
WHERE skill_id IS NULL

-- CORRECT: skips rows that are either linked OR already generated
WHERE skill_id IS NULL AND status != 'generated'
```

Symptom: the gather phase re-processes rows it should skip, causing
duplicate work in downstream phases.

### 3b. Status enum values must match exactly

TypeScript constants for status enums must use **exactly** the string
values persisted in the DB. A mismatch causes silent query failures.

```typescript
// WRONG (if DB stores 'in_progress'):
const STATUS_RUNNING = 'inProgress';

// CORRECT:
const STATUS_RUNNING = 'in_progress';
```

If a task appears to work but rows don't transition between states,
add a raw SQL check: `SELECT DISTINCT status FROM <table>` and compare
against your constants.

### 3c. LLM UUID truncation — use prefix-match fallback

LLMs reliably truncate long UUIDs when asked to echo them back (e.g., in
a JSON payload). If a task phase asks the model to reference an existing
record by its full UUID, implement a **prefix-match fallback**:

```typescript
// Instead of exact match:
const record = db.prepare(
  `SELECT * FROM candidates WHERE id = ?`
).get(llmReturnedId);

// Use prefix-match fallback:
const record = db.prepare(
  `SELECT * FROM candidates WHERE id = ? OR id LIKE ?`
).get(llmReturnedId, `${llmReturnedId.slice(0, 8)}%`);
```

This applies any time you pass UUIDs to an LLM prompt and expect them
back in structured output — skill candidate IDs, spore IDs, session IDs.

---

## Part 4: Turn Budget Exhaustion

Each phase has a fixed turn budget. If a phase spends turns on repair
work, it may exhaust the budget before finishing all intended work —
causing later items to be **silently skipped**.

### Root cause: incomplete state from an upstream phase

The most common trigger: a draft/generate phase writes partial state
(e.g., creates a record but doesn't write the linkage field that connects
it to its parent). The downstream validate/finalize phase detects the
inconsistency and burns turns repairing it instead of advancing.

**Fix:** Draft phases must write **complete state** in a single atomic
operation. If the record and its linkage are inseparable, write them
together:

```typescript
// WRONG: two operations, linkage may be missing if phase aborts
db.prepare(`INSERT INTO skills ...`).run(skillRow);
db.prepare(`UPDATE candidates SET skill_id = ? WHERE id = ?`)
  .run(skillId, candidateId);

// CORRECT: wrap in a transaction
db.transaction(() => {
  db.prepare(`INSERT INTO skills ...`).run(skillRow);
  db.prepare(`UPDATE candidates SET skill_id = ? WHERE id = ?`)
    .run(skillId, candidateId);
})();
```

### Chain-of-responsibility principle

Each phase should do only its own job. The generate phase must not
re-apply deduplication logic that the survey phase already applied —
that's survey's responsibility. When a phase oversteps its chain role,
it burns turns on work the previous phase was supposed to handle, and
creates subtle divergence between what was approved and what gets written.

**Rule:** If phase B is re-doing phase A's job, fix phase A — don't
patch phase B.

### Diagnosing turn budget exhaustion

Signs that a phase ran out of turns:
- The task completes without error but only a fraction of expected items
  were processed
- The last processed item is N-3 or N-4 in the list, not N
- The agent log shows a high turn count (near the configured limit) for
  that phase

---

## Part 5: Timeout and Fault-Tolerance Wiring

### Timeout

Set `timeout` conservatively. A phase that calls an external API or
embeds many vectors needs more headroom than a phase that only reads
from DB. Start at 120s; increase only if you see timeout errors in logs.

### Fault tolerance for multi-item phases

If a phase processes a list of items (e.g., N skill candidates), structure
the prompt so each item is handled independently:

```
For each item in the list, complete the full operation before moving to
the next. If one item fails, log the error and continue — do not abort
the entire batch.
```

Without this, one malformed record aborts processing of all subsequent
records.

### preCondition for no-op skips

Use `preCondition` to skip phases when there's nothing to do:

```yaml
preCondition: "SELECT COUNT(*) FROM candidates WHERE status = 'approved' > 0"
```

This prevents empty phases from burning turns on "nothing to do" reasoning.

---

## Common Pitfalls Summary

| Symptom | Likely Cause | Fix |
|---|---|---|
| "Run Now" does nothing | Same task already running (concurrency guard) | Wait for running instance; check task_runs |
| Task skips items silently | Turn budget exhaustion from repair work | Fix upstream phase to write complete state |
| Gather re-processes already-done rows | Idempotency check missing one condition | Check both linkage field AND status field |
| DB rows never returned by status filter | Enum mismatch between code and DB | Run `SELECT DISTINCT status` to verify |
| LLM can't find record by ID | UUID truncation | Add prefix-match fallback |
| Schedule change ignored | taskOverrides scalar-drop | Override full phases block |
| Phase hallucinates context | skipPriorContext: true | Remove that flag |

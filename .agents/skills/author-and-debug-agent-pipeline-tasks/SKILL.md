---
name: myco:author-and-debug-agent-pipeline-tasks
description: How to author, configure, and debug Myco agent pipeline tasks — covering task YAML anatomy, phases, scheduling, timeout wiring, concurrency guards, turn budget exhaustion, LLM data-fidelity failure patterns, and fault-tolerance. Apply whenever modifying task YAMLs, the executor, or the task scheduler.
managed_by: myco
user-invocable: true
allowed-tools:
  - vault_state
  - vault_set_state
  - vault_search_fts
  - vault_search_semantic
  - vault_spores
  - vault_report
---

# Authoring and Debugging Myco Agent Pipeline Tasks

Myco's agent pipeline runs structured tasks defined in YAML files under `src/agent/tasks/`. Each task is executed by `executor.ts` (the phased executor) and scheduled by `src/daemon/task-scheduler.ts`. This skill covers the full authoring and debugging surface.

## When to Activate

- Creating or modifying any `.yaml` file under `src/agent/tasks/`
- Modifying `src/agent/executor.ts` or `src/daemon/task-scheduler.ts`
- Debugging a task that appears to complete but produces wrong or missing output
- A task that silently stops mid-execution without an error
- Wiring `dependsOn` or `preCondition` between tasks
- Diagnosing scheduler concurrency issues or unexpected task blocking

## Prerequisites

- Daemon is running with agent pipeline enabled
- Task YAML exists and is registered in the task configuration
- Access to daemon logs for `[task-scheduler]` entries

## Task YAML Anatomy

```yaml
name: my-task
description: What this task does
maxTurns: 60
timeoutSeconds: 1800
model: claude-sonnet-4-5   # must match a model in the manifest — no hardcoding
schedule:
  interval: 3600            # seconds
  enabled: true
dependsOn: []               # task names that must complete first
preCondition:               # optional gate; task skips if condition fails
  type: vault_query
  check: approved_candidates_exist
phases:
  - name: assess
    maxTurns: 20
    prompt: |
      ...
  - name: evolve
    maxTurns: 35
    prompt: |
      ...
```

**Key rules:**
- `maxTurns` at the task level is the total ceiling across all phases
- Each phase has its own `maxTurns`; the task ceiling must be ≥ sum of all phase maxTurns
- `timeoutSeconds` applies wall-clock time across the entire task run
- Never hardcode model names — reference the symbiont manifest

## Sizing Turn Budgets

**Sizing formula:** task `maxTurns` = sum of all phase `maxTurns` + small overhead buffer (5–10 turns).

**Calibrated values for skill-evolve (reference example):**
- task `maxTurns`: 60 (assess 20 + evolve 35 + 5 overhead)
- task `timeoutSeconds`: 1800
- assess phase `maxTurns`: 20 (~1.5 turns/skill for up to 9 skills + report)
- evolve phase `maxTurns`: 35 (~10 turns/rewrite × up to 3 STALE skills)

**Turn costs are multiplicative for multi-item phases.** If an evolve phase must rewrite N skills, it needs N × ~10 turns. Size for the worst-case count, not the typical case.

## Schedule and Sweep Design

Tasks with a `schedule` block are dispatched by the task scheduler based on `interval` (seconds since last run). The `lastRun` timestamp is updated in the `finally` block of the scheduler — both successful and failed runs advance the cooldown clock. This prevents retry hammering after failures.

**Sweep pattern:** A task that processes N items per run (e.g., skill-evolve processes all STALE skills in one run) should have its budget sized for the maximum expected N, not a single item. Sizing for one item and running with N causes silent truncation.

## Parameter Injection

Parameters passed to a task at invocation time are merged into the prompt context. The `taskOverrides` mechanism allows per-invocation overrides of YAML configuration values.

### taskOverrides Scalar-Drop Gotcha

When `taskOverrides` is passed as a serialized object, scalar values (strings, numbers, booleans) in nested objects can be silently dropped during deserialization. The outer object arrives but inner scalars are missing — the task runs with defaults instead of the intended overrides with no error.

**Fix:** Always verify the override arrived in the task context before relying on it. Log or check the resolved value at task startup.

## skipPriorContext Hallucination Trap

Setting `skipPriorContext: true` on a phase causes the agent to start fresh without conversation history. This prevents context bleed between phases but introduces a hallucination risk: the agent may fabricate values for fields it hasn't seen in the current context window.

**Pattern:** When `skipPriorContext: true` is required, ensure the phase prompt explicitly provides all data the agent needs — don't rely on the agent "remembering" values from earlier phases. Pass critical values via vault state or explicit prompt injection.

## Concurrency Guard

The scheduler uses a per-task `Set<string>` (`runningTasks`) to prevent concurrent execution of the same task. Each task name is added to the set at start and removed in `finally`.

**Three historical bugs, all fixed:**
1. **Global boolean** (`agentRunning`): modeled "is anything running?" instead of "is this specific task running?" — caused complete pipeline serialization where any running task blocked all others. Fixed: replaced with per-task `Set<string>` and `isTaskRunning(taskName)` / `setTaskRunning(taskName, value)`.
2. **Taskless run bypass**: when no explicit task was specified, the guard checked a name that never matched any running entry and always passed. Fixed: resolve effective task name via `getDefaultTask()` before the guard check.
3. **`lastRun` only on success**: a failing run didn't advance the cooldown clock, causing immediate retry loops. Fixed: `lastRun = Date.now()` moved to the `finally` block.

**These bugs were all invisible in normal (happy-path) operation.** Scheduler correctness issues cluster around taskless invocations, failing tasks, and concurrent unrelated tasks.

## Concurrent Run Audit Log Interleaving

When two tasks run concurrently, their audit log entries interleave in timestamp order. Reading the audit log to understand a single task's execution requires filtering by `task_name`. Do not assume sequential ordering in the log implies sequential execution.

## LLM Data-Fidelity Failure Patterns

LLM agents operating on structured vault data can produce subtly wrong output without signaling an error:

- **Hallucinated IDs**: The agent fabricates an entity or spore ID that doesn't exist in the vault. Always validate IDs with `vault_search_fts` or a direct lookup before using them in writes.
- **Truncated lists**: When asked to process N items, the agent may silently process fewer. Include explicit counts and reconciliation steps in prompts that process lists.
- **Stale context reads**: If a phase reads vault state that was written by a previous phase in the same run, confirm the write committed before reading (vault writes are synchronous but phase boundaries may introduce ordering assumptions).

## Skill Lifecycle Task Scheduling Specifics

The three skill lifecycle tasks (`skill-survey`, `skill-generate`, `skill-evolve`) have distinct scheduling semantics:

- **skill-survey**: Runs on schedule unconditionally; does nothing if no candidate-worthy spore clusters exist
- **skill-generate**: Has a `preCondition` requiring at least one `approved` candidate — skips silently if the queue is empty
- **skill-evolve**: Has a `preCondition` requiring at least one active skill — skips silently if no skills exist

After applying the P1 concurrency fixes, these tasks run independently of each other. If a lifecycle task isn't firing, check preConditions before blaming the scheduler.

## Common Pitfalls

### Turn budget exhaustion with multi-item phases

A phase that processes N items silently truncates at `maxTurns` with no error indicating the work was incomplete. The run appears to succeed. This was observed concretely in `skill-evolve`: with 3 STALE skills and evolve phase `maxTurns: 18`, the phase stopped after ~1.8 rewrites. The task appeared to complete; two skills were left un-evolved.

**Detection:** Compare expected output count with actual output count after the run. Add explicit reconciliation to critical phases.

**Sizing:** N items × ~10 turns/item is the minimum. Add 20–30% headroom for variance.

### Timeout wiring: wall clock vs. turn ceiling

A task can fail in two ways: exceeding `maxTurns` (turn ceiling) or exceeding `timeoutSeconds` (wall clock). They are independent. A task that hits the turn ceiling does not raise a timeout error; it just stops. A task that hits the wall clock raises a timeout. Size both independently: `timeoutSeconds` should be large enough to accommodate the expected turn count even at slow model latency.

### Phase prompt must be self-contained when using skipPriorContext

A phase that uses `skipPriorContext: true` receives no context from earlier phases. Any data produced in earlier phases (classifications, entity IDs, counts) must be re-read from vault state or explicitly injected into the phase prompt. Failing to do this causes the agent to hallucinate values or ask for context it cannot have.

### Skill lifecycle tasks not auto-firing

If `skill-generate` or `skill-evolve` run on demand but not on schedule:
1. Verify `enabled: true` and `interval` is set in the task YAML
2. Check whether the preCondition is failing (no approved candidates, no active skills)
3. Look for `[task-scheduler]` log entries that indicate why dispatch was skipped
4. Confirm the task name matches exactly — the scheduler matches by name string

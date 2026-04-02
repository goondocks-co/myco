---
name: myco:author-and-debug-agent-pipeline-tasks
description: How to author, configure, and debug Myco agent pipeline tasks — covering task YAML anatomy (phases, schedule, dependsOn, preCondition), sweep scheduling design, parameter injection patterns, the taskOverrides scalar-drop gotcha, the skipPriorContext hallucination trap, timeout wiring, concurrency guard behavior and correctness, concurrent run audit log interleaving, LLM data-fidelity failure patterns, turn budget exhaustion, skill lifecycle task scheduling specifics, and fault-tolerance patterns. Use this skill when creating a new task YAML, adding schedule blocks, debugging a task that silently aborts or returns wrong data, or wiring phase dependencies. Apply it even if the user doesn't explicitly ask about task authoring — if they're modifying anything in src/agent/tasks/, src/agent/executor.ts, or src/daemon/task-scheduler.ts, this skill applies.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Authoring and Debugging Myco Agent Pipeline Tasks

## Task YAML Anatomy

Every task lives in `src/agent/tasks/<name>.yaml`. Core fields:

```yaml
name: my-task
description: "What this task does"
enabled: true          # whether the scheduler auto-runs this task
maxTurns: 40           # total turn budget across all phases
timeoutSeconds: 900    # wall-clock limit for the entire task run
schedule:
  intervalMinutes: 60  # how often the task sweeps
  runDuringIdle: true  # only run when the daemon has no active user session
phases:
  - name: phase-one
    maxTurns: 20
    prompt: |
      ...
  - name: phase-two
    maxTurns: 15
    dependsOn: phase-one
    prompt: |
      ...
```

**Budget rule:** Task `maxTurns` must equal the **sum of all phase `maxTurns`** plus a small overhead buffer (5 turns). If the task `maxTurns` is lower than the sum, the run will be silently truncated mid-phase.

## Scheduling Design

### Sweep Scheduling

`runDuringIdle: true` gates execution to periods when no user session is active. This prevents the agent from consuming context or compute while the developer is actively working.

`intervalMinutes` sets the minimum gap between runs. The scheduler will not start a new run within this window even if idle.

### Risk-Profile-Based Default Enablement

**Set `enabled` based on the risk/reversibility profile of the operation:**

| Operation type | Default | Rationale |
|---|---|---|
| Read-only discovery | `enabled: true` | No side effects; safe to auto-run passively |
| Generative (writes new files) | `enabled: false` | Creates artifacts; user should verify output quality first |
| Mutative (modifies existing files) | `enabled: false` | Changes existing state; higher stakes; opt-in until trusted |

**Example — skill lifecycle tasks:**
- `skill-survey` → `enabled: true` (scans spores, creates candidates in DB only; read-like)
- `skill-generate` → `enabled: false` (writes new SKILL.md files to disk)
- `skill-evolve` → `enabled: false` (rewrites existing SKILL.md files)

This asymmetry is intentional progressive onboarding: let evidence accumulate passively, then make generative/mutative steps user-driven until the user has reviewed output quality and established trust. When in doubt, default to `enabled: false` for any task that writes or modifies files.

## Phase Dependencies

Use `dependsOn` to chain phases. The executor passes the prior phase's output as context to the next phase.

```yaml
phases:
  - name: assess
    maxTurns: 20
    prompt: "Assess X. Output a JSON classification."
  - name: execute
    maxTurns: 15
    dependsOn: assess
    prompt: "Read classifications from prior phase. Execute only STALE items."
```

**Key:** The dependent phase receives the full output of the prior phase. Structure the prior phase's output as parseable data (JSON, table) so the next phase can extract it reliably.

## preCondition

Use `preCondition` to skip a task run when there's nothing to do:

```yaml
preCondition:
  tool: vault_unprocessed
  expectNonEmpty: true
```

The scheduler evaluates the condition before starting. If the condition is not met, the run is skipped and logged. This prevents wasted turn budgets on idle runs.

## Parameter Injection

Task prompts support `{{variable}}` interpolation from the `parameters` block:

```yaml
parameters:
  model: claude-opus-4-5
  maxCandidates: 10
phases:
  - name: survey
    prompt: "Process up to {{maxCandidates}} candidates using {{model}}."
```

## The taskOverrides Scalar-Drop Gotcha

When using `taskOverrides` in `myco.yaml` to customize a task's fields, **scalar values (strings, numbers, booleans) must be explicitly set** — they do not inherit from the base YAML. If you override `phases` without re-specifying `maxTurns` or `timeoutSeconds`, those fields silently drop to their defaults (often 0 or null), causing immediate truncation.

**Pattern:** Always copy the full set of scalar fields into any `taskOverrides` block, even if you're only changing one value.

## The skipPriorContext Hallucination Trap

Setting `skipPriorContext: true` on a phase prevents it from receiving the prior phase's output. This is useful for isolation but creates a hallucination risk: if the phase prompt refers to "the prior phase output" or "the classification above," the phase will have no data to ground it and may hallucinate plausible-sounding results.

**Rule:** Only use `skipPriorContext: true` on phases that are genuinely independent. Never set it on a phase that references prior output in its prompt.

## Turn Budget Exhaustion

### Silent truncation pattern

When `maxTurns` is reached, the agent stops mid-execution with no error. The run log shows "completed" but the work is incomplete. This is the hardest failure mode to detect because it looks like success.

**Detection:** Check whether the expected artifacts (spores, skill files, DB records) were actually created. If fewer outputs than expected exist, budget exhaustion is likely.

### Budget sizing for multi-item phases

Phases that process N items (N STALE skills, N unprocessed batches) have multiplicative turn costs:

```
phase maxTurns = N_items × turns_per_item + buffer
task maxTurns  = sum(all phase maxTurns) + 5 overhead
timeoutSeconds = estimated_wall_time × 1.5 safety margin
```

**Skill-evolve example (3 STALE skills):**
- assess phase: ~13 turns → set `maxTurns: 20`
- evolve phase: 3 × ~10 turns = 30 turns → set `maxTurns: 35`
- task: 20 + 35 + 5 = 60 → set `maxTurns: 60`
- time: 3 rewrites × ~5 min + assess ~3 min = ~18 min → set `timeoutSeconds: 1800`

## Concurrency Guard Behavior

The executor prevents concurrent runs of the same task via a lock. If a run is already in progress when the scheduler fires, the new run is skipped and logged. This is correct behavior — do not work around it.

**Audit log interleaving:** When two tasks run concurrently (different task names), their log entries interleave in the audit log. This is expected. Filter by `task_name` when debugging a specific task's run history.

## LLM Data-Fidelity Failure Patterns

Observed failure modes when passing structured data between phases or between agent runs:

1. **Truncation under context pressure** — long lists or large JSON blobs are silently truncated when the context window fills. The agent completes without error but operates on partial data.
2. **Type coercion errors** — numbers passed as strings in YAML `parameters` may be coerced unpredictably depending on prompt wording.
3. **Stale prior-phase assumption** — if a phase assumes prior phase output exists but `dependsOn` was not set, the phase hallucinates the data.

**Mitigations:** Keep inter-phase data structures small; use IDs not full content when passing references; always set `dependsOn` on phases that reference prior output.

## Common Pitfalls

**Task runs but produces no output**
1. Check `preCondition` — it may have evaluated false and skipped
2. Check `maxTurns` — budget may have been exhausted at the first phase
3. Check `enabled` — task may be disabled

**Task silently stops mid-run**
Budget exhausted. Calculate: N_items × turns_per_item + buffer. Recalibrate both `maxTurns` (phase and task level) and `timeoutSeconds`.

**Phase doesn't receive prior phase output**
Check `dependsOn` is set on the consuming phase. Check `skipPriorContext` is not set. Verify the prior phase actually produces parseable output before the budget was exhausted.

**taskOverrides drops fields**
Copy all scalar fields into the override block explicitly. YAML merge keys (`<<:`) do not deep-merge scalars reliably in all parsers.

**skill-generate / skill-evolve never run despite being configured**
These tasks are `enabled: false` by default. Enable them explicitly via Daemon UI → Agent Tasks. This is intentional: generative and mutative tasks require deliberate opt-in.

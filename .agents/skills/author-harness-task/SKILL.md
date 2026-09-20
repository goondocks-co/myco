---
name: author-harness-task
description: >-
  This skill should be used when the user asks to "add a harness task", "write a new agent
  task", "add a phase", "tune the turn budget", "why did the phase fail silently", "which
  model should this task use", or when work touches a task YAML under
  `packages/myco/src/agent/definitions/tasks/`. Covers task YAML anatomy and registration,
  phase decomposition, model routing, turn-budget calibration, scheduling triggers and
  session-gating, tool-surface design with readOnly enforcement, and reading the `agent_runs`
  audit table when a run ends early.
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Agent Harness Task Authoring

The Myco agent harness is a phased executor running inside the daemon. Each task is an ordered sequence of phases — each phase is a single LLM invocation with a bounded tool surface and a turn budget. This skill covers the full authoring lifecycle: designing the phase sequence, writing the task config, selecting models, calibrating budgets, configuring triggers, designing tool surfaces, managing session lifecycle coordination, and debugging when things go wrong.

## Prerequisites

- Daemon is running and `agent.enabled: true` in `.myco/myco.yaml`.
- At least one existing task YAML has been read — at least one existing task YAML (`packages/myco/src/agent/definitions/tasks/vault-evolve.yaml`) to understand the config shape.
- The new task’s purpose can be described in one sentence — the new task's purpose in one sentence and identify which vault state it reads and writes.
- Familiarity with session lifecycle states (CAPTURING, PROCESSING, COMPLETE) and agent runtime coordination.

## Procedure 1: Design the Phase Sequence

### Apply the judgment/recipe gradient

Every phase sits on a spectrum from pure-recipe to pure-judgment:

| Pole | Characteristics | Typical examples |
|------|----------------|------------------|
| **Recipe** (deterministic) | Tight tool allowlist, short budget, script-like | Mark processed, cursor update, dedup gate |
| **Judgment** (open-ended) | Broader tool access, longer budget, LLM reasons freely | Extract spores, consolidate, generate skill |

Position each phase deliberately. Never blur: a phase that both reasons and writes DB state is hard to debug and hard to retry cleanly.

### Data injection between phases

The canonical pattern is **read-only discovery → write**:
1. **Phase 1 (`discover`)**: reads vault, assembles context, writes nothing. Emits a structured summary.
2. **Phase 2 (`write`)**: receives that summary as injected context; writes to vault based on it.

This keeps Phase 2 idempotent — a failure can be replayed with the same context without re-running discovery.

### Multi-tier workflows

Complex tasks may need tiered verification phases, such as the skill lifecycle pattern: `inventory → verify → assess → act`. The verify phase specifically validates skills against current codebase state and sets watermarks for rotation.

## Procedure 2: Write the Task Config

Tasks live in `packages/myco/src/agent/definitions/tasks/`. Each task exports a TaskDefinition:

```ts
export const myNewTask: TaskDefinition = {
  name: 'my-new-task',
  isDefault: false,
  phases: [ /* see below */ ],
  triggers: {
    schedule: '0 */4 * * *',
    requireSettledSessions: true,
    settledSessionIdleMinutes: 5,
  },
};
```

**Critical**: Ensure proper TaskDefinition export. Malformed exports cause silent task failures with no error logs.

## Procedure 2.1: Grove Multi-Project Integration

### Scope iteration patterns

Grove introduces multi-project management. Tasks must handle scope iteration across registered projects:

```ts
import { forEachGrove, forEachRegisteredProject, isProjectActive } from '../../../daemon/scope-iteration';

// Iterate across all groves
await forEachGrove(async (grove) => {
  // Grove-level processing
});

// Iterate across registered projects in current grove
await forEachRegisteredProject(async (projectContext) => {
  if (!isProjectActive(projectContext)) return;
  // Per-project task execution
});
```

**Project lifecycle management**: Use `ProjectPowerStateTracker` to respect project sleep/wake state.

### Handle safety with Grove runtime cache

Use `GroveRuntimeCache` for safe cross-project state management.

### Daemon notification integration

Tasks should emit notifications for multi-project visibility.

## Procedure 3: Select Models with the Advisor Pattern

Use `advisor` field per-phase for optimal model routing:

| Tag | Best for | Reasoning capability |
|-----|----------|----------------------|
| `cloud-reasoning` | Open-ended judgment phases | Full reasoning capability, largest context window, slowest |
| `cloud-fast` | Recipe phases where speed matters | Standard reasoning, medium context, fast turnaround |
| `local-draft` | Cost-sensitive judgment phases | Local reasoning, limited context, cheapest |

### reasoningLevel abstraction

Model selection integrates with reasoning capability levels:

1. **Heavy reasoning** (`cloud-reasoning`): For phases that require complex multi-step reasoning, cross-file analysis, or semantic understanding. Turn budgets 15–25 (cloud) or 45–75 (local).
2. **Standard reasoning** (`cloud-fast`): For phases with moderate reasoning needs or tight latency budgets. Turn budgets 8–15 (cloud) or 25–45 (local).
3. **Minimal reasoning** (recipe phases): For deterministic operations, dedup gates, cursor updates. Turn budgets 2–5.

Assign `advisor` tags based on required reasoning intensity, not just speed. A fast model on a heavy-reasoning phase will exhaust budget or produce low-quality results. A slow model on a recipe phase wastes cost.

**Local model gotcha**: Multiply all turn budgets by 3–4× for local Ollama models due to lower context compression and reasoning depth.

## Procedure 4: Calibrate Turn Budgets

| Phase type | Cloud budget | Local budget |
|------------|--------------|--------------| 
| Discovery / read-only | 8–12 | 25–40 |
| Write / consolidation | 10–20 | 30–60 |
| Map-phase (per item) | 2–4 | 6–12 |

**Fix unbounded input**: Cap the input size, not the budget. Use bounded instruction builders with `MAX_BATCHES = 20`.

## Procedure 5: Configure Scheduling and Session Gating

### Session Lifecycle Phases for Task Orchestration

Tasks must understand the three-phase session lifecycle that ensures data stability during intelligence processing:

1. **CAPTURING** (`active`): Session actively capturing content from agent interactions
   - All capture operations valid and expected
   - Agent operations can modify session state
   - Session remains in this state until agent work complete
   - Transitions to PROCESSING when agent finishes

2. **PROCESSING** (`completed`): Session work finished, intelligence processing begins
   - No new captures accepted — session sealed for processing
   - Intelligence tasks (skill-survey, full-intelligence) can now safely process session
   - Session data is stable and won't be modified by agent operations
   - Prevents feedback loops where intelligence tasks process incomplete sessions
   - Transitions to COMPLETE after intelligence processing finishes

3. **COMPLETE** (`processed`): Intelligence extraction complete, session archived
   - Session read-only for historical reference and lineage tracking
   - All derived spores and insights extracted and stored
   - Can be reopened for follow-up work if needed

### Session gating (critical)

```ts
triggers: {
  requireSettledSessions: true,  // Required for transcript-reading tasks
  settledSessionIdleMinutes: 5,
}
```

Any task reading session transcripts **must** gate on settled sessions to prevent stale artifacts. Intelligence tasks only process sessions with `completed` or `processed` status, ensuring session data is stable and won't be modified during analysis.

**Vault read surfaces**: All surfaces automatically honor the gate.

### runWhenCold — catch-up tasks bypass the cold-project gate

```ts
triggers: {
  schedule: '*/15 * * * *',
  runWhenCold: true,   // drains backlog even on long-inactive projects
}
```

`runWhenCold` (`packages/myco/src/agent/types.ts`, `packages/myco/src/config/schema.ts`, `packages/myco/src/agent/schemas.ts`) is a real `TaskDefinition`/schedule field, distinct from `requireSettledSessions`. The scheduler's per-project cold gate (`packages/myco/src/daemon/task-scheduler.ts`) skips every task on a cold (long-inactive) project **except** those with `runWhenCold: true`. Design principle: there is no such thing as "cold" for catch-up or backlog-draining work (e.g. `canopy-describe`, see `packages/myco/src/agent/definitions/tasks/canopy-describe.yaml`) — that work must keep draining regardless of session recency, or its pending backlog pins the daemon awake on work the gate itself refuses to run. Cold-gating (the default, `runWhenCold` unset/false) is for knowledge-generating tasks where processing a long-idle project has no value.

**Settlement conditions**: SessionEnd hook OR `last_prompt_at` older than `settledSessionIdleMinutes`.

## Procedure 6: Design the Tool Surface

### Recipe vs. Judgment surfaces

**Recipe phases**: Explicit allowlists for predictable behavior.
```ts
const DISCOVER_TOOLS = {
  bash: { allowed: ['cat', 'grep'] },
  vault: ['vault_unprocessed', 'vault_spores'],
};
```

**Judgment phases**: Broader access but scoped writes.
```ts
const CONSOLIDATE_TOOLS = {
  vault: ['vault_spores', 'vault_search_fts', 'vault_create_spore'],
};
```

**readOnly annotation**: Set `readOnly: true` on non-writing phases for MCP enforcement and safe concurrent execution.

**Allowlist authority is the purpose text, not the tool schema docstring.** When building a deterministic allowlist that lets a call skip an LLM-judgment classifier (e.g. a "provably bookkeeping-only" predicate), derive the allowed key/field set from what the phase's authored prompt actually instructs the model to write — not just the tool's parameter docstring. `packages/myco/src/agent/tools/skill-tools.ts`'s `SKILL_RECORD_BOOKKEEPING_KEYS` allowlist was first built from the `vault_skill_records` tool schema docstring alone and missed `last_assessed_generation` and `file_fingerprints`, which the skill-evolve assess phase prompt also writes — caught only by a live verification run. Cross-check any such allowlist against the union of the tool schema AND every phase prompt that calls it.

## Procedure 7: Observe and Debug

### agent_runs audit table

Every phase execution writes to `agent_runs`:

| Column | What it indicates |
|--------|-------------------|
| `exit_reason` | `budget_exhausted` / `short_circuit` / `complete` / `error` |
| `turn_count` | LLM turns used — for tool-heavy phases this counts API requests, not SDK turns; `actions_taken.phases[].turnsUsed` can legitimately show 21 for a 10-turn-cap phase |
| `tool_output_summary` | Concatenated tool outputs (truncated) |

For failed runs, `agent_turns.tool_input` is a fully recoverable audit trail — use it to reconstruct exactly which tool calls a phase made even when `tool_output_summary` is truncated.

### Silent failure patterns

| Symptom | Likely cause |
|---------|--------------|
| `exit_reason = 'complete'` but no state change | Sentinel triggered incorrectly |
| `turn_count = 1`, empty `tool_output_summary` | Malformed prompt or injected context |
| Task never appears in `agent_runs` | TaskDefinition export malformed |

### Postcondition gates vs. clean exit

A clean `exit_reason = 'complete'` only proves the model didn't error — it does not prove the model made the load-bearing tool call. Deterministic postcondition gates (asserting a specific write occurred) catch silent-completion failures that exit-reason monitoring alone misses. A single postcondition failure can be noise; a **cluster** of postcondition failures across runs signals a prompt regression, not a one-off fluke.

### STOP after terminal tool call

Phases with a single terminal tool (e.g., `write_plan`, `vault_report`) need an explicit "STOP once the tool returns ok" instruction in the system prompt. Without it, the model burns remaining turn budget re-verifying an already-successful write instead of exiting cleanly.

### Terminal call is mandatory — no valid path ends in prose

When a phase's postCondition asserts a specific write happened, that write must be **stored by the current run**, not inherited from a stale prior run — the postcondition fails the entire run if the state wasn't written by THIS run. Write the phase prompt so every reachable outcome ends in the terminal tool call, never in prose: e.g. `packages/myco/src/agent/definitions/tasks/skill-survey.yaml`'s reconciliation phase requires a stored `vault_skill_survey_reconciliation_plan` call even when there is nothing actionable (submit a plan with all candidates Keep/Blocked) or the evidence bundle is unusable (submit a cleanup-only plan) — there is no "nothing to do, stopping" exit.

PostCondition kind names are centralized in `packages/myco/src/agent/phase-postcondition-kinds.ts` (`PHASE_POSTCONDITION_KINDS`), the single source of truth consumed by both the Zod enum in schemas.ts and the runtime dispatch table in `packages/myco/src/agent/phase-postconditions.ts`. Adding a new postCondition means appending the kind literal there AND adding its matching check function in `packages/myco/src/agent/phase-postconditions.ts` — TypeScript's `Record<PhasePostConditionKind, Fn>` enforces the pairing.

## Additional Resources

- **`references/advanced-harness-integration.md`** — Advanced Harness Integration, Cost Models, Fault Tolerance and Session Lifecycle
- **`references/map-phase.md`** — Map-Phase Architecture

## Cross-Cutting Gotchas

- **TaskDefinition export malformed** → task never runs, no error. Verify export structure and check `agent_runs`.
- **No session gate on transcript-reading task** → stale artifacts. Always set `requireSettledSessions: true`.
- **Static turn budget on unbounded input** → unpredictable runtime. Cap input size, not budget.
- **Single model for all phases** → overpaying or underperforming. Use per-phase `advisor` field with reasoning-level awareness.
- **Local model without budget multiplier** → phase exhausts. Multiply budgets by 3–4× for Ollama.
- **Map-phase sink schema expectation** → `args.sink_schema` doesn't exist in map mode. Use `argMap` instead.
- **Abort controller propagation** → Thread controllers through all iterations to prevent resource leaks.
- **Tool surface wrapping** → Each iteration gets wrapped surface. Stateful tools may behave unexpectedly.
- **Accelerator counter overflow** → Implement bounds checking and counter resets for long operations.
- **Rate limit amplification** → Map phases hit limits faster. Implement backoff and consider API quotas.
- **Provider metadata staleness** → Implement refresh mechanisms and validate availability.
- **State contract violations** → Strict adherence required. Violations cascade through harness system.
- **Grove scope iteration without project state check** → Processing inactive projects. Always check `isProjectActive()`.
- **Cross-project state corruption** → Use `GroveRuntimeCache` for thread-safe handle management.
- **Missing daemon notifications** → Grove multi-project visibility requires notification emission.
- **Migration path reference error** → Migrations are in single file `packages/myco/src/db/migrations.ts`, not directory.
- **Session gating prevents intelligence feedback loops** → Tasks reading transcripts must gate on settled sessions (completed/processed status) to ensure session data is stable during analysis and prevent processing incomplete sessions.
- **Session state consistency** → Always validate session status before operations — intelligence tasks must gate on session-terminal state (completed/processed) as active sessions produce stale artifacts.
- **Cortex instructions requirement** → Lead agent MUST call `myco_cortex({op:"instructions"})` before delegating to sub-agents — delegation without instructions causes sub-agents to operate with inconsistent scope.
- **Cortex injection uniformity** → All task phases must receive cortex context via unified injection path. Tasks that bypass cortex context propagation or re-acquire it per-phase introduce inconsistency.
- **Cross-platform hook deployment** → The cross-platform hook guard is `join(resolveMycoHome(), 'launcher.cjs')` (exported from `packages/myco/src/grove/paths.ts`). The old `.agents/myco-run.cjs` project-local path was retired by the global-install migration. MCP children inherit `cwd=/` from some agents — use `resolveVaultDir()` with `MYCO_VAULT_DIR` fallback.
- **Runtime resource management** → Agent harness execution consumes resources — implement proper cleanup. Concurrent sessions must coordinate vault database access to prevent corruption.
- **Cortex injection is capability-gated at two levels**: A task that depends on cortex context must verify two conditions before assuming injection happened: (1) `capabilityEnabled(config, 'cortex')` from `packages/myco/src/config/capabilities.ts` returns true — the gate is fail-closed (null config → false) and reads the `cortex` capability's masterGate config leaf; (2) the relevant injection flag in the `cortex.instructions` config block — either `inject_on_session_start` or `inject_on_subagent_start` — is enabled. Both must be true. A task that assumes cortex context exists will silently operate without it when the capability is disabled or the injection flags are off.
- **Classifier-adjacent changes need a live run, not just a dry run**: When a task/phase's semantic-check classifier purpose statement changes (e.g. widening which actions a phase is authorized to take — vault-evolve's extract phase being authorized for `obsolete` alongside `supersede`), verify the change with a live run before merging. Dry-run intercepts the write at the `wrapToolWithSemanticCheck` layer before the classifier evaluates it, so `agent_run_write_intents.classifier_verdict` stays NULL and the classifier gate is never exercised — a dry run can look clean while a live run would flag or block the same write.

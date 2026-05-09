---
name: myco:author-harness-task
description: |
  Use this skill when designing, writing, configuring, or debugging a new phased
  executor task for the Myco agent harness — even if the user doesn't explicitly
  ask for a "task authoring" guide. Applies when adding a new intelligence task,
  modifying phase structure, tuning turn budgets or model routing, adjusting
  scheduling triggers or session-gating, designing a tool surface, or debugging
  silent phase failures or budget exhaustion. Covers: YAML task anatomy and
  registration; phase decomposition and the judgment/recipe gradient; model
  selection via the advisor pattern; turn budget calibration including
  local-model multipliers; scheduling triggers and session-gating; tool surface
  design and readOnly enforcement; Grove scope iteration patterns; per-project
  lifecycle management; and observability via the agent_runs audit table.
managed_by: myco
user-invocable: true
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob]
---

# Myco Agent Harness Task Authoring

The Myco agent harness is a phased executor running inside the daemon. Each task is an ordered sequence of phases — each phase is a single LLM invocation with a bounded tool surface and a turn budget. This skill covers the full authoring lifecycle: designing the phase sequence, writing the task config, selecting models, calibrating budgets, configuring triggers, designing tool surfaces, and debugging when things go wrong.

## Prerequisites

- Daemon is running and `agent.enabled: true` in `.myco/myco.yaml`.
- You have read at least one existing task YAML (`packages/myco/src/agent/definitions/tasks/vault-evolve.yaml`) to understand the config shape.
- You can describe the new task's purpose in one sentence and identify which vault state it reads and writes.

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

This keeps Phase 2 idempotent — if it fails you can replay it with the same context without re-running discovery.

### Multi-tier workflows

Complex tasks may need tiered verification phases, such as the skill lifecycle pattern: `inventory → verify → assess → act`. The verify phase specifically validates skills against current codebase state and sets watermarks for rotation.

## Procedure 1.1: Map-Phase Architecture

Use `mode: map` for bulk operations with identical per-item logic. The harness owns batch fetch and iteration; the model invokes once per item with constrained tools.

### When to use map mode

**Ideal for:** Bulk operations with identical per-item processing, cost-sensitive batch work.
**Not suitable for:** Cross-item reasoning, operations requiring dynamic tool selection, phases needing full batch context.

### Map-phase configuration

```ts
{
  name: 'process_items',
  mode: 'map',
  systemPrompt: ITEM_PROCESSING_PROMPT,
  turnBudget: 3,           // Per-item budget, keep tight
  tools: ITEM_TOOLS,       // Constrained surface per item
  fetchConfig: {
    tool: 'canopy_get_entries',
    params: { limit: 20, types: ['file'] },
    itemField: 'entries',  // Array field in tool response
    emptySkip: true,       // Skip phase if no items
  },
}
```

### Advanced debugging and optimization

**Contract violations**: Map-phase harness strips sink_schema and injects argMap. Phase handlers checking `args.sink_schema` will fail.

**Accelerator configuration**:
```yaml
accelerator:
  strategy: adaptive
  initial_batch_size: 5
  max_batch_size: 20
  ramp_factor: 1.5
  success_threshold: 0.85
```

**Cost optimization**: Use provider metadata consolidation (600x+ speedup observed) and cost-aware batch sizing:
```javascript
function calculateOptimalBatchSize(inputSize, costModel) {
  const memoryConstraint = Math.floor(availableMemory / avgItemMemory);
  const costConstraint = Math.floor(maxBatchCost / estimatedItemCost);
  return Math.min(memoryConstraint, costConstraint, inputSize);
}
```

**Runtime optimization**: Implement agent instance pooling, tool surface templates, and resource monitoring for long-running operations.

**Fault tolerance**:
```yaml
retry:
  max_attempts: 3
  backoff: exponential
  recoverable_errors: ["rate_limit", "timeout", "temporary_failure"]
  permanent_errors: ["auth_error", "invalid_input"]
```

## Procedure 2: Write the Task Config

Tasks live in `packages/myco/src/agent/definitions/tasks/`. Each task exports a TaskDefinition:

```ts
export const myNewTask: TaskDefinition = {
  name: 'my-new-task',          // kebab-case, unique across all tasks
  isDefault: false,              // true = fires on settled session; false = manual/cron only
  phases: [ /* see below */ ],
  triggers: {
    schedule: '0 */4 * * *',    // omit for event-only tasks
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

// Iterate across all groves (highest level)
await forEachGrove(async (grove) => {
  // Grove-level processing
});

// Iterate across registered projects in current grove
await forEachRegisteredProject(async (projectContext) => {
  if (!isProjectActive(projectContext)) return;
  // Per-project task execution
});
```

**Project lifecycle management**: Use `ProjectPowerStateTracker` to respect project sleep/wake state:

```ts
import { ProjectPowerStateTracker } from '../../../daemon/project-power-state';

const powerTracker = new ProjectPowerStateTracker();
if (!powerTracker.isProjectAwake(projectId)) {
  // Skip or defer task for sleeping project
}
```

### Handle safety with Grove runtime cache

Use `GroveRuntimeCache` for safe cross-project state management:

```ts
import { GroveRuntimeCache } from '../../../daemon/grove-runtime-cache';

const cache = new GroveRuntimeCache();
const projectHandle = cache.getProjectHandle(projectId);
// Use handle for thread-safe operations across grove
```

### Daemon notification integration

Tasks should emit notifications for multi-project visibility:

```ts
// Emit task completion notifications
await notificationService.emit({
  domain: 'agent',
  event: 'task_completed',
  projectId,
  data: { taskName: 'my-new-task', phase: 'completion' }
});
```

## Procedure 3: Select Models with the Advisor Pattern

Use `advisor` field per-phase for optimal model routing:

| Tag | Best for |
|-----|----------|
| `cloud-reasoning` | Open-ended judgment phases (extraction, synthesis) |
| `cloud-fast` | Recipe phases where speed matters |
| `local-draft` | Cost-sensitive judgment phases |

**Local model gotcha**: Multiply all turn budgets by 3–4× for local Ollama models.

## Procedure 4: Calibrate Turn Budgets

| Phase type | Cloud budget | Local budget |
|------------|--------------|--------------|
| Discovery / read-only | 8–12 | 25–40 |
| Write / consolidation | 10–20 | 30–60 |
| Map-phase (per item) | 2–4 | 6–12 |

**Fix unbounded input**: Cap the input size, not the budget. Use bounded instruction builders with `MAX_BATCHES = 20`.

**Batch optimization**: Recent findings show 8–12 items per batch often outperforms 15–20 items for complex reasoning.

## Procedure 5: Configure Scheduling and Session Gating

### Session State Machine

```
active  ──(SessionEnd hook or idle threshold)──►  completed
  ▲                                                    │
  └──────────(SessionStart on same session)────────────┘
```

**Settlement conditions**: SessionEnd hook OR `last_prompt_at` older than `settledSessionIdleMinutes`.

### Session gating (critical)

```ts
triggers: {
  requireSettledSessions: true,  // Required for transcript-reading tasks
  settledSessionIdleMinutes: 5,
}
```

Any task reading session transcripts **must** gate on settled sessions to prevent stale artifacts.

**Vault read surfaces**: All surfaces (`vault_unprocessed`, `vault_spores`, `vault_sessions`, `vault_search_fts`, `vault_search_semantic`) automatically honor the gate.

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

## Procedure 7: Observe and Debug

### agent_runs audit table

Every phase execution writes to `agent_runs`:

| Column | What it tells you |
|--------|-------------------|
| `exit_reason` | `budget_exhausted` / `short_circuit` / `complete` / `error` |
| `turn_count` | LLM turns used |
| `tool_output_summary` | Concatenated tool outputs (truncated) |

### Silent failure patterns

| Symptom | Likely cause |
|---------|--------------|
| `exit_reason = 'complete'` but no state change | Sentinel triggered incorrectly |
| `turn_count = 1`, empty `tool_output_summary` | Malformed prompt or injected context |
| Task never appears in `agent_runs` | TaskDefinition export malformed |

## Procedure 8: Advanced Harness Integration

### Pi integration patterns

- Design agent implementations for central harness registry
- Use durable state contracts for reliable lifecycle management
- Implement proper agent scoping and resource cleanup
- Follow Pi conceptual framework for architecture consistency

### Harness-ready architecture

- Register in central harness for discoverability
- Use registry-based agent resolution for dynamic assignment
- Implement config caching patterns (reduce initialization overhead)
- Design for minimal resource consumption during idle periods

## Procedure 9: Cost Models and Performance Optimization

### Cost-aware strategies

- Monitor token consumption patterns across iterations
- Implement circuit breakers for expensive operations
- Use consolidated provider metadata for model selection optimization
- Design adaptive pricing strategies with cost efficiency feedback

### Performance patterns

- **Agent instance pooling**: Reuse instances across iterations when safe
- **Tool surface optimization**: Strip unnecessary tools, implement lazy loading
- **Batch sizing strategies**: Balance memory, cost, and latency constraints
- **Resource monitoring**: Track memory/CPU usage, alert on exhaustion

## Procedure 10: Fault Tolerance and State Management

### Robust operation patterns

- Implement checkpoint/resume for large operations
- Design idempotent operations where possible
- Use failure isolation to contain iteration failures
- Preserve partial results for manual recovery

### State management

- Persist intermediate state at logical boundaries
- Enable resumption from last successful checkpoint
- Design state contracts that survive restarts
- Implement state validation and migration patterns

## Cross-Cutting Gotchas

- **TaskDefinition export malformed** → task never runs, no error. Verify export structure and check `agent_runs`.
- **No session gate on transcript-reading task** → stale artifacts. Always set `requireSettledSessions: true`.
- **Static turn budget on unbounded input** → unpredictable runtime. Cap input size, not budget.
- **Single model for all phases** → overpaying or underperforming. Use per-phase `advisor` field.
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
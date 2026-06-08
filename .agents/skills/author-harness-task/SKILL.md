---
name: myco:author-harness-task
description: "Use this skill when designing, writing, configuring, or debugging a new phased executor task for the Myco agent harness — even if the user doesn't explicitly ask for a \"task authoring\" guide. Applies when adding a new intelligence task, modifying phase structure, tuning turn budgets or model routing, adjusting scheduling triggers or session-gating, designing a tool surface, or debugging silent phase failures or budget exhaustion. Covers: YAML task anatomy and registration; phase decomposition and the judgment/recipe gradient; model selection via the advisor pattern; turn budget calibration including local-model multipliers; scheduling triggers and session-gating; tool surface design and readOnly enforcement; Grove scope iteration patterns; per-project lifecycle management; session lifecycle orchestration and agent runtime coordination; and observability via the agent_runs audit table."
managed_by: myco
user-invocable: true
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob]
---

# Myco Agent Harness Task Authoring

The Myco agent harness is a phased executor running inside the daemon. Each task is an ordered sequence of phases — each phase is a single LLM invocation with a bounded tool surface and a turn budget. This skill covers the full authoring lifecycle: designing the phase sequence, writing the task config, selecting models, calibrating budgets, configuring triggers, designing tool surfaces, managing session lifecycle coordination, and debugging when things go wrong.

## Prerequisites

- Daemon is running and `agent.enabled: true` in `.myco/myco.yaml`.
- You have read at least one existing task YAML (`packages/myco/src/agent/definitions/tasks/vault-evolve.yaml`) to understand the config shape.
- You can describe the new task's purpose in one sentence and identify which vault state it reads and writes.
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
  turnBudget: 3,
  tools: ITEM_TOOLS,
  fetchConfig: {
    tool: 'canopy_get_entries',
    params: { limit: 20, types: ['file'] },
    itemField: 'entries',
    emptySkip: true,
  },
}
```

### Advanced debugging and optimization

**Contract violations**: Map-phase harness strips sink_schema and injects argMap. Phase handlers checking `args.sink_schema` will fail.

**Accelerator configuration** and **Cost optimization** patterns implemented for long-running operations.

**Runtime optimization**: Agent instance pooling, tool surface templates, resource monitoring.

**Fault tolerance**: Retry mechanisms with exponential backoff and error classification.

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
- Implement config caching patterns
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

## Procedure 11: Session Lifecycle Orchestration for Tasks

### Cortex Instructions Requirement

The lead (top-level agent orchestrator) must establish Cortex instructions context before delegating work to sub-agents:

1. **Instructions acquisition**: Lead agent calls `myco_cortex({op:"instructions"})` BEFORE delegating to sub-agents
2. **Context propagation**: Pass acquired instructions through delegation chain via unified path
3. **Consistency validation**: Verify all delegates operating under same instruction set
4. **Sub-agent enforcement**: Sub-agents must fail if delegation proceeds without cortex-injection-context
5. **Unified injection path**: All task phases receive cortex context injected uniformly — lead establishes context once, all child phases inherit it

This prevents inconsistent or divergent behavior across the delegation hierarchy.

### Session initialization and validation

1. **Generate session ID**: Use deterministic UUID generation based on timestamp and project context
2. **Validate project binding**: Ensure session is created within valid project scope
3. **Initialize session record**: Create database entry with proper status (`active`)
4. **Set initial metadata**: Project ID, machine ID, agent context, creation timestamp
5. **Verify project root**: Session must be created within valid Myco project using `resolveVaultDir()`
6. **Check vault permissions**: Ensure write access to `.myco/` directory
7. **Validate agent identity**: Confirm agent has permission to create sessions in this project

### Hook transport and capture coordination

1. **Scan for installed agents**: Check agent-specific hook configurations in `.myco/`
2. **Validate hook implementations**: Check that hook files exist and are executable
3. **Cross-platform deployment**: Use `join(resolveMycoHome(), 'launcher.cjs')` for the cross-platform hook guard (`.agents/myco-run.cjs` was retired by PR #355 global-install migration)
4. **Transport protocol setup**: Configure capture channels based on agent type
5. **Scope validation**: Ensure captured content belongs to current project
6. **Permission checks**: Verify agent has capture rights for target files/directories
7. **Content filtering**: Apply exclusion rules for sensitive or irrelevant content
8. **Size limits**: Enforce capture size boundaries to prevent resource exhaustion

### Runtime boundary validation

1. **Error boundary enforcement**: Prevent task errors from affecting other sessions
2. **Resource protection**: Guard against resource exhaustion attacks
3. **Data validation**: Ensure captured content meets quality standards
4. **Permission enforcement**: Block unauthorized operations consistently
5. **Failure classification**: Categorize failures as transient, configuration, system, or agent-level for proper recovery
6. **Recovery procedures**: Implement session recovery, task restart, and data repair workflows

### Multi-agent coordination within sessions

1. **Concurrent execution management**: Manage multiple agents operating on same project
2. **Task serialization**: Sequence dependent operations to avoid conflicts
3. **Resource sharing**: Coordinate shared vault and database access
4. **Result synchronization**: Merge results from parallel agent operations
5. **Isolation setup**: Configure runtime boundaries between concurrent agents

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
- **Cross-platform hook deployment** → The cross-platform hook guard is `join(resolveMycoHome(), 'launcher.cjs')` (exported from `packages/myco/src/grove/paths.ts`). The old `.agents/myco-run.cjs` project-local path was retired by PR #355 global-install migration. MCP children inherit `cwd=/` from some agents — use `resolveVaultDir()` with `MYCO_VAULT_DIR` fallback.
- **Runtime resource management** → Agent harness execution consumes resources — implement proper cleanup. Concurrent sessions must coordinate vault database access to prevent corruption.
- **Cortex injection is capability-gated at two levels**: A task that depends on cortex context must verify two conditions before assuming injection happened: (1) `capabilityEnabled(config, 'cortex')` from `packages/myco/src/config/capabilities.ts` returns true — the gate is fail-closed (null config → false) and reads the `cortex` capability's masterGate config leaf; (2) the relevant injection flag in the `cortex.instructions` config block — either `inject_on_session_start` or `inject_on_subagent_start` — is enabled. Both must be true. A task that assumes cortex context exists will silently operate without it when the capability is disabled or the injection flags are off.

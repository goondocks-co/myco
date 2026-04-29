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
  design and readOnly enforcement; and observability via the agent_runs audit
  table.
managed_by: myco
user-invocable: true
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob]
---

# Myco Agent Harness Task Authoring

The Myco agent harness is a phased executor running inside the daemon. Each
task is an ordered sequence of phases — each phase is a single LLM invocation
with a bounded tool surface and a turn budget. This skill covers the full
authoring lifecycle: designing the phase sequence, writing the task config,
selecting models, calibrating budgets, configuring triggers, designing tool
surfaces, and debugging when things go wrong.

## Prerequisites

- Daemon is running and `agent.enabled: true` in `.myco/myco.yaml`.
- You have read at least one existing task YAML (`packages/myco/src/agent/definitions/tasks/vault-evolve.yaml`
  or `packages/myco/src/agent/definitions/tasks/skill-survey.yaml`) to understand the config shape.
- You can describe the new task's purpose in one sentence and identify which
  vault state it reads and writes.

---

## Procedure 1: Design the Phase Sequence

Sketch the phases on paper before writing any code.

### Apply the judgment/recipe gradient

Every phase sits on a spectrum from pure-recipe to pure-judgment:

| Pole | Characteristics | Typical examples |
|------|----------------|------------------|
| **Recipe** (deterministic) | Tight tool allowlist, short budget, script-like | Mark processed, cursor update, dedup gate |
| **Judgment** (open-ended) | Broader tool access, longer budget, LLM reasons freely | Extract spores, consolidate, generate skill |

Position each phase deliberately:

- Plumbing (DB writes, cursor management, file I/O) → recipe pole. Keep the
  LLM out of plumbing; harness code handles it.
- Reasoning (pattern detection, synthesis, quality assessment) → judgment pole.
- **Never blur**: a phase that both reasons and writes DB state is hard to
  debug and hard to retry cleanly.

### Data injection between phases

The canonical pattern is **read-only discovery → write**:

1. **Phase 1 (`discover`)**: reads vault, assembles context, writes nothing.
   Emits a structured summary as its final tool call output.
2. **Phase 2 (`write`)**: receives that summary as injected context; writes
   to vault based on it.

This keeps Phase 2 idempotent — if it fails you can replay it with the same
context without re-running discovery.

```ts
phases: [
  {
    name: 'discover',
    systemPrompt: DISCOVER_PROMPT,
    turnBudget: 8,
    tools: READ_ONLY_TOOLS,
    readOnly: true,
  },
  {
    name: 'write',
    systemPrompt: WRITE_PROMPT,
    // Harness injects discover's output as context before this phase runs
    turnBudget: 12,
    tools: WRITE_TOOLS,
    readOnly: false,
  },
]
```

### Single-responsibility per phase

Signs you need to split a phase into two:
- The system prompt says "first do X, then do Y"
- The turn budget exhausts before reaching the second half
- Phase failures are ambiguous — you can't tell which half broke

### Multi-tier workflows

Complex tasks may need tiered verification phases, such as the skill lifecycle
pattern: `inventory → verify → assess → act`. The verify phase specifically
validates skills against current codebase state and sets watermarks for
rotation, requiring a dedicated read-only phase before assessment.

### Short-circuit conditions

If Phase 1 finds nothing to process, it should exit early and signal the
harness to skip remaining phases. Always define what "nothing to do" looks
like and what the sentinel string in the output summary should be.

---

## Procedure 1.1: Map-Phase Architecture

When you need to process a large batch of items with identical per-item logic, use the `mode: map` phase type. This is a harness primitive where the harness owns the batch fetch and iteration, and the model invokes once per item with a constrained tool surface.

### When to use map mode

**Ideal for:**
- Bulk operations with identical per-item processing (e.g., canopy-describe, file analysis)
- Cost-sensitive batch work where model context reuse is wasteful
- Operations where the harness can efficiently control iteration

**Not suitable for:**
- Cross-item reasoning or synthesis (use standard judgment phases)
- Operations requiring dynamic tool selection based on item content
- Phases where the model needs to see the full batch for decision-making

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
    params: {
      limit: 20,           // Batch size for efficiency
      types: ['file']
    },
    itemField: 'entries',  // Array field in tool response
    emptySkip: true,       // Skip phase if no items
  },
}
```

### Cost model and efficiency

**Token efficiency**: Map mode resets the conversation for each item, eliminating context accumulation. For 20-item batches, this typically saves 60-80% tokens compared to standard phases that process all items in one conversation.

**Performance characteristics:**
- **Setup cost**: ~200-300 tokens per item (system prompt reset)
- **Processing cost**: actual per-item work (varies by task)
- **Break-even point**: ~10-15 items (above this, map mode is more efficient)

**Batch sizing**: Start with 12-20 items per phase. Smaller batches increase overhead; larger batches risk timeout or memory pressure.

### Map-phase output patterns

The harness collects per-item results and summarizes them:

```
map: written=18 skipped=1 failed=1
```

**Standard output fields:**
- `written`: successful item processing count
- `skipped`: items intentionally not processed
- `failed`: items that caused errors

Structure your system prompt to ensure each item invocation produces a clear success/skip/fail outcome that the harness can categorize.

### Tool surface design for map phases

Keep the tool surface minimal and item-focused:

```ts
const MAP_ITEM_TOOLS = {
  canopy: ['canopy_describe_file'],    // Single focused tool
  vault: ['vault_create_spore'],       // Write results
  // No batch tools, no cross-item tools
};
```

**Anti-patterns:**
- Tools that query for other items (breaks isolation)
- Tools that require full batch context
- Heavy read tools (search, large file reads)

### Integration with standard phases

Map phases work best in multi-phase sequences:

```ts
phases: [
  {
    name: 'discover',
    // Standard phase: gather batch context, validate prerequisites
    systemPrompt: DISCOVER_PROMPT,
    turnBudget: 8,
    readOnly: true,
  },
  {
    name: 'process_batch',
    mode: 'map',
    // Map phase: process items efficiently
    systemPrompt: ITEM_PROMPT,
    turnBudget: 3,
    fetchConfig: { /* ... */ },
  },
  {
    name: 'consolidate',
    // Standard phase: synthesize results, handle exceptions
    systemPrompt: CONSOLIDATE_PROMPT,
    turnBudget: 12,
  },
]
```

This pattern gives you the efficiency of map mode for bulk work while preserving judgment phases for synthesis and exception handling.

---

## Procedure 2: Write the Task Config

Tasks live in `packages/myco/src/agent/definitions/tasks/`. Each task is defined as a TypeScript
configuration object that exports a TaskDefinition.

### Required fields

```ts
import { TaskDefinition } from '../../types';

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

### Phase fields

```ts
{
  name: 'extract',              // short, unique within the task
  systemPrompt: EXTRACT_PROMPT, // imported constant — keep prompts in sibling .ts file
  turnBudget: 15,               // see calibration section below
  tools: EXTRACT_TOOLS,         // typed tool-surface object
  advisor: 'cloud-reasoning',   // optional per-phase model tag (see Procedure 3)
  readOnly: false,              // true = MCP enforcement: write tools hard-blocked
}
```

### Registration

After creating the task file, the task is automatically discovered by the PowerManager through
the TaskDefinition export. The harness scans all .ts files in the tasks directory and loads
any exported TaskDefinition objects at startup.

**Critical**: Ensure your task file exports a properly typed TaskDefinition. If the export is
malformed or missing, the task silently never runs — no error, no log entry. Always verify
your task appears in `agent_runs` after daemon startup to confirm discovery worked.

---

## Procedure 3: Select Models with the Advisor Pattern

The `advisor` field routes a phase to a specific model class. This is
**per-phase**, not per-task — different phases in the same task can use
different models. Use the right model for each phase's position on the
judgment/recipe gradient.

### Model tags

| Tag | Best for |
|-----|----------|
| `cloud-reasoning` | Open-ended judgment phases (extraction, synthesis, writing) |
| `cloud-fast` | Recipe phases where speed matters more than reasoning depth |
| `local-draft` | Cost-sensitive judgment phases where local quality suffices |

### Decision rules

- **No `advisor` field**: inherits the task-level model or daemon global default.
- **Recipe/deterministic phases**: `cloud-fast` or omit (uses fast default).
- **Judgment-heavy phases**: `cloud-reasoning`.
- **QA dual-mode pattern**: deterministic assertion phases → recipe model;
  exploratory analysis phases → judgment model. Don't use a single model for
  both — you either overpay or underperform.

### Local model gotcha

If the task may run with a local Ollama model, **multiply all turn budgets by
3–4×** compared to cloud. Local models complete the same work but reason in
shorter steps and need more turns. There is no automatic per-phase multiplier —
set the budget statically and calibrate locally before merging.

---

## Procedure 4: Calibrate Turn Budgets

A budget too low silently truncates work. A budget too high wastes tokens on
padding. Calibrate before deploying.

### Starting values

| Phase type | Cloud budget | Local budget |
|------------|-------------|--------------|
| Discovery / read-only | 8–12 | 25–40 |
| Write / consolidation | 10–20 | 30–60 |
| Validation / QA | 5–8 | 15–25 |
| Map-phase (per item) | 2–4 | 6–12 |

### The static-budget-under-backlog problem

If input to a phase grows unbounded (e.g., "process all unprocessed batches"
when there are 200+), a static turn budget exhausts before completion.

**Fix: cap the input, not the turns.** Use a bounded instruction builder:

```ts
// In the phase system prompt builder:
const MAX_BATCHES = 20;
const batches = await getUnprocessedBatches({ limit: MAX_BATCHES });
// Tell the LLM: "Here are the N items to process. This is the full set."
```

Do NOT raise the budget to compensate for unbounded input — this creates
unpredictable runtime and cost.

### Batch size optimization for efficiency

Recent skill-evolve task optimization found that reducing batch processing size
from 20 to 12 skills significantly improves budget efficiency and reduces
context window pressure. When designing phases that process multiple items,
test smaller batch sizes first — often 8–12 items per batch yields better
results than 15–20 items, especially for complex reasoning phases.

### Detecting budget exhaustion

- Query `agent_runs`: if `exit_reason = 'budget_exhausted'`, the phase ran
  out of turns before completing.
- If `exit_reason = 'complete'` but work is partial, check `turn_count` —
  it may have hit the budget on the last turn without the harness logging it
  as exhaustion.
- If a phase consistently hits budget on the final turn, lower the input
  bound first, then revisit the budget.

### Stall vs. correct completion

A phase that exits at turn 1 with an empty summary is either:
1. Correctly short-circuiting (nothing to do), or
2. Silently failing (LLM confused by prompt, malformed injected context).

Distinguish by checking `tool_output_summary` in `agent_runs`. If there are
zero tool calls, the LLM never engaged — the system prompt or injected context
is likely malformed.

---

## Procedure 5: Configure Scheduling and Session Gating

### Session State Machine (Critical Foundation)

Sessions in Myco follow a defined state machine with strict settlement conditions:

```
active  ──(SessionEnd hook or idle threshold)──►  completed
  ▲                                                    │
  └──────────(SessionStart on same session)────────────┘
             (reactivates: status flips back to 'active')
```

**Settlement conditions** — a session is considered settled when either:
1. A `SessionEnd` hook fires for that session, OR
2. `last_prompt_at` is older than `settledSessionIdleMinutes` (default: 30 minutes)

**Reactivation invariant** — when `SessionStart` fires on a session that is already
`completed`, the daemon MUST flip `status` back to `'active'`. This prevents
silent data loss where new prompts arrive under a completed session.

### isDefault vs. manual

- `isDefault: true` — fires automatically on every settled session event.
  Use for pipeline tasks (intelligence extraction, skill survey) that should
  always run after user activity.
- `isDefault: false` — fires only on a cron schedule or manual trigger.
  Use for maintenance, batch, or on-demand tasks.

### Session gating (critical)

Any task that reads session transcripts or prompt batches **must** gate on
settled sessions. An active session produces stale artifacts — the LLM will
process partial data and potentially create duplicate or incorrect spores.

```ts
triggers: {
  requireSettledSessions: true,
  settledSessionIdleMinutes: 5,  // tune based on typical session cadence
},
```

**Why gating is non-negotiable**: If your task processes in-flight session data,
it can extract half-formed spores from incomplete conversations, leading to
duplicate observations when the session completes.

### Vault Read Surface Gate Compliance

The `requireSettledSessions` gate must be honored by **every** vault read surface
your task uses. A gate applied to only some query paths creates split-brain where
the agent sees settled data from one tool and in-flight data from another.

**Complete list of surfaces that must honor the gate:**

| Surface | Description | Gate Status |
|---------|-------------|-------------|
| `vault_unprocessed` | Prompt batches — must exclude active sessions | ✅ Gated |
| `vault_spores` | Spore queries — must filter by session settlement state | ✅ Gated |
| `vault_sessions` | Session list — must omit active sessions | ✅ Gated |
| `vault_search_fts` | Full-text search — must exclude active-session content | ✅ Gated |
| `vault_search_semantic` | Semantic search — must exclude active-session embeddings | ✅ Gated |

When calling these tools in your task phases, they automatically respect the gate
configuration — you don't need to implement session filtering yourself. However,
any new read surface you add must implement the canonical settlement predicate:

```sql
WHERE s.status = 'completed'
   OR s.last_prompt_at < datetime('now', '-' || :idleMinutes || ' minutes')
```

### Task Gate Configuration

Tasks that analyze transcript semantics must inherit gate awareness:

```ts
// At the start of task execution logic:
const gate = config.agent?.requireSettledSessions ?? false;
if (gate) {
  // Only pass settled session IDs to downstream query surfaces
  // The vault read surfaces handle filtering automatically
}
```

Document gate behavior in the task's TaskDefinition under `description` so
operators know the task is gate-aware.

### Configuration in .myco/myco.yaml

```yaml
# .myco/myco.yaml
agent:
  requireSettledSessions: true      # boolean; disable for dev/test only
  settledSessionIdleMinutes: 30     # integer minutes; default 30
```

**When to set `requireSettledSessions: false`:**
- Local development and testing where you inject synthetic session data
- CI environments where you control session state directly

**When to keep it `true` (production default):**
- Any deployment where the coding agent is actively running

### Cron vs. event-triggered

| Mode | Config | Best for |
|------|--------|----------|
| Event-triggered | `isDefault: true`, no `schedule` | Incremental work after each session |
| Cron-only | `isDefault: false`, `schedule` set | Cross-session aggregation, cleanup |
| Both | `isDefault: true`, `schedule` set | Rare — fresh-data + time-based runs |

### Global toggle

`agent.enabled: false` in `.myco/myco.yaml` kills ALL tasks immediately. This is the
kill-switch for the entire pipeline — use it during daemon development or after
a bad deploy. There is no per-task enable/disable flag; the toggle is all-or-nothing.

---

## Procedure 6: Design the Tool Surface

### Opinionated (recipe) surfaces

For recipe phases, define an explicit allowlist. The harness enforces it at
the MCP layer — the LLM physically cannot call tools outside the list:

```ts
const DISCOVER_TOOLS = {
  bash: { allowed: ['cat', 'head', 'tail', 'wc', 'grep'] },
  vault: ['vault_unprocessed', 'vault_spores', 'vault_sessions', 'vault_search_fts'],
};
```

Benefits: predictable, auditable, safe to replay.

### Flexible (judgment) surfaces

For judgment phases, allow broader access but still scope write tools to only
what the phase needs:

```ts
const CONSOLIDATE_TOOLS = {
  bash: { allowed: ['cat', 'grep', 'find', 'jq'] },
  vault: [
    'vault_spores', 'vault_search_fts', 'vault_search_semantic',
    'vault_create_spore', 'vault_resolve_spore',
  ],
};
```

### Claude SDK tool isolation patterns

When designing tool surfaces for tasks that integrate with Claude SDK workflows,
be aware that tool isolation behaves differently. Claude SDK agents have
stricter tool boundary enforcement and may not have access to certain MCP
tools during isolated phases. Design fallback tool patterns or alternative
data injection methods for phases that may run in SDK-isolated environments.

### readOnly annotation

`readOnly: true` on a phase enables MCP-level enforcement — write tool calls
are hard-rejected with an error instead of being silently attempted. Use this
on every phase that doesn't need to write. It:
- Prevents accidental writes during read phases
- Makes phase intent self-documenting in the config
- Enables safe concurrent execution (two readOnly phases can run in parallel)

### Tool count vs. reasoning budget

More tools = more tokens spent on tool-selection reasoning. For tight-budget
recipe phases, keep the tool list to ≤5. For judgment phases, up to ~15 tools
is reasonable before the LLM starts confusing tool names. If you need more,
consider splitting into sub-phases.

### When to add a new tool vs. compose existing ones

Add a new vault tool when the operation is a primitive needed by 3+ tasks or
requires DB access not expressible via existing tools. Otherwise compose
existing tools within the phase — avoid proliferating single-use primitives.

---

## Procedure 7: Observe and Debug

### agent_runs audit table

Every phase execution writes a row to `agent_runs`:

| Column | What it tells you |
|--------|-------------------|
| `task_name` | Which task fired |
| `phase_name` | Which phase within the task |
| `started_at` | When the phase began |
| `completed_at` | NULL = still running or crashed |
| `tool_output_summary` | Concatenated tool call outputs (truncated) |
| `turn_count` | How many LLM turns were used |
| `exit_reason` | `budget_exhausted` / `short_circuit` / `complete` / `error` |

Diagnostic query:

```sql
SELECT task_name, phase_name, exit_reason, turn_count, completed_at
FROM agent_runs
WHERE task_name = 'my-new-task'
ORDER BY started_at DESC
LIMIT 20;
```

### Silent failure patterns

| Symptom | Likely cause |
|---------|--------------|
| `exit_reason = 'complete'` but no state change | Sentinel triggered incorrectly; review short-circuit condition |
| `turn_count = 1`, empty `tool_output_summary` | LLM never called tools; malformed prompt or injected context |
| `turn_count = budget` with incomplete work | Budget exhaustion; cap the input |
| `completed_at IS NULL` | Phase crashed or daemon restarted mid-run |
| Task never appears in `agent_runs` | TaskDefinition export malformed — check task file structure |

### Cortex dry-run isolation debugging

When debugging tasks that involve cortex dry-run patterns, be aware that
isolated execution may suppress certain success hooks or completion signals.
If a task appears to complete successfully but downstream effects don't trigger,
check whether the task ran in isolation mode and verify that success indicators
are properly propagated outside the isolation boundary.

### Adding telemetry

To add a new column to `agent_runs`, create a schema migration in
`packages/myco/src/db/migrations.ts`. New columns are safe to add without touching existing
rows — the harness reads the schema at startup.

---

## Cross-Cutting Gotchas

- **TaskDefinition export malformed** → task never runs, no error. Always verify
  proper TypeScript export structure and that your task appears in `agent_runs` after daemon startup.
- **`isDefault: true` on a maintenance task** → fires after every session
  even when there's nothing to maintain. Use `isDefault: false` + cron.
- **No session gate on a transcript-reading task** → processes active sessions,
  creates stale or duplicate artifacts. Always set `requireSettledSessions: true`
  for any task that reads prompt batches or session transcripts.
- **Static turn budget on unbounded input** → unpredictable runtime and silent
  truncation. Cap the input size in the phase prompt builder, not the budget.
- **`readOnly: false` on a discovery phase** → accidental vault writes during
  read phases. Set `readOnly: true` on every non-writing phase.
- **Single model for all phases** → overpaying for recipe phases or
  underperforming on judgment phases. Use the per-phase `advisor` field.
- **Local model without budget multiplier** → phase exhausts before completing.
  Multiply all budgets by 3–4× for local Ollama models.
- **Reactivation bypass** → If `SessionStart` on a completed session doesn't
  flip status back to `active`, the gate silently loses live data. Always test
  session reactivation alongside gate changes.
- **Partial gate implementation** → If only some vault read surfaces honor
  `requireSettledSessions`, the task sees split-brain data. All read surfaces
  must respect the gate consistently.
- **Map-phase tool surface bloat** → Giving map phases access to batch or
  cross-item tools breaks the isolation model and eliminates cost savings.
  Keep map tool surfaces minimal and item-focused.
- **Map-phase batch sizing** → Batches that are too large risk timeout; too
  small increase per-item overhead. Start with 12-20 items and tune based
  on actual performance.

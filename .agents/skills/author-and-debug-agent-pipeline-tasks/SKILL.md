---
name: myco:author-and-debug-agent-pipeline-tasks
description: >-
  Use this skill when authoring, configuring, or debugging Myco agent pipeline
  tasks. It covers task YAML anatomy, scheduling, parameter injection,
  timeout and concurrency behavior, audit-log interpretation, turn-budget
  failures, skill-lifecycle task constraints, and hardening patterns for
  new tasks and MCP tools. Apply it whenever work touches
  `src/agent/tasks/`, `src/agent/executor.ts`, `src/daemon/task-scheduler.ts`,
  or `src/mcp/tools/`, even if the user does not explicitly mention task
  authoring.
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

`runDuringIdle: true` gates execution to periods when no user session is active. `intervalMinutes` sets the minimum gap between runs.

### Risk-Profile-Based Default Enablement

| Operation type | Default | Rationale |
|---|---|---|
| Read-only discovery | `enabled: true` | No side effects; safe to auto-run passively |
| Generative (writes new files) | `enabled: false` | Creates artifacts; user should verify output quality first |
| Mutative (modifies existing files) | `enabled: false` | Changes existing state; higher stakes; opt-in until trusted |

**Skill lifecycle example:** `skill-survey` → `enabled: true`; `skill-generate` and `skill-evolve` → `enabled: false`. When in doubt, default to `enabled: false` for any task that writes or modifies files.

### Verifying the Scheduler Picked It Up

After saving a task YAML, open **Daemon UI → Tasks** and confirm a "Next run" timestamp appears. A blank "Next run" indicates a YAML syntax error or wrong field name in the `schedule` block.

### Schedule the Chain Root Only

Only the root task needs a `schedule` block. Downstream tasks are fired by the executor when their dependency completes. Giving a downstream task both `schedule` and `dependsOn` creates a timing race.

```yaml
# ✅ Correct: root is scheduled, downstream is not
# skill-survey.yaml — has schedule block
# skill-generate.yaml — dependsOn: skill-survey, no schedule block
```

## Phase Dependencies

Use `dependsOn` to chain phases. The executor passes the prior phase's output as context to the next phase. Structure prior phase output as parseable data (JSON, table) so the next phase can extract it reliably.

## preCondition

```yaml
preCondition:
  tool: vault_unprocessed
  expectNonEmpty: true
```

Evaluated before starting. If the condition is not met, the run is skipped and logged.

## Parameter Injection

```yaml
parameters:
  model: claude-opus-4-5
  maxCandidates: 10
phases:
  - name: survey
    prompt: "Process up to {{maxCandidates}} candidates using {{model}}."
```

## The taskOverrides Scalar-Drop Gotcha

When using `taskOverrides` in `myco.yaml`, **scalar values must be explicitly set** — they do not inherit from the base YAML. Always copy the full set of scalar fields into any `taskOverrides` block, even if you're only changing one value.

## The skipPriorContext Hallucination Trap

`skipPriorContext: true` prevents a phase from receiving the prior phase's output. Only use it on phases that are genuinely independent. Never set it on a phase that references prior output in its prompt — the phase will hallucinate plausible-sounding results.

## Turn Budget Exhaustion

### Silent truncation pattern

When `maxTurns` is reached, the agent stops mid-execution with no error. The run log shows "completed" but the work is incomplete. Check whether expected artifacts (spores, skill files, DB records) were actually created.

### Budget sizing for multi-item phases

```
phase maxTurns = N_items × turns_per_item + buffer
task maxTurns  = sum(all phase maxTurns) + 5 overhead
timeoutSeconds = estimated_wall_time × 1.5 safety margin
```

**Skill-evolve example (3 STALE skills):**
- assess phase: ~18 turns → set `maxTurns: 25` (bumped from 20; assess now reads full content from disk)
- evolve phase: 3 × ~10 turns = 30 turns → set `maxTurns: 35`
- task: 25 + 35 + 5 = 65 → set `maxTurns: 65`
- time: 3 rewrites × ~5 min + assess ~3 min = ~18 min → set `timeoutSeconds: 1800`

## Skill Lifecycle Task Specifics

### Generate vs Evolve Responsibility Split

- **`skill-generate`** — writes brand-new SKILL.md files from approved candidates. Never touches existing skill files.
- **`skill-evolve`** — rewrites existing SKILL.md files using new spore evidence. Never creates new skills from candidates.

These are intentionally separate tasks with separate `enabled` flags. Merging their responsibilities loses the ability to enable one without the other.

### Embedding-Based Merge Detection in skill-evolve

`skill-evolve` runs a 4-layer deduplication gate before writing any evolved skill:

1. **Candidate lookup** — checks active skill candidates for the same topic
2. **Name match** — exact name comparison against existing skills
3. **Description token overlap** — token-frequency similarity against all active skills
4. **Cosine embedding similarity** — vector search in the `myco-skills` Vectorize namespace

The embedding search uses `vault_search_semantic` with `namespace: 'skills'`. If any existing skill exceeds the cosine threshold (~0.85), the evolution is blocked. **Critical**: always specify `namespace: 'skills'` — omitting it searches the default spore namespace instead.

### Content Snapshot Must Come from Disk

When the assess phase classifies skills (e.g., "STALE") and passes IDs to the act phase, the act phase must re-read full content from disk via `vault_skill_records(action: get)` before making changes. **Do not rely on lineage snapshots** — they may be stale or truncated.

```yaml
- name: assess
  prompt: "Classify skills. Output JSON with skill IDs and statuses."
- name: act
  dependsOn: assess
  prompt: |
    For each STALE skill, call vault_skill_records(action: get, id: <id>)
    to read the CURRENT on-disk content before modifying it.
```

## Concurrency Guard Behavior

The executor prevents concurrent runs of the same task via a lock. A new run is skipped if one is already in progress — this is correct behavior. When two tasks run concurrently (different names), their log entries interleave; filter by `task_name` when debugging.

## LLM Data-Fidelity Failure Patterns

1. **Truncation under context pressure** — long lists silently truncated when context fills; agent completes without error but operates on partial data.
2. **Type coercion errors** — numbers passed as strings in YAML `parameters` may be coerced unpredictably.
3. **Stale prior-phase assumption** — phase hallucinates data if `dependsOn` is not set but the prompt references prior output.

**Mitigations:** Keep inter-phase data structures small; use IDs not full content when passing references; always set `dependsOn` on phases that reference prior output.

## Hardening a New Task or MCP Tool

Every new agent task and MCP tool must ship with three interlocking safety controls before merging.

**Not covered here:** MCP tool anatomy (Zod schema, server.ts registration) → use `register-mcp-tool`. Debugging LLM behavior → see LLM Data-Fidelity section above.

### Control 1: MCP `readOnly` Annotation

Add `readOnly: true` to any tool that does not mutate vault state:

```typescript
export const vaultReadDigestTool = {
  name: "vault_read_digest",
  readOnly: true,   // ← required for read-only tools
  inputSchema: { ... },
};
```

Rules: `vault_read_*`, `vault_search_*`, `vault_spores`, `vault_entities`, `vault_edges` → `readOnly: true`. `vault_create_*`, `vault_update_*`, `vault_resolve_*`, `vault_write_*`, `vault_mark_*` → omit. **Gotcha:** annotating a mutating tool as `readOnly: true` silently suppresses the MCP host's confirmation dialog — trace the full call chain before marking read-only.

### Control 2: Global Toggle Gate

```yaml
agent:
  scheduled_tasks_enabled: true   # controls cron/interval task registration
  event_tasks_enabled: true       # controls hook-triggered task dispatch
```

**Enforcement lives at the outermost boundary, NOT inside task execute functions.**

```typescript
// Scheduled: gate in registerScheduledTasks()
function registerScheduledTasks(config: MycoConfig) {
  if (!config.agent?.scheduled_tasks_enabled) return;
  // ... register tasks ...
}

// Event-triggered: gate in the trigger function
function triggerTitleSummary(sessionId: string, config: MycoConfig) {
  if (!config.agent?.event_tasks_enabled) return;
  // ... dispatch ...
}
```

The **Run now** button in the Operations UI bypasses both flags — this is intentional.

### Control 3: Phase-Level `readOnly` Enforcement

```yaml
phases:
  - name: gather
    readOnly: true    # executor rejects write tool calls during this phase
    tools:
      - vault_spores
      - vault_search_fts
  - name: draft
    readOnly: false
    tools:
      - vault_write_skill
```

**Why tool enforcement, not prompt enforcement:** Prompts are suggestions; a confused LLM may attempt writes anyway. The executor gate is deterministic. **Gotcha:** after setting `readOnly: true`, remove write tools from the `tools:` list — a read-only phase with a write tool in its list produces spurious gate errors.

### Control 4: Test Coverage (3 tests minimum)

```typescript
// Test A — toggle-off rejection
it("does not register task when scheduled_tasks_enabled is false", async () => {
  const config = buildTestConfig({ agent: { scheduled_tasks_enabled: false } });
  expect(registerScheduledTasks(config)).toHaveLength(0);
});

// Test B — write rejected during readOnly phase
it("rejects write tool call during readOnly phase", async () => {
  const result = await executor.callTool("vault_create_spore", {...}, { phase: { readOnly: true } });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("readOnly");
});

// Test C — happy-path enabled state
it("registers task when scheduled_tasks_enabled is true", async () => {
  const config = buildTestConfig({ agent: { scheduled_tasks_enabled: true } });
  expect(registerScheduledTasks(config).map(j => j.name)).toContain("<your-task-name>");
});
```

Use `buildTestConfig()` from `tests/helpers/` — do not construct config objects inline.

### Pre-Ship Checklist

- [ ] Read-only MCP tools have `readOnly: true`; mutating tools do not
- [ ] `registerScheduledTasks()` checks `config.agent?.scheduled_tasks_enabled`
- [ ] Event trigger functions check `config.agent?.event_tasks_enabled`
- [ ] Phase-level `readOnly: true` set for all read-only phases
- [ ] No write tools listed under read-only phases
- [ ] Tests A, B, and C passing; `make build` passes clean
- [ ] Live smoke test: toggle OFF → task doesn't run; toggle ON → runs; Run Now always works

## Common Pitfalls

**Task runs but produces no output** — check `preCondition` (may evaluate false), `maxTurns` (budget exhausted at first phase), or `enabled: false`.

**Task silently stops mid-run** — budget exhausted. Recalculate: N_items × turns_per_item + buffer for both phase and task `maxTurns`.

**Phase doesn't receive prior phase output** — check `dependsOn` is set, `skipPriorContext` is not set, prior phase produced parseable output before budget exhausted.

**taskOverrides drops fields** — copy all scalar fields into the override block explicitly.

**skill-generate / skill-evolve never run** — these are `enabled: false` by default. Enable via Daemon UI → Agent Tasks.

**Downstream task scheduled alongside `dependsOn`** — creates a race; the downstream may self-fire before upstream has run. Only the chain root carries a `schedule` block.

**skill-evolve blocks on dedup gate** — check `namespace: 'skills'` is specified in `vault_search_semantic` calls; omitting the namespace searches spores instead of skills.

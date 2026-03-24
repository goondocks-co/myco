# Phased Agent Executor — Design Spec

## Problem

The current executor makes a single `query()` call with a monolithic prompt containing all phases. The LLM decides when to stop — and it consistently stops after extraction, ignoring later phases (consolidation, graph building, digest). Stronger prompting helps but is fundamentally unreliable.

## Design

Replace the single `query()` call with a **phase loop**. The executor controls the pipeline; the LLM handles intelligence within each phase.

```
for each phase in task.phases:
  result = query(phase.prompt, phase.tools, phase.maxTurns)
  phaseResults.push(result)
  if phase.required && result.turns === 0:
    log warning: required phase produced no output
```

## Task YAML Schema (extended)

```yaml
name: full-intelligence
phases:
  - name: extract
    prompt: "Extract spores from unprocessed batches..."
    tools: [vault_unprocessed, vault_create_spore, vault_mark_processed, vault_set_state]
    maxTurns: 15
    required: true

  - name: summarize
    prompt: "Update session titles and summaries..."
    tools: [vault_sessions, vault_update_session, vault_report]
    maxTurns: 5
    required: false

  - name: consolidate
    prompt: "Search for clusters of related spores..."
    tools: [vault_spores, vault_search, vault_create_spore, vault_resolve_spore]
    maxTurns: 10
    required: true

  - name: graph
    prompt: "Create entities and semantic edges..."
    tools: [vault_spores, vault_create_entity, vault_create_edge, vault_report]
    maxTurns: 10
    required: true

  - name: digest
    prompt: "Regenerate context extracts at all tiers..."
    tools: [vault_spores, vault_sessions, vault_write_digest]
    maxTurns: 10
    required: true

  - name: report
    prompt: "Summarize what was done across all phases..."
    tools: [vault_report]
    maxTurns: 2
    required: true
```

## Executor Changes

### `runAgent` becomes `runPhasedAgent`

```typescript
for (const phase of task.phases) {
  const phasePrompt = composePhasePrompt(systemPrompt, vaultContext, phase, priorPhaseResults);

  const toolServer = createVaultToolServer(agentId, runId, phase.tools); // scoped tools

  for await (const message of query({
    prompt: phasePrompt,
    options: { model, systemPrompt, mcpServers, maxTurns: phase.maxTurns },
  })) {
    // collect results
  }

  // Record phase completion in agent_turns
  // Pass relevant output to next phase as context
}
```

### Phase context passing

Each phase receives a summary of prior phase results:
- Extract phase: vault state + unprocessed batches
- Consolidate phase: IDs of newly created spores from extract phase
- Graph phase: all active spores + newly created wisdom
- Digest phase: summary of what changed

### Backward compatibility

Tasks without `phases` continue to work with the current single-query approach. The phased executor is opt-in via the `phases` array in the task YAML.

## Orchestrator Pattern

The main agent is an **orchestrator**, not a worker. A smarter model makes decisions and dispatches phases to cheaper, less capable models for execution.

```
Orchestrator (Opus/Sonnet-4-6)
  ├── Phase: Extract    → Worker (Haiku) — high volume, low reasoning
  ├── Phase: Summarize  → Worker (Haiku) — templated output
  ├── Phase: Consolidate → Worker (Sonnet) — needs judgment
  ├── Phase: Graph      → Worker (Sonnet) — needs cross-reference reasoning
  ├── Phase: Digest     → Worker (Sonnet) — needs synthesis
  └── Phase: Report     → Orchestrator — final summary
```

### How it works

1. **Orchestrator call**: The executor first calls the orchestrator model with the vault context and task description. The orchestrator decides:
   - Which phases to run (skip extract if no unprocessed batches)
   - What to prioritize (more consolidation vs. more entities)
   - What context each phase needs

2. **Worker calls**: For each phase, the executor spawns a subagent with:
   - The phase-specific model (from task YAML)
   - Scoped tools (only what this phase needs)
   - Phase-specific prompt + context from orchestrator
   - Strict turn limit

3. **Orchestrator review**: After all worker phases complete, the orchestrator reviews results and writes the final report.

### Task YAML with orchestrator model

```yaml
name: full-intelligence
model: claude-sonnet-4-6          # orchestrator model
phases:
  - name: extract
    model: claude-haiku-4-5       # cheap worker for high-volume extraction
    tools: [vault_unprocessed, vault_create_spore, vault_mark_processed]
    maxTurns: 20

  - name: consolidate
    model: claude-sonnet-4-6      # needs judgment for clustering
    tools: [vault_spores, vault_search, vault_create_spore, vault_resolve_spore]
    maxTurns: 10

  - name: graph
    model: claude-sonnet-4-6      # needs cross-reference reasoning
    tools: [vault_spores, vault_create_entity, vault_create_edge]
    maxTurns: 10

  - name: digest
    model: claude-sonnet-4-6      # needs synthesis
    tools: [vault_spores, vault_sessions, vault_write_digest]
    maxTurns: 10
```

### Cost optimization

The orchestrator pattern naturally optimizes cost:
- Extraction is 80% of the turns but uses the cheapest model
- Graph and digest need reasoning but are fewer turns
- The orchestrator itself uses minimal turns (planning + review)
- Total cost is lower than running everything on Sonnet/Opus

## Benefits

1. **Guaranteed phase execution** — code controls the loop, not the LLM
2. **Scoped tool access** — each phase only sees tools it needs
3. **Per-phase turn limits** — extraction can't consume the entire budget
4. **Phase context** — each phase knows what the prior phase produced
5. **Observability** — per-phase metrics in the audit trail
6. **Model flexibility** — different phases use different models (extraction=Haiku, graph=Sonnet)
7. **Orchestrator intelligence** — smart model makes strategic decisions, cheap models execute
8. **Cost efficiency** — high-volume work runs on cheapest viable model

## Non-goals

- Don't change the task YAML for non-phased tasks (backward compat)
- Don't change the Agent SDK integration (still uses `query()`)
- Don't add parallel phase execution yet (sequential first, parallel as optimization)

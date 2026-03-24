# Graph Redesign — Continuation Plan

> Status: In progress. Schema + lineage + tools are working. Agent execution and capture need fixes.

## What's Working

| Component | Status | Details |
|-----------|--------|---------|
| `graph_edges` table (schema v5) | Working | 189 edges, proper indexes |
| Lineage automation | Working | FROM_SESSION, EXTRACTED_FROM, HAS_BATCH auto-created |
| Wisdom consolidation | Working | 3 wisdom spores with DERIVED_FROM edges |
| Entity creation | Working | Agent creates entities with correct types |
| Semantic edge creation | Working | REFERENCES edge created correctly |
| BFS traversal | Working | Graph API returns edges for entity queries |
| Per-task model/turns/timeout | Working | Tasks override agent defaults |
| Template variables ({{session_id}}) | Working | Title-summary scopes to specific sessions |
| Session status reset | Working | Re-register sets status='active' |
| Response summary from transcript | Working | Batches 1-15 have response_summary |
| Image capture | Working | Attachments saved with prompt_batch_id |
| Generate Summary button | Working | Session detail page triggers title-summary task |
| Summary batch interval config | Working | On Settings page |

## What's Broken / Incomplete

### 1. Agent stops early (CRITICAL)
The agent uses 22/50 turns then stops. Extraction + some consolidation, but skips entity building (created entities but only 1 edge), skips digest entirely. Prompt-only enforcement doesn't work.

**Root cause**: Single `query()` call — the LLM decides when to stop. Need phased executor.

**Fix**: Build the phased executor (spec at `docs/superpowers/specs/2026-03-24-phased-executor.md`). Each phase is its own `query()` call with scoped tools and turn limits. Orchestrator model plans, worker models execute.

### 2. Duplicate batches from daemon restarts
In-memory `BatchStateMap` resets on restart, creating duplicate prompt_numbers. The `recoverBatchState` function mitigates but doesn't eliminate the issue.

**Root cause**: Stateful event handling in a process that restarts.

**Fix**: Stateless capture layer (spec at `docs/superpowers/specs/2026-03-24-stateless-capture.md`). Remove BatchStateMap entirely. Every handler queries the DB.

### 3. Response summary mapping misses recent batches
Transcript turns don't always align with batch records when there are duplicate prompt_numbers from daemon restarts. Batches 16+ in the current session have no response_summary.

**Root cause**: Same as #2 — duplicate batches make mapping unreliable.

**Fix**: Resolved by #2 (stateless capture eliminates duplicates).

### 4. Graph UI is minimal
- Entity list shows entities but can't drill down to connected spores/sessions
- Graph explorer shows edges but no navigation to source nodes
- No way to see all edges of a specific type
- No edge type breakdown in stats

**Fix**: Richer graph explorer UI (part of the graph topology page).

### 5. Task config not manageable from dashboard
Tasks have execution config (model, turns, timeout, tools, prompt) but no UI to view or edit them. The Agent page shows runs but not task definitions.

**Fix**: Task management UI (described in phased executor spec).

## Execution Order for Next Session

### Priority 1: Phased Executor (enables everything else)
Build `docs/superpowers/specs/2026-03-24-phased-executor.md`:
- [ ] Add `phases` array to task YAML schema
- [ ] Build phase loop in executor (sequential `query()` calls)
- [ ] Scoped tool server per phase
- [ ] Phase context passing (prior phase results → next phase prompt)
- [ ] Update full-intelligence task with phase definitions
- [ ] Test: verify all 6 phases execute

### Priority 2: Stateless Capture
Build `docs/superpowers/specs/2026-03-24-stateless-capture.md`:
- [ ] Add `getLatestOpenBatch` and `getNextPromptNumber` to batches.ts
- [ ] Rewrite `handleUserPrompt` — stateless
- [ ] Rewrite `handleToolUse` — stateless
- [ ] Rewrite `handleSessionStop` — stateless
- [ ] Remove `BatchStateMap`
- [ ] Test: daemon restart doesn't create duplicate batches

### Priority 3: Graph UI Improvements
- [ ] Edge type breakdown on stats/dashboard
- [ ] Graph explorer: click spore → see its session/batch
- [ ] Graph explorer: click entity → see all connected spores
- [ ] Entity detail page with edge list

### Priority 4: Task Config UI
- [ ] Task list view on Agent page
- [ ] Task detail/edit view (model, turns, timeout, tools, prompt)
- [ ] Per-task Run Now button

## Specs Written

1. `docs/superpowers/specs/2026-03-24-stateless-capture.md` — Remove BatchStateMap
2. `docs/superpowers/specs/2026-03-24-phased-executor.md` — Orchestrator pattern with per-phase subagents

## Branch State

Branch: `feat/graph-and-agent` (not merged to main)
All tests pass (697/697). Build clean.

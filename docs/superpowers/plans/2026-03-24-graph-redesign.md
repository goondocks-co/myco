# Knowledge Graph Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the knowledge graph with automatic lineage edges, wisdom consolidation, tightened entity types, event-driven session summaries, and per-task model configuration.

**Architecture:** Two-layer graph — daemon creates structural lineage edges automatically on write (no LLM), agent creates semantic intelligence edges (LLM-driven). New `graph_edges` table replaces FK-constrained `edges` table. Wisdom is a spore with `observation_type: 'wisdom'`. Session summaries triggered by events, not full agent runs.

**Tech Stack:** TypeScript, PGlite, Zod, Claude Agent SDK, Vitest, Ollama (local LLM)

**Spec:** `docs/superpowers/specs/2026-03-24-graph-redesign-design.md`

**Dependency annotations:** Tasks marked `[PARALLEL-SAFE]` can run concurrently after their dependencies complete. Tasks marked `[SEQUENTIAL]` touch shared files and must run alone.

---

## Phase 1: Schema Foundation

### Task 1: Create `graph_edges` table and schema migration [SEQUENTIAL]

The existing `edges` table has FK constraints to `entities(id)`, preventing cross-type references. Create a new `graph_edges` table that supports edges between any node types.

**Files:**
- Modify: `src/db/schema.ts` (DDL, migration, version bump)
- Create: `tests/db/queries/graph-edges.test.ts`

- [ ] **Step 1: Add graph_edges DDL to schema.ts**

Add after the existing `EDGES_TABLE` constant (~line 211). The new table has `source_type`/`target_type` columns and no FK constraints on source/target:

```sql
CREATE TABLE IF NOT EXISTS graph_edges (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  source_id       TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  type            TEXT NOT NULL,
  session_id      TEXT,
  confidence      REAL DEFAULT 1.0,
  properties      TEXT,
  created_at      INTEGER NOT NULL
)
```

Add to `TABLE_DDLS` array. Add secondary indexes:
- `idx_graph_edges_source` on `(source_id, source_type)`
- `idx_graph_edges_target` on `(target_id, target_type)`
- `idx_graph_edges_type` on `(type)`
- `idx_graph_edges_agent` on `(agent_id)`

- [ ] **Step 2: Add `properties` column to spores table**

In the `SPORES_TABLE` DDL (~line 167), add `properties TEXT` after `content_hash`.

- [ ] **Step 3: Add `model` column to agent_tasks table**

In the `AGENT_TASKS_TABLE` DDL (~line 286), add `model TEXT` after `tool_overrides`.

- [ ] **Step 4: Add `status` column to entities table**

In the `ENTITIES_TABLE` DDL (~line 186), add `status TEXT DEFAULT 'active'` after `last_seen`.

- [ ] **Step 5: Write migrateV4ToV5 function**

Bump `SCHEMA_VERSION` to 5, `PREVIOUS_SCHEMA_VERSION` to 4. Add migration:

```typescript
async function migrateV4ToV5(db: PGlite): Promise<void> {
  // Add properties column to spores
  if (await tableExists(db, 'spores') && !(await columnExists(db, 'spores', 'properties'))) {
    await db.query('ALTER TABLE spores ADD COLUMN properties TEXT');
  }
  // Add model column to agent_tasks
  if (await tableExists(db, 'agent_tasks') && !(await columnExists(db, 'agent_tasks', 'model'))) {
    await db.query('ALTER TABLE agent_tasks ADD COLUMN model TEXT');
  }
  // Add status column to entities
  if (await tableExists(db, 'entities') && !(await columnExists(db, 'entities', 'status'))) {
    await db.query("ALTER TABLE entities ADD COLUMN status TEXT DEFAULT 'active'");
  }
  // Version bump
  await db.query(`UPDATE schema_version SET version = ${SCHEMA_VERSION} WHERE version = ${PREVIOUS_SCHEMA_VERSION}`);
}
```

Wire into `createSchema()` after `migrateV3ToV4`. The `graph_edges` table is created by the DDL loop (IF NOT EXISTS).

- [ ] **Step 6: Update schema test**

In `tests/db/schema.test.ts`, update `SCHEMA_VERSION` assertion to 5. Add test for `graph_edges` table creation. Add test for new columns on spores, agent_tasks, entities.

- [ ] **Step 7: Run tests and commit**

Run: `make check`
```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: add graph_edges table, spore properties, entity status, task model columns"
```

---

### Task 2: Create graph_edges query module [PARALLEL-SAFE after Task 1]

**Files:**
- Create: `src/db/queries/graph-edges.ts`
- Create: `tests/db/queries/graph-edges.test.ts`

- [ ] **Step 1: Write failing tests**

Test `insertGraphEdge`, `listGraphEdges` (filter by source, target, type), `getGraphForNode` (BFS traversal across types).

- [ ] **Step 2: Implement graph-edges.ts**

Types:
```typescript
export interface GraphEdgeInsert {
  agent_id: string;
  source_id: string;
  source_type: 'session' | 'batch' | 'spore' | 'entity';
  target_id: string;
  target_type: 'session' | 'batch' | 'spore' | 'entity';
  type: string;
  session_id?: string;
  confidence?: number;
  properties?: string;
  created_at: number;
}

export interface GraphEdgeRow extends GraphEdgeInsert {
  id: string;
}

export type GraphNodeType = 'session' | 'batch' | 'spore' | 'entity';
```

Functions:
- `insertGraphEdge(data: GraphEdgeInsert): Promise<GraphEdgeRow>` — generates UUID id, INSERT
- `listGraphEdges(options: { sourceId?, targetId?, type?, agentId?, limit? }): Promise<GraphEdgeRow[]>`
- `getGraphForNode(nodeId: string, nodeType: GraphNodeType, options?: { depth?: number }): Promise<{ edges: GraphEdgeRow[] }>` — BFS traversal up to `depth` (default 2)

- [ ] **Step 3: Run tests and commit**

Run: `make check`
```bash
git add src/db/queries/graph-edges.ts tests/db/queries/graph-edges.test.ts
git commit -m "feat: add graph_edges query module with BFS traversal"
```

---

### Task 3: Add `properties` to SporeInsert/SporeRow [PARALLEL-SAFE after Task 1]

**Files:**
- Modify: `src/db/queries/spores.ts` (types, insert, select columns)
- Modify: `tests/db/queries/spores.test.ts`

- [ ] **Step 1: Update SporeInsert and SporeRow types**

Add `properties?: string` to `SporeInsert` (line 43). Add `properties: string | null` to `SporeRow`. Add `'properties'` to `SPORE_COLUMNS` array.

- [ ] **Step 2: Update insertSpore SQL**

Add `properties` to the INSERT column list and parameter binding.

- [ ] **Step 3: Update tests**

Add test for inserting a spore with properties (JSON string), verifying it round-trips.

- [ ] **Step 4: Run tests and commit**

Run: `make check`
```bash
git add src/db/queries/spores.ts tests/db/queries/spores.test.ts
git commit -m "feat: add properties column to spore insert/query"
```

---

## Phase 2: Lineage Automation

### Task 4: Auto-create lineage edges on spore creation [SEQUENTIAL]

When a spore is created, lineage edges should be added to `graph_edges`. This happens at the **call-site layer** (tool handler and daemon MCP proxy), NOT inside `insertSpore` itself. This keeps the low-level query module independent and ensures lineage creation never breaks spore insertion.

**Files:**
- Create: `src/db/queries/lineage.ts` (helper for creating lineage edges from a spore)
- Modify: `src/agent/tools.ts` (call lineage helper after vault_create_spore)
- Modify: `src/daemon/main.ts` (call lineage helper after MCP proxy spore creation)
- Create: `tests/db/queries/lineage.test.ts`

- [ ] **Step 1: Create lineage helper module**

Create `src/db/queries/lineage.ts` with a single function:

```typescript
import { insertGraphEdge } from './graph-edges.js';

/** Create lineage edges for a newly inserted spore. Fire-and-forget safe. */
export async function createSporeLineage(spore: {
  id: string;
  agent_id: string;
  session_id?: string | null;
  prompt_batch_id?: number | null;
  observation_type?: string;
  properties?: string | null;
  created_at: number;
}): Promise<void> {
  if (spore.session_id) {
    await insertGraphEdge({
      agent_id: spore.agent_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: spore.session_id,
      target_type: 'session',
      type: 'FROM_SESSION',
      created_at: spore.created_at,
    });
  }
  if (spore.prompt_batch_id != null) {
    await insertGraphEdge({
      agent_id: spore.agent_id,
      source_id: spore.id,
      source_type: 'spore',
      target_id: String(spore.prompt_batch_id),
      target_type: 'batch',
      type: 'EXTRACTED_FROM',
      created_at: spore.created_at,
    });
  }
  // DERIVED_FROM edges for wisdom spores
  if (spore.observation_type === 'wisdom' && spore.properties) {
    try {
      const props = JSON.parse(spore.properties);
      if (Array.isArray(props.consolidated_from)) {
        for (const sourceId of props.consolidated_from) {
          await insertGraphEdge({
            agent_id: spore.agent_id,
            source_id: spore.id,
            source_type: 'spore',
            target_id: sourceId,
            target_type: 'spore',
            type: 'DERIVED_FROM',
            created_at: spore.created_at,
          });
        }
      }
    } catch { /* ignore malformed properties */ }
  }
}
```

- [ ] **Step 2: Call lineage helper from vault_create_spore tool**

In `src/agent/tools.ts`, after the `insertSpore` call in the `vault_create_spore` handler, add:

```typescript
import { createSporeLineage } from '@myco/db/queries/lineage.js';

// After insertSpore returns the spore:
try { await createSporeLineage(spore); } catch { /* lineage failure should not break spore creation */ }
```

- [ ] **Step 3: Call lineage helper from daemon MCP proxy**

In `src/daemon/main.ts`, in the `/api/mcp/remember` handler (after spore insertion), add the same lineage call.

- [ ] **Step 4: Write tests**

Test that `createSporeLineage` creates the expected edges for: regular spore (2 edges), wisdom spore with consolidated_from (2 + N edges), spore with no session_id (1 edge).

- [ ] **Step 5: Run tests and commit**

Run: `make check`
```bash
git add src/db/queries/lineage.ts src/agent/tools.ts src/daemon/main.ts tests/db/queries/lineage.test.ts
git commit -m "feat: auto-create lineage edges on spore creation via call-site helper"
```

---

### Task 5: Auto-create HAS_BATCH lineage edges [SEQUENTIAL]

When a prompt batch is inserted, auto-create a `HAS_BATCH` edge from session to batch.

**Files:**
- Modify: `src/daemon/main.ts` (~line 133, after insertBatch call)
- Or modify: `src/db/queries/batches.ts` (if insertBatch exists there)

- [ ] **Step 1: Find the insertBatch location**

Read `src/daemon/main.ts:130-145` and `src/db/queries/batches.ts`. Determine where to add the edge.

- [ ] **Step 2: Add HAS_BATCH edge after batch insert**

After the `insertBatch` call in the daemon (line ~138), add:
```typescript
await insertGraphEdge({
  agent_id: DEFAULT_AGENT_ID,
  source_id: sessionId,
  source_type: 'session',
  target_id: String(batch.id),
  target_type: 'batch',
  type: 'HAS_BATCH',
  created_at: now,
});
```

- [ ] **Step 3: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat: auto-create HAS_BATCH lineage edge on batch insert"
```

---

**Note:** Task 6 (DERIVED_FROM edges) is now handled inside Task 4's lineage helper — `createSporeLineage` handles all three edge types (FROM_SESSION, EXTRACTED_FROM, DERIVED_FROM) in one module.

---

## Phase 3: Agent Prompt & Tool Changes (PARALLEL-SAFE — these touch separate files)

### Task 7: Update agent prompt [PARALLEL-SAFE]

**Files:**
- Modify: `src/agent/prompts/agent.md`

- [ ] **Step 1: Rewrite Entity Types section**

Replace current 7 types with 3:
- **component** — A module, class, service, or significant function. Only create when referenced by 3+ spores from 2+ sessions.
- **concept** — An architectural pattern or domain concept that spans multiple sessions. Must be specific and named, not abstract categories.
- **person** — A contributor or team member.

Add strict criteria: "Only create an entity when it is referenced by 3+ spores from 2+ different sessions and represents a specific, named thing. Good: 'DaemonClient', 'cursor-based pagination', 'Chris'. Bad: 'testing phase', 'technical debt'."

- [ ] **Step 2: Rewrite Relationship Types section**

Replace with semantic edge types only: RELATES_TO, SUPERSEDED_BY, REFERENCES, DEPENDS_ON, AFFECTS. Add note that lineage edges (FROM_SESSION, EXTRACTED_FROM, HAS_BATCH, DERIVED_FROM) are created automatically — the agent must NOT create these.

- [ ] **Step 3: Add Consolidation section**

Add new "### 4. Consolidation" section in Processing Protocol, between extraction and entity building:

Instruct the agent to: search for similar spores, cluster by type, synthesize wisdom when 3+ match, create wisdom spore with properties.consolidated_from, supersede sources via vault_resolve_spore with action 'consolidate'. Skip spores tagged 'consolidated' to prevent wisdom-of-wisdom.

- [ ] **Step 4: Reorder Processing Protocol**

New order: 1. Read State → 2. Fetch Batches → 3. Extract Spores → 3b. Session Summaries → 4. Consolidation → 5. Entity Hub Building → 6. Digest → 7. Report

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompts/agent.md
git commit -m "feat: rewrite agent prompt — entity types, consolidation, edge types"
```

---

### Task 8: Update tool schemas [PARALLEL-SAFE]

**Files:**
- Modify: `src/agent/tools.ts` (enums, parameters, write targets)
- Modify: `tests/agent/tools.test.ts`

- [ ] **Step 1: Update vault_create_entity enum**

Line 236: change from 7 types to 3:
```typescript
type: z.enum(['component', 'concept', 'person'])
```

- [ ] **Step 2: Update vault_create_edge to use graph_edges**

Line 266: change enum to semantic types:
```typescript
type: z.enum(['RELATES_TO', 'SUPERSEDED_BY', 'REFERENCES', 'DEPENDS_ON', 'AFFECTS'])
```

Update the tool implementation to write to `graph_edges` table (import `insertGraphEdge` from graph-edges module) instead of the old `edges` table via `insertEdge`. For agent-created semantic edges, set types as follows:
- `RELATES_TO` (spore→spore): source_type='spore', target_type='spore'
- `SUPERSEDED_BY` (spore→spore): source_type='spore', target_type='spore'
- `REFERENCES` (spore→entity): source_type='spore', target_type='entity'
- `DEPENDS_ON` (entity→entity): source_type='entity', target_type='entity'
- `AFFECTS` (spore→entity): source_type='spore', target_type='entity'

Add `source_type` and `target_type` as required Zod parameters on the tool. Drop `valid_from` parameter (not in `graph_edges` table — store in `properties` JSON if needed).

- [ ] **Step 3: Add `consolidate` action to vault_resolve_spore**

Line ~300: add to action enum:
```typescript
action: z.enum(['supersede', 'archive', 'merge', 'split', 'consolidate'])
```

- [ ] **Step 4: Add `properties` parameter to vault_create_spore**

Add optional properties field:
```typescript
properties: z.string().optional().describe('JSON metadata (e.g., consolidated_from for wisdom spores)'),
```

Pass it through to `insertSpore`.

- [ ] **Step 5: Update tests**

Update tools tests for the new enums and parameters.

- [ ] **Step 6: Run tests and commit**

Run: `make check`
```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat: update tool schemas — entity types, edge types, consolidate action, spore properties"
```

---

### Task 9: Restore consolidation prompt [PARALLEL-SAFE]

**Files:**
- Create: `src/prompts/consolidation.md`

- [ ] **Step 1: Review existing consolidation.md and update**

The file `src/prompts/consolidation.md` already exists. Read it and compare with the old version (`git show 983df29:src/prompts/consolidation.md`). Update the existing file to incorporate the best of both — do NOT overwrite blindly.

Ensure the prompt instructs:
- Default: consolidate semantically similar observations
- Preserve specifics (file names, error messages, concrete values)
- Include ALL source IDs in response
- JSON response format with: consolidate, title, content, source_ids, tags

- [ ] **Step 2: Commit**

```bash
git add src/prompts/consolidation.md
git commit -m "feat: restore consolidation prompt template from pre-v2 pipeline"
```

---

### Task 10: Add per-task model configuration [PARALLEL-SAFE]

**Files:**
- Modify: `src/agent/loader.ts` (AgentTaskSchema, line 54)
- Modify: `src/agent/types.ts` (add model to task type)
- Modify: `src/agent/executor.ts` (model resolution chain)
- Modify: `tests/agent/loader.test.ts`
- Modify: `tests/agent/executor.test.ts`

- [ ] **Step 1: Add model to AgentTaskSchema**

In `src/agent/loader.ts` line 54, add to schema:
```typescript
model: z.string().optional(),
```

- [ ] **Step 2: Add model to task types**

In `src/agent/types.ts`, add `model?: string` to the task type and `EffectiveConfig`.

- [ ] **Step 3: Update resolveEffectiveConfig in executor**

Task model takes priority: `config.model = taskOverride?.model ?? config.model`

- [ ] **Step 4: Update tests**

Test that a task with `model: 'ollama/llama3.2'` overrides the agent definition model.

- [ ] **Step 5: Run tests and commit**

Run: `make check`
```bash
git add src/agent/loader.ts src/agent/types.ts src/agent/executor.ts tests/agent/
git commit -m "feat: per-task model configuration with resolution chain"
```

---

### Task 11: Add summary_batch_interval to config [PARALLEL-SAFE]

**Files:**
- Modify: `src/config/schema.ts` (AgentSchema)

- [ ] **Step 1: Add field**

In AgentSchema (~line 21):
```typescript
const AgentSchema = z.object({
  auto_run: z.boolean().default(true),
  interval_seconds: z.number().int().positive().default(300),
  summary_batch_interval: z.number().int().positive().default(5),
});
```

- [ ] **Step 2: Commit**

```bash
git add src/config/schema.ts
git commit -m "feat: add summary_batch_interval config for event-driven summaries"
```

---

## Phase 4: Daemon Integration [SEQUENTIAL — touches daemon/main.ts]

### Task 12: Session summary triggers [SEQUENTIAL]

**Files:**
- Modify: `src/daemon/main.ts` (stop handler, batch handler, summary dispatch)

- [ ] **Step 1: Add summary dispatch after session stop**

In the stop handler (~line 625, after `handleSessionStop`), add fire-and-forget summary task dispatch:

```typescript
// Fire-and-forget: generate title + summary via agent task
try {
  const { runAgent } = await import('../agent/executor.js');
  runAgent(vaultDir, {
    task: 'title-summary',
    instruction: `Process session ${sessionId} only`,
  }).catch(err => logger.warn('agent', 'Title-summary task failed', { error: err.message }));
} catch { /* agent unavailable */ }
```

- [ ] **Step 2: Add batch-threshold summary trigger**

In the batch insertion handler (~line 138, after insertBatch), track batch count and dispatch summary when threshold is reached. Add a concurrency guard to avoid overlapping with full-intelligence runs:

```typescript
const batchCount = state.promptNumber;
const interval = config.agent.summary_batch_interval;
if (interval > 0 && batchCount > 0 && batchCount % interval === 0) {
  // Check if an agent run is already in progress before dispatching
  const { getRunningRun } = await import('../db/queries/runs.js');
  const running = await getRunningRun(DEFAULT_AGENT_ID);
  if (!running) {
    try {
      const { runAgent } = await import('../agent/executor.js');
      runAgent(vaultDir, {
        task: 'title-summary',
        instruction: `Process session ${sessionId} only`,
      }).catch(err => logger.warn('agent', 'Batch-threshold summary failed', { error: err.message }));
    } catch { /* agent unavailable */ }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat: trigger session summary on stop + batch threshold"
```

---

### Task 13: Update graph API to use graph_edges [SEQUENTIAL]

**Files:**
- Modify: `src/daemon/api/mycelium.ts` (graph endpoint handler)
- Modify: `src/db/queries/entities.ts` (graph traversal)

- [ ] **Step 1: Update graph endpoint**

The graph API currently queries `edges` table. Update to query `graph_edges` table instead. The `getGraphForNode` function in graph-edges.ts handles BFS — use it.

- [ ] **Step 2: Update entity list to respect status**

Add `WHERE status = 'active'` filter to `listEntities` query. The new `status` column defaults to 'active'.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/mycelium.ts src/db/queries/entities.ts
git commit -m "feat: update graph API to use graph_edges, filter entities by status"
```

---

## Phase 5: Data Migration & Documentation [PARALLEL-SAFE]

### Task 14: Backfill lineage edges for existing spores [PARALLEL-SAFE after Task 4]

Existing spores don't have lineage edges yet (lineage is only created on new inserts). Add a startup fixup to backfill.

**Files:**
- Modify: `src/db/schema.ts` (add fixup function)

- [ ] **Step 1: Add backfill fixup**

Add an idempotent fixup that runs on startup (alongside `fixupAgentIdValues`):

```typescript
async function backfillSporeLineage(db: PGlite): Promise<void> {
  if (!(await tableExists(db, 'graph_edges')) || !(await tableExists(db, 'spores'))) return;

  // Check if any spores lack FROM_SESSION edges
  const probe = await db.query(`
    SELECT s.id FROM spores s
    LEFT JOIN graph_edges ge ON ge.source_id = s.id AND ge.type = 'FROM_SESSION'
    WHERE s.session_id IS NOT NULL AND ge.id IS NULL
    LIMIT 1
  `);
  if (probe.rows.length === 0) return; // All spores already have lineage

  // Backfill FROM_SESSION
  await db.query(`
    INSERT INTO graph_edges (id, agent_id, source_id, source_type, target_id, target_type, type, created_at)
    SELECT gen_random_uuid(), s.agent_id, s.id, 'spore', s.session_id, 'session', 'FROM_SESSION', s.created_at
    FROM spores s
    LEFT JOIN graph_edges ge ON ge.source_id = s.id AND ge.type = 'FROM_SESSION'
    WHERE s.session_id IS NOT NULL AND ge.id IS NULL
  `);

  // Backfill EXTRACTED_FROM
  await db.query(`
    INSERT INTO graph_edges (id, agent_id, source_id, source_type, target_id, target_type, type, created_at)
    SELECT gen_random_uuid(), s.agent_id, s.id, 'spore', CAST(s.prompt_batch_id AS TEXT), 'batch', 'EXTRACTED_FROM', s.created_at
    FROM spores s
    LEFT JOIN graph_edges ge ON ge.source_id = s.id AND ge.type = 'EXTRACTED_FROM'
    WHERE s.prompt_batch_id IS NOT NULL AND ge.id IS NULL
  `);
}
```

Call from `createSchema` fast-path alongside other fixups.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema.ts
git commit -m "fix: backfill lineage edges for existing spores on startup"
```

---

### Task 15: Archive old entity types [PARALLEL-SAFE after Task 13]

**Files:**
- Modify: `src/db/schema.ts` (add to fixupAgentIdValues or new fixup function)

- [ ] **Step 1: Add entity archive fixup**

Add an idempotent fixup (like `fixupAgentIdValues`) that runs on startup:

```typescript
async function archiveInvalidEntityTypes(db: PGlite): Promise<void> {
  if (!(await tableExists(db, 'entities')) || !(await columnExists(db, 'entities', 'status'))) return;

  const VALID_TYPES = ['component', 'concept', 'person'];
  await db.query(
    `UPDATE entities SET status = 'archived' WHERE status = 'active' AND type NOT IN ($1, $2, $3)`,
    VALID_TYPES,
  );
}
```

Call from `createSchema` fast-path alongside `fixupAgentIdValues`.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema.ts
git commit -m "fix: archive entities with removed types (bug, decision, tool, file)"
```

---

### Task 16: Update documentation [PARALLEL-SAFE]

**Files:**
- Modify: `docs/lifecycle.md`
- Modify: `CLAUDE.md` (glossary, golden paths if needed)

- [ ] **Step 1: Update lifecycle.md**

Add new sections or update existing ones:
- **Graph Architecture** — two-layer model (lineage + intelligence), node types, edge types
- **Lineage Edges** — auto-created on spore/batch insert, no LLM needed
- **Consolidation** — wisdom synthesis from spore clusters, supersession flow
- **Session Summary Triggers** — event-driven (stop + batch threshold), per-task model config
- **Entity Types** — component, concept, person only, hub criteria

- [ ] **Step 2: Update CLAUDE.md glossary**

Add/update:
- **Wisdom** — higher-order observation synthesized from 3+ related spores. Stored as spore with `observation_type: 'wisdom'`.
- **Lineage edge** — automatic graph connection created by daemon (FROM_SESSION, EXTRACTED_FROM, HAS_BATCH, DERIVED_FROM).
- **Semantic edge** — intelligence graph connection created by agent (RELATES_TO, SUPERSEDED_BY, REFERENCES, DEPENDS_ON, AFFECTS).
- **Graph edge** — stored in `graph_edges` table. Supports cross-type references (session, batch, spore, entity).

- [ ] **Step 3: Commit**

```bash
git add docs/lifecycle.md CLAUDE.md
git commit -m "docs: update lifecycle and glossary for graph redesign"
```

---

## Phase 6: Verification

### Task 17: Full pipeline verification [SEQUENTIAL — last]

**Files:** No file changes — runtime testing.

- [ ] **Step 1: Build and restart**

Run: `make build && myco-dev restart`

- [ ] **Step 2: Verify migration**

Run: `myco-dev stats` — check schema version is 5, entity counts reflect archived types.

- [ ] **Step 3: Verify lineage edges**

Check `graph_edges` table for existing lineage. Since lineage edges are created on insert, existing spores won't have them yet. Trigger a small test: create a new session, send events, verify edges appear.

- [ ] **Step 4: Trigger agent run**

Run: `myco-dev agent --task full-intelligence`

Watch for:
- Spore extraction (existing behavior)
- `vault_update_session` calls (session summary)
- Consolidation attempts (semantic search for clusters)
- Entity creation with tightened criteria
- New edge types in graph_edges

- [ ] **Step 5: Verify graph API**

```bash
curl -s 'http://localhost:PORT/api/entities?limit=5' | python3 -m json.tool
# Should show only component/concept/person types, status=active
```

- [ ] **Step 6: Run make check**

Run: `make check` — all tests pass.

---

## Execution Parallelism Map

```
Phase 1:  [Task 1] ──────────────────────────────> (schema foundation)
                    ├── [Task 2] (graph-edges module)      ──┐
                    ├── [Task 3] (spore properties)         ──┤
Phase 2:            └──── [Task 4] (lineage helper) ──────────┤  (after 2+3)
                          [Task 5] (batch lineage) ───────────┤
Phase 3:            ├── [Task 7] (agent prompt)      ─────────┤  ALL PARALLEL
                    ├── [Task 8] (tool schemas)      ─────────┤  (after 2)
                    ├── [Task 9] (consolidation prompt) ──────┤
                    ├── [Task 10] (per-task model config) ────┤
                    └── [Task 11] (config schema) ────────────┘
Phase 4:  [Task 12] (summary triggers) ──> [Task 13] (graph API) ──>
Phase 5:  [Task 14] (backfill lineage) ──> [Task 15] (archive entities) ──>
          [Task 16] (docs) ──>
Phase 6:  [Task 17] (verification)
```

After Task 1: Tasks 2, 3, 7, 9, 10, 11 can all run in parallel.
Task 4 depends on Tasks 2 and 3 (imports graph-edges, uses spore properties).
Task 5 is sequential (touches daemon/main.ts).
Task 8 depends on Task 2 (imports graph-edges).
Tasks 12, 13 are sequential (both touch daemon/main.ts or graph API).
Tasks 14, 15, 16 are parallel-safe after Phase 4.
Task 17 runs last.

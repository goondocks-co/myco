---
name: myco:plan-persistence-and-agent-directed-capture
description: |
  Procedures for implementing and maintaining Myco's plan persistence architecture,
  including logical-key identity models, agent-directed capture patterns via MCP tools,
  cross-channel deduplication strategies, unified capture helper architecture, plan
  lineage tracking, and search integration. Use when implementing plan capture systems,
  designing logical-key strategies, building MCP capture tools, or resolving plan
  deduplication conflicts, even if the user doesn't explicitly ask for plan
  persistence architecture.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Plan Persistence and Agent-Directed Capture

Myco's plan persistence architecture implements agent-directed capture through logical-key identity models, enabling deterministic deduplication across multiple capture channels. This skill covers the design patterns, implementation strategies, and integration approaches for building robust plan capture systems.

## Prerequisites

- Understanding of Myco's vault database schema and plan table structure
- Familiarity with MCP (Model Context Protocol) tool development
- Knowledge of plan content types (transcript plans, agent-generated plans, file-based plans)
- Access to plan capture codebase in `packages/myco/src/daemon/` and related modules

## Procedure 1: Logical-Key Identity Model Implementation

The logical-key identity model provides deterministic plan identification across capture channels, replacing path-based identity with content-driven keys.

### Key Type Design

Implement three logical key types using the utilities in `packages/myco/src/plans/identity.ts`:

```typescript
// path:<normalized_path> - for file-based plans
const pathKey = buildPathPlanLogicalKey(filePath);

// tag:<tag> - for session-tagged plan collections  
const tagKey = buildSessionTagPlanLogicalKey(sessionId, planTag);

// key:<plan_key> - for explicit agent-provided keys
const explicitKey = `key:${agentProvidedKey}`;
```

### Normalization Rules

- **Path normalization**: Use `normalizePlanSourcePath()` to strip project root, normalize separators, resolve relative paths
- **Tag normalization**: Session tags are processed through `humanizePlanToken()` for consistent formatting
- **Key validation**: Ensure uniqueness through database constraints, prevent conflicts with reserved prefixes

### Database Integration

The plans table uses `logical_key` as the deduplication key (found in `packages/myco/src/db/schema-ddl.ts`):

```sql
-- Plan table design with logical_key as primary deduplication field
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT PRIMARY KEY,
  logical_key      TEXT NOT NULL,
  status           TEXT DEFAULT 'active',
  title            TEXT,
  content          TEXT,
  source_path      TEXT,  -- original path reference, nullable
  session_id       TEXT REFERENCES sessions(id),
  content_hash     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER,
  machine_id       TEXT NOT NULL DEFAULT 'local'
);
```

The `id` field provides stable row identity while `logical_key` handles deduplication. All plan operations (upsert, search, lineage) use `logical_key` for content identity.

## Procedure 2: Agent-Directed Capture via MCP Tools

Invert from heuristic capture (event-driven scanning) to intentional capture (agent-chooses-when) through the `myco_plans` MCP tool with `op: "save"`.

### MCP Tool Implementation

The tool is defined in `packages/myco/src/tools/definitions.ts` and implemented in `packages/myco/src/tools/plans.ts`:

```typescript
// MCP tool handler in plans.ts
import { saveMcpPlan } from '@myco/plans/save-mcp.js';

export async function handleMycoPlans(
  input: PlansInput,
  client: DaemonClient,
): Promise<PlansResult> {
  if (input.op !== 'save') {
    // list/get/delete handled separately
  }

  const result = await saveMcpPlan({
    session_id: input.session_id,
    content: input.content,
    source_path: input.source_path,
    plan_key: input.plan_key,
    title: input.title,
    status: input.status,
    tags: input.tags,
  });

  if (!result.ok || !result.data) {
    return { ok: false, error: 'Plan save failed' };
  }
  return { ok: true, ...(result.data as SavePlanSuccess) };
}
```

### Agent Integration Patterns

- **Reactive planning**: Agent saves plans during problem-solving sessions via `myco_plans` with `op: "save"`
- **Proactive archival**: Agent identifies reusable patterns and persists them with explicit `plan_key`
- **Cross-session persistence**: Agent maintains plan continuity by referencing prior plans through logical keys

### Payload Structure

```typescript
interface SavePlanInput {
  op: "save";
  session_id: string;      // Required: current session context
  content: string;         // Required: plan body (markdown, YAML, etc.)
  source_path?: string;    // Optional: original file reference
  plan_key?: string;       // Optional: explicit logical key
  title?: string;          // Optional: human-readable title
  status?: string;         // Optional: plan status
  tags?: string[];         // Optional: searchable tags
}
```

## Procedure 3: Unified Capture Helper Architecture

Consolidate all plan capture paths through the `persistPlan()` helper in `packages/myco/src/daemon/plan-capture.ts` to ensure consistent upsert logic and deduplication.

### Capture Helper Design

```typescript
// packages/myco/src/daemon/plan-capture.ts
export function persistPlan(input: PersistPlanInput): PlanRow {
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const contentHash = createHash(CONTENT_HASH_ALGORITHM)
    .update(input.content).digest('hex');
  
  const existingPlan = getPlanByLogicalKey(input.logicalKey);
  
  // Short-circuit if content hasn't changed
  if (existingPlan && existingPlan.content_hash === contentHash) {
    return existingPlan;
  }
  
  // Upsert plan with last-write-wins semantics
  const planRow: PlanRow = {
    id: buildPlanId(),
    logical_key: input.logicalKey,
    title: resolvePlanTitle({
      content: input.content,
      title: input.title,
      existingTitle: existingPlan?.title
    }),
    content: input.content,
    content_hash: contentHash,
    source_path: input.sourcePath,
    status: input.status ?? existingPlan?.status ?? 'active',
    created_at: existingPlan?.created_at ?? createdAt,
    updated_at: createdAt,
    // ... other fields
  };
  
  return upsertPlan(planRow);
}
```

### Integration Points

- **Transcript mining**: Extract plans from session transcripts, generate tag-based logical keys via `extractPlansFromTranscript()`
- **MCP agents**: Direct agent calls via `myco_plans` with `op: "save"` through the MCP tool surface
- **File scanning**: Periodic file system scans for new plan files using path-based logical keys; filtered by `selectAuthoredPlanWrites()` to agent-authored writes only

## Procedure 4: Cross-Channel Deduplication

Handle plans captured from multiple channels with the same logical identity through conflict resolution strategies built into `persistPlan()`.

### Last-Write-Wins Strategy

```typescript
// Deduplication logic in persistPlan()
const existingPlan = getPlanByLogicalKey(input.logicalKey);

if (existingPlan && input.logger && existingPlan.source_path !== input.sourcePath) {
  input.logger.warn('Plan overwrite detected', {
    logical_key: input.logicalKey,
    old_source: existingPlan.source_path,
    new_source: input.sourcePath,
    kind: LOG_KINDS.PLAN_CAPTURE_CONFLICT
  });
}

// Apply last-write-wins automatically - no user intervention required
return upsertPlan(planRow);
```

### Channel Coordination

- **Transcript vs. Agent**: Agent-saved plans override transcript-extracted versions
- **File vs. Agent**: Agent-directed updates take precedence over file scanning  
- **Multiple agents**: Last successful save wins through timestamp comparison

## Procedure 5: Plan Lineage and Provenance Tracking

Maintain relationships between sessions, plans, and derived spores through the existing lineage system referenced in `packages/myco/src/db/schema-ddl.ts`.

### Session-Plan Lineage

Plans are automatically linked to sessions through the `session_id` foreign key:

```typescript
const planRow: PlanRow = {
  // ... other fields
  session_id: input.sessionId,        // Links plan to originating session
  prompt_batch_id: input.promptBatchId, // Links to specific prompt batch
};
```

## Procedure 6: Search Integration

Integrate plan content into the semantic search pipeline through FTS5 full-text search and semantic similarity queries.

### FTS5 Integration

```typescript
const ftsResults = await vault_search_fts({
  query: searchTerm,
  type: 'plan',
  limit: 10
});
```

### Semantic Search

```typescript
const planResults = await vault_search_semantic({
  query: searchTerm,
  namespace: 'plans',
  limit: 10
});
```

## Cross-Cutting Gotchas

**Logical key conflicts during migration**: When migrating from path-based to logical-key identity, ensure existing plans get proper logical keys assigned. Use the migration utilities in `packages/myco/src/plans/identity.ts` to backfill `logical_key` from `source_path` before switching to the new model.

**Content hash optimization**: The `persistPlan()` function includes content hash comparison to avoid redundant writes when multiple channels converge on identical content. This prevents unnecessary team-sync enqueue operations and database churn.

**Session lifecycle coordination**: Agent-directed capture can happen after session termination. The plan capture system handles both active and terminal sessions without blocking plan persistence — the `session_id` is validated but not required to be active.

**Plan title resolution**: The `resolvePlanTitle()` function implements fallback logic: explicit title > content-derived title > existing title preservation. This prevents title thrashing when plans are updated from different sources.

**Content type validation**: Plans can contain markdown, YAML, JSON, or plain text. The system defaults to 'markdown' but preserves explicit `content_type` specifications for proper rendering in the UI.

**Authorship-gating via `selectAuthoredPlanWrites`**: Plan capture on session stop does not blindly scan all file-write activities — `selectAuthoredPlanWrites()` in `packages/myco/src/daemon/plan-capture.ts` filters to write events the agent itself authored (cross-referenced with `isPlanWriteEvent()`). This prevents captures of files modified by third parties during a session. When adding new capture paths, use `selectAuthoredPlanWrites()` rather than raw `listSessionFileActivities()` from `packages/myco/src/db/queries/activities.ts`.

**Cross-symbiont path normalization mismatch**: `relativizeToolPath()` in `packages/myco/src/daemon/event-handlers.ts` stores activity `file_path` values relative to the project root. `normalizePlanSourcePath()` in `packages/myco/src/plans/identity.ts` also expects a project-relative path. If you match activity file paths to plan source paths across symbionts, ensure both sides use the same root — passing an absolute path to `normalizePlanSourcePath()` produces a non-matching logical key and silently creates a duplicate plan instead of deduplicating.

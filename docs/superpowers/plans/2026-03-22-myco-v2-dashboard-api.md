# Myco v2 Dashboard & API Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overhaul the Myco dashboard and daemon API to reflect v2 architecture — PGlite-only data store, Agent SDK curator, dual-mode search, session browser, mycelium intelligence viewer, agent operations.

**Architecture:** Backend-first approach. Schema changes and new query helpers land first, then daemon API routes, then UI pages one at a time. Each phase produces testable, working software. The v1 pipeline UI is removed and replaced with v2-native pages.

**Tech Stack:** PGlite (pgvector + tsvector), TypeScript, React, Tailwind CSS, React Router v6, @tanstack/react-query, Vite

**Spec:** `docs/superpowers/specs/2026-03-22-myco-v2-dashboard-api-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/db/queries/attachments.ts` | Attachment CRUD (insert, list by session) |
| `src/db/queries/search.ts` | Dual-mode search: semantic (pgvector) + FTS (tsvector) |
| `src/db/queries/feed.ts` | Activity feed UNION query across sessions/runs/spores |
| `src/daemon/api/sessions.ts` | Session detail, batches, activities, attachments routes |
| `src/daemon/api/mycelium.ts` | Spores, entities, graph, digest routes |
| `src/daemon/api/search.ts` | Dual-mode search route |
| `src/daemon/api/agent.ts` | Agent turns, tasks routes (extends existing agent routes) |
| `src/daemon/api/feed.ts` | Activity feed route |
| `src/daemon/api/embedding.ts` | Embedding status route |
| `tests/db/queries/attachments.test.ts` | Attachment query tests |
| `tests/db/queries/search.test.ts` | Search query tests |
| `tests/db/queries/feed.test.ts` | Activity feed tests |
| `tests/daemon/api/sessions.test.ts` | Session API route tests |
| `tests/daemon/api/mycelium.test.ts` | Mycelium API route tests |
| `tests/daemon/api/search.test.ts` | Search API route tests |
| `tests/daemon/api/feed.test.ts` | Activity feed route tests |
| `tests/daemon/api/embedding.test.ts` | Embedding status route tests |
| `ui/src/pages/Sessions.tsx` | Sessions list + detail page |
| `ui/src/pages/Mycelium.tsx` | Spores, graph, digest page (new) |
| `ui/src/pages/Agent.tsx` | Agent run history, decisions, trigger |
| `ui/src/pages/Settings.tsx` | Slim v3 config editor |
| `ui/src/components/sessions/SessionList.tsx` | Session table with filters |
| `ui/src/components/sessions/SessionDetail.tsx` | Session detail with timeline |
| `ui/src/components/sessions/BatchTimeline.tsx` | Batch cards: prompt → activities → AI summary |
| `ui/src/components/sessions/ActivityList.tsx` | Tool call list for a batch |
| `ui/src/components/mycelium/SporeList.tsx` | Filterable spore table |
| `ui/src/components/mycelium/SporeDetail.tsx` | Spore with source links, edges |
| `ui/src/components/mycelium/GraphExplorer.tsx` | Entity graph visualization |
| `ui/src/components/mycelium/DigestView.tsx` | Digest extracts by tier |
| `ui/src/components/agent/RunList.tsx` | Agent run history table |
| `ui/src/components/agent/RunDetail.tsx` | Run detail: decisions panel + audit trail panel (inline, not separate files) |
| `ui/src/components/agent/TriggerRun.tsx` | Run trigger with task picker |
| `ui/src/components/dashboard/DataFlow.tsx` | Data lifecycle flow visualization |
| `ui/src/components/dashboard/ActivityFeed.tsx` | Recent events stream |
| `ui/src/components/dashboard/CuratorStatus.tsx` | Curator idle/running panel |
| `ui/src/components/dashboard/EmbeddingHealth.tsx` | Embedding provider/queue panel |
| `ui/src/components/search/GlobalSearch.tsx` | Cmd+K search dialog |
| `ui/src/components/search/SearchResults.tsx` | Grouped search results |
| `ui/src/hooks/use-sessions.ts` | Sessions list + detail hooks |
| `ui/src/hooks/use-spores.ts` | Spore list + detail hooks |
| `ui/src/hooks/use-agent.ts` | Agent runs, tasks, trigger hooks |
| `ui/src/hooks/use-search.ts` | Dual-mode search hook |
| `ui/src/hooks/use-embedding.ts` | Embedding status hook |
| `ui/src/hooks/use-activity.ts` | Activity feed hook |

### Modified Files

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add FTS columns (tsvector + GIN), add embedding to plans/artifacts, bump SCHEMA_VERSION |
| `src/db/queries/batches.ts` | Add `listBatchesBySession()` |
| `src/db/queries/activities.ts` | Add `listActivitiesByBatch()` |
| `src/db/queries/entities.ts` | Add `listEntities()` with mention filter, `getEntityWithEdges()` |
| `src/db/queries/digest-extracts.ts` | Add `listDigestExtracts()` |
| `src/db/queries/turns.ts` | Add `listTurnsByRun()` |
| `src/db/queries/tasks.ts` | Add `listTasksByCurator()` |
| `src/db/queries/embeddings.ts` | Update `EMBEDDABLE_TABLES` to add plans/artifacts, remove prompt_batches |
| `src/db/queries/spores.ts` | Add `offset` to `ListSporesOptions` for pagination |
| `src/config/schema.ts` | Strip to v3 (embedding, daemon, capture only) |
| `src/config/loader.ts` | Add v2→v3 migration, fix `needsWrite` guard for v3 shape |
| `src/intelligence/embed-query.ts` | Update config path from `config.intelligence.embedding` to `config.embedding` |
| `src/daemon/server.ts` | Add binary response support for serving attachment files |
| `src/daemon/main.ts` | Register new API routes, fix attachment DB inserts in stop handler |
| `src/services/stats.ts` | Rewrite for v2 stats shape |
| `src/constants.ts` | Add FTS, feed, search constants |
| `ui/src/layout/Layout.tsx` | New navigation items, add search trigger |
| `ui/src/lib/constants.ts` | Remove pipeline constants, add v2 constants |
| `ui/src/lib/api.ts` | No structural changes — existing pattern works |
| `ui/src/hooks/use-daemon.ts` | Update StatsResponse type for v2 |
| `ui/src/hooks/use-config.ts` | Update for v3 config shape |
| `ui/src/pages/Dashboard.tsx` | Complete rewrite — visual operations hub |

### Deleted Files

| File | Reason |
|------|--------|
| `ui/src/pages/Operations.tsx` | v1 pipeline utilities removed |
| `ui/src/pages/Configuration.tsx` | Replaced by Settings.tsx |
| `ui/src/pages/Mycelium.tsx` | Replaced by new Mycelium.tsx (different content) |
| `ui/src/components/pipeline/` | Entire directory — v1 pipeline visualization |
| `ui/src/components/operations/` | Entire directory — v1 curation, rebuild, reprocess |
| `ui/src/components/dashboard/` | Existing dashboard components (stat cards) — replaced |
| `ui/src/hooks/use-pipeline.ts` | v1 pipeline hook |

---

## Task Group 1: Schema & Query Foundation (Phase 3a)

### Task 1: Schema changes — FTS columns, embedding columns, version bump

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `tests/db/schema.test.ts`

- [ ] **Step 1: Add FTS columns to schema**

In `src/db/schema.ts`, add `search_vector tsvector` column to the `prompt_batches` and `activities` CREATE TABLE statements. Add GIN indexes for FTS. The `search_vector` is populated on insert via application code (not triggers, since PGlite trigger support is limited).

In the `PROMPT_BATCHES_TABLE` DDL, add after `content_hash TEXT UNIQUE`:
```sql
search_vector     tsvector
```

In the `ACTIVITIES_TABLE` DDL, add after `content_hash TEXT UNIQUE`:
```sql
search_vector     tsvector
```

Add to the `INDEXES` array:
```typescript
'CREATE INDEX IF NOT EXISTS idx_prompt_batches_search ON prompt_batches USING GIN (search_vector)',
'CREATE INDEX IF NOT EXISTS idx_activities_search ON activities USING GIN (search_vector)',
```

- [ ] **Step 2: Add embedding columns to plans and artifacts**

In the `PLANS_TABLE` DDL, add after `updated_at INTEGER`:
```sql
embedding         vector(${EMBEDDING_DIMENSIONS})
```

In the `ARTIFACTS_TABLE` DDL, add after `updated_at INTEGER`:
```sql
embedding         vector(${EMBEDDING_DIMENSIONS})
```

Add HNSW indexes to the `INDEXES` array:
```typescript
'CREATE INDEX IF NOT EXISTS idx_plans_embedding ON plans USING hnsw (embedding vector_cosine_ops)',
'CREATE INDEX IF NOT EXISTS idx_artifacts_embedding ON artifacts USING hnsw (embedding vector_cosine_ops)',
```

- [ ] **Step 3: Update EMBEDDABLE_TABLES in embeddings.ts**

In `src/db/queries/embeddings.ts`, update the `EMBEDDABLE_TABLES` constant to add `plans` and `artifacts`, and remove `prompt_batches` (raw batch text is not embedded — session summaries incorporate batch detail):

```typescript
const EMBEDDABLE_TABLES = ['sessions', 'spores', 'plans', 'artifacts'] as const;
```

Update the `EmbeddableTable` type, `TABLE_SELECT_COLUMNS` map, and `INVALID_TABLE_MSG` to match.

- [ ] **Step 4: Add schema migration for existing databases**

In the `createSchema()` function, after the v1→v2 migration block, add a v2→v3 migration:

```typescript
if (currentVersion === 2) {
  // Add FTS columns
  await db.query('ALTER TABLE prompt_batches ADD COLUMN IF NOT EXISTS search_vector tsvector');
  await db.query('ALTER TABLE activities ADD COLUMN IF NOT EXISTS search_vector tsvector');
  // Add embedding columns
  await db.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIMENSIONS})`);
  await db.query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIMENSIONS})`);
  // Indexes
  await db.query('CREATE INDEX IF NOT EXISTS idx_prompt_batches_search ON prompt_batches USING GIN (search_vector)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_activities_search ON activities USING GIN (search_vector)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_plans_embedding ON plans USING hnsw (embedding vector_cosine_ops)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_artifacts_embedding ON artifacts USING hnsw (embedding vector_cosine_ops)');
  // Note: prompt_batches.embedding column is kept for backward compat but no longer populated.
  // It is removed from EMBEDDABLE_TABLES so it won't be searched.
  await db.query('UPDATE schema_version SET version = 3');
}
```

Update `SCHEMA_VERSION` constant to `3`.

- [ ] **Step 5: Update schema tests**

In `tests/db/schema.test.ts`, update `SCHEMA_VERSION` expectations. Add test that `prompt_batches` has `search_vector` column, `plans` has `embedding` column, `artifacts` has `embedding` column.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/queries/embeddings.ts tests/db/schema.test.ts
git commit -m "feat(db): add FTS tsvector columns, embedding for plans/artifacts, schema v3"
```

---

### Task 2: Attachment query helpers

**Files:**
- Create: `src/db/queries/attachments.ts`
- Create: `tests/db/queries/attachments.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/db/queries/attachments.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertAttachment, listAttachmentsBySession } from '@myco/db/queries/attachments.js';

describe('attachment queries', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);
  });
  afterEach(async () => { await closeDatabase(); });

  it('inserts and lists attachments by session', async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });

    await insertAttachment({
      id: 'att-1', session_id: 'sess-1', file_path: 'attachments/abc123-t1-1.png',
      media_type: 'image/png', created_at: now,
    });
    await insertAttachment({
      id: 'att-2', session_id: 'sess-1', prompt_batch_id: 1,
      file_path: 'attachments/abc123-t2-1.jpg', media_type: 'image/jpeg', created_at: now,
    });

    const attachments = await listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(2);
    expect(attachments[0].file_path).toContain('abc123');
  });

  it('returns empty array for session with no attachments', async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertSession({ id: 'sess-1', agent: 'claude-code', started_at: now, created_at: now });
    const attachments = await listAttachmentsBySession('sess-1');
    expect(attachments).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/queries/attachments.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement attachment queries**

```typescript
// src/db/queries/attachments.ts
import { getDatabase } from '@myco/db/client.js';

export interface AttachmentInsert {
  id: string;
  session_id: string;
  prompt_batch_id?: number;
  file_path: string;
  media_type?: string;
  description?: string;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  session_id: string;
  prompt_batch_id: number | null;
  file_path: string;
  media_type: string | null;
  description: string | null;
  created_at: number;
}

export async function insertAttachment(data: AttachmentInsert): Promise<AttachmentRow> {
  const db = getDatabase();
  const result = await db.query(
    `INSERT INTO attachments (id, session_id, prompt_batch_id, file_path, media_type, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [data.id, data.session_id, data.prompt_batch_id ?? null, data.file_path,
     data.media_type ?? null, data.description ?? null, data.created_at],
  );
  return result.rows[0] as AttachmentRow;
}

export async function listAttachmentsBySession(sessionId: string): Promise<AttachmentRow[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM attachments WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId],
  );
  return result.rows as AttachmentRow[];
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/db/queries/attachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/attachments.ts tests/db/queries/attachments.test.ts
git commit -m "feat(db): add attachment query helpers"
```

---

### Task 3: Extend existing query helpers with new list functions

**Files:**
- Modify: `src/db/queries/batches.ts`
- Modify: `src/db/queries/activities.ts`
- Modify: `src/db/queries/entities.ts`
- Modify: `src/db/queries/digest-extracts.ts`
- Modify: `src/db/queries/turns.ts`
- Modify: `src/db/queries/tasks.ts`
- Create: `tests/db/queries/extended-queries.test.ts`

- [ ] **Step 1: Write failing tests for all new query functions**

Test `listBatchesBySession`, `listActivitiesByBatch`, `listEntities` (with `mentioned_in` filter), `getEntityWithEdges`, `listDigestExtracts`, `listTurnsByRun`, `listTasksByCurator`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/queries/extended-queries.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add `listBatchesBySession()` to batches.ts**

```typescript
export async function listBatchesBySession(
  sessionId: string,
  options?: { limit?: number },
): Promise<BatchRow[]> {
  const db = getDatabase();
  const limit = options?.limit ?? BATCHES_DEFAULT_LIMIT;
  const result = await db.query(
    'SELECT * FROM prompt_batches WHERE session_id = $1 ORDER BY prompt_number ASC LIMIT $2',
    [sessionId, limit],
  );
  return result.rows.map(toBatchRow);
}
```

Add `const BATCHES_DEFAULT_LIMIT = 200;` as a module constant.

- [ ] **Step 4: Add `listActivitiesByBatch()` to activities.ts**

```typescript
export async function listActivitiesByBatch(batchId: number): Promise<ActivityRow[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM activities WHERE prompt_batch_id = $1 ORDER BY timestamp ASC',
    [batchId],
  );
  return result.rows.map(toActivityRow);
}
```

- [ ] **Step 5: Add `listEntities()` and `getEntityWithEdges()` to entities.ts**

```typescript
export interface ListEntitiesOptions {
  curator_id?: string;
  type?: string;
  mentioned_in?: string;
  note_type?: string;
  limit?: number;
  offset?: number;
}

export async function listEntities(options?: ListEntitiesOptions): Promise<EntityRow[]> {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (options?.curator_id) {
    conditions.push(`curator_id = $${paramIdx++}`);
    params.push(options.curator_id);
  }
  if (options?.type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(options.type);
  }
  if (options?.mentioned_in && options?.note_type) {
    conditions.push(`id IN (SELECT entity_id FROM entity_mentions WHERE note_id = $${paramIdx++} AND note_type = $${paramIdx++})`);
    params.push(options.mentioned_in, options.note_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;
  params.push(limit, offset);

  const result = await db.query(
    `SELECT * FROM entities ${where} ORDER BY last_seen DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    params,
  );
  return result.rows as EntityRow[];
}

export async function getEntityWithEdges(
  entityId: string,
  depth: number = 1,
): Promise<{ center: EntityRow; nodes: EntityRow[]; edges: EdgeRow[] }> {
  const db = getDatabase();
  const center = await db.query('SELECT * FROM entities WHERE id = $1', [entityId]);
  if (center.rows.length === 0) throw new Error(`Entity not found: ${entityId}`);

  // BFS traversal up to depth
  const visited = new Set<string>([entityId]);
  const seenEdges = new Set<number>();
  const allEdges: EdgeRow[] = [];
  let frontier = [entityId];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const placeholders = frontier.map((_, i) => `$${i + 1}`).join(', ');
    const edgeResult = await db.query(
      `SELECT * FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      frontier,
    );
    const newFrontier: string[] = [];
    for (const edge of edgeResult.rows as EdgeRow[]) {
      if (!seenEdges.has(edge.id)) {
        seenEdges.add(edge.id);
        allEdges.push(edge);
      }
      for (const nodeId of [edge.source_id, edge.target_id]) {
        if (!visited.has(nodeId)) {
          visited.add(nodeId);
          newFrontier.push(nodeId);
        }
      }
    }
    frontier = newFrontier;
  }

  const nodeIds = [...visited].filter(id => id !== entityId);
  let nodes: EntityRow[] = [];
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map((_, i) => `$${i + 1}`).join(', ');
    const nodeResult = await db.query(
      `SELECT * FROM entities WHERE id IN (${placeholders})`,
      nodeIds,
    );
    nodes = nodeResult.rows as EntityRow[];
  }

  return { center: center.rows[0] as EntityRow, nodes, edges: allEdges };
}
```

- [ ] **Step 6: Add `listDigestExtracts()` to digest-extracts.ts**

```typescript
export async function listDigestExtracts(curatorId: string): Promise<DigestExtractRow[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM digest_extracts WHERE curator_id = $1 ORDER BY tier ASC',
    [curatorId],
  );
  return result.rows as DigestExtractRow[];
}
```

- [ ] **Step 7: Add `listTurnsByRun()` to turns.ts**

```typescript
export async function listTurnsByRun(runId: string): Promise<TurnRow[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM agent_turns WHERE run_id = $1 ORDER BY turn_number ASC',
    [runId],
  );
  return result.rows as TurnRow[];
}
```

- [ ] **Step 8: Add `listTasksByCurator()` to tasks.ts**

```typescript
export async function listTasksByCurator(curatorId: string): Promise<TaskRow[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM agent_tasks WHERE curator_id = $1 ORDER BY display_name ASC',
    [curatorId],
  );
  return result.rows as TaskRow[];
}
```

- [ ] **Step 9: Run all tests**

Run: `npx vitest run tests/db/queries/extended-queries.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/db/queries/batches.ts src/db/queries/activities.ts src/db/queries/entities.ts \
  src/db/queries/digest-extracts.ts src/db/queries/turns.ts src/db/queries/tasks.ts \
  tests/db/queries/extended-queries.test.ts
git commit -m "feat(db): add list-by-parent query helpers for all entity types"
```

---

### Task 4: Dual-mode search query helpers

**Files:**
- Create: `src/db/queries/search.ts`
- Create: `tests/db/queries/search.test.ts`
- Modify: `src/db/queries/batches.ts` (populate search_vector on insert)
- Modify: `src/db/queries/activities.ts` (populate search_vector on insert)

- [ ] **Step 1: Write failing tests**

Test semantic search (pgvector across sessions, spores, plans, artifacts) and FTS search (tsvector across prompt_batches, activities).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/queries/search.test.ts`

- [ ] **Step 3: Implement search query module**

```typescript
// src/db/queries/search.ts
import { getDatabase } from '@myco/db/client.js';
import { SEARCH_RESULTS_DEFAULT_LIMIT, SEARCH_SIMILARITY_THRESHOLD } from '@myco/constants.js';

export interface SearchResult {
  id: string;
  type: 'session' | 'spore' | 'plan' | 'artifact' | 'prompt_batch' | 'activity';
  title: string;
  preview: string;
  score: number;
  session_id?: string;
}

export async function semanticSearch(
  queryVector: number[],
  options?: { type?: string; limit?: number },
): Promise<SearchResult[]> {
  const db = getDatabase();
  const limit = options?.limit ?? SEARCH_RESULTS_DEFAULT_LIMIT;
  const vectorStr = `[${queryVector.join(',')}]`;

  // Search across all embeddable intelligence tables
  // Tables are hardcoded (not user input) so safe to interpolate table/column names
  const tables = options?.type
    ? [options.type]
    : ['sessions', 'spores', 'plans', 'artifacts'];

  const queries = tables.map(table => {
    const titleCol = table === 'sessions' ? 'title' : table === 'spores' ? 'observation_type' : 'title';
    const previewCol = table === 'sessions' ? 'summary' : 'content';
    return `SELECT id, '${table}' as type, ${titleCol} as title,
            LEFT(${previewCol}, 300) as preview,
            1 - (embedding <=> $1::vector) as score
            FROM ${table}
            WHERE embedding IS NOT NULL
            AND 1 - (embedding <=> $1::vector) > ${SEARCH_SIMILARITY_THRESHOLD}`;
  });

  const result = await db.query(
    `${queries.join(' UNION ALL ')} ORDER BY score DESC LIMIT $2`,
    [vectorStr, limit],
  );
  return result.rows as SearchResult[];
}

export async function fullTextSearch(
  query: string,
  options?: { type?: string; limit?: number },
): Promise<SearchResult[]> {
  const db = getDatabase();
  const limit = options?.limit ?? SEARCH_RESULTS_DEFAULT_LIMIT;

  // Use plainto_tsquery for safe text input handling (no SQL injection)
  const tables = options?.type
    ? [options.type]
    : ['prompt_batches', 'activities'];

  const queries = tables.map(table => {
    if (table === 'prompt_batches') {
      return `SELECT id::text, 'prompt_batch' as type,
              LEFT(user_prompt, 80) as title,
              LEFT(user_prompt, 300) as preview,
              ts_rank(search_vector, plainto_tsquery('english', $1)) as score,
              session_id
              FROM prompt_batches
              WHERE search_vector @@ plainto_tsquery('english', $1)`;
    }
    return `SELECT id::text, 'activity' as type,
            tool_name as title,
            LEFT(tool_input, 300) as preview,
            ts_rank(search_vector, plainto_tsquery('english', $1)) as score,
            session_id
            FROM activities
            WHERE search_vector @@ plainto_tsquery('english', $1)`;
  });

  const result = await db.query(
    `${queries.join(' UNION ALL ')} ORDER BY score DESC LIMIT $2`,
    [query, limit],
  );
  return result.rows as SearchResult[];
}
```

- [ ] **Step 4: Update batch and activity inserts to populate search_vector**

In `src/db/queries/batches.ts`, update `insertBatch()` to include:
```sql
search_vector = to_tsvector('english', COALESCE($user_prompt, '') || ' ' || COALESCE($response_summary, ''))
```

In `src/db/queries/activities.ts`, update `insertActivity()` to include:
```sql
search_vector = to_tsvector('english', COALESCE($tool_name, '') || ' ' || COALESCE($tool_input, '') || ' ' || COALESCE($file_path, ''))
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/db/queries/search.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/search.ts src/db/queries/batches.ts src/db/queries/activities.ts \
  tests/db/queries/search.test.ts
git commit -m "feat(db): add dual-mode search — semantic (pgvector) + FTS (tsvector)"
```

---

### Task 5: Activity feed query helper

**Files:**
- Create: `src/db/queries/feed.ts`
- Create: `tests/db/queries/feed.test.ts`

- [ ] **Step 1: Write failing tests**

Test that the feed returns a unified list of recent events from sessions, agent_runs, and spores, sorted by timestamp, capped at limit.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement feed query**

```typescript
// src/db/queries/feed.ts
import { getDatabase } from '@myco/db/client.js';
import { FEED_DEFAULT_LIMIT } from '@myco/constants.js';

export interface FeedEntry {
  type: 'session' | 'agent_run' | 'spore';
  id: string;
  summary: string;
  timestamp: number;
}

export async function getActivityFeed(limit: number = FEED_DEFAULT_LIMIT): Promise<FeedEntry[]> {
  const db = getDatabase();
  const result = await db.query(`
    (SELECT 'session' as type, id, COALESCE(title, 'Session ' || LEFT(id, 8)) as summary,
            COALESCE(ended_at, started_at) as timestamp
     FROM sessions ORDER BY started_at DESC LIMIT $1)

    UNION ALL

    (SELECT 'agent_run' as type, id, task || ' — ' || status as summary,
            COALESCE(completed_at, started_at) as timestamp
     FROM agent_runs ORDER BY started_at DESC LIMIT $1)

    UNION ALL

    (SELECT 'spore' as type, id, observation_type || ': ' || LEFT(content, 80) as summary,
            created_at as timestamp
     FROM spores WHERE status = 'active' ORDER BY created_at DESC LIMIT $1)

    ORDER BY timestamp DESC LIMIT $1
  `, [limit]);
  return result.rows as FeedEntry[];
}
```

- [ ] **Step 4: Add constants**

In `src/constants.ts`, add:
```typescript
export const FEED_DEFAULT_LIMIT = 50;
export const SEARCH_RESULTS_DEFAULT_LIMIT = 20;
export const SEARCH_SIMILARITY_THRESHOLD = 0.3;
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/db/queries/feed.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/feed.ts tests/db/queries/feed.test.ts src/constants.ts
git commit -m "feat(db): add activity feed UNION query and search constants"
```

---

### Task 6: Config schema overhaul — strip to v3

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts` (or wherever migrations live)
- Modify: `tests/config/` (update config tests)

- [ ] **Step 1: Read current config consumers**

Search for imports of config types across the codebase to understand what will break:
```bash
rg "MycoConfig|LlmProviderConfig|DigestConfig|DigestIntelligenceConfig|CaptureSchema|ContextSchema|TeamSchema" --type ts -l
```

- [ ] **Step 2: Strip config schema**

Replace `src/config/schema.ts` with the v3 schema:

```typescript
import { z } from 'zod';

const EmbeddingProviderSchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible']).default('ollama'),
  model: z.string().default('bge-m3'),
  base_url: z.string().url().optional(),
});

const DaemonSchema = z.object({
  port: z.number().int().min(1024).max(65535).nullable().default(null),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const CaptureSchema = z.object({
  transcript_paths: z.array(z.string()).default([]),
  artifact_watch: z.array(z.string()).default(['.claude/plans/', '.cursor/plans/']),
  artifact_extensions: z.array(z.string()).default(['.md']),
  buffer_max_events: z.number().int().positive().default(500),
});

export const MycoConfigSchema = z.object({
  version: z.literal(3),
  config_version: z.number().int().nonnegative().default(0),
  embedding: EmbeddingProviderSchema.default(() => EmbeddingProviderSchema.parse({})),
  daemon: DaemonSchema.default(() => DaemonSchema.parse({})),
  capture: CaptureSchema.default(() => CaptureSchema.parse({})),
});

export type MycoConfig = z.infer<typeof MycoConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
```

- [ ] **Step 3: Add v2→v3 config migration**

In the config loader/migration code, add migration that:
- Extracts `intelligence.embedding` → top-level `embedding`
- Keeps `daemon.port` and `daemon.log_level` (drops `grace_period`, `max_log_size`)
- Keeps `capture.transcript_paths`, `artifact_watch`, `artifact_extensions`, `buffer_max_events`
- Drops: `intelligence.llm`, `capture.extraction_max_tokens` etc., `context`, `team`, `digest`
- Sets `version: 3`

- [ ] **Step 4: Fix all config consumers**

Update every file that imports removed config types or accesses removed fields. This will cascade — track with `tsc --noEmit` and fix each error.

Key files that MUST be updated:
- `src/intelligence/embed-query.ts` — change `config.intelligence.embedding` → `config.embedding`
- `src/intelligence/embeddings.ts` — same config path update
- `src/daemon/main.ts` — remove digest config, context config, intelligence.llm references. Also update inline stats route (which accesses `config.intelligence.llm`) — this will be fully rewritten in Task 8 but must not crash in between.
- `src/context/injector.ts` — remove context layers config references, use hardcoded defaults
- `src/services/stats.ts` — remove intelligence.llm references (rewritten in Task 8)
- `src/config/loader.ts` — update `needsWrite` guard to check for v3 shape (not v1/v2 fields like `digest`), update migration code
- `src/cli/setup-llm.ts` — remove or stub (LLM config no longer user-managed)
- `src/cli/setup-digest.ts` — remove or stub (digest config no longer user-managed)
- `src/cli/verify.ts` — update for v3 config paths

- [ ] **Step 5: Run lint**

Run: `npx tsc --noEmit 2>&1 | head -50`
Expected: PASS (or known remaining issues from later tasks)

- [ ] **Step 6: Run tests**

Run: `npx vitest run`
Fix any test failures from config shape changes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(config): strip to v3 schema — embedding, daemon, capture only"
```

---

### Task 7: Fix attachment DB inserts in stop handler

**Files:**
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Import insertAttachment in daemon main**

Add import at top of file:
```typescript
import { insertAttachment } from '@myco/db/queries/attachments.js';
```

- [ ] **Step 2: Add DB insert after image file write**

In the stop event processing section where images are written (around line 567-587), after the `fs.writeFileSync` call and inside the `if (!fs.existsSync(filePath))` block, add:

```typescript
// Record attachment in PGlite
const attachmentId = `${sessionShort}-t${i + 1}-${j + 1}`;
insertAttachment({
  id: attachmentId,
  session_id: sessionId,
  prompt_batch_id: batchState.get(sessionId)?.currentBatchId ?? undefined,
  file_path: filename,
  media_type: img.mediaType,
  created_at: epochSeconds(),
}).catch(err => logger.warn('processor', 'Failed to record attachment', { error: String(err) }));
```

- [ ] **Step 3: Commit**

```bash
git add src/daemon/main.ts
git commit -m "fix(daemon): insert attachment records into PGlite when writing images"
```

---

### Task 8: Update stats service for v2

**Files:**
- Modify: `src/services/stats.ts`
- Modify: `src/daemon/main.ts` (stats route handler)

- [ ] **Step 1: Read current stats implementation**

Understand what `gatherStats()` returns and what the inline stats route handler returns.

- [ ] **Step 2: Rewrite stats for v2**

The stats response should include:
```typescript
interface V2Stats {
  daemon: { pid, port, version, uptime_seconds, active_sessions };
  vault: { path, name, session_count, batch_count, spore_count, plan_count, artifact_count, entity_count, edge_count };
  embedding: { provider, model, queue_depth, embedded_count, total_embeddable };
  curator: { last_run_at, last_run_status, total_runs };
  digest: { freshest_tier, generated_at, tiers_available };
  unprocessed_batches: number;
}
```

Query PGlite for each count. Embedding queue_depth = `SELECT COUNT(*) FROM sessions WHERE summary IS NOT NULL AND embedding IS NULL` + similar for spores, plans, artifacts.

- [ ] **Step 3: Update tests**

- [ ] **Step 4: Commit**

```bash
git add src/services/stats.ts src/daemon/main.ts
git commit -m "feat(stats): rewrite stats service for v2 — embedding coverage, curator status, entity counts"
```

---

## Task Group 2: Daemon API Routes (Phase 3a continued)

### Task 9: Session detail API routes

**Files:**
- Create: `src/daemon/api/sessions.ts`
- Create: `tests/daemon/api/sessions.test.ts`
- Modify: `src/daemon/main.ts` (register routes)

- [ ] **Step 1: Write failing tests**

Test all session routes: `GET /api/sessions/:id`, `GET /api/sessions/:id/batches`, `GET /api/batches/:id/activities`, `GET /api/sessions/:id/attachments`.

- [ ] **Step 2: Implement session API handlers**

```typescript
// src/daemon/api/sessions.ts
import { getSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { listActivitiesByBatch } from '@myco/db/queries/activities.js';
import { listAttachmentsBySession } from '@myco/db/queries/attachments.js';
import type { RouteRequest, RouteResponse } from '../server.js';

export async function handleGetSession(req: RouteRequest): Promise<RouteResponse> {
  const session = await getSession(req.params.id);
  if (!session) return { status: 404, body: { error: 'not_found' } };
  return { body: session };
}

export async function handleGetSessionBatches(req: RouteRequest): Promise<RouteResponse> {
  const batches = await listBatchesBySession(req.params.id);
  return { body: batches };
}

export async function handleGetBatchActivities(req: RouteRequest): Promise<RouteResponse> {
  const activities = await listActivitiesByBatch(Number(req.params.id));
  return { body: activities };
}

export async function handleGetSessionAttachments(req: RouteRequest): Promise<RouteResponse> {
  const attachments = await listAttachmentsBySession(req.params.id);
  return { body: attachments };
}
```

- [ ] **Step 3: Register routes in daemon main**

```typescript
server.registerRoute('GET', '/api/sessions/:id', handleGetSession);
server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
server.registerRoute('GET', '/api/batches/:id/activities', handleGetBatchActivities);
server.registerRoute('GET', '/api/sessions/:id/attachments', handleGetSessionAttachments);
```

- [ ] **Step 4: Add binary response support to daemon server**

In `src/daemon/server.ts`, the `handleRequest` method always calls `JSON.stringify(result.body)`. For serving image files, we need to support raw `Buffer` responses. Modify `handleRequest` to detect `Buffer` bodies:

```typescript
// In handleRequest, before JSON.stringify:
if (Buffer.isBuffer(result.body)) {
  res.writeHead(result.status ?? 200, result.headers ?? {});
  res.end(result.body);
  return;
}
```

Update the `RouteResponse` type to allow `headers` and `Buffer` body:
```typescript
interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}
```

- [ ] **Step 5: Add static file serving for attachments**

```typescript
server.registerRoute('GET', '/api/attachments/:filename', async (req) => {
  const filePath = path.join(vaultDir, 'attachments', req.params.filename);
  if (!fs.existsSync(filePath)) return { status: 404, body: { error: 'not_found' } };
  const data = fs.readFileSync(filePath);
  const ext = path.extname(req.params.filename).slice(1);
  const mediaType = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
  return { status: 200, headers: { 'Content-Type': mediaType }, body: data };
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/daemon/api/sessions.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/daemon/api/sessions.ts src/daemon/server.ts tests/daemon/api/sessions.test.ts src/daemon/main.ts
git commit -m "feat(api): add session detail, batches, activities, attachments routes with binary serving"
```

---

### Task 10: Mycelium API routes (spores, entities, graph, digest)

**Files:**
- Create: `src/daemon/api/mycelium.ts`
- Create: `tests/daemon/api/mycelium.test.ts`
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Write failing tests**

Test: spore listing with filters, spore detail with edges, entity listing with mention filter, graph traversal, digest extracts by curator.

- [ ] **Step 2: Implement mycelium API handlers**

```typescript
// src/daemon/api/mycelium.ts
import { listSpores, getSpore } from '@myco/db/queries/spores.js';
import { listEntities, getEntityWithEdges } from '@myco/db/queries/entities.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { DEFAULT_CURATOR_ID } from '@myco/constants.js';
import type { RouteRequest, RouteResponse } from '../server.js';

// Note: listSpores() in spores.ts needs an `offset` field added to ListSporesOptions
// for pagination support. Add this when implementing this handler.
export async function handleListSpores(req: RouteRequest): Promise<RouteResponse> {
  const curatorId = req.query.curator_id ?? DEFAULT_CURATOR_ID;
  const spores = await listSpores({
    curator_id: curatorId,
    observation_type: req.query.type,
    status: req.query.status,
    limit: Number(req.query.limit) || 50,
    offset: Number(req.query.offset) || 0,
  });
  return { body: spores };
}

export async function handleGetSpore(req: RouteRequest): Promise<RouteResponse> {
  const spore = await getSpore(req.params.id);
  if (!spore) return { status: 404, body: { error: 'not_found' } };
  // TODO: enrich with edges and resolution history
  return { body: spore };
}

export async function handleListEntities(req: RouteRequest): Promise<RouteResponse> {
  const entities = await listEntities({
    curator_id: req.query.curator_id ?? DEFAULT_CURATOR_ID,
    type: req.query.type,
    mentioned_in: req.query.mentioned_in,
    note_type: req.query.note_type,
    limit: Number(req.query.limit) || 100,
  });
  return { body: entities };
}

export async function handleGetGraph(req: RouteRequest): Promise<RouteResponse> {
  const depth = Math.min(Number(req.query.depth) || 1, 3);
  try {
    const graph = await getEntityWithEdges(req.params.id, depth);
    // Add mention counts to nodes
    const db = (await import('@myco/db/client.js')).getDatabase();
    const nodes = await Promise.all(graph.nodes.map(async (node) => {
      const mentions = await db.query(
        'SELECT COUNT(*) as count FROM entity_mentions WHERE entity_id = $1',
        [node.id],
      );
      return { ...node, mention_count: Number(mentions.rows[0].count) };
    }));
    return { body: { center: graph.center, nodes, edges: graph.edges, depth } };
  } catch (err) {
    return { status: 404, body: { error: 'entity_not_found' } };
  }
}

export async function handleGetDigest(req: RouteRequest): Promise<RouteResponse> {
  const curatorId = req.query.curator_id ?? DEFAULT_CURATOR_ID;
  const extracts = await listDigestExtracts(curatorId);
  return { body: extracts };
}
```

- [ ] **Step 3: Register routes in daemon main**

```typescript
server.registerRoute('GET', '/api/spores', handleListSpores);
server.registerRoute('GET', '/api/spores/:id', handleGetSpore);
server.registerRoute('GET', '/api/entities', handleListEntities);
server.registerRoute('GET', '/api/graph/:id', handleGetGraph);
server.registerRoute('GET', '/api/digest', handleGetDigest);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/daemon/api/mycelium.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/mycelium.ts tests/daemon/api/mycelium.test.ts src/daemon/main.ts
git commit -m "feat(api): add mycelium routes — spores, entities, graph, digest"
```

---

### Task 11: Search, feed, embedding status, agent turns/tasks routes

**Files:**
- Create: `src/daemon/api/search.ts`
- Create: `src/daemon/api/feed.ts`
- Create: `src/daemon/api/embedding.ts`
- Modify: `src/daemon/api/agent.ts` (or inline in main.ts — extend existing agent routes)
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Implement search route**

```typescript
// src/daemon/api/search.ts
import { semanticSearch, fullTextSearch } from '@myco/db/queries/search.js';
import { tryEmbed } from '@myco/intelligence/embed-query.js';

export async function handleSearch(req: RouteRequest): Promise<RouteResponse> {
  const query = req.query.q;
  if (!query) return { status: 400, body: { error: 'missing_query' } };
  const mode = req.query.mode ?? 'semantic';
  const type = req.query.type;
  const limit = Number(req.query.limit) || 20;

  if (mode === 'fts') {
    const results = await fullTextSearch(query, { type, limit });
    return { body: { mode: 'fts', results } };
  }

  // Semantic search — embed query first
  const embedding = await tryEmbed(query);
  if (!embedding) {
    return { body: { mode: 'semantic', results: [], error: 'embedding_unavailable' } };
  }
  const results = await semanticSearch(embedding, { type, limit });
  return { body: { mode: 'semantic', results } };
}
```

- [ ] **Step 2: Implement feed route**

```typescript
// src/daemon/api/feed.ts
import { getActivityFeed } from '@myco/db/queries/feed.js';

export async function handleGetFeed(req: RouteRequest): Promise<RouteResponse> {
  const limit = Number(req.query.limit) || 50;
  const feed = await getActivityFeed(limit);
  return { body: feed };
}
```

- [ ] **Step 3: Implement embedding status route**

```typescript
// src/daemon/api/embedding.ts
import { getDatabase } from '@myco/db/client.js';
import { loadConfig } from '@myco/config/loader.js';

export async function handleGetEmbeddingStatus(req: RouteRequest, vaultDir: string): Promise<RouteResponse> {
  const db = getDatabase();
  const config = loadConfig(vaultDir);

  // Queue depth: items that should have embeddings but don't
  const queries = [
    db.query("SELECT COUNT(*) as count FROM sessions WHERE summary IS NOT NULL AND embedding IS NULL"),
    db.query("SELECT COUNT(*) as count FROM spores WHERE embedding IS NULL"),
    db.query("SELECT COUNT(*) as count FROM plans WHERE embedding IS NULL"),
    db.query("SELECT COUNT(*) as count FROM artifacts WHERE embedding IS NULL"),
  ];
  const [sessions, spores, plans, artifacts] = await Promise.all(queries);
  const queueDepth = [sessions, spores, plans, artifacts].reduce(
    (sum, r) => sum + Number(r.rows[0].count), 0
  );

  // Total embedded
  const embedded = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM sessions WHERE embedding IS NOT NULL) +
      (SELECT COUNT(*) FROM spores WHERE embedding IS NOT NULL) +
      (SELECT COUNT(*) FROM plans WHERE embedding IS NOT NULL) +
      (SELECT COUNT(*) FROM artifacts WHERE embedding IS NOT NULL) as count
  `);

  return {
    body: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      base_url: config.embedding.base_url ?? null,
      queue_depth: queueDepth,
      embedded_count: Number(embedded.rows[0].count),
      status: queueDepth === 0 ? 'idle' : 'pending',
    },
  };
}
```

- [ ] **Step 4: Add agent turns and tasks routes**

In `src/daemon/main.ts`, add:
```typescript
import { listTurnsByRun } from '@myco/db/queries/turns.js';
import { listTasksByCurator } from '@myco/db/queries/tasks.js';

server.registerRoute('GET', '/api/agent/runs/:id/turns', async (req) => {
  const turns = await listTurnsByRun(req.params.id);
  return { body: turns };
});

server.registerRoute('GET', '/api/agent/tasks', async (req) => {
  const curatorId = req.query.curator_id ?? DEFAULT_CURATOR_ID;
  const tasks = await listTasksByCurator(curatorId);
  return { body: tasks };
});
```

- [ ] **Step 5: Register all new routes in daemon main**

```typescript
server.registerRoute('GET', '/api/search', handleSearch);
server.registerRoute('GET', '/api/activity', handleGetFeed);
server.registerRoute('GET', '/api/embedding/status', (req) => handleGetEmbeddingStatus(req, vaultDir));
```

- [ ] **Step 6: Run full test suite**

Run: `make check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/daemon/api/search.ts src/daemon/api/feed.ts src/daemon/api/embedding.ts \
  src/daemon/main.ts
git commit -m "feat(api): add search, activity feed, embedding status, agent turns/tasks routes"
```

---

## Task Group 3: UI Layout & Dashboard (Phase 3b)

### Task 12: Remove v1 UI pages and components

**Files:**
- Delete: `ui/src/pages/Operations.tsx`
- Delete: `ui/src/pages/Mycelium.tsx` (v1 version)
- Delete: `ui/src/pages/Configuration.tsx`
- Delete: `ui/src/components/pipeline/` (entire directory)
- Delete: `ui/src/components/operations/` (entire directory)
- Delete: `ui/src/hooks/use-pipeline.ts`
- Modify: `ui/src/layout/Layout.tsx` (update nav)
- Modify: `ui/src/App.tsx` (or router file — update routes)

- [ ] **Step 1: Delete v1 files**

Remove all listed files and directories.

- [ ] **Step 2: Update navigation in Layout.tsx**

Replace `NAV_ITEMS` (around line 28) with:
```typescript
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/sessions', label: 'Sessions', icon: MessageSquare },
  { to: '/mycelium', label: 'Mycelium', icon: Network },
  { to: '/agent', label: 'Agent', icon: Bot },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/logs', label: 'Logs', icon: ScrollText },
]
```

Add missing icon imports from `lucide-react`: `MessageSquare`, `Bot`.

- [ ] **Step 3: Update routes**

Find the React Router configuration (likely in `App.tsx` or a routes file) and update:
```typescript
<Route path="/" element={<Dashboard />} />
<Route path="/sessions" element={<Sessions />} />
<Route path="/sessions/:id" element={<Sessions />} />
<Route path="/mycelium" element={<Mycelium />} />
<Route path="/agent" element={<Agent />} />
<Route path="/settings" element={<SettingsPage />} />
<Route path="/logs" element={<Logs />} />
```

- [ ] **Step 4: Create stub pages**

Create minimal stub pages so the app compiles:
- `ui/src/pages/Sessions.tsx` — `export default function Sessions() { return <div>Sessions</div>; }`
- `ui/src/pages/Mycelium.tsx` — same pattern
- `ui/src/pages/Agent.tsx` — same pattern
- `ui/src/pages/Settings.tsx` — same pattern

- [ ] **Step 5: Update UI constants**

In `ui/src/lib/constants.ts`, remove `PIPELINE_STAGES` and any pipeline-related constants.

- [ ] **Step 6: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS (or only errors from removed imports in Dashboard.tsx, which is next)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(ui): remove v1 pages and components, update navigation for v2"
```

---

### Task 13: Global search component

**Files:**
- Create: `ui/src/components/search/GlobalSearch.tsx`
- Create: `ui/src/components/search/SearchResults.tsx`
- Create: `ui/src/hooks/use-search.ts`
- Modify: `ui/src/layout/Layout.tsx` (add search trigger to header)

- [ ] **Step 1: Create search hook**

```typescript
// ui/src/hooks/use-search.ts
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

interface SearchResult {
  id: string;
  type: string;
  title: string;
  preview: string;
  score: number;
  session_id?: string;
}

export function useSearch(query: string, mode: 'semantic' | 'fts' = 'semantic') {
  return useQuery({
    queryKey: ['search', query, mode],
    queryFn: () => fetchJson<{ mode: string; results: SearchResult[] }>(
      `/api/search?q=${encodeURIComponent(query)}&mode=${mode}`
    ),
    enabled: query.length > 2,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2: Create GlobalSearch component**

A dialog triggered by `Cmd+K`. Input field with mode toggle (semantic/fts). Debounced query. Results grouped by type. Click navigates to detail page via React Router.

- [ ] **Step 3: Create SearchResults component**

Groups results by type (sessions, spores, plans, prompt_batches, activities). Each result shows title, preview, score. Clicking navigates to the appropriate detail route.

- [ ] **Step 4: Add search trigger to Layout**

In Layout.tsx header area, add a search button/input that opens the GlobalSearch dialog. Register `Cmd+K` keyboard shortcut via `useEffect`.

- [ ] **Step 5: Verify build**

Run: `cd ui && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/search/ ui/src/hooks/use-search.ts ui/src/layout/Layout.tsx
git commit -m "feat(ui): add global search dialog with dual-mode support (Cmd+K)"
```

---

### Task 14: Dashboard page — visual operations hub

**Files:**
- Rewrite: `ui/src/pages/Dashboard.tsx`
- Create: `ui/src/components/dashboard/DataFlow.tsx`
- Create: `ui/src/components/dashboard/ActivityFeed.tsx`
- Create: `ui/src/components/dashboard/CuratorStatus.tsx`
- Create: `ui/src/components/dashboard/EmbeddingHealth.tsx`
- Create: `ui/src/hooks/use-activity.ts`
- Create: `ui/src/hooks/use-embedding.ts`
- Modify: `ui/src/hooks/use-daemon.ts` (update StatsResponse for v2)

- [ ] **Step 1: Create hooks**

`use-activity.ts`: Polls `GET /api/activity` every 10s.
`use-embedding.ts`: Polls `GET /api/embedding/status` every 10s.
Update `use-daemon.ts` StatsResponse type to match v2 shape.

- [ ] **Step 2: Create DataFlow component**

Horizontal flow visualization: Sessions → Batches → Embedding → Curation → Mycelium → Digest. Each node renders as a rounded card with count, status badge, and link. Use CSS flexbox with connecting lines or SVG arrows. Counts from the stats API.

- [ ] **Step 3: Create ActivityFeed component**

Scrollable list of recent events from `use-activity`. Each entry: icon by type, summary text, relative timestamp. Click navigates to detail.

- [ ] **Step 4: Create CuratorStatus component**

Shows idle/running state. Last run info from `GET /api/agent/runs?limit=1`. "Run Now" button triggers `POST /api/agent/run`.

- [ ] **Step 5: Create EmbeddingHealth component**

Provider, model, queue depth, embedded count from `use-embedding`. Status badge: idle (green), pending (amber), unavailable (red).

- [ ] **Step 6: Compose Dashboard page**

```tsx
export default function Dashboard() {
  return (
    <div className="space-y-6">
      <DataFlow />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ActivityFeed className="lg:col-span-2" />
        <div className="space-y-4">
          <CuratorStatus />
          <EmbeddingHealth />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/Dashboard.tsx ui/src/components/dashboard/ \
  ui/src/hooks/use-activity.ts ui/src/hooks/use-embedding.ts ui/src/hooks/use-daemon.ts
git commit -m "feat(ui): dashboard visual operations hub — data flow, activity feed, curator status"
```

---

## Task Group 4: Sessions Browser (Phase 3c)

### Task 15: Sessions page — list + detail

**Files:**
- Rewrite: `ui/src/pages/Sessions.tsx`
- Create: `ui/src/components/sessions/SessionList.tsx`
- Create: `ui/src/components/sessions/SessionDetail.tsx`
- Create: `ui/src/components/sessions/BatchTimeline.tsx`
- Create: `ui/src/components/sessions/ActivityList.tsx`
- Create: `ui/src/hooks/use-sessions.ts`

- [ ] **Step 1: Create sessions hooks**

```typescript
// ui/src/hooks/use-sessions.ts
export function useSessions(filters) // GET /api/sessions with query params
export function useSession(id) // GET /api/sessions/:id
export function useSessionBatches(id) // GET /api/sessions/:id/batches
export function useBatchActivities(batchId) // GET /api/batches/:id/activities
export function useSessionAttachments(id) // GET /api/sessions/:id/attachments
```

- [ ] **Step 2: Create SessionList component**

Table with columns from spec: title, agent, branch, status, prompts, tools, started, duration. Filters bar above table. Pagination controls. Click row navigates to `/sessions/:id`.

- [ ] **Step 3: Create BatchTimeline component**

For each batch: collapsible card showing user prompt (with inline images from attachments), activity list, AI summary. Images rendered via `<img src="/api/attachments/{filename}" />`.

- [ ] **Step 4: Create ActivityList component**

Tool call rows: tool_name, file_path, success badge, duration. Expandable for input/output detail.

- [ ] **Step 5: Create SessionDetail component**

Header with session metadata. BatchTimeline as main content. Metadata sidebar: transcript path, parent session, content hash, linked plans/artifacts, attachment count.

- [ ] **Step 6: Compose Sessions page**

Uses React Router `useParams` to detect `:id`. If ID present, show SessionDetail. Otherwise, show SessionList.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/Sessions.tsx ui/src/components/sessions/ ui/src/hooks/use-sessions.ts
git commit -m "feat(ui): sessions browser with batch timeline, activities, inline screenshots"
```

---

## Task Group 5: Mycelium Browser (Phase 3d)

### Task 16: Mycelium page — spores tab

**Files:**
- Rewrite: `ui/src/pages/Mycelium.tsx`
- Create: `ui/src/components/mycelium/SporeList.tsx`
- Create: `ui/src/components/mycelium/SporeDetail.tsx`
- Create: `ui/src/hooks/use-spores.ts`

- [ ] **Step 1: Create spores hook**

```typescript
// ui/src/hooks/use-spores.ts
export function useSpores(filters) // GET /api/spores
export function useSpore(id) // GET /api/spores/:id
```

- [ ] **Step 2: Create SporeList component**

Filterable table: observation type, status, importance, content preview, source session link, created date. Filters bar with type dropdown, status toggle, importance range slider.

- [ ] **Step 3: Create SporeDetail component**

Full content, context, source session link (navigates to `/sessions/:id`), resolution history (if superseded/consolidated), connected entities.

- [ ] **Step 4: Compose Mycelium page with tabs**

Use a tab component (or simple state). Tabs: Spores, Graph, Digest. Spores tab shows SporeList with slide-over SporeDetail.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/Mycelium.tsx ui/src/components/mycelium/SporeList.tsx \
  ui/src/components/mycelium/SporeDetail.tsx ui/src/hooks/use-spores.ts
git commit -m "feat(ui): mycelium spores tab — filterable list with detail view"
```

---

### Task 17: Mycelium page — graph tab

**Files:**
- Create: `ui/src/components/mycelium/GraphExplorer.tsx`

- [ ] **Step 1: Choose and install graph visualization library**

Install `react-force-graph-2d` (lightweight, good for entity graphs):
```bash
cd ui && npm install react-force-graph-2d
```

If types are missing: `npm install -D @types/react-force-graph-2d` or use a declaration.

- [ ] **Step 2: Create graph hook**

```typescript
export function useGraph(entityId, depth) // GET /api/graph/:id?depth=N
export function useEntitiesByMention(noteId, noteType) // GET /api/entities?mentioned_in=X&note_type=Y
```

- [ ] **Step 3: Create GraphExplorer component**

Takes entity ID as prop. Fetches graph data. Renders force-directed graph with:
- Nodes colored by entity type
- Edge labels
- Click node to re-center (fetch new graph centered on that entity)
- Depth slider (1-3)
- Empty state message when no data

- [ ] **Step 4: Add Graph tab to Mycelium page**

Wire GraphExplorer into the Graph tab. Entry from SporeDetail: "View in graph" link that resolves entities via `useEntitiesByMention`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/mycelium/GraphExplorer.tsx ui/package.json ui/package-lock.json
git commit -m "feat(ui): mycelium graph explorer with force-directed entity visualization"
```

---

### Task 18: Mycelium page — digest tab

**Files:**
- Create: `ui/src/components/mycelium/DigestView.tsx`

- [ ] **Step 1: Create digest hook**

```typescript
export function useDigest(curatorId?) // GET /api/digest?curator_id=X
```

- [ ] **Step 2: Create DigestView component**

Shows digest extracts by tier (1500, 3000, 5000, 7500, 10000). Each tier card: token count label, content preview (collapsible to full), generated_at timestamp with relative time, freshness badge. Empty state: "No digest generated yet — run the curator with the digest-only task."

- [ ] **Step 3: Add Digest tab to Mycelium page**

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/mycelium/DigestView.tsx
git commit -m "feat(ui): mycelium digest tab — tier-based extract viewer"
```

---

## Task Group 6: Agent Page (Phase 3e)

### Task 19: Agent page — run history + detail

**Files:**
- Rewrite: `ui/src/pages/Agent.tsx`
- Create: `ui/src/components/agent/RunList.tsx`
- Create: `ui/src/components/agent/RunDetail.tsx`
- Create: `ui/src/components/agent/TriggerRun.tsx`
- Create: `ui/src/hooks/use-agent.ts`

- [ ] **Step 1: Create agent hooks**

```typescript
// ui/src/hooks/use-agent.ts
export function useAgentRuns(options?) // GET /api/agent/runs
export function useAgentRun(id) // GET /api/agent/runs/:id
export function useAgentReports(runId) // GET /api/agent/runs/:id/reports
export function useAgentTurns(runId) // GET /api/agent/runs/:id/turns
export function useAgentTasks() // GET /api/agent/tasks
export function useTriggerRun() // POST /api/agent/run mutation
```

- [ ] **Step 2: Create RunList component**

Table: task name, status badge, started (relative), duration, tokens, cost (USD). Click navigates to run detail. "Run Now" button opens TriggerRun.

- [ ] **Step 3: Create RunDetail component**

Summary bar: status, tokens, cost, actions, duration.

**Decisions section (default open):** Renders agent_reports. Each report card: action badge, summary text, expandable details JSON.

**Audit Trail section (collapsed by default):** Toggle to show full agent_turns. Table: turn number, tool name, input preview, output preview, timing.

- [ ] **Step 4: Create TriggerRun component**

Dialog/inline form: task picker dropdown (from `useAgentTasks`), instruction text area, run button. On submit, call mutation. Show running state with polling.

- [ ] **Step 5: Compose Agent page**

Default: RunList. URL param `:id` triggers RunDetail overlay or nested route.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/Agent.tsx ui/src/components/agent/ ui/src/hooks/use-agent.ts
git commit -m "feat(ui): agent page — run history, decisions, audit trail, trigger run"
```

---

## Task Group 7: Settings + Cleanup (Phase 3f)

### Task 20: Settings page

**Files:**
- Create: `ui/src/pages/Settings.tsx`
- Modify: `ui/src/hooks/use-config.ts` (update for v3 schema)

- [ ] **Step 1: Update config hook for v3**

Update the config type and save mutation to match the stripped v3 schema (embedding, daemon, capture only).

- [ ] **Step 2: Create Settings page**

Two sections:

**Project:** Vault name (read-only from stats), daemon port (number input), log level (select dropdown).

**Embedding:** Provider (select: ollama, openai-compatible), model (text input), base URL (text input, optional). "Test Connection" button that calls `GET /api/models?provider=X&type=embedding` and shows result.

Save button with dirty-state tracking. Restart prompt if daemon settings changed.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/Settings.tsx ui/src/hooks/use-config.ts
git commit -m "feat(ui): slim settings page — project config + embedding provider"
```

---

### Task 21: Final cleanup and integration testing

**Files:**
- Various — fix remaining compilation errors

- [ ] **Step 1: Run full lint**

Run: `npx tsc --noEmit`
Fix any remaining type errors.

- [ ] **Step 2: Run full test suite**

Run: `make check`
Fix any test failures.

- [ ] **Step 3: Build**

Run: `make build`
Fix any build errors. Vite build for UI: `cd ui && npx vite build`.

- [ ] **Step 4: Manual smoke test**

Start daemon: `node dist/src/cli.js restart`
Open dashboard: `http://localhost:<port>/`
Verify:
- [ ] Navigation shows all 6 pages
- [ ] Dashboard renders data flow, activity feed, curator status, embedding health
- [ ] Sessions page lists sessions, detail view shows batch timeline
- [ ] Mycelium page shows spores/graph/digest tabs
- [ ] Agent page shows run history, trigger run works
- [ ] Settings page shows v3 config, save works
- [ ] Global search (`Cmd+K`) opens and searches
- [ ] Logs page still works

- [ ] **Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: final cleanup and integration fixes for v2 dashboard"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `make check` passes (lint + test)
- [ ] `make build` succeeds (backend + UI)
- [ ] Database schema version is 3
- [ ] FTS search_vector columns exist on prompt_batches and activities
- [ ] Embedding columns exist on plans and artifacts
- [ ] Attachments are recorded in PGlite when images are written
- [ ] All new API routes respond correctly
- [ ] Config is v3 shape (embedding, daemon, capture only)
- [ ] v1 pipeline UI is fully removed
- [ ] Dashboard shows data flow visualization
- [ ] Sessions browser shows batch timeline with inline screenshots
- [ ] Mycelium browser shows spores, graph, digest
- [ ] Agent page shows run history with decisions
- [ ] Settings page is slim (project + embedding only)
- [ ] Global search works in both semantic and FTS modes
- [ ] All routes are scoped to curator_id where applicable

## Notes

**Task execution order:** Tasks 1–11 (backend) should complete before Tasks 12–21 (frontend). Within the backend tasks, 1–5 (schema + queries) before 6 (config) before 7–11 (API routes). Frontend tasks can largely parallelize: Tasks 12–13 first (layout), then 14–19 in any order, then 20–21 last.

**Config migration risk:** Task 6 (config schema overhaul) has the widest blast radius — it touches every config consumer. Run `tsc --noEmit` after each fix to catch cascading errors. Consider doing this task in a separate worktree for isolation.

**Graph visualization:** Task 17 depends on a graph library choice. `react-force-graph-2d` is recommended for simplicity, but if the entity count grows large, consider `cytoscape.js` for better performance. Evaluate during implementation.

**Binary response support:** Task 9 requires serving image files via the daemon HTTP server. Check whether the server's `RouteResponse` type supports binary `Buffer` responses. If not, add support (likely a `Content-Type` header override and raw body pass-through).

/**
 * Tests for extended list-by-parent query helpers added in the v2 dashboard
 * overhaul. Covers:
 *
 *   - listBatchesBySession   (batches.ts)
 *   - listActivitiesByBatch  (activities.ts)
 *   - listEntities           (entities.ts — new mentioned_in + offset filters)
 *   - getEntityWithEdges     (entities.ts — BFS graph traversal)
 *   - listDigestExtracts     (digest-extracts.ts)
 *   - listTurnsByRun         (turns.ts)
 *   - listTasksByAgent     (tasks.ts)
 *   - listSpores with offset  (spores.ts)
 *
 * Each test uses an in-memory PGlite instance that is created fresh in
 * beforeEach and torn down in afterEach.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch, listBatchesBySession } from '@myco/db/queries/batches.js';
import { insertActivity, listActivitiesByBatch } from '@myco/db/queries/activities.js';
import {
  insertEntity,
  listEntities,
  getEntityWithEdges,
} from '@myco/db/queries/entities.js';
import { insertGraphEdge } from '@myco/db/queries/graph-edges.js';
import type { GraphEdgeInsert } from '@myco/db/queries/graph-edges.js';
import { upsertDigestExtract, listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertTurn, listTurnsByRun } from '@myco/db/queries/turns.js';
import { upsertTask, listTasksByAgent } from '@myco/db/queries/tasks.js';
import { insertSpore, listSpores } from '@myco/db/queries/spores.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { BatchInsert } from '@myco/db/queries/batches.js';
import type { ActivityInsert } from '@myco/db/queries/activities.js';
import type { EntityInsert } from '@myco/db/queries/entities.js';
import type { TurnInsert } from '@myco/db/queries/turns.js';
import type { TaskInsert } from '@myco/db/queries/tasks.js';
import type { SporeInsert } from '@myco/db/queries/spores.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Epoch seconds. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Shared test IDs — kept consistent to simplify FK wiring. */
const TEST_AGENT_ID = 'agent-ext-test';
const TEST_RUN_ID = 'run-ext-test';

function makeSession(overrides: Partial<SessionInsert> = {}): SessionInsert {
  const now = epochNow();
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

function makeBatch(sessionId: string, overrides: Partial<BatchInsert> = {}): BatchInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

function makeActivity(
  sessionId: string,
  overrides: Partial<ActivityInsert> = {},
): ActivityInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    tool_name: 'Read',
    timestamp: now,
    created_at: now,
    ...overrides,
  };
}

function makeEntity(overrides: Partial<EntityInsert> = {}): EntityInsert {
  const now = epochNow();
  return {
    id: `entity-${Math.random().toString(36).slice(2, 10)}`,
    agent_id: TEST_AGENT_ID,
    type: 'component',
    name: `file-${Math.random().toString(36).slice(2, 8)}`,
    first_seen: now,
    last_seen: now,
    ...overrides,
  };
}

function makeGraphEdge(
  sourceId: string,
  targetId: string,
  overrides: Partial<GraphEdgeInsert> = {},
): GraphEdgeInsert {
  return {
    agent_id: TEST_AGENT_ID,
    source_id: sourceId,
    source_type: 'entity',
    target_id: targetId,
    target_type: 'entity',
    type: 'REFERENCES',
    created_at: epochNow(),
    ...overrides,
  };
}

function makeTurn(overrides: Partial<TurnInsert> = {}): TurnInsert {
  return {
    run_id: TEST_RUN_ID,
    agent_id: TEST_AGENT_ID,
    turn_number: 1,
    tool_name: 'vault_search',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskInsert> = {}): TaskInsert {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: TEST_AGENT_ID,
    prompt: 'Analyze the vault and produce observations.',
    created_at: epochNow(),
    ...overrides,
  };
}

function makeSpore(overrides: Partial<SporeInsert> = {}): SporeInsert {
  const now = epochNow();
  return {
    id: `spore-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: TEST_AGENT_ID,
    observation_type: 'gotcha',
    content: 'Test observation',
    created_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('extended list-by-parent query helpers', () => {
  let sessionId: string;

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await cleanTestDb();

    // Agent FK required by several tables
    await registerAgent({
      id: TEST_AGENT_ID,
      name: 'Ext Test Agent',
      created_at: epochNow(),
    });

    // Session FK required by batches / activities / spores
    const session = makeSession();
    await upsertSession(session);
    sessionId = session.id;

    // Run FK required by turns
    await insertRun({
      id: TEST_RUN_ID,
      agent_id: TEST_AGENT_ID,
      started_at: epochNow(),
    });
  });

  // =========================================================================
  // listBatchesBySession
  // =========================================================================

  describe('listBatchesBySession', () => {
    it('returns all batches for a session ordered by prompt_number ASC', async () => {
      const now = epochNow();
      await insertBatch(makeBatch(sessionId, { prompt_number: 3, created_at: now }));
      await insertBatch(makeBatch(sessionId, { prompt_number: 1, created_at: now + 1 }));
      await insertBatch(makeBatch(sessionId, { prompt_number: 2, created_at: now + 2 }));

      const rows = await listBatchesBySession(sessionId);
      expect(rows).toHaveLength(3);
      // Ordered by prompt_number ASC — nulls sort before positives in PG
      const nonNull = rows.filter(r => r.prompt_number !== null);
      expect(nonNull[0].prompt_number).toBe(1);
      expect(nonNull[1].prompt_number).toBe(2);
      expect(nonNull[2].prompt_number).toBe(3);
    });

    it('returns empty array when session has no batches', async () => {
      const rows = await listBatchesBySession('no-such-session');
      expect(rows).toEqual([]);
    });

    it('does not return batches from other sessions', async () => {
      const session2 = makeSession();
      await upsertSession(session2);

      await insertBatch(makeBatch(sessionId, { prompt_number: 1 }));
      await insertBatch(makeBatch(session2.id, { prompt_number: 2 }));

      const rows = await listBatchesBySession(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe(sessionId);
    });

    it('respects limit option', async () => {
      for (let i = 1; i <= 5; i++) {
        await insertBatch(makeBatch(sessionId, { prompt_number: i }));
      }

      const rows = await listBatchesBySession(sessionId, { limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('respects offset option for pagination', async () => {
      for (let i = 1; i <= 5; i++) {
        await insertBatch(makeBatch(sessionId, { prompt_number: i }));
      }

      const page1 = await listBatchesBySession(sessionId, { limit: 2, offset: 0 });
      const page2 = await listBatchesBySession(sessionId, { limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // Pages must not overlap
      const page1Ids = new Set(page1.map(r => r.id));
      for (const row of page2) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
    });
  });

  // =========================================================================
  // listActivitiesByBatch
  // =========================================================================

  describe('listActivitiesByBatch', () => {
    it('returns all activities for a batch ordered by timestamp ASC', async () => {
      const batch = await insertBatch(makeBatch(sessionId));
      const now = epochNow();

      await insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch.id,
        tool_name: 'Bash',
        timestamp: now + 2,
      }));
      await insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch.id,
        tool_name: 'Read',
        timestamp: now,
      }));
      await insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch.id,
        tool_name: 'Edit',
        timestamp: now + 1,
      }));

      const rows = await listActivitiesByBatch(batch.id);
      expect(rows).toHaveLength(3);
      expect(rows[0].tool_name).toBe('Read');
      expect(rows[1].tool_name).toBe('Edit');
      expect(rows[2].tool_name).toBe('Bash');
    });

    it('returns empty array when batch has no activities', async () => {
      const rows = await listActivitiesByBatch(999999);
      expect(rows).toEqual([]);
    });

    it('does not return activities from other batches', async () => {
      const batch1 = await insertBatch(makeBatch(sessionId));
      const batch2 = await insertBatch(makeBatch(sessionId));
      const now = epochNow();

      await insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch1.id,
        tool_name: 'Read',
        timestamp: now,
      }));
      await insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch2.id,
        tool_name: 'Edit',
        timestamp: now + 1,
      }));

      const rows = await listActivitiesByBatch(batch1.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('Read');
    });
  });

  // =========================================================================
  // listEntities (extended filters: mentioned_in, offset)
  // =========================================================================

  describe('listEntities — mentioned_in filter', () => {
    it('returns entities mentioned in a specific note', async () => {
      const db = (await import('@myco/db/client.js')).getDatabase();
      const e1 = await insertEntity(makeEntity({ name: 'src/foo.ts' }));
      const e2 = await insertEntity(makeEntity({ name: 'src/bar.ts' }));
      const e3 = await insertEntity(makeEntity({ name: 'src/baz.ts' }));

      // Mention e1 and e2 in note-abc/session
      await db.query(
        `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
         VALUES ($1, 'note-abc', 'session', $2),
                ($3, 'note-abc', 'session', $4)`,
        [e1.id, TEST_AGENT_ID, e2.id, TEST_AGENT_ID],
      );
      // Mention e3 in a different note
      await db.query(
        `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
         VALUES ($1, 'note-xyz', 'session', $2)`,
        [e3.id, TEST_AGENT_ID],
      );

      const rows = await listEntities({
        mentioned_in: 'note-abc',
        note_type: 'session',
      });

      expect(rows).toHaveLength(2);
      const ids = rows.map(r => r.id);
      expect(ids).toContain(e1.id);
      expect(ids).toContain(e2.id);
      expect(ids).not.toContain(e3.id);
    });

    it('returns empty array when no entities match the note', async () => {
      await insertEntity(makeEntity());
      const rows = await listEntities({
        mentioned_in: 'nonexistent-note',
        note_type: 'session',
      });
      expect(rows).toEqual([]);
    });
  });

  describe('listEntities — offset pagination', () => {
    it('supports offset for pagination', async () => {
      // Insert 5 entities with distinct last_seen values for stable ordering
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        await insertEntity(makeEntity({ last_seen: now + i }));
      }

      const page1 = await listEntities({ limit: 2, offset: 0 });
      const page2 = await listEntities({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);

      const page1Ids = new Set(page1.map(r => r.id));
      for (const row of page2) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
    });
  });

  // =========================================================================
  // getEntityWithEdges
  // =========================================================================

  describe('getEntityWithEdges', () => {
    it('returns null for a non-existent entity', async () => {
      const result = await getEntityWithEdges('no-such-entity');
      expect(result).toBeNull();
    });

    it('returns center with empty nodes/edges when no edges exist', async () => {
      const center = await insertEntity(makeEntity({ name: 'isolated' }));
      const result = await getEntityWithEdges(center.id);

      expect(result).not.toBeNull();
      expect(result!.center.id).toBe(center.id);
      expect(result!.nodes).toHaveLength(0);
      expect(result!.edges).toHaveLength(0);
    });

    it('returns 1-hop neighbours and edges', async () => {
      const center = await insertEntity(makeEntity({ name: 'center' }));
      const neighbour1 = await insertEntity(makeEntity({ name: 'n1' }));
      const neighbour2 = await insertEntity(makeEntity({ name: 'n2' }));

      await insertGraphEdge(makeGraphEdge(center.id, neighbour1.id));
      await insertGraphEdge(makeGraphEdge(center.id, neighbour2.id));

      const result = await getEntityWithEdges(center.id, 1);

      expect(result).not.toBeNull();
      expect(result!.center.id).toBe(center.id);
      expect(result!.edges).toHaveLength(2);
      expect(result!.nodes).toHaveLength(2);
      const nodeIds = result!.nodes.map(n => n.id);
      expect(nodeIds).toContain(neighbour1.id);
      expect(nodeIds).toContain(neighbour2.id);
    });

    it('handles incoming edges (target → center)', async () => {
      const center = await insertEntity(makeEntity({ name: 'center' }));
      const source = await insertEntity(makeEntity({ name: 'src' }));

      await insertGraphEdge(makeGraphEdge(source.id, center.id));

      const result = await getEntityWithEdges(center.id, 1);

      expect(result!.edges).toHaveLength(1);
      expect(result!.nodes).toHaveLength(1);
      expect(result!.nodes[0].id).toBe(source.id);
    });

    it('deduplicates edges across BFS iterations', async () => {
      // A — B — C  (depth 2 from A would see edge A-B twice if not deduplicated)
      const a = await insertEntity(makeEntity({ name: 'a' }));
      const b = await insertEntity(makeEntity({ name: 'b' }));
      const c = await insertEntity(makeEntity({ name: 'c' }));

      const edgeAB = await insertGraphEdge(makeGraphEdge(a.id, b.id));
      await insertGraphEdge(makeGraphEdge(b.id, c.id));

      const result = await getEntityWithEdges(a.id, 2);

      // Edge A-B must appear exactly once
      const abEdges = result!.edges.filter(e => e.id === edgeAB.id);
      expect(abEdges).toHaveLength(1);
      // Total: 2 edges (A-B and B-C)
      expect(result!.edges).toHaveLength(2);
    });
  });

  // =========================================================================
  // listDigestExtracts
  // =========================================================================

  describe('listDigestExtracts', () => {
    it('returns all extracts for an agent ordered by tier ASC', async () => {
      const now = epochNow();
      await upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 3, content: 'tier 3', generated_at: now });
      await upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1, content: 'tier 1', generated_at: now });
      await upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 2, content: 'tier 2', generated_at: now });

      const rows = await listDigestExtracts(TEST_AGENT_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].tier).toBe(1);
      expect(rows[1].tier).toBe(2);
      expect(rows[2].tier).toBe(3);
    });

    it('returns empty array when agent has no extracts', async () => {
      const rows = await listDigestExtracts('no-such-agent');
      expect(rows).toEqual([]);
    });

    it('does not return extracts from other agents', async () => {
      await registerAgent({ id: 'agent-other', name: 'Other', created_at: epochNow() });
      const now = epochNow();
      await upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1, content: 'mine', generated_at: now });
      await upsertDigestExtract({ agent_id: 'agent-other', tier: 1, content: 'theirs', generated_at: now });

      const rows = await listDigestExtracts(TEST_AGENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe('mine');
    });
  });

  // =========================================================================
  // listTurnsByRun
  // =========================================================================

  describe('listTurnsByRun', () => {
    it('returns turns for a run ordered by turn_number ASC', async () => {
      await insertTurn(makeTurn({ turn_number: 3, tool_name: 'vault_report' }));
      await insertTurn(makeTurn({ turn_number: 1, tool_name: 'vault_search' }));
      await insertTurn(makeTurn({ turn_number: 2, tool_name: 'vault_read' }));

      const rows = await listTurnsByRun(TEST_RUN_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].turn_number).toBe(1);
      expect(rows[0].tool_name).toBe('vault_search');
      expect(rows[1].turn_number).toBe(2);
      expect(rows[2].turn_number).toBe(3);
    });

    it('returns empty array when run has no turns', async () => {
      const rows = await listTurnsByRun('no-such-run');
      expect(rows).toEqual([]);
    });
  });

  // =========================================================================
  // listTasksByAgent
  // =========================================================================

  describe('listTasksByAgent', () => {
    it('returns all tasks for an agent ordered by display_name ASC', async () => {
      await upsertTask(makeTask({ display_name: 'Zebra Task' }));
      await upsertTask(makeTask({ display_name: 'Alpha Task' }));
      await upsertTask(makeTask({ display_name: 'Mango Task' }));

      const rows = await listTasksByAgent(TEST_AGENT_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].display_name).toBe('Alpha Task');
      expect(rows[1].display_name).toBe('Mango Task');
      expect(rows[2].display_name).toBe('Zebra Task');
    });

    it('returns empty array when agent has no tasks', async () => {
      const rows = await listTasksByAgent('no-such-agent');
      expect(rows).toEqual([]);
    });

    it('does not return tasks from other agents', async () => {
      await registerAgent({ id: 'agent-other2', name: 'Other2', created_at: epochNow() });
      await upsertTask(makeTask({ id: 'task-mine', display_name: 'My Task' }));
      await upsertTask(makeTask({ id: 'task-theirs', agent_id: 'agent-other2', display_name: 'Their Task' }));

      const rows = await listTasksByAgent(TEST_AGENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('task-mine');
    });
  });

  // =========================================================================
  // listSpores with offset
  // =========================================================================

  describe('listSpores — offset pagination', () => {
    it('supports offset for pagination', async () => {
      const now = epochNow();
      // Insert 5 spores with distinct created_at (DESC ordering)
      for (let i = 0; i < 5; i++) {
        await insertSpore(makeSpore({ created_at: now + i }));
      }

      const page1 = await listSpores({ limit: 2, offset: 0 });
      const page2 = await listSpores({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);

      const page1Ids = new Set(page1.map(r => r.id));
      for (const row of page2) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
    });

    it('returns empty array when offset exceeds total rows', async () => {
      await insertSpore(makeSpore());

      const rows = await listSpores({ offset: 10 });
      expect(rows).toEqual([]);
    });
  });
});

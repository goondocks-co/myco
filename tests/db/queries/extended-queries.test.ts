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
import { getDatabase } from '@myco/db/client.js';
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

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    // Agent FK required by several tables
    registerAgent({
      id: TEST_AGENT_ID,
      name: 'Ext Test Agent',
      created_at: epochNow(),
    });

    // Session FK required by batches / activities / spores
    const session = makeSession();
    upsertSession(session);
    sessionId = session.id;

    // Run FK required by turns
    insertRun({
      id: TEST_RUN_ID,
      agent_id: TEST_AGENT_ID,
      started_at: epochNow(),
    });
  });

  // =========================================================================
  // listBatchesBySession
  // =========================================================================

  describe('listBatchesBySession', () => {
    it('returns all batches for a session ordered by prompt_number ASC', () => {
      const now = epochNow();
      insertBatch(makeBatch(sessionId, { prompt_number: 3, created_at: now }));
      insertBatch(makeBatch(sessionId, { prompt_number: 1, created_at: now + 1 }));
      insertBatch(makeBatch(sessionId, { prompt_number: 2, created_at: now + 2 }));

      const rows = listBatchesBySession(sessionId);
      expect(rows).toHaveLength(3);
      // Ordered by prompt_number ASC — nulls sort before positives in PG
      const nonNull = rows.filter(r => r.prompt_number !== null);
      expect(nonNull[0].prompt_number).toBe(1);
      expect(nonNull[1].prompt_number).toBe(2);
      expect(nonNull[2].prompt_number).toBe(3);
    });

    it('returns empty array when session has no batches', () => {
      const rows = listBatchesBySession('no-such-session');
      expect(rows).toEqual([]);
    });

    it('does not return batches from other sessions', () => {
      const session2 = makeSession();
      upsertSession(session2);

      insertBatch(makeBatch(sessionId, { prompt_number: 1 }));
      insertBatch(makeBatch(session2.id, { prompt_number: 2 }));

      const rows = listBatchesBySession(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe(sessionId);
    });

    it('respects limit option', () => {
      for (let i = 1; i <= 5; i++) {
        insertBatch(makeBatch(sessionId, { prompt_number: i }));
      }

      const rows = listBatchesBySession(sessionId, { limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('respects offset option for pagination', () => {
      for (let i = 1; i <= 5; i++) {
        insertBatch(makeBatch(sessionId, { prompt_number: i }));
      }

      const page1 = listBatchesBySession(sessionId, { limit: 2, offset: 0 });
      const page2 = listBatchesBySession(sessionId, { limit: 2, offset: 2 });
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
    it('returns all activities for a batch ordered by timestamp ASC', () => {
      const batch = insertBatch(makeBatch(sessionId));
      const now = epochNow();

      insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch.id,
        tool_name: 'Bash',
        timestamp: now + 2,
      }));
      insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch.id,
        tool_name: 'Read',
        timestamp: now,
      }));
      insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch.id,
        tool_name: 'Edit',
        timestamp: now + 1,
      }));

      const rows = listActivitiesByBatch(batch.id);
      expect(rows).toHaveLength(3);
      expect(rows[0].tool_name).toBe('Read');
      expect(rows[1].tool_name).toBe('Edit');
      expect(rows[2].tool_name).toBe('Bash');
    });

    it('returns empty array when batch has no activities', () => {
      const rows = listActivitiesByBatch(999999);
      expect(rows).toEqual([]);
    });

    it('does not return activities from other batches', () => {
      const batch1 = insertBatch(makeBatch(sessionId));
      const batch2 = insertBatch(makeBatch(sessionId));
      const now = epochNow();

      insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch1.id,
        tool_name: 'Read',
        timestamp: now,
      }));
      insertActivity(makeActivity(sessionId, {
        prompt_batch_id: batch2.id,
        tool_name: 'Edit',
        timestamp: now + 1,
      }));

      const rows = listActivitiesByBatch(batch1.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('Read');
    });
  });

  // =========================================================================
  // listEntities (extended filters: mentioned_in, offset)
  // =========================================================================

  describe('listEntities — mentioned_in filter', () => {
    it('returns entities mentioned in a specific note', () => {
      const db = getDatabase();
      const e1 = insertEntity(makeEntity({ name: 'src/foo.ts' }));
      const e2 = insertEntity(makeEntity({ name: 'src/bar.ts' }));
      const e3 = insertEntity(makeEntity({ name: 'src/baz.ts' }));

      // Mention e1 and e2 in note-abc/session
      db.prepare(
        `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
         VALUES (?, 'note-abc', 'session', ?)`,
      ).run(e1.id, TEST_AGENT_ID);
      db.prepare(
        `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
         VALUES (?, 'note-abc', 'session', ?)`,
      ).run(e2.id, TEST_AGENT_ID);
      // Mention e3 in a different note
      db.prepare(
        `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
         VALUES (?, 'note-xyz', 'session', ?)`,
      ).run(e3.id, TEST_AGENT_ID);

      const rows = listEntities({
        mentioned_in: 'note-abc',
        note_type: 'session',
      });

      expect(rows).toHaveLength(2);
      const ids = rows.map(r => r.id);
      expect(ids).toContain(e1.id);
      expect(ids).toContain(e2.id);
      expect(ids).not.toContain(e3.id);
    });

    it('returns empty array when no entities match the note', () => {
      insertEntity(makeEntity());
      const rows = listEntities({
        mentioned_in: 'nonexistent-note',
        note_type: 'session',
      });
      expect(rows).toEqual([]);
    });
  });

  describe('listEntities — offset pagination', () => {
    it('supports offset for pagination', () => {
      // Insert 5 entities with distinct last_seen values for stable ordering
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        insertEntity(makeEntity({ last_seen: now + i }));
      }

      const page1 = listEntities({ limit: 2, offset: 0 });
      const page2 = listEntities({ limit: 2, offset: 2 });

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
    it('returns null for a non-existent entity', () => {
      const result = getEntityWithEdges('no-such-entity');
      expect(result).toBeNull();
    });

    it('returns center with empty nodes/edges when no edges exist', () => {
      const center = insertEntity(makeEntity({ name: 'isolated' }));
      const result = getEntityWithEdges(center.id);

      expect(result).not.toBeNull();
      expect(result!.center.id).toBe(center.id);
      expect(result!.nodes).toHaveLength(0);
      expect(result!.edges).toHaveLength(0);
    });

    it('returns 1-hop neighbours and edges', () => {
      const center = insertEntity(makeEntity({ name: 'center' }));
      const neighbour1 = insertEntity(makeEntity({ name: 'n1' }));
      const neighbour2 = insertEntity(makeEntity({ name: 'n2' }));

      insertGraphEdge(makeGraphEdge(center.id, neighbour1.id));
      insertGraphEdge(makeGraphEdge(center.id, neighbour2.id));

      const result = getEntityWithEdges(center.id, 1);

      expect(result).not.toBeNull();
      expect(result!.center.id).toBe(center.id);
      expect(result!.edges).toHaveLength(2);
      expect(result!.nodes).toHaveLength(2);
      const nodeIds = result!.nodes.map(n => n.id);
      expect(nodeIds).toContain(neighbour1.id);
      expect(nodeIds).toContain(neighbour2.id);
    });

    it('handles incoming edges (target → center)', () => {
      const center = insertEntity(makeEntity({ name: 'center' }));
      const source = insertEntity(makeEntity({ name: 'src' }));

      insertGraphEdge(makeGraphEdge(source.id, center.id));

      const result = getEntityWithEdges(center.id, 1);

      expect(result!.edges).toHaveLength(1);
      expect(result!.nodes).toHaveLength(1);
      expect(result!.nodes[0].id).toBe(source.id);
    });

    it('deduplicates edges across BFS iterations', () => {
      // A — B — C  (depth 2 from A would see edge A-B twice if not deduplicated)
      const a = insertEntity(makeEntity({ name: 'a' }));
      const b = insertEntity(makeEntity({ name: 'b' }));
      const c = insertEntity(makeEntity({ name: 'c' }));

      const edgeAB = insertGraphEdge(makeGraphEdge(a.id, b.id));
      insertGraphEdge(makeGraphEdge(b.id, c.id));

      const result = getEntityWithEdges(a.id, 2);

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
    it('returns all extracts for an agent ordered by tier ASC', () => {
      const now = epochNow();
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 3, content: 'tier 3', generated_at: now });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1, content: 'tier 1', generated_at: now });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 2, content: 'tier 2', generated_at: now });

      const rows = listDigestExtracts(TEST_AGENT_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].tier).toBe(1);
      expect(rows[1].tier).toBe(2);
      expect(rows[2].tier).toBe(3);
    });

    it('returns empty array when agent has no extracts', () => {
      const rows = listDigestExtracts('no-such-agent');
      expect(rows).toEqual([]);
    });

    it('does not return extracts from other agents', () => {
      registerAgent({ id: 'agent-other', name: 'Other', created_at: epochNow() });
      const now = epochNow();
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1, content: 'mine', generated_at: now });
      upsertDigestExtract({ agent_id: 'agent-other', tier: 1, content: 'theirs', generated_at: now });

      const rows = listDigestExtracts(TEST_AGENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe('mine');
    });
  });

  // =========================================================================
  // listTurnsByRun
  // =========================================================================

  describe('listTurnsByRun', () => {
    it('returns turns for a run ordered by turn_number ASC', () => {
      insertTurn(makeTurn({ turn_number: 3, tool_name: 'vault_report' }));
      insertTurn(makeTurn({ turn_number: 1, tool_name: 'vault_search' }));
      insertTurn(makeTurn({ turn_number: 2, tool_name: 'vault_read' }));

      const rows = listTurnsByRun(TEST_RUN_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].turn_number).toBe(1);
      expect(rows[0].tool_name).toBe('vault_search');
      expect(rows[1].turn_number).toBe(2);
      expect(rows[2].turn_number).toBe(3);
    });

    it('returns empty array when run has no turns', () => {
      const rows = listTurnsByRun('no-such-run');
      expect(rows).toEqual([]);
    });
  });

  // =========================================================================
  // listTasksByAgent
  // =========================================================================

  describe('listTasksByAgent', () => {
    it('returns all tasks for an agent ordered by display_name ASC', () => {
      upsertTask(makeTask({ display_name: 'Zebra Task' }));
      upsertTask(makeTask({ display_name: 'Alpha Task' }));
      upsertTask(makeTask({ display_name: 'Mango Task' }));

      const rows = listTasksByAgent(TEST_AGENT_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].display_name).toBe('Alpha Task');
      expect(rows[1].display_name).toBe('Mango Task');
      expect(rows[2].display_name).toBe('Zebra Task');
    });

    it('returns empty array when agent has no tasks', () => {
      const rows = listTasksByAgent('no-such-agent');
      expect(rows).toEqual([]);
    });

    it('does not return tasks from other agents', () => {
      registerAgent({ id: 'agent-other2', name: 'Other2', created_at: epochNow() });
      upsertTask(makeTask({ id: 'task-mine', display_name: 'My Task' }));
      upsertTask(makeTask({ id: 'task-theirs', agent_id: 'agent-other2', display_name: 'Their Task' }));

      const rows = listTasksByAgent(TEST_AGENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('task-mine');
    });
  });

  // =========================================================================
  // listSpores with offset
  // =========================================================================

  describe('listSpores — offset pagination', () => {
    it('supports offset for pagination', () => {
      const now = epochNow();
      // Insert 5 spores with distinct created_at (DESC ordering)
      for (let i = 0; i < 5; i++) {
        insertSpore(makeSpore({ created_at: now + i }));
      }

      const page1 = listSpores({ limit: 2, offset: 0 });
      const page2 = listSpores({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);

      const page1Ids = new Set(page1.map(r => r.id));
      for (const row of page2) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
    });

    it('returns empty array when offset exceeds total rows', () => {
      insertSpore(makeSpore());

      const rows = listSpores({ offset: 10 });
      expect(rows).toEqual([]);
    });
  });
});

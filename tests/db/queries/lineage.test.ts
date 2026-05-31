/**
 * Tests for lineage edge creation helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { createSporeLineage, createBatchLineage, recordPlanSessionTouch } from '@myco/db/queries/lineage.js';
import { listGraphEdges } from '@myco/db/queries/graph-edges.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';

const TEST_AGENT_ID = 'test-agent';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Insert an agent directly into the agents table. */
function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, epochNow());
}

describe('lineage helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    createAgent(TEST_AGENT_ID);
  });

  describe('createSporeLineage', () => {
    it('creates FROM_SESSION and EXTRACTED_FROM edges for a regular spore', () => {
      createSporeLineage({
        id: 'spore-1',
        agent_id: TEST_AGENT_ID,
        session_id: 'session-1',
        prompt_batch_id: 42,
        created_at: epochNow(),
      });

      const edges = listGraphEdges({ sourceId: 'spore-1', scope: ALL_PROJECTS_SCOPE });
      expect(edges).toHaveLength(2);

      const types = edges.map(e => e.type).sort();
      expect(types).toEqual(['EXTRACTED_FROM', 'FROM_SESSION']);
    });

    it('creates only FROM_SESSION when no batch id', () => {
      createSporeLineage({
        id: 'spore-2',
        agent_id: TEST_AGENT_ID,
        session_id: 'session-1',
        created_at: epochNow(),
      });

      const edges = listGraphEdges({ sourceId: 'spore-2', scope: ALL_PROJECTS_SCOPE });
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe('FROM_SESSION');
    });

    it('creates no edges when no session_id or batch', () => {
      createSporeLineage({
        id: 'spore-3',
        agent_id: TEST_AGENT_ID,
        created_at: epochNow(),
      });

      const edges = listGraphEdges({ sourceId: 'spore-3', scope: ALL_PROJECTS_SCOPE });
      expect(edges).toHaveLength(0);
    });

    it('creates DERIVED_FROM edges for wisdom spores with consolidated_from', () => {
      createSporeLineage({
        id: 'wisdom-1',
        agent_id: TEST_AGENT_ID,
        session_id: 'session-1',
        observation_type: 'wisdom',
        properties: JSON.stringify({ consolidated_from: ['spore-a', 'spore-b', 'spore-c'] }),
        created_at: epochNow(),
      });

      const edges = listGraphEdges({ sourceId: 'wisdom-1', scope: ALL_PROJECTS_SCOPE });
      // 1 FROM_SESSION + 3 DERIVED_FROM = 4
      expect(edges).toHaveLength(4);

      const derivedEdges = edges.filter(e => e.type === 'DERIVED_FROM');
      expect(derivedEdges).toHaveLength(3);
      const targetIds = derivedEdges.map(e => e.target_id).sort();
      expect(targetIds).toEqual(['spore-a', 'spore-b', 'spore-c']);
    });

    it('handles malformed properties JSON gracefully', () => {
      createSporeLineage({
        id: 'spore-bad',
        agent_id: TEST_AGENT_ID,
        session_id: 'session-1',
        observation_type: 'wisdom',
        properties: 'not valid json',
        created_at: epochNow(),
      });

      const edges = listGraphEdges({ sourceId: 'spore-bad', scope: ALL_PROJECTS_SCOPE });
      // Only FROM_SESSION, no DERIVED_FROM because JSON parse failed
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe('FROM_SESSION');
    });
  });

  describe('createBatchLineage', () => {
    it('creates a HAS_BATCH edge from session to batch', () => {
      const now = epochNow();
      createBatchLineage(TEST_AGENT_ID, 'session-1', 42, now);

      const edges = listGraphEdges({ sourceId: 'session-1', type: 'HAS_BATCH', scope: ALL_PROJECTS_SCOPE });
      expect(edges).toHaveLength(1);
      expect(edges[0].source_type).toBe('session');
      expect(edges[0].target_id).toBe('42');
      expect(edges[0].target_type).toBe('batch');
    });
  });

  describe('recordPlanSessionTouch', () => {
    // The lineage edge is system-attributed to DEFAULT_AGENT_ID (same owner
    // createBatchLineage uses); ensure it exists to satisfy the agent FK.
    beforeEach(() => { createAgent(DEFAULT_AGENT_ID); });

    const plan = {
      id: 'plan-1',
      project_id: null as string | null,
      session_id: 'creator-session',
    };

    it('emits a PLAN_REFERENCED edge stamped at the touch time, not the plan birth time', () => {
      recordPlanSessionTouch(plan, 'reader-session', 'PLAN_REFERENCED');
      const edges = listGraphEdges({ sourceId: 'plan-1', scope: ALL_PROJECTS_SCOPE });
      expect(edges).toHaveLength(1);
      expect(edges[0].source_type).toBe('plan');
      expect(edges[0].target_id).toBe('reader-session');
      expect(edges[0].type).toBe('PLAN_REFERENCED');
      // Edge records WHEN the cross-session touch happened (now), not the plan's
      // creation time — so it must be a current, non-zero epoch.
      expect(edges[0].created_at).toBeGreaterThan(1_000_000_000);
    });

    it('does NOT emit an edge when the calling session is the creating session', () => {
      recordPlanSessionTouch(plan, 'creator-session', 'PLAN_REFERENCED');
      expect(listGraphEdges({ sourceId: 'plan-1', scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    });

    it('does NOT emit an edge when the calling session is null', () => {
      recordPlanSessionTouch(plan, null, 'PLAN_REFERENCED');
      expect(listGraphEdges({ sourceId: 'plan-1', scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    });

    it('is idempotent for the same (plan, session, type) touch', () => {
      recordPlanSessionTouch(plan, 'reader-session', 'PLAN_REFERENCED');
      recordPlanSessionTouch(plan, 'reader-session', 'PLAN_REFERENCED');
      expect(listGraphEdges({ sourceId: 'plan-1', scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
    });
  });
});

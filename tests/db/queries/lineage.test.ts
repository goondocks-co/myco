/**
 * Tests for lineage edge creation helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { createSporeLineage, createBatchLineage } from '@myco/db/queries/lineage.js';
import { listGraphEdges } from '@myco/db/queries/graph-edges.js';

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

      const edges = listGraphEdges({ sourceId: 'spore-1' });
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

      const edges = listGraphEdges({ sourceId: 'spore-2' });
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe('FROM_SESSION');
    });

    it('creates no edges when no session_id or batch', () => {
      createSporeLineage({
        id: 'spore-3',
        agent_id: TEST_AGENT_ID,
        created_at: epochNow(),
      });

      const edges = listGraphEdges({ sourceId: 'spore-3' });
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

      const edges = listGraphEdges({ sourceId: 'wisdom-1' });
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

      const edges = listGraphEdges({ sourceId: 'spore-bad' });
      // Only FROM_SESSION, no DERIVED_FROM because JSON parse failed
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe('FROM_SESSION');
    });
  });

  describe('createBatchLineage', () => {
    it('creates a HAS_BATCH edge from session to batch', () => {
      const now = epochNow();
      createBatchLineage(TEST_AGENT_ID, 'session-1', 42, now);

      const edges = listGraphEdges({ sourceId: 'session-1', type: 'HAS_BATCH' });
      expect(edges).toHaveLength(1);
      expect(edges[0].source_type).toBe('session');
      expect(edges[0].target_id).toBe('42');
      expect(edges[0].target_type).toBe('batch');
    });
  });
});

/**
 * Tests for graph edge CRUD query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  insertGraphEdge,
  listGraphEdges,
  getGraphForNode,
} from '@myco/db/queries/graph-edges.js';
import type { GraphEdgeInsert } from '@myco/db/queries/graph-edges.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

const TEST_AGENT_ID = 'test-agent';

/** Insert an agent directly into the agents table. */
async function createAgent(id: string): Promise<void> {
  const db = getDatabase();
  await db.query(
    `INSERT INTO agents (id, name, created_at) VALUES ($1, $2, $3)`,
    [id, `agent-${id}`, epochNow()],
  );
}

/** Factory for minimal valid graph edge data. */
function makeEdge(overrides: Partial<GraphEdgeInsert> = {}): GraphEdgeInsert {
  return {
    agent_id: TEST_AGENT_ID,
    source_id: 'spore-1',
    source_type: 'spore',
    target_id: 'session-1',
    target_type: 'session',
    type: 'FROM_SESSION',
    created_at: epochNow(),
    ...overrides,
  };
}

describe('graph edge query helpers', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await cleanTestDb();
    await createAgent(TEST_AGENT_ID);
  });

  describe('insertGraphEdge', () => {
    it('inserts an edge and returns it with generated id', async () => {
      const edge = await insertGraphEdge(makeEdge());

      expect(edge.id).toBeDefined();
      expect(edge.agent_id).toBe(TEST_AGENT_ID);
      expect(edge.source_id).toBe('spore-1');
      expect(edge.source_type).toBe('spore');
      expect(edge.target_id).toBe('session-1');
      expect(edge.target_type).toBe('session');
      expect(edge.type).toBe('FROM_SESSION');
      expect(edge.confidence).toBe(1.0);
    });

    it('stores optional fields', async () => {
      const edge = await insertGraphEdge(makeEdge({
        session_id: 'sess-abc',
        confidence: 0.8,
        properties: JSON.stringify({ reason: 'test' }),
      }));

      expect(edge.session_id).toBe('sess-abc');
      expect(edge.confidence).toBe(0.8);
      expect(JSON.parse(edge.properties!)).toEqual({ reason: 'test' });
    });
  });

  describe('listGraphEdges', () => {
    it('returns edges ordered by created_at DESC', async () => {
      const now = epochNow();
      await insertGraphEdge(makeEdge({ source_id: 'old', created_at: now - 100 }));
      await insertGraphEdge(makeEdge({ source_id: 'new', created_at: now }));

      const edges = await listGraphEdges();
      expect(edges).toHaveLength(2);
      expect(edges[0].source_id).toBe('new');
      expect(edges[1].source_id).toBe('old');
    });

    it('filters by sourceId', async () => {
      await insertGraphEdge(makeEdge({ source_id: 'spore-a' }));
      await insertGraphEdge(makeEdge({ source_id: 'spore-b' }));

      const edges = await listGraphEdges({ sourceId: 'spore-a' });
      expect(edges).toHaveLength(1);
      expect(edges[0].source_id).toBe('spore-a');
    });

    it('filters by targetId', async () => {
      await insertGraphEdge(makeEdge({ target_id: 'session-x' }));
      await insertGraphEdge(makeEdge({ target_id: 'session-y' }));

      const edges = await listGraphEdges({ targetId: 'session-x' });
      expect(edges).toHaveLength(1);
      expect(edges[0].target_id).toBe('session-x');
    });

    it('filters by type', async () => {
      await insertGraphEdge(makeEdge({ type: 'FROM_SESSION' }));
      await insertGraphEdge(makeEdge({ type: 'EXTRACTED_FROM' }));

      const edges = await listGraphEdges({ type: 'FROM_SESSION' });
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe('FROM_SESSION');
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await insertGraphEdge(makeEdge({ source_id: `s-${i}`, created_at: epochNow() + i }));
      }

      const edges = await listGraphEdges({ limit: 2 });
      expect(edges).toHaveLength(2);
    });
  });

  describe('getGraphForNode', () => {
    it('returns edges connected to the starting node', async () => {
      await insertGraphEdge(makeEdge({
        source_id: 'spore-1', source_type: 'spore',
        target_id: 'session-1', target_type: 'session',
        type: 'FROM_SESSION',
      }));
      await insertGraphEdge(makeEdge({
        source_id: 'spore-1', source_type: 'spore',
        target_id: 'batch-1', target_type: 'batch',
        type: 'EXTRACTED_FROM',
      }));

      const result = await getGraphForNode('spore-1', 'spore', { depth: 1 });
      expect(result.edges).toHaveLength(2);
    });

    it('traverses multiple hops', async () => {
      // spore-1 → session-1 → batch-1 (via separate edges)
      await insertGraphEdge(makeEdge({
        source_id: 'spore-1', source_type: 'spore',
        target_id: 'session-1', target_type: 'session',
        type: 'FROM_SESSION',
      }));
      await insertGraphEdge(makeEdge({
        source_id: 'session-1', source_type: 'session',
        target_id: 'batch-1', target_type: 'batch',
        type: 'HAS_BATCH',
      }));

      // Depth 1 should find only the first edge
      const shallow = await getGraphForNode('spore-1', 'spore', { depth: 1 });
      expect(shallow.edges).toHaveLength(1);

      // Depth 2 should find both
      const deep = await getGraphForNode('spore-1', 'spore', { depth: 2 });
      expect(deep.edges).toHaveLength(2);
    });

    it('deduplicates edges across hops', async () => {
      // Create a cycle: A → B → A (via different edge types)
      await insertGraphEdge(makeEdge({
        source_id: 'A', source_type: 'spore',
        target_id: 'B', target_type: 'spore',
        type: 'RELATES_TO',
      }));
      await insertGraphEdge(makeEdge({
        source_id: 'B', source_type: 'spore',
        target_id: 'A', target_type: 'spore',
        type: 'DERIVED_FROM',
      }));

      const result = await getGraphForNode('A', 'spore', { depth: 3 });
      expect(result.edges).toHaveLength(2);
    });

    it('returns empty edges for isolated node', async () => {
      const result = await getGraphForNode('isolated', 'entity');
      expect(result.edges).toEqual([]);
    });
  });
});

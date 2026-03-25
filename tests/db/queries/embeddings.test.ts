/**
 * Tests for pgvector embedding query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { SporeInsert } from '@myco/db/queries/spores.js';
import {
  setEmbedding,
  searchSimilar,
  getUnembedded,
  EMBEDDABLE_TABLES,
} from '@myco/db/queries/embeddings.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid session data. */
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

/** Insert an agent directly into the agents table and return its id. */
async function createAgent(id: string): Promise<string> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO agents (id, name, created_at) VALUES ($1, $2, $3)`,
    [id, `agent-${id}`, now],
  );
  return id;
}

/** Factory for minimal valid spore data. */
function makeSpore(
  agentId: string,
  overrides: Partial<SporeInsert> = {},
): SporeInsert {
  const now = epochNow();
  return {
    id: `spore-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: agentId,
    observation_type: 'gotcha',
    content: 'Some observation content',
    created_at: now,
    ...overrides,
  };
}

/**
 * Create a synthetic unit vector of EMBEDDING_DIMENSIONS length.
 *
 * Places a 1.0 at `hotIndex` and 0.0 everywhere else.
 * Useful for controlled similarity testing — identical hot indices
 * give cosine similarity of 1.0, different indices give 0.0.
 */
function makeUnitVector(hotIndex: number): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vec[hotIndex] = 1.0;
  return vec;
}

describe('embedding query helpers', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // setEmbedding
  // ---------------------------------------------------------------------------

  describe('setEmbedding', () => {
    it('stores an embedding on a session row', async () => {
      const session = makeSession();
      await upsertSession(session);

      const vec = makeUnitVector(0);
      await setEmbedding('sessions', session.id, vec);

      // Verify the embedding was stored by querying directly
      const db = getDatabase();
      const result = await db.query(
        `SELECT embedding IS NOT NULL AS has_embedding FROM sessions WHERE id = $1`,
        [session.id],
      );
      expect((result.rows[0] as Record<string, unknown>).has_embedding).toBe(true);
    });

    it('stores an embedding on a spore row', async () => {
      const agentId = await createAgent('agent-emb');
      const spore = makeSpore(agentId);
      await insertSpore(spore);

      const vec = makeUnitVector(1);
      await setEmbedding('spores', spore.id, vec);

      const db = getDatabase();
      const result = await db.query(
        `SELECT embedding IS NOT NULL AS has_embedding FROM spores WHERE id = $1`,
        [spore.id],
      );
      expect((result.rows[0] as Record<string, unknown>).has_embedding).toBe(true);
    });

    it('is idempotent — overwrites existing embedding without error', async () => {
      const session = makeSession();
      await upsertSession(session);

      const vec1 = makeUnitVector(0);
      const vec2 = makeUnitVector(1);

      await setEmbedding('sessions', session.id, vec1);
      await setEmbedding('sessions', session.id, vec2);

      // Should not throw and the embedding should be the second one
      const db = getDatabase();
      const result = await db.query(
        `SELECT embedding IS NOT NULL AS has_embedding FROM sessions WHERE id = $1`,
        [session.id],
      );
      expect((result.rows[0] as Record<string, unknown>).has_embedding).toBe(true);
    });

    it('rejects invalid table names', async () => {
      const vec = makeUnitVector(0);
      await expect(
        setEmbedding('users; DROP TABLE sessions;--', 'id', vec),
      ).rejects.toThrow();
    });

    it('throws for non-existent row (no rows affected)', async () => {
      const vec = makeUnitVector(0);
      await expect(
        setEmbedding('sessions', 'nonexistent-id', vec),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // searchSimilar
  // ---------------------------------------------------------------------------

  describe('searchSimilar', () => {
    it('returns results ordered by similarity (most similar first)', async () => {
      const now = epochNow();
      const s1 = makeSession({ id: 'sess-close', created_at: now, started_at: now });
      const s2 = makeSession({ id: 'sess-far', created_at: now + 1, started_at: now + 1 });
      const s3 = makeSession({ id: 'sess-mid', created_at: now + 2, started_at: now + 2 });
      await upsertSession(s1);
      await upsertSession(s2);
      await upsertSession(s3);

      // Query vector: [1, 0, 0, ...]
      const queryVec = makeUnitVector(0);

      // sess-close: identical to query (cosine distance = 0, similarity = 1)
      await setEmbedding('sessions', 'sess-close', makeUnitVector(0));
      // sess-far: orthogonal to query (cosine distance = 1, similarity = 0)
      await setEmbedding('sessions', 'sess-far', makeUnitVector(1));
      // sess-mid: mix that should be between the two
      const midVec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      midVec[0] = 0.7;
      midVec[1] = 0.7;
      await setEmbedding('sessions', 'sess-mid', midVec);

      const results = await searchSimilar('sessions', queryVec);

      expect(results.length).toBe(3);
      // Most similar first
      expect(results[0].id).toBe('sess-close');
      expect(results[0].similarity).toBeCloseTo(1.0, 1);
      // Mid-similarity second
      expect(results[1].id).toBe('sess-mid');
      expect(results[1].similarity).toBeGreaterThan(0);
      expect(results[1].similarity).toBeLessThan(1);
      // Least similar last
      expect(results[2].id).toBe('sess-far');
    });

    it('only returns rows with embeddings', async () => {
      const now = epochNow();
      const s1 = makeSession({ id: 'sess-embedded', created_at: now, started_at: now });
      const s2 = makeSession({ id: 'sess-bare', created_at: now + 1, started_at: now + 1 });
      await upsertSession(s1);
      await upsertSession(s2);

      await setEmbedding('sessions', 'sess-embedded', makeUnitVector(0));
      // s2 has no embedding

      const results = await searchSimilar('sessions', makeUnitVector(0));

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('sess-embedded');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        const s = makeSession({ id: `sess-lim-${i}`, created_at: now + i, started_at: now + i });
        await upsertSession(s);
        await setEmbedding('sessions', s.id, makeUnitVector(i % EMBEDDING_DIMENSIONS));
      }

      const results = await searchSimilar('sessions', makeUnitVector(0), { limit: 2 });
      expect(results.length).toBe(2);
    });

    it('returns empty array when no rows have embeddings', async () => {
      await upsertSession(makeSession());

      const results = await searchSimilar('sessions', makeUnitVector(0));
      expect(results).toEqual([]);
    });

    it('returns similarity between 0 and 1 for cosine distance', async () => {
      const session = makeSession();
      await upsertSession(session);
      await setEmbedding('sessions', session.id, makeUnitVector(0));

      const results = await searchSimilar('sessions', makeUnitVector(0));

      expect(results.length).toBe(1);
      expect(results[0].similarity).toBeGreaterThanOrEqual(0);
      expect(results[0].similarity).toBeLessThanOrEqual(1);
    });

    it('works with spores table', async () => {
      const agentId = await createAgent('agent-search');
      const spore = makeSpore(agentId, { id: 'spore-search' });
      await insertSpore(spore);
      await setEmbedding('spores', 'spore-search', makeUnitVector(2));

      const results = await searchSimilar('spores', makeUnitVector(2));

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('spore-search');
      expect(results[0].similarity).toBeCloseTo(1.0, 1);
    });

    it('rejects invalid table names', async () => {
      await expect(
        searchSimilar('evil_table', makeUnitVector(0)),
      ).rejects.toThrow();
    });

    it('supports simple equality filters', async () => {
      const now = epochNow();
      const s1 = makeSession({ id: 'sess-a1', agent: 'claude-code', created_at: now, started_at: now });
      const s2 = makeSession({ id: 'sess-a2', agent: 'cursor', created_at: now + 1, started_at: now + 1 });
      await upsertSession(s1);
      await upsertSession(s2);
      await setEmbedding('sessions', 'sess-a1', makeUnitVector(0));
      await setEmbedding('sessions', 'sess-a2', makeUnitVector(0));

      const results = await searchSimilar('sessions', makeUnitVector(0), {
        filters: { agent: 'cursor' },
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('sess-a2');
    });
  });

  // ---------------------------------------------------------------------------
  // getUnembedded
  // ---------------------------------------------------------------------------

  describe('getUnembedded', () => {
    it('returns rows without embeddings', async () => {
      const now = epochNow();
      const summary = 'A non-empty session summary';
      const s1 = makeSession({ id: 'sess-no-emb', created_at: now, started_at: now, summary });
      const s2 = makeSession({ id: 'sess-has-emb', created_at: now + 1, started_at: now + 1, summary });
      await upsertSession(s1);
      await upsertSession(s2);
      await setEmbedding('sessions', 'sess-has-emb', makeUnitVector(0));

      const rows = await getUnembedded('sessions');

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('sess-no-emb');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      const summary = 'A non-empty session summary';
      for (let i = 0; i < 5; i++) {
        await upsertSession(makeSession({ id: `sess-unemb-${i}`, created_at: now + i, started_at: now + i, summary }));
      }

      const rows = await getUnembedded('sessions', { limit: 2 });
      expect(rows.length).toBe(2);
    });

    it('returns empty array when all rows have embeddings', async () => {
      const session = makeSession({ summary: 'A non-empty session summary' });
      await upsertSession(session);
      await setEmbedding('sessions', session.id, makeUnitVector(0));

      const rows = await getUnembedded('sessions');
      expect(rows).toEqual([]);
    });

    it('returns empty array when table is empty', async () => {
      const rows = await getUnembedded('sessions');
      expect(rows).toEqual([]);
    });

    it('works with spores table', async () => {
      const agentId = await createAgent('agent-unemb');
      const spore = makeSpore(agentId, { id: 'spore-unemb' });
      await insertSpore(spore);

      const rows = await getUnembedded('spores');
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('spore-unemb');
    });

    it('rejects invalid table names', async () => {
      await expect(getUnembedded('evil_table')).rejects.toThrow();
    });

    it('orders results by created_at ASC (oldest first for processing queue)', async () => {
      const now = epochNow();
      const summary = 'A session summary for ordering test';
      await upsertSession(makeSession({ id: 'sess-old', created_at: now - 100, started_at: now - 100, summary }));
      await upsertSession(makeSession({ id: 'sess-new', created_at: now, started_at: now, summary }));
      await upsertSession(makeSession({ id: 'sess-mid', created_at: now - 50, started_at: now - 50, summary }));

      const rows = await getUnembedded('sessions');

      expect(rows.length).toBe(3);
      expect(rows[0].id).toBe('sess-old');
      expect(rows[1].id).toBe('sess-mid');
      expect(rows[2].id).toBe('sess-new');
    });

    it('should not return sessions without summaries for embedding', async () => {
      const now = epochNow();
      // Session with no summary — should be excluded from the queue
      await upsertSession(makeSession({ id: 'sess-no-summary', created_at: now, started_at: now }));
      // Session with a summary but no embedding — should appear in the queue
      await upsertSession(makeSession({
        id: 'sess-has-summary',
        created_at: now + 1,
        started_at: now + 1,
        summary: 'This session did something useful',
      }));

      const rows = await getUnembedded('sessions');

      const ids = rows.map((r) => r.id);
      expect(ids).not.toContain('sess-no-summary');
      expect(ids).toContain('sess-has-summary');
    });
  });

  // ---------------------------------------------------------------------------
  // EMBEDDABLE_TABLES constant
  // ---------------------------------------------------------------------------

  describe('EMBEDDABLE_TABLES', () => {
    it('contains exactly the four tables with embedding columns', () => {
      expect(EMBEDDABLE_TABLES).toEqual(['sessions', 'spores', 'plans', 'artifacts']);
    });
  });
});

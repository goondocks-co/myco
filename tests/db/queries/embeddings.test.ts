/**
 * Tests for embedding flag management helpers.
 *
 * Vector storage and similarity search are handled by the external VectorStore.
 * This module only manages the `embedded` flag on relational tables.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { SporeInsert } from '@myco/db/queries/spores.js';
import {
  markEmbedded,
  clearEmbedded,
  getUnembedded,
  getEmbeddingQueueDepth,
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
function createAgent(id: string): string {
  const db = getDatabase();
  const now = epochNow();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, now);
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

describe('embedding flag helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // markEmbedded / clearEmbedded
  // ---------------------------------------------------------------------------

  describe('markEmbedded', () => {
    it('sets embedded flag to 1 on a session row', () => {
      const session = makeSession();
      upsertSession(session);

      markEmbedded('sessions', session.id);

      const db = getDatabase();
      const row = db.prepare(
        `SELECT embedded FROM sessions WHERE id = ?`,
      ).get(session.id) as { embedded: number };
      expect(row.embedded).toBe(1);
    });

    it('sets embedded flag to 1 on a spore row', () => {
      const agentId = createAgent('agent-emb');
      const spore = makeSpore(agentId);
      insertSpore(spore);

      markEmbedded('spores', spore.id);

      const db = getDatabase();
      const row = db.prepare(
        `SELECT embedded FROM spores WHERE id = ?`,
      ).get(spore.id) as { embedded: number };
      expect(row.embedded).toBe(1);
    });

    it('is idempotent — marking twice does not throw', () => {
      const session = makeSession();
      upsertSession(session);

      markEmbedded('sessions', session.id);
      expect(() => markEmbedded('sessions', session.id)).not.toThrow();

      const db = getDatabase();
      const row = db.prepare(
        `SELECT embedded FROM sessions WHERE id = ?`,
      ).get(session.id) as { embedded: number };
      expect(row.embedded).toBe(1);
    });

    it('rejects invalid table names', () => {
      expect(() => markEmbedded('users; DROP TABLE sessions;--', 'id')).toThrow();
    });
  });

  describe('clearEmbedded', () => {
    it('clears the embedded flag back to 0', () => {
      const session = makeSession();
      upsertSession(session);
      markEmbedded('sessions', session.id);

      clearEmbedded('sessions', session.id);

      const db = getDatabase();
      const row = db.prepare(
        `SELECT embedded FROM sessions WHERE id = ?`,
      ).get(session.id) as { embedded: number };
      expect(row.embedded).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getUnembedded
  // ---------------------------------------------------------------------------

  describe('getUnembedded', () => {
    it('returns rows without embeddings', () => {
      const now = epochNow();
      const summary = 'A non-empty session summary';
      const s1 = makeSession({ id: 'sess-no-emb', created_at: now, started_at: now, summary });
      const s2 = makeSession({ id: 'sess-has-emb', created_at: now + 1, started_at: now + 1, summary });
      upsertSession(s1);
      upsertSession(s2);
      markEmbedded('sessions', 'sess-has-emb');

      const rows = getUnembedded('sessions');

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('sess-no-emb');
    });

    it('respects the limit option', () => {
      const now = epochNow();
      const summary = 'A non-empty session summary';
      for (let i = 0; i < 5; i++) {
        upsertSession(makeSession({ id: `sess-unemb-${i}`, created_at: now + i, started_at: now + i, summary }));
      }

      const rows = getUnembedded('sessions', 2);
      expect(rows.length).toBe(2);
    });

    it('returns empty array when all rows are embedded', () => {
      const session = makeSession({ summary: 'A non-empty session summary' });
      upsertSession(session);
      markEmbedded('sessions', session.id);

      const rows = getUnembedded('sessions');
      expect(rows).toEqual([]);
    });

    it('returns empty array when table is empty', () => {
      const rows = getUnembedded('sessions');
      expect(rows).toEqual([]);
    });

    it('works with spores table', () => {
      const agentId = createAgent('agent-unemb');
      const spore = makeSpore(agentId, { id: 'spore-unemb' });
      insertSpore(spore);

      const rows = getUnembedded('spores');
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('spore-unemb');
    });

    it('excludes superseded spores from embedding queue', () => {
      const agentId = createAgent('agent-status');
      insertSpore(makeSpore(agentId, { id: 'spore-active', status: 'active' }));
      insertSpore(makeSpore(agentId, { id: 'spore-superseded', status: 'superseded' }));

      const rows = getUnembedded('spores');
      const ids = rows.map((r) => r.id);
      expect(ids).toContain('spore-active');
      expect(ids).not.toContain('spore-superseded');
    });

    it('rejects invalid table names', () => {
      expect(() => getUnembedded('evil_table')).toThrow();
    });

    it('orders results by created_at ASC (oldest first for processing queue)', () => {
      const now = epochNow();
      const summary = 'A session summary for ordering test';
      upsertSession(makeSession({ id: 'sess-old', created_at: now - 100, started_at: now - 100, summary }));
      upsertSession(makeSession({ id: 'sess-new', created_at: now, started_at: now, summary }));
      upsertSession(makeSession({ id: 'sess-mid', created_at: now - 50, started_at: now - 50, summary }));

      const rows = getUnembedded('sessions');

      expect(rows.length).toBe(3);
      expect(rows[0].id).toBe('sess-old');
      expect(rows[1].id).toBe('sess-mid');
      expect(rows[2].id).toBe('sess-new');
    });

    it('should not return sessions without summaries for embedding', () => {
      const now = epochNow();
      // Session with no summary — should be excluded from the queue
      upsertSession(makeSession({ id: 'sess-no-summary', created_at: now, started_at: now }));
      // Session with a summary but no embedding — should appear in the queue
      upsertSession(makeSession({
        id: 'sess-has-summary',
        created_at: now + 1,
        started_at: now + 1,
        summary: 'This session did something useful',
      }));

      const rows = getUnembedded('sessions');

      const ids = rows.map((r) => r.id);
      expect(ids).not.toContain('sess-no-summary');
      expect(ids).toContain('sess-has-summary');
    });
  });

  // ---------------------------------------------------------------------------
  // getEmbeddingQueueDepth
  // ---------------------------------------------------------------------------

  describe('getEmbeddingQueueDepth', () => {
    it('returns all zeros for empty database', () => {
      const result = getEmbeddingQueueDepth();
      expect(result.queue_depth).toBe(0);
      expect(result.embedded_count).toBe(0);
      expect(result.total).toBe(0);
    });

    it('counts unembedded rows across tables', () => {
      const now = epochNow();
      upsertSession(makeSession({ summary: 'Has summary', created_at: now, started_at: now }));
      const agentId = createAgent('agent-depth');
      insertSpore(makeSpore(agentId));

      const result = getEmbeddingQueueDepth();
      expect(result.queue_depth).toBe(2);
      expect(result.embedded_count).toBe(0);
      expect(result.total).toBe(2);
    });

    it('counts embedded rows correctly', () => {
      const session = makeSession({ summary: 'Has summary' });
      upsertSession(session);
      markEmbedded('sessions', session.id);

      const result = getEmbeddingQueueDepth();
      expect(result.embedded_count).toBe(1);
      expect(result.queue_depth).toBe(0);
    });

    it('excludes superseded spores from queue depth', () => {
      const agentId = createAgent('agent-qdepth');
      insertSpore(makeSpore(agentId, { id: 'spore-active-q', status: 'active' }));
      insertSpore(makeSpore(agentId, { id: 'spore-superseded-q', status: 'superseded' }));

      const result = getEmbeddingQueueDepth();
      // Only the active spore should count
      expect(result.queue_depth).toBe(1);
      expect(result.total).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // EMBEDDABLE_TABLES constant
  // ---------------------------------------------------------------------------

  describe('EMBEDDABLE_TABLES', () => {
    it('contains exactly the four tables with embedded flags', () => {
      expect(EMBEDDABLE_TABLES).toEqual(['sessions', 'spores', 'plans', 'artifacts']);
    });
  });
});

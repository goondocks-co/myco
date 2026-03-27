/**
 * Tests for spore CRUD query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import {
  insertSpore,
  getSpore,
  listSpores,
  countSpores,
  updateSporeStatus,
} from '@myco/db/queries/spores.js';
import type { SporeInsert } from '@myco/db/queries/spores.js';

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

describe('spore query helpers', () => {
  let agentId: string;
  let sessionId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    // Create an agent for FK references
    agentId = createAgent('agent-test');

    // Create a session for optional FK references
    const session = makeSession();
    upsertSession(session);
    sessionId = session.id;
  });

  // ---------------------------------------------------------------------------
  // insertSpore + getSpore
  // ---------------------------------------------------------------------------

  describe('insertSpore', () => {
    it('inserts a new spore and retrieves it', () => {
      const data = makeSpore(agentId, { content: 'Watch out for this' });
      const row = insertSpore(data);

      expect(row.id).toBe(data.id);
      expect(row.agent_id).toBe(agentId);
      expect(row.observation_type).toBe('gotcha');
      expect(row.content).toBe('Watch out for this');
      expect(row.status).toBe('active');
      expect(row.importance).toBe(5);

      const fetched = getSpore(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.content).toBe('Watch out for this');
    });

    it('stores all optional fields', () => {
      const data = makeSpore(agentId, {
        session_id: sessionId,
        prompt_batch_id: null,
        observation_type: 'decision',
        context: 'While reviewing PR #42',
        importance: 8,
        file_path: 'src/main.ts',
        tags: 'architecture,refactor',
        content_hash: 'hash-abc',
      });
      const row = insertSpore(data);

      expect(row.session_id).toBe(sessionId);
      expect(row.observation_type).toBe('decision');
      expect(row.context).toBe('While reviewing PR #42');
      expect(row.importance).toBe(8);
      expect(row.file_path).toBe('src/main.ts');
      expect(row.tags).toBe('architecture,refactor');
      expect(row.content_hash).toBe('hash-abc');
    });

    it('stores and retrieves properties as JSON string', () => {
      const props = JSON.stringify({ consolidated_from: ['spore-a', 'spore-b'] });
      const data = makeSpore(agentId, { properties: props });
      const row = insertSpore(data);

      expect(row.properties).toBe(props);

      const fetched = getSpore(data.id);
      expect(fetched!.properties).toBe(props);
      expect(JSON.parse(fetched!.properties!)).toEqual({ consolidated_from: ['spore-a', 'spore-b'] });
    });

    it('accepts any observation_type string', () => {
      const data = makeSpore(agentId, { observation_type: 'custom_weird_type' });
      const row = insertSpore(data);

      expect(row.observation_type).toBe('custom_weird_type');
    });
  });

  // ---------------------------------------------------------------------------
  // getSpore
  // ---------------------------------------------------------------------------

  describe('getSpore', () => {
    it('returns null for non-existent id', () => {
      const row = getSpore('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listSpores
  // ---------------------------------------------------------------------------

  describe('listSpores', () => {
    it('returns spores ordered by created_at DESC', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { id: 'spore-old', created_at: now - 100 }));
      insertSpore(makeSpore(agentId, { id: 'spore-mid', created_at: now - 50 }));
      insertSpore(makeSpore(agentId, { id: 'spore-new', created_at: now }));

      const rows = listSpores();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('spore-new');
      expect(rows[1].id).toBe('spore-mid');
      expect(rows[2].id).toBe('spore-old');
    });

    it('filters by agent_id', () => {
      const agentId2 = createAgent('agent-other');
      const now = epochNow();

      insertSpore(makeSpore(agentId, { id: 'spore-c1', created_at: now }));
      insertSpore(makeSpore(agentId2, { id: 'spore-c2', created_at: now + 1 }));

      const rows = listSpores({ agent_id: agentId });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('spore-c1');
    });

    it('filters by observation_type', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { id: 'spore-gotcha', observation_type: 'gotcha', created_at: now }));
      insertSpore(makeSpore(agentId, { id: 'spore-decision', observation_type: 'decision', created_at: now + 1 }));
      insertSpore(makeSpore(agentId, { id: 'spore-gotcha2', observation_type: 'gotcha', created_at: now + 2 }));

      const rows = listSpores({ observation_type: 'gotcha' });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('spore-gotcha2');
      expect(rows[1].id).toBe('spore-gotcha');
    });

    it('filters by status', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { id: 'spore-active', created_at: now }));
      insertSpore(makeSpore(agentId, { id: 'spore-superseded', created_at: now + 1 }));
      updateSporeStatus('spore-superseded', 'superseded', now + 2);

      const rows = listSpores({ status: 'active' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('spore-active');
    });

    it('combines multiple filters', () => {
      const agentId2 = createAgent('agent-combo');
      const now = epochNow();

      insertSpore(makeSpore(agentId, { id: 's1', observation_type: 'gotcha', created_at: now }));
      insertSpore(makeSpore(agentId, { id: 's2', observation_type: 'decision', created_at: now + 1 }));
      insertSpore(makeSpore(agentId2, { id: 's3', observation_type: 'gotcha', created_at: now + 2 }));

      const rows = listSpores({ agent_id: agentId, observation_type: 'gotcha' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('s1');
    });

    it('respects the limit option', () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        insertSpore(makeSpore(agentId, { created_at: now + i }));
      }

      const rows = listSpores({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no spores match', () => {
      const rows = listSpores({ observation_type: 'nonexistent' });
      expect(rows).toEqual([]);
    });

    it('filters by content substring (search)', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { id: 'spore-alpha', content: 'SQLite WAL mode rocks', created_at: now }));
      insertSpore(makeSpore(agentId, { id: 'spore-beta', content: 'Unrelated note here', created_at: now + 1 }));
      insertSpore(makeSpore(agentId, { id: 'spore-gamma', content: 'WAL is also fast', created_at: now + 2 }));

      const rows = listSpores({ search: 'WAL' });
      expect(rows).toHaveLength(2);
      const ids = rows.map(r => r.id);
      expect(ids).toContain('spore-alpha');
      expect(ids).toContain('spore-gamma');
    });

    it('filters by observation_type substring (search)', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { id: 'spore-ot1', observation_type: 'gotcha', created_at: now }));
      insertSpore(makeSpore(agentId, { id: 'spore-ot2', observation_type: 'discovery', created_at: now + 1 }));
      insertSpore(makeSpore(agentId, { id: 'spore-ot3', observation_type: 'gotcha', content: 'nothing special', created_at: now + 2 }));

      const rows = listSpores({ search: 'gotcha' });
      expect(rows).toHaveLength(2);
      const ids = rows.map(r => r.id);
      expect(ids).toContain('spore-ot1');
      expect(ids).toContain('spore-ot3');
    });

    it('combines search with type filter and respects pagination', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { id: 'sp1', observation_type: 'gotcha', content: 'needle here', created_at: now }));
      insertSpore(makeSpore(agentId, { id: 'sp2', observation_type: 'gotcha', content: 'needle also', created_at: now + 1 }));
      insertSpore(makeSpore(agentId, { id: 'sp3', observation_type: 'gotcha', content: 'needle third', created_at: now + 2 }));
      insertSpore(makeSpore(agentId, { id: 'sp4', observation_type: 'decision', content: 'needle but wrong type', created_at: now + 3 }));

      // Should find 3 gotcha+needle, then page them
      const page1 = listSpores({ search: 'needle', observation_type: 'gotcha', limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].id).toBe('sp3');
      expect(page1[1].id).toBe('sp2');

      const page2 = listSpores({ search: 'needle', observation_type: 'gotcha', limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
      expect(page2[0].id).toBe('sp1');
    });
  });

  // ---------------------------------------------------------------------------
  // countSpores
  // ---------------------------------------------------------------------------

  describe('countSpores', () => {
    it('counts all spores when no filters given', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { created_at: now }));
      insertSpore(makeSpore(agentId, { created_at: now + 1 }));

      expect(countSpores()).toBe(2);
    });

    it('counts spores matching a search filter', () => {
      const now = epochNow();
      insertSpore(makeSpore(agentId, { id: 'c1', content: 'alpha beta', created_at: now }));
      insertSpore(makeSpore(agentId, { id: 'c2', content: 'alpha gamma', created_at: now + 1 }));
      insertSpore(makeSpore(agentId, { id: 'c3', content: 'delta epsilon', created_at: now + 2 }));

      expect(countSpores({ search: 'alpha' })).toBe(2);
      expect(countSpores({ search: 'delta' })).toBe(1);
      expect(countSpores({ search: 'zeta' })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // updateSporeStatus
  // ---------------------------------------------------------------------------

  describe('updateSporeStatus', () => {
    it('updates status and updated_at', () => {
      const data = makeSpore(agentId);
      insertSpore(data);

      const updatedAt = epochNow() + 10;
      const row = updateSporeStatus(data.id, 'superseded', updatedAt);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('superseded');
      expect(row!.updated_at).toBe(updatedAt);
    });

    it('returns null for non-existent spore', () => {
      const result = updateSporeStatus('nope', 'superseded', epochNow());
      expect(result).toBeNull();
    });

    it('is idempotent — same status update produces same result', () => {
      const data = makeSpore(agentId);
      insertSpore(data);

      const updatedAt = epochNow() + 10;
      updateSporeStatus(data.id, 'consolidated', updatedAt);
      const row = updateSporeStatus(data.id, 'consolidated', updatedAt);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('consolidated');
      expect(row!.updated_at).toBe(updatedAt);
    });
  });
});

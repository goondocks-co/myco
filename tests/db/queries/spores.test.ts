/**
 * Tests for spore CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import {
  insertSpore,
  getSpore,
  listSpores,
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

/** Insert a curator directly into the curators table and return its id. */
async function createCurator(id: string): Promise<string> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO curators (id, name, created_at) VALUES ($1, $2, $3)`,
    [id, `curator-${id}`, now],
  );
  return id;
}

/** Factory for minimal valid spore data. */
function makeSpore(
  curatorId: string,
  overrides: Partial<SporeInsert> = {},
): SporeInsert {
  const now = epochNow();
  return {
    id: `spore-${Math.random().toString(36).slice(2, 8)}`,
    curator_id: curatorId,
    observation_type: 'gotcha',
    content: 'Some observation content',
    created_at: now,
    ...overrides,
  };
}

describe('spore query helpers', () => {
  let curatorId: string;
  let sessionId: string;

  beforeEach(async () => {
    const db = await initDatabase(); // in-memory
    await createSchema(db);

    // Create a curator for FK references
    curatorId = await createCurator('curator-test');

    // Create a session for optional FK references
    const session = makeSession();
    await upsertSession(session);
    sessionId = session.id;
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // insertSpore + getSpore
  // ---------------------------------------------------------------------------

  describe('insertSpore', () => {
    it('inserts a new spore and retrieves it', async () => {
      const data = makeSpore(curatorId, { content: 'Watch out for this' });
      const row = await insertSpore(data);

      expect(row.id).toBe(data.id);
      expect(row.curator_id).toBe(curatorId);
      expect(row.observation_type).toBe('gotcha');
      expect(row.content).toBe('Watch out for this');
      expect(row.status).toBe('active');
      expect(row.importance).toBe(5);

      const fetched = await getSpore(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.content).toBe('Watch out for this');
    });

    it('stores all optional fields', async () => {
      const data = makeSpore(curatorId, {
        session_id: sessionId,
        prompt_batch_id: null,
        observation_type: 'decision',
        context: 'While reviewing PR #42',
        importance: 8,
        file_path: 'src/main.ts',
        tags: 'architecture,refactor',
        content_hash: 'hash-abc',
      });
      const row = await insertSpore(data);

      expect(row.session_id).toBe(sessionId);
      expect(row.observation_type).toBe('decision');
      expect(row.context).toBe('While reviewing PR #42');
      expect(row.importance).toBe(8);
      expect(row.file_path).toBe('src/main.ts');
      expect(row.tags).toBe('architecture,refactor');
      expect(row.content_hash).toBe('hash-abc');
    });

    it('accepts any observation_type string', async () => {
      const data = makeSpore(curatorId, { observation_type: 'custom_weird_type' });
      const row = await insertSpore(data);

      expect(row.observation_type).toBe('custom_weird_type');
    });
  });

  // ---------------------------------------------------------------------------
  // getSpore
  // ---------------------------------------------------------------------------

  describe('getSpore', () => {
    it('returns null for non-existent id', async () => {
      const row = await getSpore('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listSpores
  // ---------------------------------------------------------------------------

  describe('listSpores', () => {
    it('returns spores ordered by created_at DESC', async () => {
      const now = epochNow();
      await insertSpore(makeSpore(curatorId, { id: 'spore-old', created_at: now - 100 }));
      await insertSpore(makeSpore(curatorId, { id: 'spore-mid', created_at: now - 50 }));
      await insertSpore(makeSpore(curatorId, { id: 'spore-new', created_at: now }));

      const rows = await listSpores();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('spore-new');
      expect(rows[1].id).toBe('spore-mid');
      expect(rows[2].id).toBe('spore-old');
    });

    it('filters by curator_id', async () => {
      const curatorId2 = await createCurator('curator-other');
      const now = epochNow();

      await insertSpore(makeSpore(curatorId, { id: 'spore-c1', created_at: now }));
      await insertSpore(makeSpore(curatorId2, { id: 'spore-c2', created_at: now + 1 }));

      const rows = await listSpores({ curator_id: curatorId });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('spore-c1');
    });

    it('filters by observation_type', async () => {
      const now = epochNow();
      await insertSpore(makeSpore(curatorId, { id: 'spore-gotcha', observation_type: 'gotcha', created_at: now }));
      await insertSpore(makeSpore(curatorId, { id: 'spore-decision', observation_type: 'decision', created_at: now + 1 }));
      await insertSpore(makeSpore(curatorId, { id: 'spore-gotcha2', observation_type: 'gotcha', created_at: now + 2 }));

      const rows = await listSpores({ observation_type: 'gotcha' });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('spore-gotcha2');
      expect(rows[1].id).toBe('spore-gotcha');
    });

    it('filters by status', async () => {
      const now = epochNow();
      await insertSpore(makeSpore(curatorId, { id: 'spore-active', created_at: now }));
      await insertSpore(makeSpore(curatorId, { id: 'spore-superseded', created_at: now + 1 }));
      await updateSporeStatus('spore-superseded', 'superseded', now + 2);

      const rows = await listSpores({ status: 'active' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('spore-active');
    });

    it('combines multiple filters', async () => {
      const curatorId2 = await createCurator('curator-combo');
      const now = epochNow();

      await insertSpore(makeSpore(curatorId, { id: 's1', observation_type: 'gotcha', created_at: now }));
      await insertSpore(makeSpore(curatorId, { id: 's2', observation_type: 'decision', created_at: now + 1 }));
      await insertSpore(makeSpore(curatorId2, { id: 's3', observation_type: 'gotcha', created_at: now + 2 }));

      const rows = await listSpores({ curator_id: curatorId, observation_type: 'gotcha' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('s1');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        await insertSpore(makeSpore(curatorId, { created_at: now + i }));
      }

      const rows = await listSpores({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no spores match', async () => {
      const rows = await listSpores({ observation_type: 'nonexistent' });
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateSporeStatus
  // ---------------------------------------------------------------------------

  describe('updateSporeStatus', () => {
    it('updates status and updated_at', async () => {
      const data = makeSpore(curatorId);
      await insertSpore(data);

      const updatedAt = epochNow() + 10;
      const row = await updateSporeStatus(data.id, 'superseded', updatedAt);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('superseded');
      expect(row!.updated_at).toBe(updatedAt);
    });

    it('returns null for non-existent spore', async () => {
      const result = await updateSporeStatus('nope', 'superseded', epochNow());
      expect(result).toBeNull();
    });

    it('is idempotent — same status update produces same result', async () => {
      const data = makeSpore(curatorId);
      await insertSpore(data);

      const updatedAt = epochNow() + 10;
      await updateSporeStatus(data.id, 'consolidated', updatedAt);
      const row = await updateSporeStatus(data.id, 'consolidated', updatedAt);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('consolidated');
      expect(row!.updated_at).toBe(updatedAt);
    });
  });
});

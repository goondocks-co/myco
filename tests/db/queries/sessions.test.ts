/**
 * Tests for session CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  upsertSession,
  getSession,
  listSessions,
  updateSession,
  closeSession,
} from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';

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

describe('session query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // upsertSession + getSession
  // ---------------------------------------------------------------------------

  describe('upsertSession', () => {
    it('inserts a new session and retrieves it', async () => {
      const data = makeSession({ title: 'First session' });
      upsertSession(data);

      const row = getSession(data.id);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(data.id);
      expect(row!.agent).toBe('claude-code');
      expect(row!.title).toBe('First session');
      expect(row!.status).toBe('active');
      expect(row!.prompt_count).toBe(0);
      expect(row!.tool_count).toBe(0);
    });

    it('is idempotent — second upsert updates without error', async () => {
      const data = makeSession({ title: 'Original' });
      upsertSession(data);
      upsertSession({ ...data, title: 'Updated' });

      const row = getSession(data.id);
      expect(row).not.toBeNull();
      expect(row!.title).toBe('Updated');
    });

    it('preserves fields not included in the update', async () => {
      const now = epochNow();
      const data = makeSession({
        title: 'Keep me',
        summary: 'A detailed summary',
        started_at: now,
      });
      upsertSession(data);

      // Upsert with only agent changed — title and summary should persist
      upsertSession({ ...data, agent: 'cursor' });

      const row = getSession(data.id);
      expect(row!.agent).toBe('cursor');
      expect(row!.title).toBe('Keep me');
      expect(row!.summary).toBe('A detailed summary');
    });
  });

  // ---------------------------------------------------------------------------
  // getSession
  // ---------------------------------------------------------------------------

  describe('getSession', () => {
    it('returns null for non-existent id', async () => {
      const row = getSession('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // updateSession
  // ---------------------------------------------------------------------------

  describe('updateSession', () => {
    it('updates specific fields', async () => {
      const data = makeSession();
      upsertSession(data);

      updateSession(data.id, {
        title: 'New title',
        prompt_count: 5,
        tool_count: 12,
      });

      const row = getSession(data.id);
      expect(row!.title).toBe('New title');
      expect(row!.prompt_count).toBe(5);
      expect(row!.tool_count).toBe(12);
    });

    it('returns null when updating non-existent session', async () => {
      const result = updateSession('nope', { title: 'x' });
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // closeSession
  // ---------------------------------------------------------------------------

  describe('closeSession', () => {
    it('sets status to completed and records ended_at', async () => {
      const data = makeSession();
      upsertSession(data);

      const endTime = epochNow();
      const row = closeSession(data.id, endTime);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('completed');
      expect(row!.ended_at).toBe(endTime);
    });

    it('returns null for non-existent session', async () => {
      const result = closeSession('nope', epochNow());
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listSessions
  // ---------------------------------------------------------------------------

  describe('listSessions', () => {
    it('returns sessions ordered by created_at DESC', async () => {
      const now = epochNow();
      const s1 = makeSession({ id: 'sess-old', created_at: now - 100, started_at: now - 100 });
      const s2 = makeSession({ id: 'sess-mid', created_at: now - 50, started_at: now - 50 });
      const s3 = makeSession({ id: 'sess-new', created_at: now, started_at: now });

      // Insert out of order to verify ordering
      upsertSession(s2);
      upsertSession(s1);
      upsertSession(s3);

      const rows = listSessions();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('sess-new');
      expect(rows[1].id).toBe('sess-mid');
      expect(rows[2].id).toBe('sess-old');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        upsertSession(makeSession({ created_at: now + i, started_at: now + i }));
      }

      const rows = listSessions({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('filters by status', async () => {
      const now = epochNow();
      const active = makeSession({ id: 'sess-active', created_at: now, started_at: now });
      const done = makeSession({ id: 'sess-done', created_at: now + 1, started_at: now + 1 });

      upsertSession(active);
      upsertSession(done);
      closeSession(done.id, now + 2);

      const rows = listSessions({ status: 'completed' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-done');
    });

    it('filters by agent', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'sess-cc', agent: 'claude-code', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'sess-cu', agent: 'cursor', created_at: now + 1, started_at: now + 1 }));

      const rows = listSessions({ agent: 'cursor' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-cu');
    });

    it('returns empty array when no sessions match', async () => {
      const rows = listSessions({ status: 'completed' });
      expect(rows).toEqual([]);
    });

    it('combines multiple filters', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 's1', agent: 'claude-code', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 's2', agent: 'cursor', created_at: now + 1, started_at: now + 1 }));
      upsertSession(makeSession({ id: 's3', agent: 'cursor', created_at: now + 2, started_at: now + 2 }));
      closeSession('s3', now + 3);

      const rows = listSessions({ agent: 'cursor', status: 'completed' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('s3');
    });
  });
});

/**
 * Tests for activity query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { BatchInsert } from '@myco/db/queries/batches.js';
import {
  insertActivity,
  listActivities,
  countActivities,
} from '@myco/db/queries/activities.js';
import type { ActivityInsert } from '@myco/db/queries/activities.js';

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

/** Factory for minimal valid batch data. */
function makeBatch(sessionId: string, overrides: Partial<BatchInsert> = {}): BatchInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid activity data. */
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

describe('activity query helpers', () => {
  let sessionId: string;

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await cleanTestDb();

    const session = makeSession();
    await upsertSession(session);
    sessionId = session.id;
  });

  // ---------------------------------------------------------------------------
  // insertActivity
  // ---------------------------------------------------------------------------

  describe('insertActivity', () => {
    it('inserts a new activity and returns it with a generated id', async () => {
      const data = makeActivity(sessionId, { tool_name: 'Bash' });
      const row = await insertActivity(data);

      expect(row.id).toBeGreaterThan(0);
      expect(row.session_id).toBe(sessionId);
      expect(row.tool_name).toBe('Bash');
      expect(row.success).toBe(1);
      expect(row.processed).toBe(0);
    });

    it('stores all optional fields', async () => {
      const data = makeActivity(sessionId, {
        tool_name: 'Edit',
        tool_input: '{"file": "src/main.ts"}',
        tool_output_summary: 'File edited successfully',
        file_path: 'src/main.ts',
        files_affected: 'src/main.ts,src/util.ts',
        duration_ms: 150,
        success: 0,
        error_message: 'Permission denied',
        content_hash: 'abc123',
      });
      const row = await insertActivity(data);

      expect(row.tool_input).toBe('{"file": "src/main.ts"}');
      expect(row.tool_output_summary).toBe('File edited successfully');
      expect(row.file_path).toBe('src/main.ts');
      expect(row.files_affected).toBe('src/main.ts,src/util.ts');
      expect(row.duration_ms).toBe(150);
      expect(row.success).toBe(0);
      expect(row.error_message).toBe('Permission denied');
      expect(row.content_hash).toBe('abc123');
    });

    it('links to a prompt batch via prompt_batch_id', async () => {
      const batch = await insertBatch(makeBatch(sessionId));
      const data = makeActivity(sessionId, { prompt_batch_id: batch.id });
      const row = await insertActivity(data);

      expect(row.prompt_batch_id).toBe(batch.id);
    });
  });

  // ---------------------------------------------------------------------------
  // listActivities
  // ---------------------------------------------------------------------------

  describe('listActivities', () => {
    it('lists activities by session_id ordered by timestamp ASC', async () => {
      const now = epochNow();
      await insertActivity(makeActivity(sessionId, { tool_name: 'Read', timestamp: now }));
      await insertActivity(makeActivity(sessionId, { tool_name: 'Edit', timestamp: now + 1 }));
      await insertActivity(makeActivity(sessionId, { tool_name: 'Bash', timestamp: now + 2 }));

      const rows = await listActivities({ session_id: sessionId });
      expect(rows).toHaveLength(3);
      expect(rows[0].tool_name).toBe('Read');
      expect(rows[1].tool_name).toBe('Edit');
      expect(rows[2].tool_name).toBe('Bash');
    });

    it('filters by prompt_batch_id', async () => {
      const batch1 = await insertBatch(makeBatch(sessionId));
      const batch2 = await insertBatch(makeBatch(sessionId));

      const now = epochNow();
      await insertActivity(makeActivity(sessionId, { prompt_batch_id: batch1.id, tool_name: 'Read', timestamp: now }));
      await insertActivity(makeActivity(sessionId, { prompt_batch_id: batch2.id, tool_name: 'Edit', timestamp: now + 1 }));
      await insertActivity(makeActivity(sessionId, { prompt_batch_id: batch1.id, tool_name: 'Bash', timestamp: now + 2 }));

      const rows = await listActivities({ prompt_batch_id: batch1.id });
      expect(rows).toHaveLength(2);
      expect(rows[0].tool_name).toBe('Read');
      expect(rows[1].tool_name).toBe('Bash');
    });

    it('combines session_id and prompt_batch_id filters', async () => {
      const session2 = makeSession();
      await upsertSession(session2);

      const batch = await insertBatch(makeBatch(sessionId));

      const now = epochNow();
      await insertActivity(makeActivity(sessionId, { prompt_batch_id: batch.id, tool_name: 'Read', timestamp: now }));
      await insertActivity(makeActivity(sessionId, { tool_name: 'Edit', timestamp: now + 1 }));

      const rows = await listActivities({ session_id: sessionId, prompt_batch_id: batch.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('Read');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        await insertActivity(makeActivity(sessionId, { timestamp: now + i }));
      }

      const rows = await listActivities({ session_id: sessionId, limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no activities match', async () => {
      const rows = await listActivities({ session_id: 'nonexistent' });
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // countActivities
  // ---------------------------------------------------------------------------

  describe('countActivities', () => {
    it('returns 0 when no activities exist for a session', async () => {
      const count = await countActivities(sessionId);
      expect(count).toBe(0);
    });

    it('counts activities for a specific session', async () => {
      const now = epochNow();
      await insertActivity(makeActivity(sessionId, { timestamp: now }));
      await insertActivity(makeActivity(sessionId, { timestamp: now + 1 }));
      await insertActivity(makeActivity(sessionId, { timestamp: now + 2 }));

      const count = await countActivities(sessionId);
      expect(count).toBe(3);
    });

    it('does not count activities from other sessions', async () => {
      const session2 = makeSession();
      await upsertSession(session2);

      const now = epochNow();
      await insertActivity(makeActivity(sessionId, { timestamp: now }));
      await insertActivity(makeActivity(session2.id, { timestamp: now + 1 }));

      const count = await countActivities(sessionId);
      expect(count).toBe(1);
    });
  });
});

/**
 * Tests for prompt batch query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import {
  insertBatch,
  closeBatch,
  getUnprocessedBatches,
  incrementActivityCount,
  markBatchProcessed,
} from '@myco/db/queries/batches.js';
import type { BatchInsert } from '@myco/db/queries/batches.js';

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

/** Factory for minimal valid batch data (requires a session_id). */
function makeBatch(sessionId: string, overrides: Partial<BatchInsert> = {}): BatchInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

describe('prompt batch query helpers', () => {
  let sessionId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    // Create a parent session for FK references
    const session = makeSession();
    upsertSession(session);
    sessionId = session.id;
  });

  // ---------------------------------------------------------------------------
  // insertBatch
  // ---------------------------------------------------------------------------

  describe('insertBatch', () => {
    it('inserts a new batch and returns it with a generated id', () => {
      const data = makeBatch(sessionId, { user_prompt: 'Hello world' });
      const row = insertBatch(data);

      expect(row.id).toBeGreaterThan(0);
      expect(row.session_id).toBe(sessionId);
      expect(row.user_prompt).toBe('Hello world');
      expect(row.status).toBe('active');
      expect(row.activity_count).toBe(0);
      expect(row.processed).toBe(0);
    });

    it('assigns sequential ids', () => {
      const b1 = insertBatch(makeBatch(sessionId));
      const b2 = insertBatch(makeBatch(sessionId));

      expect(b2.id).toBeGreaterThan(b1.id);
    });

    it('stores optional fields', () => {
      const data = makeBatch(sessionId, {
        prompt_number: 3,
        user_prompt: 'What is Myco?',
        response_summary: 'Myco is a knowledge capture system.',
        classification: 'question',
      });
      const row = insertBatch(data);

      expect(row.prompt_number).toBe(3);
      expect(row.user_prompt).toBe('What is Myco?');
      expect(row.response_summary).toBe('Myco is a knowledge capture system.');
      expect(row.classification).toBe('question');
    });
  });

  // ---------------------------------------------------------------------------
  // closeBatch
  // ---------------------------------------------------------------------------

  describe('closeBatch', () => {
    it('sets status to completed and records ended_at', () => {
      const batch = insertBatch(makeBatch(sessionId));
      const endTime = epochNow();
      const row = closeBatch(batch.id, endTime);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('completed');
      expect(row!.ended_at).toBe(endTime);
    });

    it('returns null for non-existent batch', () => {
      const result = closeBatch(999999, epochNow());
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // incrementActivityCount
  // ---------------------------------------------------------------------------

  describe('incrementActivityCount', () => {
    it('increments activity_count by 1', () => {
      const batch = insertBatch(makeBatch(sessionId));
      expect(batch.activity_count).toBe(0);

      const updated = incrementActivityCount(batch.id);
      expect(updated).not.toBeNull();
      expect(updated!.activity_count).toBe(1);

      const again = incrementActivityCount(batch.id);
      expect(again!.activity_count).toBe(2);
    });

    it('returns null for non-existent batch', () => {
      const result = incrementActivityCount(999999);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // markBatchProcessed
  // ---------------------------------------------------------------------------

  describe('markBatchProcessed', () => {
    it('sets processed flag to 1', () => {
      const batch = insertBatch(makeBatch(sessionId));
      expect(batch.processed).toBe(0);

      const row = markBatchProcessed(batch.id);
      expect(row).not.toBeNull();
      expect(row!.processed).toBe(1);
    });

    it('returns null for non-existent batch', () => {
      const result = markBatchProcessed(999999);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getUnprocessedBatches
  // ---------------------------------------------------------------------------

  describe('getUnprocessedBatches', () => {
    it('returns only unprocessed batches ordered by id ASC', () => {
      const b1 = insertBatch(makeBatch(sessionId, { user_prompt: 'first' }));
      const b2 = insertBatch(makeBatch(sessionId, { user_prompt: 'second' }));
      insertBatch(makeBatch(sessionId, { user_prompt: 'third' }));

      // Mark b2 as processed
      markBatchProcessed(b2.id);

      const rows = getUnprocessedBatches();
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(b1.id);
      expect(rows[0].user_prompt).toBe('first');
      expect(rows[1].user_prompt).toBe('third');
    });

    it('respects the limit option', () => {
      for (let i = 0; i < 5; i++) {
        insertBatch(makeBatch(sessionId));
      }

      const rows = getUnprocessedBatches({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('supports cursor-based pagination via after_id', () => {
      const b1 = insertBatch(makeBatch(sessionId, { user_prompt: 'a' }));
      const b2 = insertBatch(makeBatch(sessionId, { user_prompt: 'b' }));
      const b3 = insertBatch(makeBatch(sessionId, { user_prompt: 'c' }));

      const rows = getUnprocessedBatches({ after_id: b1.id });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(b2.id);
      expect(rows[1].id).toBe(b3.id);
    });

    it('combines cursor and limit', () => {
      const b1 = insertBatch(makeBatch(sessionId));
      insertBatch(makeBatch(sessionId));
      insertBatch(makeBatch(sessionId));

      const rows = getUnprocessedBatches({ after_id: b1.id, limit: 1 });
      expect(rows).toHaveLength(1);
    });

    it('returns empty array when all batches are processed', () => {
      const batch = insertBatch(makeBatch(sessionId));
      markBatchProcessed(batch.id);

      const rows = getUnprocessedBatches();
      expect(rows).toEqual([]);
    });

    it('returns empty array when no batches exist', () => {
      const rows = getUnprocessedBatches();
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle: insert → increment → close → mark processed
  // ---------------------------------------------------------------------------

  describe('batch lifecycle', () => {
    it('progresses through full lifecycle', () => {
      // Insert
      const batch = insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        user_prompt: 'Implement feature X',
      }));
      expect(batch.status).toBe('active');
      expect(batch.activity_count).toBe(0);
      expect(batch.processed).toBe(0);

      // Increment activity count as tools are used
      incrementActivityCount(batch.id);
      incrementActivityCount(batch.id);
      incrementActivityCount(batch.id);

      // Close the batch
      const endTime = epochNow();
      const closed = closeBatch(batch.id, endTime);
      expect(closed!.status).toBe('completed');
      expect(closed!.ended_at).toBe(endTime);
      expect(closed!.activity_count).toBe(3);

      // Still shows as unprocessed
      const unprocessed = getUnprocessedBatches();
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0].id).toBe(batch.id);

      // Mark as processed
      const processed = markBatchProcessed(batch.id);
      expect(processed!.processed).toBe(1);

      // No longer in unprocessed list
      const empty = getUnprocessedBatches();
      expect(empty).toEqual([]);
    });
  });
});

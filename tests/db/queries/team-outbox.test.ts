/**
 * Tests for team outbox query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  enqueueOutbox,
  listPending,
  markSent,
  markForRetry,
  pruneOld,
  countPending,
  incrementRetryCount,
  countDeadLettered,
  MAX_OUTBOX_RETRIES,
} from '@myco/db/queries/team-outbox.js';
import type { OutboxInsert } from '@myco/db/queries/team-outbox.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid outbox data. */
function makeOutbox(overrides: Partial<OutboxInsert> = {}): OutboxInsert {
  const now = epochNow();
  return {
    table_name: 'spores',
    row_id: `spore-${Math.random().toString(36).slice(2, 8)}`,
    payload: JSON.stringify({ id: 'spore-1', content: 'test' }),
    machine_id: 'test_abc123',
    created_at: now,
    ...overrides,
  };
}

describe('team outbox query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // enqueueOutbox
  // ---------------------------------------------------------------------------

  describe('enqueueOutbox', () => {
    it('inserts a pending record with sent_at NULL', () => {
      const row = enqueueOutbox(makeOutbox());

      expect(row.id).toBeGreaterThan(0);
      expect(row.table_name).toBe('spores');
      expect(row.operation).toBe('upsert');
      expect(row.sent_at).toBeNull();
      expect(row.machine_id).toBe('test_abc123');
    });

    it('defaults operation to upsert', () => {
      const row = enqueueOutbox(makeOutbox());
      expect(row.operation).toBe('upsert');
    });

    it('respects custom operation', () => {
      const row = enqueueOutbox(makeOutbox({ operation: 'delete' }));
      expect(row.operation).toBe('delete');
    });

    it('stores payload as JSON string', () => {
      const payload = JSON.stringify({ id: 'test', content: 'hello' });
      const row = enqueueOutbox(makeOutbox({ payload }));
      expect(row.payload).toBe(payload);
    });

    it('auto-increments id', () => {
      const row1 = enqueueOutbox(makeOutbox());
      const row2 = enqueueOutbox(makeOutbox());
      expect(row2.id).toBeGreaterThan(row1.id);
    });

    it('rejects local-only table names (#58)', () => {
      expect(() =>
        enqueueOutbox(makeOutbox({ table_name: 'cortex_instructions' })),
      ).toThrow(/local-only and must not be synced/);
    });
  });

  // ---------------------------------------------------------------------------
  // listPending
  // ---------------------------------------------------------------------------

  describe('listPending', () => {
    it('returns empty array when no pending records', () => {
      const rows = listPending();
      expect(rows).toEqual([]);
    });

    it('returns records oldest-first', () => {
      const now = epochNow();
      enqueueOutbox(makeOutbox({ created_at: now + 2, row_id: 'c' }));
      enqueueOutbox(makeOutbox({ created_at: now, row_id: 'a' }));
      enqueueOutbox(makeOutbox({ created_at: now + 1, row_id: 'b' }));

      const rows = listPending();

      expect(rows[0].row_id).toBe('a');
      expect(rows[1].row_id).toBe('b');
      expect(rows[2].row_id).toBe('c');
    });

    it('excludes sent records', () => {
      const row = enqueueOutbox(makeOutbox());
      markSent([row.id], epochNow());

      const pending = listPending();
      expect(pending).toHaveLength(0);
    });

    it('respects explicit limit', () => {
      for (let i = 0; i < 5; i++) {
        enqueueOutbox(makeOutbox({ created_at: epochNow() + i }));
      }

      const rows = listPending(3);
      expect(rows).toHaveLength(3);
    });

    it('uses default batch size when backlog is small', () => {
      // Insert fewer than burst threshold
      for (let i = 0; i < 10; i++) {
        enqueueOutbox(makeOutbox({ created_at: epochNow() + i }));
      }

      // Should return all 10 (below DEFAULT_BATCH_SIZE of 50)
      const rows = listPending();
      expect(rows).toHaveLength(10);
    });
  });

  // ---------------------------------------------------------------------------
  // markSent
  // ---------------------------------------------------------------------------

  describe('markSent', () => {
    it('sets sent_at on specified records', () => {
      const row1 = enqueueOutbox(makeOutbox());
      const row2 = enqueueOutbox(makeOutbox());
      const sentAt = epochNow();

      markSent([row1.id, row2.id], sentAt);

      const pending = listPending();
      expect(pending).toHaveLength(0);
    });

    it('does nothing for empty ids array', () => {
      enqueueOutbox(makeOutbox());
      markSent([], epochNow());

      const pending = listPending();
      expect(pending).toHaveLength(1);
    });

    it('only marks specified records', () => {
      const row1 = enqueueOutbox(makeOutbox());
      const row2 = enqueueOutbox(makeOutbox());

      markSent([row1.id], epochNow());

      const pending = listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(row2.id);
    });
  });

  // ---------------------------------------------------------------------------
  // markForRetry
  // ---------------------------------------------------------------------------

  describe('markForRetry', () => {
    it('resets sent_at to NULL for re-processing', () => {
      const row = enqueueOutbox(makeOutbox());
      markSent([row.id], epochNow());

      // Verify it's marked as sent
      expect(listPending()).toHaveLength(0);

      // Mark for retry
      markForRetry([row.id]);

      // Now it should be pending again
      const pending = listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(row.id);
    });

    it('does nothing for empty ids array', () => {
      const row = enqueueOutbox(makeOutbox());
      markSent([row.id], epochNow());
      markForRetry([]);

      expect(listPending()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // pruneOld
  // ---------------------------------------------------------------------------

  describe('pruneOld', () => {
    it('removes sent records older than 24 hours', () => {
      const oldTime = epochNow() - 90_000; // 25 hours ago
      const row = enqueueOutbox(makeOutbox({ created_at: oldTime }));
      markSent([row.id], oldTime);

      const deleted = pruneOld();
      expect(deleted).toBe(1);
    });

    it('does not remove recently sent records', () => {
      const row = enqueueOutbox(makeOutbox());
      markSent([row.id], epochNow());

      const deleted = pruneOld();
      expect(deleted).toBe(0);
    });

    it('does not remove pending records', () => {
      enqueueOutbox(makeOutbox({ created_at: epochNow() - 90_000 }));

      const deleted = pruneOld();
      expect(deleted).toBe(0);
    });

    it('returns count of deleted records', () => {
      const oldTime = epochNow() - 90_000;
      const row1 = enqueueOutbox(makeOutbox({ created_at: oldTime }));
      const row2 = enqueueOutbox(makeOutbox({ created_at: oldTime }));
      markSent([row1.id, row2.id], oldTime);

      const deleted = pruneOld();
      expect(deleted).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // countPending
  // ---------------------------------------------------------------------------

  describe('countPending', () => {
    it('returns 0 when no records', () => {
      expect(countPending()).toBe(0);
    });

    it('counts only pending records', () => {
      const row1 = enqueueOutbox(makeOutbox());
      enqueueOutbox(makeOutbox());
      markSent([row1.id], epochNow());

      expect(countPending()).toBe(1);
    });

    it('increments as records are enqueued', () => {
      enqueueOutbox(makeOutbox());
      expect(countPending()).toBe(1);

      enqueueOutbox(makeOutbox());
      expect(countPending()).toBe(2);
    });

    it('excludes dead-lettered records', () => {
      const row = enqueueOutbox(makeOutbox());
      // Push retry count to max
      for (let i = 0; i < MAX_OUTBOX_RETRIES; i++) {
        incrementRetryCount([row.id], epochNow());
      }

      expect(countPending()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // incrementRetryCount
  // ---------------------------------------------------------------------------

  describe('incrementRetryCount', () => {
    it('increments retry_count and sets last_attempt_at', () => {
      const row = enqueueOutbox(makeOutbox());
      const now = epochNow();

      incrementRetryCount([row.id], now);

      const pending = listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].retry_count).toBe(1);
      expect(pending[0].last_attempt_at).toBe(now);
    });

    it('returns empty when no records reach max retries', () => {
      const row = enqueueOutbox(makeOutbox());
      const deadLettered = incrementRetryCount([row.id], epochNow());

      expect(deadLettered).toEqual([]);
    });

    it('returns ids of newly dead-lettered records', () => {
      const row = enqueueOutbox(makeOutbox());
      // Increment to one below max
      for (let i = 0; i < MAX_OUTBOX_RETRIES - 1; i++) {
        incrementRetryCount([row.id], epochNow());
      }

      // This push should dead-letter it
      const deadLettered = incrementRetryCount([row.id], epochNow());
      expect(deadLettered).toEqual([row.id]);
    });

    it('does nothing for empty ids array', () => {
      enqueueOutbox(makeOutbox());
      const deadLettered = incrementRetryCount([], epochNow());

      expect(deadLettered).toEqual([]);
      expect(listPending()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // dead-lettering (listPending / countDeadLettered)
  // ---------------------------------------------------------------------------

  describe('dead-lettering', () => {
    it('listPending excludes records at max retries', () => {
      const row = enqueueOutbox(makeOutbox());
      for (let i = 0; i < MAX_OUTBOX_RETRIES; i++) {
        incrementRetryCount([row.id], epochNow());
      }

      expect(listPending()).toHaveLength(0);
    });

    it('countDeadLettered counts records at max retries', () => {
      expect(countDeadLettered()).toBe(0);

      const row = enqueueOutbox(makeOutbox());
      for (let i = 0; i < MAX_OUTBOX_RETRIES; i++) {
        incrementRetryCount([row.id], epochNow());
      }

      expect(countDeadLettered()).toBe(1);
    });

    it('dead-lettered records are not returned by listPending but counted by countDeadLettered', () => {
      const good = enqueueOutbox(makeOutbox());
      const bad = enqueueOutbox(makeOutbox());

      for (let i = 0; i < MAX_OUTBOX_RETRIES; i++) {
        incrementRetryCount([bad.id], epochNow());
      }

      expect(listPending()).toHaveLength(1);
      expect(listPending()[0].id).toBe(good.id);
      expect(countPending()).toBe(1);
      expect(countDeadLettered()).toBe(1);
    });
  });
});

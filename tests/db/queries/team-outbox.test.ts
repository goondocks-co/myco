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
  pruneOld,
  countPending,
  discardRows,
  sanitizeSyncPayload,
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

  describe('sanitizeSyncPayload', () => {
    it('strips local-only session columns before team sync', () => {
      expect(sanitizeSyncPayload('sessions', {
        id: 'session-1',
        summary: 'shared',
        embedded: 1,
        canopy_injections_offered: 3,
        canopy_injection_total_tokens: 120,
        canopy_skips_after_injection: 2,
        canopy_reads_after_injection: 1,
        canopy_tokens_saved: 500,
        canopy_redundant_reads: 4,
        canopy_map_tool_calls: 7,
      })).toEqual({
        id: 'session-1',
        summary: 'shared',
      });
    });

    it('leaves shared columns for other tables intact', () => {
      expect(sanitizeSyncPayload('spores', {
        id: 'spore-1',
        content: 'shared',
        canopy_tokens_saved: 500,
      })).toEqual({
        id: 'spore-1',
        content: 'shared',
        canopy_tokens_saved: 500,
      });
    });
  });

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
  // discardRows
  // ---------------------------------------------------------------------------

  describe('discardRows', () => {
    it('deletes the matching rows outright (used for worker-rejected payloads)', () => {
      const a = enqueueOutbox(makeOutbox());
      const b = enqueueOutbox(makeOutbox());

      discardRows([a.id]);

      const pending = listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(b.id);
    });

    it('is a no-op for empty ids', () => {
      enqueueOutbox(makeOutbox());
      discardRows([]);
      expect(listPending()).toHaveLength(1);
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
  });
});

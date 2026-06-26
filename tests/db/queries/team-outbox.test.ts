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
  markSourceRowsSynced,
  pruneOld,
  countPending,
  countPendingForProjects,
  dropPendingForProjects,
  discardRows,
  backfillAll,
  backfillAllForRebuild,
  backfillUnsynced,
  sanitizeSyncPayload,
  countTeamSyncRows,
} from '@myco/db/queries/team-outbox.js';
import { getDatabase } from '@myco/db/client.js';
import { setProjectSyncMembership } from '@myco/db/queries/team-sync-state.js';
import type { OutboxInsert, OutboxRow } from '@myco/db/queries/team-outbox.js';

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

    it('strips release evidence from synced derived release state', () => {
      expect(sanitizeSyncPayload('knowledge_release_state', {
        id: 1,
        namespace: 'sessions',
        record_id: 'session-1',
        state: 'released',
        confidence: 'high',
        evidence_json: '{"checked_refs":["refs/heads/main"]}',
      })).toEqual({
        id: 1,
        namespace: 'sessions',
        record_id: 'session-1',
        state: 'released',
        confidence: 'high',
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

    it('resolves team_id from project membership when omitted', () => {
      setProjectSyncMembership([{ project_id: 'proj-a', team_id: 'team-a' }]);

      const row = enqueueOutbox(makeOutbox({ project_id: 'proj-a' }));

      expect(row.team_id).toBe('team-a');
    });

    it('parses payload back to its structured shape on read', () => {
      const data = { id: 'test', content: 'hello' };
      const row = enqueueOutbox(makeOutbox({ payload: JSON.stringify(data) }));
      expect(row.payload).toEqual(data);
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

    it('rejects raw release provenance table names', () => {
      expect(() =>
        enqueueOutbox(makeOutbox({ table_name: 'knowledge_git_provenance' })),
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

    it('defaults to the Cloudflare Queues sendBatch limit', () => {
      for (let i = 0; i < 105; i++) {
        enqueueOutbox(makeOutbox({ created_at: epochNow() + i, row_id: `row-${i}` }));
      }

      const rows = listPending();

      expect(rows).toHaveLength(100);
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
  // markSourceRowsSynced
  // ---------------------------------------------------------------------------

  describe('markSourceRowsSynced', () => {
    function seedSpore(id: string, projectId = 'proj-remove'): void {
      const db = getDatabase();
      db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
         VALUES ('user', 'user', 'built-in', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id, synced_at)
         VALUES (?, ?, 'user', 'decision', 'x', 1, 'machine-1', NULL)`,
      ).run(id, projectId);
    }

    function sourceBookkeepingRow(operation: 'upsert' | 'delete', rowId: string): OutboxRow {
      return {
        id: operation === 'delete' ? 1 : 2,
        table_name: 'spores',
        row_id: rowId,
        operation,
        payload: { id: rowId, machine_id: 'machine-1' },
        machine_id: 'machine-1',
        team_id: 'team-a',
        project_id: 'proj-remove',
        created_at: 1,
        sent_at: null,
      };
    }

    it('does not mark source rows synced for carried-team delete tombstones', () => {
      seedSpore('sp-delete');

      markSourceRowsSynced([sourceBookkeepingRow('delete', 'sp-delete')], 123);

      const row = getDatabase()
        .prepare(`SELECT synced_at FROM spores WHERE id = 'sp-delete'`)
        .get() as { synced_at: number | null };
      expect(row.synced_at).toBeNull();
    });

    it('still marks source rows synced for accepted upserts', () => {
      seedSpore('sp-upsert');

      markSourceRowsSynced([sourceBookkeepingRow('upsert', 'sp-upsert')], 123);

      const row = getDatabase()
        .prepare(`SELECT synced_at FROM spores WHERE id = 'sp-upsert'`)
        .get() as { synced_at: number | null };
      expect(row.synced_at).toBe(123);
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

  // ---------------------------------------------------------------------------
  // countPendingForProjects
  // ---------------------------------------------------------------------------

  describe('countPendingForProjects', () => {
    it('counts only unsent rows for the given projects', () => {
      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 's1', project_id: 'proj_a' }));
      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 's2', project_id: 'proj_b' }));
      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 's3', project_id: null }));

      expect(countPendingForProjects(['proj_a'])).toBe(1);
      expect(countPendingForProjects(['proj_a', 'proj_b'])).toBe(2);
      expect(countPendingForProjects([])).toBe(0);
    });
  });

  describe('dropPendingForProjects', () => {
    it('deletes only unsent non-delete rows for the given projects', () => {
      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 's1', project_id: 'proj_a' }));
      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 's1-delete', operation: 'delete', project_id: 'proj_a' }));
      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 's2', project_id: 'proj_b' }));
      expect(dropPendingForProjects(['proj_a'])).toBe(1);
      expect(countPendingForProjects(['proj_a'])).toBe(1);
      expect(listPending().find((row) => row.row_id === 's1-delete')?.operation).toBe('delete');
      expect(countPendingForProjects(['proj_b'])).toBe(1);
      expect(dropPendingForProjects([])).toBe(0);
    });
  });

  describe('backfillUnsynced — sent-entry masking (RC-12)', () => {
    it('re-enqueues an unsynced row whose only outbox trace is sent-but-unpruned', () => {
      const db = getDatabase();
      const now = epochNow();
      setProjectSyncMembership([{ project_id: 'proj-a', team_id: 'team-a' }]);
      // An unsynced local row (synced_at NULL) — e.g. reset by the
      // JOIN/drop path — whose prior outbox entry was sent and is inside
      // the 24h retention window.
      db.prepare(
        `INSERT INTO sessions (
          id, agent, project_id, started_at, created_at, machine_id, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run('session-masked', 'codex', 'proj-a', now, now, 'machine-a');
      const stale = enqueueOutbox(makeOutbox({
        table_name: 'sessions', row_id: 'session-masked', machine_id: 'machine-a',
      }));
      markSent([stale.id], now - 60);

      // Pre-fix: the sent entry masked the row — backfill found nothing and
      // the row stayed absent from D1 while the UI showed 0 pending.
      expect(backfillUnsynced('machine-a')).toBe(1);
      expect(listPending()).toHaveLength(1);
      expect(listPending()[0].row_id).toBe('session-masked');
      expect(listPending()[0].team_id).toBe('team-a');
    });

    it('still skips rows that already have a PENDING outbox entry', () => {
      const db = getDatabase();
      const now = epochNow();
      setProjectSyncMembership([{ project_id: 'proj-a', team_id: 'team-a' }]);
      db.prepare(
        `INSERT INTO sessions (
          id, agent, project_id, started_at, created_at, machine_id, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run('session-pending', 'codex', 'proj-a', now, now, 'machine-a');
      enqueueOutbox(makeOutbox({
        table_name: 'sessions', row_id: 'session-pending', machine_id: 'machine-a',
      }));

      // Already handed off — the sweep must not double-queue it.
      expect(backfillUnsynced('machine-a')).toBe(0);
      expect(listPending()).toHaveLength(1);
    });
  });

  describe('backfillAll', () => {
    it('re-enqueues previously synced Grove rows', () => {
      const db = getDatabase();
      const now = epochNow();
      setProjectSyncMembership([{ project_id: 'proj-a', team_id: 'team-a' }]);
      db.prepare(
        `INSERT INTO sessions (
          id, agent, project_id, started_at, created_at, machine_id, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('session-synced', 'codex', 'proj-a', now, now, 'machine-a', now - 10);

      // Already-synced rows are invisible to the routine unsynced sweep.
      expect(backfillUnsynced('machine-a')).toBe(0);

      // 'all' mode re-enqueues regardless of synced_at.
      expect(backfillAll('machine-a')).toBe(1);
      expect(listPending()).toHaveLength(1);
      expect(listPending()[0].team_id).toBe('team-a');
    });
  });

  // ---------------------------------------------------------------------------
  // Rebuild ('all') mode must re-enqueue unconditionally (#2 data-loss window)
  // ---------------------------------------------------------------------------
  //
  // rebuildFromLocal truncates this machine's cloud rows (client.rebuild())
  // BEFORE re-enqueuing. If 'all' mode skipped any source row that happened to
  // have a *pending* outbox entry (e.g. a routine flush was mid-drain when the
  // rebuild fired), that row would be deleted from cloud yet never re-enqueued
  // — silently lost from D1 until an unrelated future edit. So 'all'/rebuild
  // mode must re-enqueue every local row, even ones with a pending outbox entry.
  describe("rebuild ('all') mode re-enqueues rows with a pending outbox entry", () => {
    /** Seed a synced spore plus its agents FK row. */
    function seedSyncedSpore(db: ReturnType<typeof getDatabase>, id: string, machineId: string): void {
      const now = epochNow();
      db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, created_at) VALUES ('rebuild-agent', 'rebuild-agent', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id, synced_at)
         VALUES (?, 'proj', 'rebuild-agent', 'decision', 'active', 'c', ?, ?, ?)`,
      ).run(id, now, machineId, now - 10);
    }

    it('backfillAllForRebuild re-enqueues a row that already has a PENDING outbox entry (no skip)', () => {
      const db = getDatabase();
      setProjectSyncMembership([{ project_id: 'proj', team_id: 'team-a' }]);
      seedSyncedSpore(db, 'spore-pending', 'machine-a');

      // Pre-existing PENDING (sent_at IS NULL) outbox entry for that same row —
      // simulates a routine flush that is mid-drain when a rebuild fires.
      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 'spore-pending' }));
      expect(countPending()).toBe(1);

      // Rebuild re-enqueues the row regardless of the pending entry.
      const enqueued = backfillAllForRebuild('machine-a');
      expect(enqueued).toBeGreaterThanOrEqual(1);

      // A NEW outbox entry now exists for the row (two pending entries total —
      // the duplicate is safe: the worker upsert is keyed by (id, machine_id)).
      const pendingForRow = db.prepare(
        `SELECT id, team_id FROM team_outbox
         WHERE table_name = 'spores' AND row_id = 'spore-pending' AND sent_at IS NULL
         ORDER BY id`,
      ).all() as Array<{ id: number; team_id: string | null }>;
      expect(pendingForRow.length).toBe(2);
      expect(pendingForRow.map((row) => row.team_id)).toContain('team-a');
    });

    it("'unsynced' mode STILL skips a row that already has an outbox entry (unchanged)", () => {
      const db = getDatabase();
      const now = epochNow();
      setProjectSyncMembership([{ project_id: 'proj', team_id: 'team-a' }]);
      // Source row is UNSYNCED so the only thing that can suppress it is the
      // existing outbox-entry dedup.
      db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, created_at) VALUES ('rebuild-agent', 'rebuild-agent', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id, synced_at)
         VALUES ('spore-unsynced', 'proj', 'rebuild-agent', 'decision', 'active', 'c', ?, 'machine-a', NULL)`,
      ).run(now);

      enqueueOutbox(makeOutbox({ table_name: 'spores', row_id: 'spore-unsynced' }));
      expect(countPending()).toBe(1);

      // 'unsynced' dedups against the existing outbox entry → nothing re-enqueued.
      expect(backfillUnsynced('machine-a')).toBe(0);
      expect(countPending()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // countTeamSyncRows — machine_id scoping
  // ---------------------------------------------------------------------------

  describe('countTeamSyncRows', () => {
    function insertSpore(
      db: ReturnType<typeof getDatabase>,
      id: string,
      machineId: string,
      projectId = 'proj',
    ) {
      // Agents table is the only FK dependency for spores in these tests.
      // Insert agent idempotently so multiple calls within one test don't error.
      db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, created_at) VALUES ('test-agent', 'test-agent', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
         VALUES (?, ?, 'test-agent', 'decision', 'active', 'c', 1, ?)`,
      ).run(id, projectId, machineId);
    }

    it('without machineId counts rows across ALL machine_ids', () => {
      const db = getDatabase();
      insertSpore(db, 'spore-local-1', 'local');
      insertSpore(db, 'spore-local-2', 'local');
      insertSpore(db, 'spore-real-1', 'sirkirby_test');

      const allCounts = countTeamSyncRows();
      expect(allCounts.spores).toBe(3);
    });

    it('with machineId counts ONLY rows for that machine_id', () => {
      const db = getDatabase();
      insertSpore(db, 'spore-local-1', 'local');
      insertSpore(db, 'spore-local-2', 'local');
      insertSpore(db, 'spore-real-1', 'sirkirby_test');

      const scopedCounts = countTeamSyncRows('sirkirby_test');
      expect(scopedCounts.spores).toBe(1);
    });

    it('machine-scoped and unscoped counts match when only one machine_id exists', () => {
      const db = getDatabase();
      insertSpore(db, 'spore-only-1', 'solo_machine');
      insertSpore(db, 'spore-only-2', 'solo_machine');

      expect(countTeamSyncRows('solo_machine').spores).toBe(2);
      expect(countTeamSyncRows().spores).toBe(2);
    });

    it('drift is zero when local is machine-scoped to match cloud (regression: legacy machine_ids)', () => {
      const db = getDatabase();
      // Legacy rows under machine_id='local' (pre-real-id era)
      for (let i = 0; i < 3; i++) {
        insertSpore(db, `spore-legacy-${i}`, 'local');
      }
      // Rows under the real machine_id
      for (let i = 0; i < 5; i++) {
        insertSpore(db, `spore-real-${i}`, 'real_machine_abc');
      }

      // Cloud only mirrors the real machine_id rows (5)
      const cloudSporeCount = 5;
      const localScoped = countTeamSyncRows('real_machine_abc').spores;
      const localAll = countTeamSyncRows().spores;

      // Machine-scoped local matches cloud → no drift
      expect(localScoped).toBe(cloudSporeCount);
      // Unscoped local would produce false drift
      expect(localAll).toBe(8);
      expect(localAll - cloudSporeCount).toBe(3); // false drift magnitude = legacy rows
    });

    it('with projectIds counts only rows served by the selected team in this Grove', () => {
      const db = getDatabase();
      insertSpore(db, 'spore-served-1', 'machine-a', 'proj-served');
      insertSpore(db, 'spore-served-2', 'machine-a', 'proj-served');
      insertSpore(db, 'spore-other', 'machine-a', 'proj-other');
      insertSpore(db, 'spore-served-other-machine', 'machine-b', 'proj-served');

      const scopedCounts = countTeamSyncRows('machine-a', ['proj-served']);

      expect(scopedCounts.spores).toBe(2);
      expect(scopedCounts.team_members).toBe(0);
    });
  });
});

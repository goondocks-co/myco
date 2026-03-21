import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PipelineManager } from '@myco/daemon/pipeline';
import {
  PIPELINE_STAGES,
  ITEM_STAGE_MAP,
  PIPELINE_TRANSIENT_MAX_RETRIES,
  PIPELINE_PARSE_MAX_RETRIES,
  PIPELINE_BACKOFF_BASE_MS,
  PIPELINE_BACKOFF_MULTIPLIER,
  PIPELINE_CIRCUIT_FAILURE_THRESHOLD,
  STAGE_PROVIDER_MAP,
  PIPELINE_RETENTION_DAYS,
} from '@myco/constants';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('PipelineManager', () => {
  let tmpDir: string;
  let manager: PipelineManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pipeline-'));
    manager = new PipelineManager(tmpDir);
  });

  afterEach(() => {
    manager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('creates pipeline.db with correct tables', () => {
      const dbPath = path.join(tmpDir, 'pipeline.db');
      expect(fs.existsSync(dbPath)).toBe(true);
      const health = manager.health();
      expect(health).toBeDefined();
    });

    it('is idempotent — opening twice does not error', () => {
      manager.close();
      const manager2 = new PipelineManager(tmpDir);
      const health = manager2.health();
      expect(health).toBeDefined();
      manager2.close();
    });

    it('sets WAL journal mode', () => {
      const mode = manager.getPragma('journal_mode');
      expect(mode).toBe('wal');
    });

    it('enables foreign keys', () => {
      const fk = manager.getPragma('foreign_keys');
      expect(fk).toBe(1);
    });
  });

  describe('health()', () => {
    it('returns empty health when no work items exist', () => {
      const health = manager.health();
      expect(health.stages).toEqual({});
      expect(health.circuits).toEqual([]);
      expect(health.totals).toEqual({
        pending: 0,
        processing: 0,
        failed: 0,
        blocked: 0,
        poisoned: 0,
        succeeded: 0,
      });
    });

    it('aggregates stage/status counts from pipeline_status view', () => {
      // Insert a work item and a stage transition directly to test the view
      const db = manager.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('sess-abc123', 'session', '/sessions/2026-03-21/session-abc123.md', now, now);
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('sess-abc123', 'session', 'capture', 'succeeded', 1, now);
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('sess-abc123', 'session', 'extraction', 'pending', 1, now);

      const health = manager.health();
      expect(health.stages['capture']).toEqual({ succeeded: 1 });
      expect(health.stages['extraction']).toEqual({ pending: 1 });
      expect(health.totals.succeeded).toBe(1);
      expect(health.totals.pending).toBe(1);
    });

    it('returns circuit breaker states', () => {
      const db = manager.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO circuit_breakers (provider_role, state, failure_count, last_failure, last_error, opens_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('llm', 'open', 3, now, 'ECONNREFUSED', now, now);

      const health = manager.health();
      expect(health.circuits).toHaveLength(1);
      expect(health.circuits[0]).toEqual({
        provider_role: 'llm',
        state: 'open',
        failure_count: 3,
        last_error: 'ECONNREFUSED',
      });
    });

    it('only counts the latest transition per item/stage (ROW_NUMBER)', () => {
      const db = manager.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('sess-xyz789', 'session', '/sessions/2026-03-21/session-xyz789.md', now, now);

      // Two transitions for the same stage — only the latest should count
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('sess-xyz789', 'session', 'extraction', 'failed', 1, now);
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('sess-xyz789', 'session', 'extraction', 'processing', 2, now);

      const health = manager.health();
      // Only the latest (processing) should appear, not the earlier (failed)
      expect(health.stages['extraction']).toEqual({ processing: 1 });
      expect(health.totals.processing).toBe(1);
      expect(health.totals.failed).toBe(0);
    });
  });

  describe('register()', () => {
    it('creates work item with correct initial stages for session', () => {
      manager.register('sess-abc123', 'session', '/sessions/2026-03-21/session-abc123.md');

      const statuses = manager.getItemStatus('sess-abc123', 'session');
      expect(statuses).toHaveLength(PIPELINE_STAGES.length);

      const sessionStages = ITEM_STAGE_MAP['session'];
      for (const s of statuses) {
        if (sessionStages.includes(s.stage as typeof PIPELINE_STAGES[number])) {
          expect(s.status).toBe('pending');
        } else {
          expect(s.status).toBe('skipped');
        }
      }

      // Session: capture, extraction, embedding, digest are applicable; consolidation is skipped
      const consolidation = statuses.find((s) => s.stage === 'consolidation');
      expect(consolidation?.status).toBe('skipped');

      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('pending');
    });

    it('creates work item with skipped stages for spore (extraction skipped)', () => {
      manager.register('spore-def456', 'spore');

      const statuses = manager.getItemStatus('spore-def456', 'spore');
      expect(statuses).toHaveLength(PIPELINE_STAGES.length);

      const extraction = statuses.find((s) => s.stage === 'extraction');
      expect(extraction?.status).toBe('skipped');

      const embedding = statuses.find((s) => s.stage === 'embedding');
      expect(embedding?.status).toBe('pending');
    });

    it('creates work item with skipped stages for artifact (extraction + consolidation skipped)', () => {
      manager.register('art-ghi789', 'artifact');

      const statuses = manager.getItemStatus('art-ghi789', 'artifact');
      expect(statuses).toHaveLength(PIPELINE_STAGES.length);

      const extraction = statuses.find((s) => s.stage === 'extraction');
      expect(extraction?.status).toBe('skipped');

      const consolidation = statuses.find((s) => s.stage === 'consolidation');
      expect(consolidation?.status).toBe('skipped');

      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('pending');
    });

    it('is idempotent — re-registering same item does not error or duplicate', () => {
      manager.register('sess-abc123', 'session');
      manager.register('sess-abc123', 'session');

      const statuses = manager.getItemStatus('sess-abc123', 'session');
      expect(statuses).toHaveLength(PIPELINE_STAGES.length);

      // Verify no duplicate transitions in the raw table
      const db = manager.getDb();
      const rows = db
        .prepare(
          'SELECT COUNT(*) as cnt FROM stage_transitions WHERE work_item_id = ? AND item_type = ?',
        )
        .get('sess-abc123', 'session') as { cnt: number };
      expect(rows.cnt).toBe(PIPELINE_STAGES.length);
    });
  });

  describe('advance()', () => {
    beforeEach(() => {
      manager.register('sess-001', 'session');
    });

    it('records stage transition on success', () => {
      manager.advance('sess-001', 'session', 'capture', 'succeeded');

      const statuses = manager.getItemStatus('sess-001', 'session');
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('succeeded');
      expect(capture?.attempt).toBe(1);
    });

    it('records stage transition on failure with error details', () => {
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'transient',
        errorMessage: 'ECONNREFUSED',
      });

      const statuses = manager.getItemStatus('sess-001', 'session');
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('failed');
      expect(capture?.error_type).toBe('transient');
      expect(capture?.error_message).toBe('ECONNREFUSED');
    });

    it('increments attempt count on retry (fail → pending → fail = attempt 2)', () => {
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'transient',
        errorMessage: 'timeout',
      });
      manager.advance('sess-001', 'session', 'capture', 'processing');
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'transient',
        errorMessage: 'timeout again',
      });

      const statuses = manager.getItemStatus('sess-001', 'session');
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('failed');
      expect(capture?.attempt).toBe(2);
    });

    it('blocks downstream stages when upstream fails with config error', () => {
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'config',
        errorMessage: 'missing provider',
      });

      const statuses = manager.getItemStatus('sess-001', 'session');

      // capture itself is poisoned (config errors get 0 retries effectively, since PIPELINE_PARSE_MAX_RETRIES...
      // actually config triggers blocking, not poisoning of self)
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('failed');

      // All downstream stages (extraction, embedding, consolidation, digest for session) should be blocked
      // But consolidation was already skipped for session — skipped stays skipped
      const extraction = statuses.find((s) => s.stage === 'extraction');
      expect(extraction?.status).toBe('blocked');

      const embedding = statuses.find((s) => s.stage === 'embedding');
      expect(embedding?.status).toBe('blocked');

      const digest = statuses.find((s) => s.stage === 'digest');
      expect(digest?.status).toBe('blocked');
    });

    it('auto-poisons after exceeding transient retry limit', () => {
      // PIPELINE_TRANSIENT_MAX_RETRIES = 3
      for (let i = 0; i < PIPELINE_TRANSIENT_MAX_RETRIES; i++) {
        manager.advance('sess-001', 'session', 'capture', 'processing');
        manager.advance('sess-001', 'session', 'capture', 'failed', {
          errorType: 'transient',
          errorMessage: `failure ${i + 1}`,
        });
      }

      // The next failure should auto-poison
      manager.advance('sess-001', 'session', 'capture', 'processing');
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'transient',
        errorMessage: 'one too many',
      });

      const statuses = manager.getItemStatus('sess-001', 'session');
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('poisoned');
    });

    it('auto-poisons after exceeding parse retry limit', () => {
      // PIPELINE_PARSE_MAX_RETRIES = 1
      manager.advance('sess-001', 'session', 'capture', 'processing');
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'parse',
        errorMessage: 'bad JSON',
      });

      // One more should poison
      manager.advance('sess-001', 'session', 'capture', 'processing');
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'parse',
        errorMessage: 'still bad JSON',
      });

      const statuses = manager.getItemStatus('sess-001', 'session');
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('poisoned');
    });
  });

  describe('getItemStatus()', () => {
    it('returns empty array for non-existent item', () => {
      const statuses = manager.getItemStatus('nonexistent', 'session');
      expect(statuses).toEqual([]);
    });

    it('returns all stages for a registered item', () => {
      manager.register('sess-001', 'session');
      const statuses = manager.getItemStatus('sess-001', 'session');
      expect(statuses).toHaveLength(PIPELINE_STAGES.length);

      const stageNames = statuses.map((s) => s.stage);
      for (const stage of PIPELINE_STAGES) {
        expect(stageNames).toContain(stage);
      }
    });
  });

  describe('nextBatch()', () => {
    it('returns pending items ordered by creation time (oldest first)', () => {
      // Register items with staggered timestamps by manipulating created_at
      const db = manager.getDb();

      manager.register('sess-old', 'session');
      manager.register('sess-new', 'session');

      // Manually adjust created_at so sess-old is older
      db.prepare("UPDATE work_items SET created_at = '2026-03-20T00:00:00.000Z' WHERE id = 'sess-old'").run();
      db.prepare("UPDATE work_items SET created_at = '2026-03-21T00:00:00.000Z' WHERE id = 'sess-new'").run();

      const batch = manager.nextBatch('capture', 10);
      expect(batch).toHaveLength(2);
      expect(batch[0].id).toBe('sess-old');
      expect(batch[1].id).toBe('sess-new');
    });

    it('respects batch size limit', () => {
      manager.register('sess-001', 'session');
      manager.register('sess-002', 'session');
      manager.register('sess-003', 'session');

      const batch = manager.nextBatch('capture', 2);
      expect(batch).toHaveLength(2);
    });

    it('excludes items still in backoff window', () => {
      manager.register('sess-001', 'session');

      // Fail the capture stage — this should put it in backoff
      manager.advance('sess-001', 'session', 'capture', 'processing');
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'transient',
        errorMessage: 'timeout',
      });
      // Re-set to pending for retry eligibility
      manager.advance('sess-001', 'session', 'capture', 'pending');

      // The backoff should exclude it since completed_at was just now and
      // backoff = PIPELINE_BACKOFF_BASE_MS * PIPELINE_BACKOFF_MULTIPLIER^0 = 30000ms
      const batch = manager.nextBatch('capture', 10);
      expect(batch).toHaveLength(0);
    });

    it('only returns items whose upstream stage succeeded', () => {
      manager.register('sess-001', 'session');

      // extraction requires capture to be succeeded first
      // capture is still pending, so extraction should not be returned
      const batch = manager.nextBatch('extraction', 10);
      expect(batch).toHaveLength(0);

      // Now succeed capture
      manager.advance('sess-001', 'session', 'capture', 'succeeded');

      const batchAfter = manager.nextBatch('extraction', 10);
      expect(batchAfter).toHaveLength(1);
      expect(batchAfter[0].id).toBe('sess-001');
    });

    it('does not return items with blocked or skipped status', () => {
      manager.register('sess-001', 'session');

      // Block extraction by config error on capture
      manager.advance('sess-001', 'session', 'capture', 'failed', {
        errorType: 'config',
        errorMessage: 'no provider',
      });

      // extraction is now blocked — should not be in the batch
      const batch = manager.nextBatch('extraction', 10);
      expect(batch).toHaveLength(0);

      // consolidation is skipped for session — should not appear
      manager.register('sess-002', 'session');
      manager.advance('sess-002', 'session', 'capture', 'succeeded');
      manager.advance('sess-002', 'session', 'extraction', 'succeeded');
      manager.advance('sess-002', 'session', 'embedding', 'succeeded');

      const consolBatch = manager.nextBatch('consolidation', 10);
      expect(consolBatch).toHaveLength(0);
    });

    it('returns items whose upstream stage is skipped', () => {
      // For spore, extraction is skipped, so embedding should be available
      // once capture is succeeded
      manager.register('spore-001', 'spore');
      manager.advance('spore-001', 'spore', 'capture', 'succeeded');

      // extraction is skipped for spore — embedding's upstream (extraction) is skipped
      // so embedding should be available
      const batch = manager.nextBatch('embedding', 10);
      expect(batch).toHaveLength(1);
      expect(batch[0].id).toBe('spore-001');
    });
  });

  describe('circuit breakers', () => {
    it('starts in closed state (circuitState returns closed with 0 failures)', () => {
      const state = manager.circuitState('llm');
      expect(state.provider_role).toBe('llm');
      expect(state.state).toBe('closed');
      expect(state.failure_count).toBe(0);
      expect(state.last_failure).toBeNull();
      expect(state.last_error).toBeNull();
      expect(state.opens_at).toBeNull();
    });

    it('does not open before threshold (2 trips → still closed)', () => {
      for (let i = 0; i < PIPELINE_CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
        manager.tripCircuit('llm', 'connection refused');
      }
      const state = manager.circuitState('llm');
      expect(state.state).toBe('closed');
      expect(state.failure_count).toBe(PIPELINE_CIRCUIT_FAILURE_THRESHOLD - 1);
    });

    it('opens after failure threshold consecutive failures (3 trips → open)', () => {
      for (let i = 0; i < PIPELINE_CIRCUIT_FAILURE_THRESHOLD; i++) {
        manager.tripCircuit('llm', `error ${i + 1}`);
      }
      const state = manager.circuitState('llm');
      expect(state.state).toBe('open');
      expect(state.failure_count).toBe(PIPELINE_CIRCUIT_FAILURE_THRESHOLD);
      expect(state.opens_at).not.toBeNull();
      expect(state.last_error).toBe(`error ${PIPELINE_CIRCUIT_FAILURE_THRESHOLD}`);
    });

    it('resets on manual reset (open → resetCircuit → closed with 0 failures)', () => {
      for (let i = 0; i < PIPELINE_CIRCUIT_FAILURE_THRESHOLD; i++) {
        manager.tripCircuit('llm', 'error');
      }
      expect(manager.circuitState('llm').state).toBe('open');

      manager.resetCircuit('llm');

      const state = manager.circuitState('llm');
      expect(state.state).toBe('closed');
      expect(state.failure_count).toBe(0);
      expect(state.opens_at).toBeNull();
    });

    it('probeCircuit returns false when circuit is closed', () => {
      const result = manager.probeCircuit('llm');
      expect(result).toBe(false);
    });

    it('probeCircuit returns false when circuit is open but cooldown not expired', () => {
      for (let i = 0; i < PIPELINE_CIRCUIT_FAILURE_THRESHOLD; i++) {
        manager.tripCircuit('llm', 'error');
      }
      // Circuit is open, opens_at is in the future
      const result = manager.probeCircuit('llm');
      expect(result).toBe(false);
      expect(manager.circuitState('llm').state).toBe('open');
    });

    it('probeCircuit returns true when cooldown expired (sets state to half-open)', () => {
      // Insert a circuit breaker row with opens_at in the past
      const pastTime = new Date(Date.now() - 10_000).toISOString();
      const db = manager.getDb();
      db.prepare(
        `INSERT INTO circuit_breakers (provider_role, state, failure_count, last_failure, last_error, opens_at, updated_at)
         VALUES (?, 'open', ?, ?, ?, ?, ?)`,
      ).run('llm', PIPELINE_CIRCUIT_FAILURE_THRESHOLD, pastTime, 'expired error', pastTime, pastTime);

      const result = manager.probeCircuit('llm');
      expect(result).toBe(true);
      expect(manager.circuitState('llm').state).toBe('half-open');
    });

    it('blockItemsForCircuit blocks pending items at affected stages', () => {
      // Register items and advance capture to succeeded so extraction is pending+eligible
      manager.register('sess-001', 'session');
      manager.advance('sess-001', 'session', 'capture', 'succeeded');

      // extraction uses 'llm' provider — blocking llm should block extraction
      const blockedCount = manager.blockItemsForCircuit('llm');
      expect(blockedCount).toBeGreaterThan(0);

      const statuses = manager.getItemStatus('sess-001', 'session');
      const extraction = statuses.find((s) => s.stage === 'extraction');
      expect(extraction?.status).toBe('blocked');
    });

    it('unblockItemsForCircuit moves blocked items back to pending', () => {
      manager.register('sess-001', 'session');
      manager.advance('sess-001', 'session', 'capture', 'succeeded');

      // Block via circuit
      manager.blockItemsForCircuit('llm');

      const afterBlock = manager.getItemStatus('sess-001', 'session');
      expect(afterBlock.find((s) => s.stage === 'extraction')?.status).toBe('blocked');

      // Unblock via circuit reset
      const unblockedCount = manager.unblockItemsForCircuit('llm');
      expect(unblockedCount).toBeGreaterThan(0);

      const afterUnblock = manager.getItemStatus('sess-001', 'session');
      expect(afterUnblock.find((s) => s.stage === 'extraction')?.status).toBe('pending');
    });

    it('blocking only affects stages that use the tripped provider role (other stages unaffected)', () => {
      // Register a session — capture has no provider (null), extraction uses 'llm'
      manager.register('sess-001', 'session');

      // capture is still pending — blocking 'llm' should NOT affect capture
      const blockedCount = manager.blockItemsForCircuit('llm');

      const statuses = manager.getItemStatus('sess-001', 'session');
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('pending'); // capture is unaffected

      const extraction = statuses.find((s) => s.stage === 'extraction');
      expect(extraction?.status).toBe('blocked'); // extraction uses 'llm'

      // blockedCount reflects only stages that map to 'llm'
      expect(blockedCount).toBeGreaterThan(0);
    });
  });

  describe('compact()', () => {
    it('compacts transitions older than retention window into stage_history', () => {
      const db = manager.getDb();
      const now = new Date().toISOString();
      // Insert a work item
      db.prepare(
        'INSERT INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('sess-compact-001', 'session', null, now, now);

      // Insert two old transitions (30+ days ago) for the same item/stage
      const old1 = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const old2 = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-001', 'session', 'capture', 'failed', 1, 'transient', old2);
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-001', 'session', 'capture', 'succeeded', 2, null, old1);

      const result = manager.compact(PIPELINE_RETENTION_DAYS);
      expect(result.compacted).toBe(1); // 1 group (work_item_id, item_type, stage)
      expect(result.deleted).toBe(2);   // 2 transition rows deleted

      // stage_history should have one row
      const histRow = db
        .prepare('SELECT * FROM stage_history WHERE work_item_id = ? AND item_type = ? AND stage = ?')
        .get('sess-compact-001', 'session', 'capture') as Record<string, unknown> | undefined;
      expect(histRow).toBeDefined();
      expect(histRow!.total_attempts).toBe(2);
      expect(histRow!.final_status).toBe('succeeded'); // latest transition status
      expect(histRow!.first_attempt).toBe(old2);
      expect(histRow!.last_attempt).toBe(old1);

      // original transitions should be gone
      const remaining = db
        .prepare('SELECT COUNT(*) as cnt FROM stage_transitions WHERE work_item_id = ? AND item_type = ? AND stage = ?')
        .get('sess-compact-001', 'session', 'capture') as { cnt: number };
      expect(remaining.cnt).toBe(0);
    });

    it('preserves transitions within retention window', () => {
      const db = manager.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('sess-compact-002', 'session', null, now, now);

      // Insert one old transition and one recent transition
      const oldTs = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recentTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-002', 'session', 'extraction', 'failed', 1, 'transient', oldTs);
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-002', 'session', 'extraction', 'pending', 2, null, recentTs);

      const result = manager.compact(PIPELINE_RETENTION_DAYS);
      // Only the old transition qualifies, but it belongs to a group that also has a recent row
      // The group should NOT be compacted if any member is within the window
      // (only entirely-old groups are compacted)
      expect(result.deleted).toBe(1); // only the old one deleted
      expect(result.compacted).toBe(1); // 1 group entry upserted for the old one

      // The recent transition should still be in stage_transitions
      const remaining = db
        .prepare('SELECT COUNT(*) as cnt FROM stage_transitions WHERE work_item_id = ? AND item_type = ? AND stage = ?')
        .get('sess-compact-002', 'session', 'extraction') as { cnt: number };
      expect(remaining.cnt).toBe(1);
    });

    it('stores error_types JSON correctly', () => {
      const db = manager.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('sess-compact-003', 'session', null, now, now);

      const oldBase = Date.now() - 35 * 24 * 60 * 60 * 1000;
      // 2 transient failures, 1 config failure
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-003', 'session', 'embedding', 'failed', 1, 'transient', new Date(oldBase).toISOString());
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-003', 'session', 'embedding', 'failed', 2, 'transient', new Date(oldBase + 1000).toISOString());
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-003', 'session', 'embedding', 'failed', 3, 'config', new Date(oldBase + 2000).toISOString());

      manager.compact(PIPELINE_RETENTION_DAYS);

      const histRow = db
        .prepare('SELECT error_types FROM stage_history WHERE work_item_id = ? AND item_type = ? AND stage = ?')
        .get('sess-compact-003', 'session', 'embedding') as { error_types: string } | undefined;
      expect(histRow).toBeDefined();
      const errorTypes = JSON.parse(histRow!.error_types) as Record<string, number>;
      expect(errorTypes['transient']).toBe(2);
      expect(errorTypes['config']).toBe(1);
    });

    it('handles items with no errors (error_types should be empty object)', () => {
      const db = manager.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('sess-compact-004', 'session', null, now, now);

      const oldTs = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('sess-compact-004', 'session', 'digest', 'succeeded', 1, null, oldTs);

      manager.compact(PIPELINE_RETENTION_DAYS);

      const histRow = db
        .prepare('SELECT error_types FROM stage_history WHERE work_item_id = ? AND item_type = ? AND stage = ?')
        .get('sess-compact-004', 'session', 'digest') as { error_types: string | null } | undefined;
      expect(histRow).toBeDefined();
      // error_types should be an empty JSON object (no errors)
      const errorTypes = JSON.parse(histRow!.error_types ?? '{}') as Record<string, number>;
      expect(Object.keys(errorTypes)).toHaveLength(0);
    });
  });

  describe('recoverStuck()', () => {
    it('moves processing items to pending', () => {
      manager.register('sess-stuck-001', 'session');
      // Advance to processing
      manager.advance('sess-stuck-001', 'session', 'capture', 'processing');

      const count = manager.recoverStuck();
      expect(count).toBeGreaterThanOrEqual(1);

      const statuses = manager.getItemStatus('sess-stuck-001', 'session');
      const capture = statuses.find((s) => s.stage === 'capture');
      expect(capture?.status).toBe('pending');
    });

    it('does not affect items in other statuses (succeeded, failed, pending)', () => {
      manager.register('sess-stuck-002', 'session');
      manager.advance('sess-stuck-002', 'session', 'capture', 'succeeded');
      // extraction is still pending after capture succeeds

      manager.register('sess-stuck-003', 'session');
      manager.advance('sess-stuck-003', 'session', 'capture', 'failed', {
        errorType: 'transient',
        errorMessage: 'boom',
      });

      const count = manager.recoverStuck();
      expect(count).toBe(0);

      // succeeded stays succeeded
      const s2 = manager.getItemStatus('sess-stuck-002', 'session');
      expect(s2.find((s) => s.stage === 'capture')?.status).toBe('succeeded');

      // failed stays failed
      const s3 = manager.getItemStatus('sess-stuck-003', 'session');
      expect(s3.find((s) => s.stage === 'capture')?.status).toBe('failed');
    });

    it('returns correct count of recovered items', () => {
      manager.register('sess-stuck-010', 'session');
      manager.register('sess-stuck-011', 'session');
      manager.register('sess-stuck-012', 'session');

      manager.advance('sess-stuck-010', 'session', 'capture', 'processing');
      manager.advance('sess-stuck-011', 'session', 'capture', 'processing');
      // sess-stuck-012 stays pending

      const count = manager.recoverStuck();
      expect(count).toBe(2);
    });
  });

  describe('schema tables exist', () => {
    it('has work_items table', () => {
      const db = manager.getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'").get() as { name: string } | undefined;
      expect(row?.name).toBe('work_items');
    });

    it('has stage_transitions table', () => {
      const db = manager.getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stage_transitions'").get() as { name: string } | undefined;
      expect(row?.name).toBe('stage_transitions');
    });

    it('has stage_history table', () => {
      const db = manager.getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stage_history'").get() as { name: string } | undefined;
      expect(row?.name).toBe('stage_history');
    });

    it('has circuit_breakers table', () => {
      const db = manager.getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='circuit_breakers'").get() as { name: string } | undefined;
      expect(row?.name).toBe('circuit_breakers');
    });

    it('has pipeline_status view', () => {
      const db = manager.getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='pipeline_status'").get() as { name: string } | undefined;
      expect(row?.name).toBe('pipeline_status');
    });
  });
});

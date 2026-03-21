import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PipelineManager } from '@myco/daemon/pipeline';
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

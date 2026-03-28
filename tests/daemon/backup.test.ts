/**
 * Tests for the backup engine — create, list, preview, and restore.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import {
  BACKUP_TABLES,
  createBackup,
  listBackups,
  restorePreview,
  restoreBackup,
} from '@myco/daemon/backup.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Test machine IDs. */
const LOCAL_MACHINE = 'testuser_aaaa1111';
const REMOTE_MACHINE = 'otheruser_bbbb2222';

/** Test agent ID. */
const TEST_AGENT_ID = 'test-agent';

/** Create a temporary backup directory for each test. */
function makeTmpBackupDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-backup-'));
}

/** Seed the test agent row (needed for FK constraints). */
function seedAgent() {
  const now = epochNow();
  registerAgent({
    id: TEST_AGENT_ID,
    name: 'Test Agent',
    source: 'built-in',
    created_at: now,
  });
}

/** Insert a test session row. */
function seedSession(id: string, machineId: string) {
  const now = epochNow();
  upsertSession({
    id,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    machine_id: machineId,
  });
}

/** Insert a test spore row. */
function seedSpore(id: string, sessionId: string, machineId: string) {
  const now = epochNow();
  insertSpore({
    id,
    agent_id: TEST_AGENT_ID,
    session_id: sessionId,
    observation_type: 'gotcha',
    content: `Test spore content for ${id}`,
    created_at: now,
    machine_id: machineId,
  });
}

/** Insert a test plan row. */
function seedPlan(id: string, machineId: string) {
  const now = epochNow();
  upsertPlan({
    id,
    title: `Test plan ${id}`,
    content: 'Plan content here',
    created_at: now,
    machine_id: machineId,
  });
}

describe('backup engine', () => {
  let tmpDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    tmpDir = makeTmpBackupDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('BACKUP_TABLES', () => {
    it('includes all synced tables', () => {
      expect(BACKUP_TABLES).toContain('sessions');
      expect(BACKUP_TABLES).toContain('spores');
      expect(BACKUP_TABLES).toContain('plans');
      expect(BACKUP_TABLES).toContain('entities');
      expect(BACKUP_TABLES).toContain('graph_edges');
      expect(BACKUP_TABLES).toContain('team_members');
    });

    it('excludes non-synced tables', () => {
      expect(BACKUP_TABLES).not.toContain('activities');
      expect(BACKUP_TABLES).not.toContain('log_entries');
      expect(BACKUP_TABLES).not.toContain('agents');
      expect(BACKUP_TABLES).not.toContain('agent_runs');
    });
  });

  describe('createBackup()', () => {
    it('creates a file named by machine_id', () => {
      seedAgent();
      seedSession('sess-001', LOCAL_MACHINE);

      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      expect(filePath).toBe(path.join(tmpDir, `${LOCAL_MACHINE}.sql`));
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('writes INSERT OR IGNORE statements for synced tables', () => {
      seedAgent();
      seedSession('sess-002', LOCAL_MACHINE);
      seedSpore('spore-001', 'sess-002', LOCAL_MACHINE);

      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      const content = fs.readFileSync(
        path.join(tmpDir, `${LOCAL_MACHINE}.sql`),
        'utf-8',
      );

      expect(content).toContain('INSERT OR IGNORE INTO sessions');
      expect(content).toContain('INSERT OR IGNORE INTO spores');
      expect(content).toContain('sess-002');
      expect(content).toContain('spore-001');
    });

    it('includes header with machine_id and protocol version', () => {
      seedAgent();
      seedSession('sess-003', LOCAL_MACHINE);

      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      const content = fs.readFileSync(
        path.join(tmpDir, `${LOCAL_MACHINE}.sql`),
        'utf-8',
      );

      expect(content).toContain(`machine_id=${LOCAL_MACHINE}`);
      expect(content).toContain('Protocol version:');
    });

    it('excludes tables with no rows', () => {
      // No data seeded — backup should have header only
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      const content = fs.readFileSync(
        path.join(tmpDir, `${LOCAL_MACHINE}.sql`),
        'utf-8',
      );

      expect(content).not.toContain('INSERT OR IGNORE');
    });

    it('handles strings with single quotes', () => {
      seedAgent();
      seedSession('sess-quote', LOCAL_MACHINE);

      const now = epochNow();
      insertSpore({
        id: 'spore-quote',
        agent_id: TEST_AGENT_ID,
        session_id: 'sess-quote',
        observation_type: 'gotcha',
        content: "It's a test with 'quotes'",
        created_at: now,
        machine_id: LOCAL_MACHINE,
      });

      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      const content = fs.readFileSync(
        path.join(tmpDir, `${LOCAL_MACHINE}.sql`),
        'utf-8',
      );

      // Single quotes should be escaped as double single quotes
      expect(content).toContain("It''s a test with ''quotes''");
    });

    it('is idempotent — second backup overwrites first', () => {
      seedAgent();
      seedSession('sess-004', LOCAL_MACHINE);

      const path1 = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const content1 = fs.readFileSync(path1, 'utf-8');

      const path2 = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const content2 = fs.readFileSync(path2, 'utf-8');

      expect(path1).toBe(path2);
      // Content may differ slightly in timestamp but both should contain the session
      expect(content1).toContain('sess-004');
      expect(content2).toContain('sess-004');
    });
  });

  describe('listBackups()', () => {
    it('returns empty array for non-existent directory', () => {
      const result = listBackups('/nonexistent/path');
      expect(result).toEqual([]);
    });

    it('returns metadata for backup files', () => {
      seedAgent();
      seedSession('sess-005', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      const backups = listBackups(tmpDir);

      expect(backups).toHaveLength(1);
      expect(backups[0].machine_id).toBe(LOCAL_MACHINE);
      expect(backups[0].file_name).toBe(`${LOCAL_MACHINE}.sql`);
      expect(backups[0].size_bytes).toBeGreaterThan(0);
      expect(backups[0].modified_at).toBeTruthy();
    });

    it('ignores non-.sql files', () => {
      fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'not a backup');
      seedAgent();
      seedSession('sess-006', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      const backups = listBackups(tmpDir);
      expect(backups).toHaveLength(1);
    });
  });

  describe('restorePreview()', () => {
    it('shows all records as new when DB is empty', () => {
      // Create backup with data, then clean DB
      seedAgent();
      seedSession('sess-010', LOCAL_MACHINE);
      seedSpore('spore-010', 'sess-010', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      cleanTestDb();

      const backupPath = path.join(tmpDir, `${LOCAL_MACHINE}.sql`);
      const tables = restorePreview(getDatabase(), backupPath);

      const sessionTable = tables.find((t) => t.table === 'sessions');
      expect(sessionTable).toBeDefined();
      expect(sessionTable!.new).toBe(1);
      expect(sessionTable!.existing).toBe(0);
    });

    it('shows records as existing when they already exist', () => {
      seedAgent();
      seedSession('sess-011', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      // Data still in DB — preview should show existing
      const backupPath = path.join(tmpDir, `${LOCAL_MACHINE}.sql`);
      const tables = restorePreview(getDatabase(), backupPath);

      const sessionTable = tables.find((t) => t.table === 'sessions');
      expect(sessionTable).toBeDefined();
      expect(sessionTable!.existing).toBe(1);
      expect(sessionTable!.new).toBe(0);
    });

    it('does not modify the database', () => {
      seedAgent();
      seedSession('sess-012', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      cleanTestDb();

      const db = getDatabase();
      const backupPath = path.join(tmpDir, `${LOCAL_MACHINE}.sql`);

      restorePreview(db, backupPath);

      // DB should still be empty after preview
      const count = db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number };
      expect(count.c).toBe(0);
    });
  });

  describe('restoreBackup()', () => {
    it('inserts new records', () => {
      seedAgent();
      seedSession('sess-020', LOCAL_MACHINE);
      seedSpore('spore-020', 'sess-020', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      cleanTestDb();

      const backupPath = path.join(tmpDir, `${LOCAL_MACHINE}.sql`);
      const result = restoreBackup(getDatabase(), backupPath);

      expect(result.total_restored).toBeGreaterThan(0);

      // Verify data is in the DB
      const db = getDatabase();
      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get('sess-020');
      expect(session).toBeDefined();

      const spore = db.prepare('SELECT id FROM spores WHERE id = ?').get('spore-020');
      expect(spore).toBeDefined();
    });

    it('skips existing records without duplication', () => {
      seedAgent();
      seedSession('sess-021', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      // Restore into DB that already has the data
      const backupPath = path.join(tmpDir, `${LOCAL_MACHINE}.sql`);
      const result = restoreBackup(getDatabase(), backupPath);

      const sessionTable = result.tables.find((t) => t.table === 'sessions');
      expect(sessionTable).toBeDefined();
      expect(sessionTable!.existing).toBe(1);
      expect(sessionTable!.new).toBe(0);

      // Still only 1 session
      const db = getDatabase();
      const count = db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('merges foreign machine data alongside local data', () => {
      seedAgent();
      // Local data
      seedSession('local-sess', LOCAL_MACHINE);

      // Create a backup from "remote" machine
      seedSession('remote-sess', REMOTE_MACHINE);
      createBackup(getDatabase(), tmpDir, REMOTE_MACHINE);

      // Remove the remote session, keep local
      getDatabase().prepare("DELETE FROM sessions WHERE id = 'remote-sess'").run();

      // Restore — should add remote-sess without touching local-sess
      const backupPath = path.join(tmpDir, `${REMOTE_MACHINE}.sql`);
      const result = restoreBackup(getDatabase(), backupPath);

      expect(result.total_restored).toBeGreaterThan(0);

      const db = getDatabase();
      const count = db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number };
      expect(count.c).toBe(2);
    });

    it('returns per-table breakdown', () => {
      seedAgent();
      seedSession('sess-030', LOCAL_MACHINE);
      seedSpore('spore-030', 'sess-030', LOCAL_MACHINE);
      seedPlan('plan-030', LOCAL_MACHINE);
      createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      cleanTestDb();

      const backupPath = path.join(tmpDir, `${LOCAL_MACHINE}.sql`);
      const result = restoreBackup(getDatabase(), backupPath);

      expect(result.tables.length).toBeGreaterThan(0);
      for (const t of result.tables) {
        expect(t).toHaveProperty('table');
        expect(t).toHaveProperty('new');
        expect(t).toHaveProperty('existing');
      }
      expect(result.total_restored).toBe(
        result.tables.reduce((sum, t) => sum + t.new, 0),
      );
      expect(result.total_skipped).toBe(
        result.tables.reduce((sum, t) => sum + t.existing, 0),
      );
    });
  });
});

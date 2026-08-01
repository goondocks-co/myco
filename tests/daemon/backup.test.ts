/**
 * Tests for the backup engine — create, list, preview, and restore.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
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
  DETACH_ARTIFACT_TABLES,
  createBackup,
  listBackups,
  previewRestoreContents,
  restoreBackup,
} from '@myco/backup/engine.js';

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
    logical_key: `backup:${id}`,
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
    it('includes the project-scoped capture surface plus team_members', () => {
      // Sample of tables we expect every backup to carry. The full set is
      // derived from GROVE_PROJECT_SCOPED_TABLES so the assertion list does
      // not need to mirror it exhaustively.
      expect(BACKUP_TABLES).toContain('sessions');
      expect(BACKUP_TABLES).toContain('spores');
      expect(BACKUP_TABLES).toContain('plans');
      expect(BACKUP_TABLES).toContain('entities');
      expect(BACKUP_TABLES).toContain('graph_edges');
      expect(BACKUP_TABLES).toContain('team_members');
      expect(BACKUP_TABLES).toContain('canopy_entries');
      expect(BACKUP_TABLES).toContain('canopy_maps');
    });

    it('covers every project-scoped table and nothing outside the surface', () => {
      // `entity_mentions` participates as of v75 (it gained the `id` primary
      // key the dump's INSERT OR IGNORE idempotency addresses rows by) — the
      // detach artifact is the ONLY carrier in that direction, so a carve-out
      // here is silent single-carrier data loss.
      expect(BACKUP_TABLES).toContain('entity_mentions');

      // Tables outside the project-scoped surface (and not team_members)
      // do not appear in BACKUP_TABLES.
      expect(BACKUP_TABLES).not.toContain('agents');
      expect(BACKUP_TABLES).not.toContain('team_outbox');
    });
  });

  describe('createBackup()', () => {
    it('creates a timestamped file under the machine_id prefix', () => {
      seedAgent();
      seedSession('sess-001', LOCAL_MACHINE);

      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      expect(filePath).toMatch(new RegExp(`${LOCAL_MACHINE}__[0-9]+\\.sql$`));
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('writes INSERT OR IGNORE statements for synced tables', () => {
      seedAgent();
      seedSession('sess-002', LOCAL_MACHINE);
      seedSpore('spore-001', 'sess-002', LOCAL_MACHINE);

      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('INSERT OR IGNORE INTO sessions');
      expect(content).toContain('INSERT OR IGNORE INTO spores');
      expect(content).toContain('sess-002');
      expect(content).toContain('spore-001');
    });

    it('includes header with machine_id and protocol version', () => {
      seedAgent();
      seedSession('sess-003', LOCAL_MACHINE);

      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain(`machine_id=${LOCAL_MACHINE}`);
      expect(content).toContain('Protocol version:');
    });

    it('excludes tables with no rows', () => {
      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const content = fs.readFileSync(filePath, 'utf-8');
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

      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain("It''s a test with ''quotes''");
    });

    it('produces a new timestamped file on every call', () => {
      seedAgent();
      seedSession('sess-004', LOCAL_MACHINE);

      const path1 = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      // Ensure ts increments — wait one second since stamps are epoch-seconds.
      const beforeSecond = Math.floor(Date.now() / 1000);
      while (Math.floor(Date.now() / 1000) === beforeSecond) { /* spin */ }
      const path2 = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      expect(path1).not.toBe(path2);
      expect(fs.readFileSync(path1, 'utf-8')).toContain('sess-004');
      expect(fs.readFileSync(path2, 'utf-8')).toContain('sess-004');
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
      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const expectedName = path.basename(filePath);

      const backups = listBackups(tmpDir);

      expect(backups).toHaveLength(1);
      expect(backups[0].machine_id).toBe(LOCAL_MACHINE);
      expect(backups[0].file_name).toBe(expectedName);
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

    it('ignores cloud-sync conflict files with special characters', () => {
      seedAgent();
      seedSession('sess-007', LOCAL_MACHINE);
      const filePath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      const expectedName = path.basename(filePath);

      fs.writeFileSync(
        path.join(tmpDir, `${LOCAL_MACHINE} (# Edit conflict 2000-01-01 XXXXXXX #).sql`),
        'fake backup',
      );
      fs.writeFileSync(
        path.join(tmpDir, `${LOCAL_MACHINE} (conflicted copy 2000-01-01).sql`),
        'fake backup',
      );
      fs.writeFileSync(
        path.join(tmpDir, `${LOCAL_MACHINE}.sync-conflict-20000101-000000-ABCDEF0.sql`),
        'fake backup',
      );

      const backups = listBackups(tmpDir);
      expect(backups).toHaveLength(1);
      expect(backups[0].file_name).toBe(expectedName);
    });
  });

  describe('previewRestoreContents()', () => {
    it('reports per-table counts from the dump headers without executing it', async () => {
      seedAgent();
      seedSession('sess-013', LOCAL_MACHINE);
      const backupPath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      const tables = await previewRestoreContents(getDatabase(), backupPath);
      const sessions = tables.find((t) => t.table === 'sessions');
      expect(sessions).toBeDefined();
      expect(sessions!.in_backup).toBe(1);
      expect(sessions!.in_db).toBe(1);
    });

    it('does not modify the database and reflects live db counts', async () => {
      seedAgent();
      seedSession('sess-014', LOCAL_MACHINE);
      const backupPath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      cleanTestDb();

      const db = getDatabase();
      const tables = await previewRestoreContents(db, backupPath);
      const sessions = tables.find((t) => t.table === 'sessions');
      expect(sessions!.in_backup).toBe(1);
      expect(sessions!.in_db).toBe(0);

      const count = db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number };
      expect(count.c).toBe(0);
    });
  });

  describe('restoreBackup()', () => {
    it('inserts new records', () => {
      seedAgent();
      seedSession('sess-020', LOCAL_MACHINE);
      seedSpore('spore-020', 'sess-020', LOCAL_MACHINE);
      const backupPath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      cleanTestDb();

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
      const backupPath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

      // Restore into DB that already has the data
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
      const backupPath = createBackup(getDatabase(), tmpDir, REMOTE_MACHINE);

      // Remove the remote session, keep local
      getDatabase().prepare("DELETE FROM sessions WHERE id = 'remote-sess'").run();

      // Restore — should add remote-sess without touching local-sess
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
      const backupPath = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
      cleanTestDb();

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

describe('restore atomicity (R7) + detach artifact set', () => {
  let tmpDir: string;
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); tmpDir = makeTmpBackupDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('a mid-dump failure lands ZERO rows — never a partially-restored project (R7)', () => {
    seedAgent();
    seedSession('s1', LOCAL_MACHINE);
    seedSpore('sp1', 's1', LOCAL_MACHINE);
    seedSpore('sp2', 's1', LOCAL_MACHINE);
    const dump = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);

    // Corrupt the dump midway: valid inserts, then a statement that throws.
    const content = fs.readFileSync(dump, 'utf-8');
    fs.writeFileSync(dump, content + '\nINSERT INTO no_such_table (x) VALUES (1);\n', 'utf-8');

    cleanTestDb(); // fresh empty target
    expect(() => restoreBackup(getDatabase(), dump)).toThrow();
    // The valid prefix must have rolled back with the failure.
    const count = (t: string) => (getDatabase().prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    expect(count('spores')).toBe(0);
    expect(count('sessions')).toBe(0);
  });

  it('restore is idempotent — a second identical restore adds nothing (R6)', () => {
    seedAgent();
    seedSession('s1', LOCAL_MACHINE);
    seedSpore('sp1', 's1', LOCAL_MACHINE);
    const dump = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE);
    cleanTestDb();
    const first = restoreBackup(getDatabase(), dump);
    const second = restoreBackup(getDatabase(), dump);
    expect(first.total_restored).toBeGreaterThan(0);
    expect(second.total_restored).toBe(0);
    expect(second.total_skipped).toBeGreaterThan(0);
  });

  it('a detach artifact carries the project and NEVER the host roster', () => {
    seedAgent();
    seedSession('s1', LOCAL_MACHINE);
    seedSpore('sp1', 's1', LOCAL_MACHINE);
    getDatabase().prepare(
      `INSERT INTO team_members (id, "user", machine_id) VALUES ('tm1', 'host-operator', 'host_roster_row')`,
    ).run();

    const dump = createBackup(getDatabase(), tmpDir, LOCAL_MACHINE, undefined, undefined, DETACH_ARTIFACT_TABLES);
    const content = fs.readFileSync(dump, 'utf-8');
    expect(content).toContain('INSERT OR IGNORE INTO spores');
    expect(content).not.toContain('team_members');
  });
});

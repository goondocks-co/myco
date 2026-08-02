import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import {
  addToKeepList,
  BackupSchemaMismatchError,
  createBackup,
  pruneBackups,
  readKeepList,
  restoreBackup,
} from '@myco/backup/engine.js';

const MACHINE = 'test-machine';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-keep-restore-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function makeVault(name: string, stampOverride?: number): string {
  const dbPath = path.join(workDir, name, 'myco.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    if (stampOverride !== undefined) {
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(stampOverride, epochSeconds());
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = openDatabase(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('keep-list prune exemption', () => {
  it('a pinned backup survives retention that would otherwise reclaim it', () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    // Two timestamped backups, oldest pinned.
    const old = path.join(backupDir, `${MACHINE}__100.sql`);
    const older = path.join(backupDir, `${MACHINE}__50.sql`);
    const newest = path.join(backupDir, `${MACHINE}__200.sql`);
    for (const f of [old, older, newest]) fs.writeFileSync(f, '-- Myco backup: machine_id=x\n');
    addToKeepList(backupDir, path.basename(older));

    const result = pruneBackups(backupDir, { keep_daily: 1, keep_weekly: 0 });

    // Newest kept by retention; pinned kept by exemption; middle pruned.
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.existsSync(older)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(result.removed).toEqual([path.basename(old)]);
  });

  it('caps pins PER machine — a shared folder cannot let one machine unpin another\'s', () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    // Machine B pins one checkpoint, then machine A pins six.
    const bPin = 'machine-b__10.sql';
    fs.writeFileSync(path.join(backupDir, bPin), 'x');
    addToKeepList(backupDir, bPin);
    for (let i = 1; i <= 6; i += 1) {
      const f = `machine-a__${i}.sql`;
      fs.writeFileSync(path.join(backupDir, f), 'x');
      addToKeepList(backupDir, f);
    }

    const kept = readKeepList(backupDir);
    expect(kept).toContain(bPin);
    expect(kept.filter((n) => n.startsWith('machine-a__')).length).toBe(5);
    expect(kept).not.toContain('machine-a__1.sql');
  });

  it('a corrupt keep-list fail-closes pruning instead of unpinning everything', () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= 3; i += 1) {
      fs.writeFileSync(path.join(backupDir, `${MACHINE}__${i}.sql`), 'x');
    }
    fs.writeFileSync(path.join(backupDir, 'keep.json'), '{not json');

    const result = pruneBackups(backupDir, { keep_daily: 1, keep_weekly: 0 });

    expect(result.removed).toEqual([]);
    for (let i = 1; i <= 3; i += 1) {
      expect(fs.existsSync(path.join(backupDir, `${MACHINE}__${i}.sql`))).toBe(true);
    }
  });

  it('caps pins at 5, dropping the oldest pin and stale entries', () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= 6; i += 1) {
      const f = path.join(backupDir, `${MACHINE}__${i}.sql`);
      fs.writeFileSync(f, 'x');
      addToKeepList(backupDir, path.basename(f));
    }
    const kept = readKeepList(backupDir);
    expect(kept.length).toBe(5);
    expect(kept).not.toContain(`${MACHINE}__1.sql`);
    expect(kept).toContain(`${MACHINE}__6.sql`);

    // An entry whose file vanished is dropped on the next add.
    fs.rmSync(path.join(backupDir, `${MACHINE}__3.sql`));
    addToKeepList(backupDir, `${MACHINE}__6.sql`);
    expect(readKeepList(backupDir)).not.toContain(`${MACHINE}__3.sql`);
  });
});

describe('restore direction gate', () => {
  it('refuses a newer-format dump into an older-format DB, typed', () => {
    const newVault = makeVault('new-src');
    withDb(newVault, (db) => {
      db.prepare(
        `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
         VALUES ('s1', 'claude-code', 100, 100, ?)`,
      ).run(MACHINE);
    });
    const backupPath = withDb(newVault, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    const oldVault = makeVault('old-target', SCHEMA_VERSION - 2);
    withDb(oldVault, (db) => {
      expect(() => restoreBackup(db, backupPath)).toThrow(BackupSchemaMismatchError);
      // Nothing landed.
      const n = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
      expect(n).toBe(0);
    });
  });

  it('allows an older-format dump into a newer DB (additive columns)', () => {
    const oldVault = makeVault('old-src', SCHEMA_VERSION - 2);
    withDb(oldVault, (db) => {
      db.prepare(
        `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
         VALUES ('s2', 'claude-code', 100, 100, ?)`,
      ).run(MACHINE);
    });
    const backupPath = withDb(oldVault, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    const newVault = makeVault('new-target');
    withDb(newVault, (db) => {
      const result = restoreBackup(db, backupPath);
      expect(result.total_restored).toBeGreaterThan(0);
    });
  });
});

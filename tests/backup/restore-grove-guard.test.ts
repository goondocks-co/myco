import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { createGroveId } from '@myco/grove/ids.js';
import { groveIdFromDbPath } from '@myco/grove/paths.js';
import {
  BackupGroveMismatchError,
  createBackup,
  readSnapshotHeader,
  restoreBackup,
} from '@myco/backup/engine.js';

const MACHINE = 'test-machine';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-restore-guard-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Create a schema-initialized DB at a Grove-shaped path. */
function createGroveShapedDb(groveId: string, home = 'home'): string {
  const dbPath = path.join(workDir, home, 'groves', groveId, 'myco.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
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

function seedSession(dbPath: string, id: string): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
       VALUES (?, 'claude-code', 100, 100, ?)`,
    ).run(id, MACHINE);
  });
}

function sessionCount(dbPath: string): number {
  return withDb(dbPath, (db) =>
    (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
  );
}

describe('restoreBackup Grove lineage guard', () => {
  it('records the source grove_id in the dump header', () => {
    const groveId = createGroveId();
    const dbPath = createGroveShapedDb(groveId);
    seedSession(dbPath, 'sess-1');

    const backupPath = withDb(dbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    expect(groveIdFromDbPath(dbPath)).toBe(groveId);
    expect(readSnapshotHeader(backupPath).grove_id).toBe(groveId);
  });

  it('refuses to restore another Grove\'s archive and leaves the target untouched', () => {
    const sourceGroveId = createGroveId();
    const targetGroveId = createGroveId();
    const sourceDbPath = createGroveShapedDb(sourceGroveId);
    const targetDbPath = createGroveShapedDb(targetGroveId);
    seedSession(sourceDbPath, 'sess-1');

    const backupPath = withDb(sourceDbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    withDb(targetDbPath, (db) => {
      let caught: unknown;
      try {
        restoreBackup(db, backupPath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BackupGroveMismatchError);
      expect((caught as BackupGroveMismatchError).backupGroveId).toBe(sourceGroveId);
      expect((caught as BackupGroveMismatchError).targetGroveId).toBe(targetGroveId);
    });
    expect(sessionCount(targetDbPath)).toBe(0);
  });

  it('restores a legacy archive without grove_id lineage', () => {
    const sourceGroveId = createGroveId();
    const targetGroveId = createGroveId();
    const sourceDbPath = createGroveShapedDb(sourceGroveId);
    const targetDbPath = createGroveShapedDb(targetGroveId);
    seedSession(sourceDbPath, 'sess-legacy');

    const backupPath = withDb(sourceDbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );
    // Strip the lineage line, emulating an archive from before grove_id
    // was recorded.
    const stripped = fs.readFileSync(backupPath, 'utf-8')
      .split('\n')
      .filter((line) => !line.startsWith('-- grove_id:'))
      .join('\n');
    fs.writeFileSync(backupPath, stripped, 'utf-8');
    expect(readSnapshotHeader(backupPath).grove_id).toBeNull();

    const result = withDb(targetDbPath, (db) => restoreBackup(db, backupPath));
    expect(result.total_restored).toBeGreaterThan(0);
    expect(sessionCount(targetDbPath)).toBe(1);
  });

  it('restores a same-Grove archive into another machine\'s copy of that Grove', () => {
    const groveId = createGroveId();
    const machineADbPath = createGroveShapedDb(groveId, 'machine-a');
    const machineBDbPath = createGroveShapedDb(groveId, 'machine-b');
    seedSession(machineADbPath, 'sess-from-a');

    const backupPath = withDb(machineADbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    const result = withDb(machineBDbPath, (db) => restoreBackup(db, backupPath));
    expect(result.total_restored).toBeGreaterThan(0);
    expect(sessionCount(machineBDbPath)).toBe(1);
  });

  it('keeps restoring archives of non-Grove DBs (no lineage recorded)', () => {
    const looseDbPath = path.join(workDir, 'loose.db');
    withDb(looseDbPath, (db) => createSchema(db));
    seedSession(looseDbPath, 'sess-loose');

    const backupPath = withDb(looseDbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );
    expect(readSnapshotHeader(backupPath).grove_id).toBeNull();

    const targetGroveId = createGroveId();
    const targetDbPath = createGroveShapedDb(targetGroveId);
    const result = withDb(targetDbPath, (db) => restoreBackup(db, backupPath));
    expect(result.total_restored).toBeGreaterThan(0);
  });
});

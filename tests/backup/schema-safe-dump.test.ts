import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import {
  BACKUP_TABLES,
  createBackup,
  readSnapshotHeader,
} from '@myco/backup/engine.js';

const MACHINE = 'test-machine';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-safe-dump-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function createVaultDb(name: string): string {
  const dbPath = path.join(workDir, name, 'myco.db');
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

describe('createBackup schema safety', () => {
  it('records the stamped schema_version in the header and round-trips it', () => {
    const dbPath = createVaultDb('current');
    const backupPath = withDb(dbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    const header = readSnapshotHeader(backupPath);
    expect(header.schema_version).toBe(SCHEMA_VERSION);
    expect(header.skipped_tables).toEqual([]);
  });

  it('records the OLD stamped version when the vault is behind the binary', () => {
    const dbPath = createVaultDb('behind');
    withDb(dbPath, (db) => {
      // Fresh installs stamp only the current version; rewrite the stamp to
      // simulate a vault frozen two versions back.
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, 100)')
        .run(SCHEMA_VERSION - 2);
    });

    const backupPath = withDb(dbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    expect(readSnapshotHeader(backupPath).schema_version).toBe(SCHEMA_VERSION - 2);
  });

  it('dumps only tables present in the DB and lists the rest as skipped', () => {
    const dbPath = createVaultDb('old-schema');
    // Simulate an old-schema vault relative to the requested table list by
    // asking for tables this DB does not have.
    const requested = [...BACKUP_TABLES, 'table_from_the_future', 'another_future_table'];

    const backupPath = withDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
         VALUES ('sess-1', 'claude-code', 100, 100, ?)`,
      ).run(MACHINE);
      return createBackup(db, path.join(workDir, 'backups'), MACHINE, undefined, undefined, requested);
    });

    const header = readSnapshotHeader(backupPath);
    expect(header.skipped_tables).toEqual(['table_from_the_future', 'another_future_table']);

    const content = fs.readFileSync(backupPath, 'utf-8');
    expect(content).toContain('-- Table: sessions');
    expect(content).not.toContain('-- Table: table_from_the_future');
    expect(content).not.toContain('INSERT OR IGNORE INTO table_from_the_future');
  });

  it('does not throw on a DB missing tables from BACKUP_TABLES (old-schema vault)', () => {
    const dbPath = createVaultDb('missing-member');
    withDb(dbPath, (db) => {
      db.exec('DROP TABLE entity_mentions');
    });

    const backupPath = withDb(dbPath, (db) =>
      createBackup(db, path.join(workDir, 'backups'), MACHINE),
    );

    expect(readSnapshotHeader(backupPath).skipped_tables).toEqual(['entity_mentions']);
  });

  it('streams the dump in bounded chunks — never one whole-dump string', () => {
    // The pre-migration checkpoint runs createBackup on the daemon's boot
    // path; a whole-dump accumulator is a multi-GB RSS spike and a V8
    // max-string-length throw on large vaults, which the fail-closed
    // checkpoint converts into "the daemon cannot start". The streamed
    // writer flushes ~1MB buffers, so a dump comfortably larger than one
    // buffer MUST produce multiple writeSync calls. A revert to
    // accumulation produces exactly one write and fails here.
    const dbPath = createVaultDb('streaming');
    withDb(dbPath, (db) => {
      const insert = db.prepare(
        `INSERT INTO sessions (id, agent, started_at, created_at, machine_id, summary)
         VALUES (?, 'claude-code', 100, 100, ?, ?)`,
      );
      const bigSummary = 'x'.repeat(60_000);
      for (let i = 0; i < 60; i += 1) {
        insert.run(`sess-${i}`, MACHINE, bigSummary);
      }
    });

    const realWriteSync = fs.writeSync;
    let writeCalls = 0;
    // eslint-disable-next-line no-import-assign -- restored in finally
    (fs as { writeSync: typeof fs.writeSync }).writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      writeCalls += 1;
      return realWriteSync(...args);
    }) as typeof fs.writeSync;
    let backupPath: string;
    try {
      backupPath = withDb(dbPath, (db) =>
        createBackup(db, path.join(workDir, 'backups'), MACHINE),
      );
    } finally {
      (fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
    }

    // ~3.6MB of rows through a ~1MB buffer: at least 3 flushes.
    expect(writeCalls).toBeGreaterThan(1);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(2_000_000);
  });

  it('emits no schema_version line for a DB without a schema_version table', () => {
    const dbPath = path.join(workDir, 'bare', 'myco.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    let backupPath: string;
    try {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
      backupPath = createBackup(db, path.join(workDir, 'backups'), MACHINE, undefined, undefined, ['sessions']);
    } finally {
      db.close();
    }

    expect(readSnapshotHeader(backupPath).schema_version).toBeNull();
  });
});

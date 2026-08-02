import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION, setPreMigrationHook } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import { createGroveId } from '@myco/grove/ids.js';
import { pruneBackups, readSnapshotHeader } from '@myco/backup/engine.js';
import {
  installPreMigrationCheckpoint,
  PreMigrationCheckpointError,
} from '@myco/backup/pre-migration-checkpoint.js';
import { listGroveBackups } from '@myco/backup/service.js';

let workDir: string;
let mycoHome: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-premigration-checkpoint-'));
  mycoHome = path.join(workDir, 'home');
});

afterEach(() => {
  setPreMigrationHook(null);
  fs.rmSync(workDir, { recursive: true, force: true });
});

function stampedVersion(db: Database): number {
  const row = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
  ).get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/** A Grove-shaped vault whose stamp is rolled back one version. */
function createPendingGroveVault(groveId: string): string {
  const dbPath = path.join(mycoHome, 'groves', groveId, 'myco.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION - 1, epochSeconds());
  } finally {
    db.close();
  }
  return dbPath;
}

describe('pre-migration checkpoint', () => {
  it('dumps the Grove BEFORE migrating and stamps the OLD version in the header', () => {
    const groveId = createGroveId();
    const dbPath = createPendingGroveVault(groveId);
    installPreMigrationCheckpoint({ mycoHome });

    const db = openDatabase(dbPath);
    try {
      createSchema(db, 'machine-a');
      expect(stampedVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }

    const backups = listGroveBackups(groveId, { mycoHome });
    expect(backups.length).toBe(1);
    const header = readSnapshotHeader(backups[0].path);
    expect(header.schema_version).toBe(SCHEMA_VERSION - 1);
    expect(header.grove_id).toBe(groveId);
  });

  it('does not checkpoint when no migration is pending', () => {
    const groveId = createGroveId();
    const dbPath = path.join(mycoHome, 'groves', groveId, 'myco.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    installPreMigrationCheckpoint({ mycoHome });

    const db = openDatabase(dbPath);
    try {
      createSchema(db); // fresh install
      createSchema(db); // same-version reapply
    } finally {
      db.close();
    }

    expect(listGroveBackups(groveId, { mycoHome }).length).toBe(0);
  });

  it('skips non-Grove databases (temp snapshots, ad-hoc paths)', () => {
    const dbPath = path.join(workDir, 'adhoc', 'myco.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    try {
      createSchema(db);
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION - 1, epochSeconds());
    } finally {
      db.close();
    }

    installPreMigrationCheckpoint({ mycoHome });

    const db2 = openDatabase(dbPath);
    try {
      // Migrates without a checkpoint and without throwing.
      createSchema(db2);
      expect(stampedVersion(db2)).toBe(SCHEMA_VERSION);
    } finally {
      db2.close();
    }
  });

  it('the checkpoint is pinned against retention pruning', () => {
    const groveId = createGroveId();
    const dbPath = createPendingGroveVault(groveId);
    installPreMigrationCheckpoint({ mycoHome });

    const db = openDatabase(dbPath);
    try {
      createSchema(db, 'machine-a');
    } finally {
      db.close();
    }

    const [checkpoint] = listGroveBackups(groveId, { mycoHome });
    // Harsher than any reachable config (keep_daily has a .min(1) floor):
    // if the pin holds here it holds under every valid retention policy.
    const prune = pruneBackups(checkpoint.dir, { keep_daily: 0, keep_weekly: 0 });
    expect(prune.removed).toEqual([]);
    expect(fs.existsSync(checkpoint.path)).toBe(true);
  });

  it('a failed checkpoint aborts the migration with the stamp unchanged', () => {
    const groveId = createGroveId();
    const dbPath = createPendingGroveVault(groveId);
    installPreMigrationCheckpoint({ mycoHome });

    // Make the Grove's backup dir unusable: a FILE where the backups
    // directory must be created.
    const groveDir = path.join(mycoHome, 'groves', groveId);
    fs.writeFileSync(path.join(groveDir, 'backups'), 'not a directory');

    const db = openDatabase(dbPath);
    try {
      expect(() => createSchema(db)).toThrow(PreMigrationCheckpointError);
      expect(stampedVersion(db)).toBe(SCHEMA_VERSION - 1);
    } finally {
      db.close();
    }
  });
});

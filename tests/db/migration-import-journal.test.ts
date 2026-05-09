import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import {
  listImportMappingsForMigration,
  lookupImportMappingBySource,
  lookupImportMappingByTarget,
  markImportMappingStatus,
  recordImportMapping,
} from '@myco/db/queries/migration-import-journal.js';
import { createMigrationId } from '@myco/grove/ids.js';

function tableExists(tableName: string): boolean {
  const row = getDatabase().prepare(
    `SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(tableName) as { count: number };
  return row.count === 1;
}

function indexExists(indexName: string): boolean {
  const row = getDatabase().prepare(
    `SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?`,
  ).get(indexName) as { count: number };
  return row.count === 1;
}

describe('migration import journal', () => {
  beforeEach(() => {
    const db = initDatabase();
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('is installed by the current schema', () => {
    expect(SCHEMA_VERSION).toBe(38);
    expect(tableExists('migration_import_journal')).toBe(true);
    expect(indexExists('idx_migration_import_journal_source')).toBe(true);
    expect(indexExists('idx_migration_import_journal_target')).toBe(true);
  });

  it('records and resolves source-to-target row mappings', () => {
    const migrationId = createMigrationId();
    const row = recordImportMapping({
      migration_id: migrationId,
      source_project_root: '/legacy/project',
      source_db_path: '/legacy/project/.myco/myco.db',
      target_grove_id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source_table: 'plans',
      source_id: 'old-plan-id',
      target_table: 'plans',
      target_id: 'plan_cccccccccccccccccccccccccccccccc',
      source_machine_id: 'legacy-machine',
      target_machine_id: 'target-machine',
      import_origin: 'local',
    });

    expect(row.id).toMatch(/^mmap_[0-9a-f]{32}$/);
    expect(row.status).toBe('mapped');
    expect(lookupImportMappingBySource(migrationId, 'plans', 'old-plan-id')?.target_id)
      .toBe('plan_cccccccccccccccccccccccccccccccc');
    expect(lookupImportMappingByTarget(migrationId, 'plans', 'plan_cccccccccccccccccccccccccccccccc')?.source_id)
      .toBe('old-plan-id');
  });

  it('upserts source mappings so migration retries do not duplicate rows', () => {
    const migrationId = createMigrationId();
    const first = recordImportMapping({
      migration_id: migrationId,
      source_project_root: '/legacy/project',
      source_db_path: '/legacy/project/.myco/myco.db',
      target_grove_id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source_table: 'spores',
      source_id: 42,
      target_table: 'spores',
      target_id: 'spore_cccccccccccccccccccccccccccccccc',
    });
    const retry = recordImportMapping({
      migration_id: migrationId,
      source_project_root: '/legacy/project',
      source_db_path: '/legacy/project/.myco/myco.db',
      target_grove_id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source_table: 'spores',
      source_id: 42,
      target_table: 'spores',
      target_id: 'spore_dddddddddddddddddddddddddddddddd',
      status: 'imported',
      notes: 'retry selected rebuilt row',
    });

    expect(retry.id).toBe(first.id);
    expect(retry.source_id).toBe('42');
    expect(retry.target_id).toBe('spore_dddddddddddddddddddddddddddddddd');
    expect(retry.status).toBe('imported');
    expect(listImportMappingsForMigration(migrationId)).toHaveLength(1);
  });

  it('distinguishes overlapping source ids from different project vault imports', () => {
    const migrationId = createMigrationId();
    recordImportMapping({
      migration_id: migrationId,
      source_project_root: '/legacy/project-a',
      source_db_path: '/legacy/project-a/.myco/myco.db',
      target_grove_id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      source_table: 'plans',
      source_id: 'same-id',
      target_table: 'plans',
      target_id: 'plan_same_target_id',
    });
    recordImportMapping({
      migration_id: migrationId,
      source_project_root: '/legacy/project-b',
      source_db_path: '/legacy/project-b/.myco/myco.db',
      target_grove_id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source_table: 'plans',
      source_id: 'same-id',
      target_table: 'plans',
      target_id: 'plan_same_target_id',
    });

    expect(listImportMappingsForMigration(migrationId)).toHaveLength(2);
    expect(lookupImportMappingBySource(migrationId, 'plans', 'same-id', {
      source_db_path: '/legacy/project-a/.myco/myco.db',
    })?.target_project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(lookupImportMappingBySource(migrationId, 'plans', 'same-id', {
      source_db_path: '/legacy/project-b/.myco/myco.db',
    })?.target_project_id).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(lookupImportMappingByTarget(migrationId, 'plans', 'plan_same_target_id', {
      target_project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })?.source_project_root).toBe('/legacy/project-b');
  });

  it('updates status and error fields for failed imports', () => {
    const migrationId = createMigrationId();
    recordImportMapping({
      migration_id: migrationId,
      source_project_root: '/legacy/project',
      source_db_path: '/legacy/project/.myco/myco.db',
      target_grove_id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source_table: 'sessions',
      source_id: 'old-session',
      target_table: 'sessions',
      target_id: 'sess_cccccccccccccccccccccccccccccccc',
    });

    const failed = markImportMappingStatus(migrationId, 'sessions', 'old-session', 'error', {
      error: 'missing parent batch',
    });

    expect(failed.status).toBe('error');
    expect(failed.error).toBe('missing parent batch');
  });

  it('runs the import-journal migration against a v30 database on the way to current schema', () => {
    closeDatabase();
    const db = initDatabase();
    db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (30, 1000)').run();

    createSchema(db);

    expect(tableExists('migration_import_journal')).toBe(true);
    const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    expect(version.version).toBe(38);
  });

  // The base "schema_version=38" assertion above proves the migration
  // chain runs end-to-end, but doesn't prove v37 ACTUALLY DELETES journal
  // contents. Without seeded rows, an empty post-migration table is
  // indistinguishable from "nothing was there to begin with" — so a
  // future regression that no-op'd v37 would still pass that test.
  // This case seeds rows AT v36 and asserts they're gone after the
  // chain replays through v37.
  it('v37 deletes pre-migration journal rows when a v36 database is migrated forward', () => {
    closeDatabase();
    const db = initDatabase();

    // Build the pre-v37 surface manually: schema_version table + the
    // journal table with the same DDL the chain installed at v34.
    db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (36, 1000)').run();
    db.prepare(`
      CREATE TABLE migration_import_journal (
        id                   TEXT PRIMARY KEY,
        migration_id         TEXT NOT NULL,
        source_project_root  TEXT NOT NULL,
        source_db_path       TEXT NOT NULL,
        target_grove_id      TEXT NOT NULL,
        target_project_id    TEXT NOT NULL,
        source_table         TEXT NOT NULL,
        source_id            TEXT NOT NULL,
        target_table         TEXT NOT NULL,
        target_id            TEXT NOT NULL,
        source_machine_id    TEXT,
        target_machine_id    TEXT,
        import_origin        TEXT NOT NULL DEFAULT 'local',
        status               TEXT NOT NULL DEFAULT 'mapped',
        notes                TEXT,
        error                TEXT,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      )
    `).run();

    // Seed three rows that look like real importer output. v37's job is
    // to wipe ALL of them, regardless of status — the activation marker
    // already moved past them so they're dead weight.
    const seedRow = (id: string, status: string) => {
      db.prepare(`
        INSERT INTO migration_import_journal (
          id, migration_id, source_project_root, source_db_path,
          target_grove_id, target_project_id, source_table, source_id,
          target_table, target_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, 'mig_old', '/legacy/project', '/legacy/project/.myco/myco.db',
        'grove_test', 'proj_test', 'plans', `src-${id}`,
        'plans', `tgt-${id}`, status, 1000, 1000,
      );
    };
    seedRow('mmap_a', 'mapped');
    seedRow('mmap_b', 'imported');
    seedRow('mmap_c', 'error');

    const before = db.prepare('SELECT COUNT(*) AS n FROM migration_import_journal').get() as { n: number };
    expect(before.n).toBe(3);

    // Run only v37 in isolation — running the full chain through v38+
    // would require seeding additional Grove-era tables (prompt_batches
    // ALTER, etc.). v37's contract is "wipe migration_import_journal
    // contents and stamp version 37," and that's exactly what this
    // assertion proves.
    const v37 = MIGRATIONS.find((m) => m.version === 37)!;
    v37.migrate(db, 'local');

    const after = db.prepare('SELECT COUNT(*) AS n FROM migration_import_journal').get() as { n: number };
    expect(after.n).toBe(0);

    const version = db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
    ).get() as { version: number };
    expect(version.version).toBe(37);
  });
});

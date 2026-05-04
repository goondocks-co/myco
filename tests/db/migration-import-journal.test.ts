import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
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
    expect(SCHEMA_VERSION).toBe(34);
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
    expect(version.version).toBe(34);
  });
});

import type { Database } from 'bun:sqlite';
import { epochSeconds } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import { createMigrationMappingId } from '@myco/grove/ids.js';

export type ImportMappingStatus = 'mapped' | 'imported' | 'skipped' | 'error';

export interface ImportMappingInput {
  migration_id: string;
  source_project_root: string;
  source_db_path: string;
  target_grove_id: string;
  target_project_id: string;
  source_table: string;
  source_id: string | number;
  target_table: string;
  target_id: string;
  source_machine_id?: string | null;
  target_machine_id?: string | null;
  import_origin?: string;
  status?: ImportMappingStatus;
  notes?: string | null;
  error?: string | null;
}

export interface ImportMappingRow {
  id: string;
  migration_id: string;
  source_project_root: string;
  source_db_path: string;
  target_grove_id: string;
  target_project_id: string;
  source_table: string;
  source_id: string;
  target_table: string;
  target_id: string;
  source_machine_id: string | null;
  target_machine_id: string | null;
  import_origin: string;
  status: ImportMappingStatus;
  notes: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLUMNS = [
  'id',
  'migration_id',
  'source_project_root',
  'source_db_path',
  'target_grove_id',
  'target_project_id',
  'source_table',
  'source_id',
  'target_table',
  'target_id',
  'source_machine_id',
  'target_machine_id',
  'import_origin',
  'status',
  'notes',
  'error',
  'created_at',
  'updated_at',
].join(', ');

const VALID_STATUSES = new Set<ImportMappingStatus>(['mapped', 'imported', 'skipped', 'error']);

export function recordImportMapping(input: ImportMappingInput, db: Database = getDatabase()): ImportMappingRow {
  const normalized = normalizeInput(input);
  const now = epochSeconds();
  const id = createMigrationMappingId();

  db.prepare(
    `INSERT INTO migration_import_journal (
       id, migration_id, source_project_root, source_db_path,
       target_grove_id, target_project_id,
       source_table, source_id, target_table, target_id,
       source_machine_id, target_machine_id, import_origin,
       status, notes, error, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (migration_id, source_table, source_id) DO UPDATE SET
       source_project_root = excluded.source_project_root,
       source_db_path = excluded.source_db_path,
       target_grove_id = excluded.target_grove_id,
       target_project_id = excluded.target_project_id,
       target_table = excluded.target_table,
       target_id = excluded.target_id,
       source_machine_id = excluded.source_machine_id,
       target_machine_id = excluded.target_machine_id,
       import_origin = excluded.import_origin,
       status = excluded.status,
       notes = excluded.notes,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    normalized.migration_id,
    normalized.source_project_root,
    normalized.source_db_path,
    normalized.target_grove_id,
    normalized.target_project_id,
    normalized.source_table,
    normalized.source_id,
    normalized.target_table,
    normalized.target_id,
    normalized.source_machine_id,
    normalized.target_machine_id,
    normalized.import_origin,
    normalized.status,
    normalized.notes,
    normalized.error,
    now,
    now,
  );

  const row = lookupImportMappingBySource(
    normalized.migration_id,
    normalized.source_table,
    normalized.source_id,
    db,
  );
  if (!row) throw new Error('Failed to record import mapping');
  return row;
}

export function lookupImportMappingBySource(
  migrationId: string,
  sourceTable: string,
  sourceId: string | number,
  db: Database = getDatabase(),
): ImportMappingRow | null {
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM migration_import_journal
      WHERE migration_id = ? AND source_table = ? AND source_id = ?`,
  ).get(migrationId, sourceTable, String(sourceId)) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function lookupImportMappingByTarget(
  migrationId: string,
  targetTable: string,
  targetId: string,
  db: Database = getDatabase(),
): ImportMappingRow | null {
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM migration_import_journal
      WHERE migration_id = ? AND target_table = ? AND target_id = ?`,
  ).get(migrationId, targetTable, targetId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function listImportMappingsForMigration(
  migrationId: string,
  db: Database = getDatabase(),
): ImportMappingRow[] {
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM migration_import_journal
      WHERE migration_id = ?
      ORDER BY created_at ASC, id ASC`,
  ).all(migrationId) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

export function markImportMappingStatus(
  migrationId: string,
  sourceTable: string,
  sourceId: string | number,
  status: ImportMappingStatus,
  options: { notes?: string | null; error?: string | null } = {},
  db: Database = getDatabase(),
): ImportMappingRow {
  assertStatus(status);
  db.prepare(
    `UPDATE migration_import_journal
        SET status = ?,
            notes = COALESCE(?, notes),
            error = ?,
            updated_at = ?
      WHERE migration_id = ? AND source_table = ? AND source_id = ?`,
  ).run(
    status,
    options.notes ?? null,
    options.error ?? null,
    epochSeconds(),
    migrationId,
    sourceTable,
    String(sourceId),
  );

  const row = lookupImportMappingBySource(migrationId, sourceTable, sourceId, db);
  if (!row) throw new Error(`Import mapping not found: ${migrationId}/${sourceTable}/${sourceId}`);
  return row;
}

function normalizeInput(input: ImportMappingInput): Required<ImportMappingInput> {
  const normalized = {
    ...input,
    source_id: String(input.source_id),
    source_machine_id: input.source_machine_id ?? null,
    target_machine_id: input.target_machine_id ?? null,
    import_origin: input.import_origin ?? 'local',
    status: input.status ?? 'mapped',
    notes: input.notes ?? null,
    error: input.error ?? null,
  };

  for (const key of [
    'migration_id',
    'source_project_root',
    'source_db_path',
    'target_grove_id',
    'target_project_id',
    'source_table',
    'source_id',
    'target_table',
    'target_id',
    'import_origin',
  ] as const) {
    const value = normalized[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Import mapping ${key} is required`);
    }
  }

  assertStatus(normalized.status);
  return normalized as Required<ImportMappingInput>;
}

function assertStatus(status: string): asserts status is ImportMappingStatus {
  if (VALID_STATUSES.has(status as ImportMappingStatus)) return;
  throw new Error(`Invalid import mapping status: ${status}`);
}

function mapRow(row: Record<string, unknown>): ImportMappingRow {
  return {
    id: row.id as string,
    migration_id: row.migration_id as string,
    source_project_root: row.source_project_root as string,
    source_db_path: row.source_db_path as string,
    target_grove_id: row.target_grove_id as string,
    target_project_id: row.target_project_id as string,
    source_table: row.source_table as string,
    source_id: row.source_id as string,
    target_table: row.target_table as string,
    target_id: row.target_id as string,
    source_machine_id: (row.source_machine_id as string | null) ?? null,
    target_machine_id: (row.target_machine_id as string | null) ?? null,
    import_origin: row.import_origin as string,
    status: row.status as ImportMappingStatus,
    notes: (row.notes as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

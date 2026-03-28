/**
 * Backup engine — SQL-dump backup and restore for synced vault tables.
 *
 * Produces portable `INSERT OR IGNORE` SQL dumps scoped to a single machine.
 * Restore merges foreign machine data without overwriting local records.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { SYNC_PROTOCOL_VERSION, epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tables included in backup dumps (all synced tables). */
export const BACKUP_TABLES = [
  'sessions',
  'prompt_batches',
  'spores',
  'entities',
  'graph_edges',
  'entity_mentions',
  'resolution_events',
  'plans',
  'artifacts',
  'digest_extracts',
  'team_members',
] as const;

/** File extension for backup dumps. */
const BACKUP_EXTENSION = '.sql';

/** Header comment template for backup files. */
const BACKUP_HEADER_TEMPLATE = '-- Myco backup';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata for a backup file on disk. */
export interface BackupMeta {
  machine_id: string;
  file_name: string;
  size_bytes: number;
  modified_at: string;
}

/** Per-table counts returned by restore preview/execute. */
export interface TableCounts {
  table: string;
  new: number;
  existing: number;
}

/** Result returned by restoreBackup. */
export interface RestoreResult {
  tables: TableCounts[];
  total_restored: number;
  total_skipped: number;
}

// ---------------------------------------------------------------------------
// SQL value serialization
// ---------------------------------------------------------------------------

/**
 * Escape a string value for inclusion in a SQL literal.
 * Doubles single quotes per SQL standard.
 */
function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Serialize a JavaScript value into a SQL literal.
 *
 * - null / undefined → NULL
 * - number → numeric literal
 * - Buffer → X'hex'
 * - string → 'escaped string'
 */
function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  return `'${escapeSql(String(value))}'`;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Create a SQL dump backup of all synced tables.
 *
 * Writes `INSERT OR IGNORE` statements for every row in BACKUP_TABLES
 * to `{backupDir}/{machineId}.sql`. Idempotent — overwrites any existing
 * backup for the same machine.
 *
 * @returns the absolute path of the created backup file.
 */
export function createBackup(
  db: Database,
  backupDir: string,
  machineId: string,
): string {
  fs.mkdirSync(backupDir, { recursive: true });

  const lines: string[] = [];
  const timestamp = epochSeconds();

  // Header
  lines.push(`${BACKUP_HEADER_TEMPLATE}: machine_id=${machineId}, created_at=${timestamp}`);
  lines.push(`-- Protocol version: ${SYNC_PROTOCOL_VERSION}`);
  lines.push('');

  for (const table of BACKUP_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    if (rows.length === 0) continue;

    lines.push(`-- Table: ${table} (${rows.length} rows)`);

    // Get column names from the first row
    const columns = Object.keys(rows[0]);
    const columnList = columns.map((c) => `"${c}"`).join(', ');

    for (const row of rows) {
      const values = columns.map((c) => toSqlLiteral(row[c])).join(', ');
      lines.push(`INSERT OR IGNORE INTO ${table} (${columnList}) VALUES (${values});`);
    }

    lines.push('');
  }

  const filePath = path.join(backupDir, `${machineId}${BACKUP_EXTENSION}`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  return filePath;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Scan the backup directory for `.sql` files and return metadata.
 *
 * Machine ID is derived from the filename (stripping the extension).
 */
export function listBackups(backupDir: string): BackupMeta[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return [];
  }

  const backups: BackupMeta[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(BACKUP_EXTENSION)) continue;

    const filePath = path.join(backupDir, entry);
    const stat = fs.statSync(filePath);

    backups.push({
      machine_id: entry.slice(0, -BACKUP_EXTENSION.length),
      file_name: entry,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }

  return backups.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

// ---------------------------------------------------------------------------
// Restore helpers
// ---------------------------------------------------------------------------

/** Regex matching INSERT OR IGNORE statements generated by createBackup. */
const INSERT_REGEX = /^INSERT OR IGNORE INTO (\w+)\s+\(([^)]+)\)\s+VALUES\s+\((.+)\);$/;

/** Parsed INSERT statement. */
interface ParsedInsert {
  table: string;
  columns: string[];
  valueSql: string;
}

/**
 * Parse all INSERT statements from a backup file.
 */
function parseBackupFile(backupPath: string): ParsedInsert[] {
  const content = fs.readFileSync(backupPath, 'utf-8');
  const inserts: ParsedInsert[] = [];

  for (const line of content.split('\n')) {
    const match = INSERT_REGEX.exec(line);
    if (!match) continue;

    inserts.push({
      table: match[1],
      columns: match[2].split(',').map((c) => c.trim().replace(/"/g, '')),
      valueSql: match[3],
    });
  }

  return inserts;
}

// ---------------------------------------------------------------------------
// Restore preview
// ---------------------------------------------------------------------------

/**
 * Preview what a restore would do without making changes.
 *
 * For each INSERT in the backup, checks if a conflicting row already exists
 * (via INSERT OR IGNORE in a savepoint that gets rolled back).
 *
 * Returns per-table counts of new vs existing records.
 */
export function restorePreview(
  db: Database,
  backupPath: string,
): TableCounts[] {
  const inserts = parseBackupFile(backupPath);
  const counts = new Map<string, { new: number; existing: number }>();

  // Defer FK checks — backup may reference rows in non-synced tables
  db.pragma('foreign_keys = OFF');
  // Use a savepoint so we can test INSERTs without persisting
  db.exec('SAVEPOINT restore_preview');
  try {
    for (const insert of inserts) {
      if (!counts.has(insert.table)) {
        counts.set(insert.table, { new: 0, existing: 0 });
      }
      const tableCounts = counts.get(insert.table)!;

      try {
        const columnList = insert.columns.map((c) => `"${c}"`).join(', ');
        const stmt = `INSERT OR IGNORE INTO ${insert.table} (${columnList}) VALUES (${insert.valueSql})`;
        const result = db.prepare(stmt).run();

        if (result.changes > 0) {
          tableCounts.new++;
        } else {
          tableCounts.existing++;
        }
      } catch {
        tableCounts.existing++;
      }
    }
  } finally {
    db.exec('ROLLBACK TO restore_preview');
    db.exec('RELEASE restore_preview');
    db.pragma('foreign_keys = ON');
  }

  return Array.from(counts.entries()).map(([table, c]) => ({
    table,
    new: c.new,
    existing: c.existing,
  }));
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a backup by running all INSERTs in a transaction.
 *
 * Uses `INSERT OR IGNORE` — existing records are skipped, new records
 * are inserted. Returns per-table counts.
 */
export function restoreBackup(
  db: Database,
  backupPath: string,
): RestoreResult {
  const inserts = parseBackupFile(backupPath);
  const counts = new Map<string, { new: number; existing: number }>();

  // Defer FK checks — backup may reference rows in non-synced tables (e.g. agents)
  // that don't exist yet. Re-enable after the transaction.
  db.pragma('foreign_keys = OFF');
  try {
    const runRestore = db.transaction(() => {
      for (const insert of inserts) {
        if (!counts.has(insert.table)) {
          counts.set(insert.table, { new: 0, existing: 0 });
        }
        const tableCounts = counts.get(insert.table)!;

        const columnList = insert.columns.map((c) => `"${c}"`).join(', ');
        const stmt = `INSERT OR IGNORE INTO ${insert.table} (${columnList}) VALUES (${insert.valueSql})`;
        const result = db.prepare(stmt).run();

        if (result.changes > 0) {
          tableCounts.new++;
        } else {
          tableCounts.existing++;
        }
      }
    });

    runRestore();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const tables = Array.from(counts.entries()).map(([table, c]) => ({
    table,
    new: c.new,
    existing: c.existing,
  }));

  const total_restored = tables.reduce((sum, t) => sum + t.new, 0);
  const total_skipped = tables.reduce((sum, t) => sum + t.existing, 0);

  return { tables, total_restored, total_skipped };
}

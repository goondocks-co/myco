/**
 * Backup engine — SQL-dump backup and restore for synced vault tables.
 *
 * Produces portable `INSERT OR IGNORE` SQL dumps scoped to a single machine.
 * Restore merges foreign machine data without overwriting local records.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { SYNC_PROTOCOL_VERSION, epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tables included in backup dumps (all synced tables).
 *
 * `cortex_instructions` is intentionally excluded: it's local-only
 * operating guidance (see schema v19 migration + LOCAL_ONLY_OUTBOX_TABLES)
 * and must not move across machines via backup/restore.
 */
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

/**
 * Backup filename forms accepted on disk:
 * - Legacy: `<machine_id>.sql` (overwrite-in-place; one per machine)
 * - Current: `<machine_id>__<epochSeconds>.sql` (timestamped; pruneable history)
 *
 * Machine IDs follow `{github_user}_{machine_hash}` (see machine-id.ts) —
 * alphanumerics, underscore, hyphen. The literal `__` separator is reserved
 * for the timestamp. Constraining the stem rejects conflict markers
 * introduced by cloud sync services in shared backup folders.
 */
const BACKUP_FILENAME_PATTERN = /^([A-Za-z0-9_-]+?)(?:__([0-9]+))?\.sql$/;

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
 * Writes `INSERT OR IGNORE` statements for every row in BACKUP_TABLES to
 * `{backupDir}/{machineId}__{epochSeconds}.sql`. Each invocation produces
 * a new file; old ones are reclaimed by `pruneBackups` per the configured
 * retention policy.
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

  const filePath = path.join(backupDir, `${machineId}__${timestamp}${BACKUP_EXTENSION}`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  return filePath;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

interface RawBackupEntry {
  machine_id: string;
  file_name: string;
  size_bytes: number;
  /** Epoch ms — from filename timestamp when present, else file mtime. */
  modified_ms: number;
}

function listAllBackupEntries(backupDir: string): RawBackupEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return [];
  }

  const out: RawBackupEntry[] = [];
  for (const entry of entries) {
    const match = BACKUP_FILENAME_PATTERN.exec(entry);
    if (!match) continue;
    const machineId = match[1];
    const stampSeconds = match[2] ? Number(match[2]) : null;
    if (!machineId) continue;

    const filePath = path.join(backupDir, entry);
    const stat = fs.statSync(filePath);
    const modifiedMs = stampSeconds !== null && Number.isFinite(stampSeconds)
      ? stampSeconds * 1000
      : stat.mtime.getTime();

    out.push({
      machine_id: machineId,
      file_name: entry,
      size_bytes: stat.size,
      modified_ms: modifiedMs,
    });
  }
  return out;
}

/**
 * Full backup history for `backupDir`, sorted newest-first. Includes
 * every timestamped file plus any legacy untimestamped one-per-machine
 * file. The retention engine (`pruneBackups`) caps how many entries
 * survive on disk; this function returns whatever's currently there
 * so the UI can render point-in-time restore choices.
 */
export function listBackups(backupDir: string): BackupMeta[] {
  const all = listAllBackupEntries(backupDir);
  return all
    .sort((a, b) => b.modified_ms - a.modified_ms)
    .map((e) => ({
      machine_id: e.machine_id,
      file_name: e.file_name,
      size_bytes: e.size_bytes,
      modified_at: new Date(e.modified_ms).toISOString(),
    }));
}

export interface PruneRetentionPolicy {
  keep_daily: number;
  keep_weekly: number;
}

export interface PruneResult {
  removed: string[];
  kept: number;
}

const TIMESTAMPED_PATTERN = /__[0-9]+\.sql$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reclaim old backup files per `retention`. For each machine_id, retain
 * the `keep_daily` most recent timestamped files plus one file per week
 * for `keep_weekly` weeks beyond that window. Legacy untimestamped files
 * (one-per-machine, overwrite-in-place) are always preserved.
 */
export function pruneBackups(
  backupDir: string,
  retention: PruneRetentionPolicy,
  now = Date.now(),
): PruneResult {
  const all = listAllBackupEntries(backupDir);
  const grouped = new Map<string, RawBackupEntry[]>();
  for (const entry of all) {
    const arr = grouped.get(entry.machine_id) ?? [];
    arr.push(entry);
    grouped.set(entry.machine_id, arr);
  }

  const removed: string[] = [];
  let kept = 0;

  for (const [, files] of grouped) {
    files.sort((a, b) => b.modified_ms - a.modified_ms);
    const legacy = files.filter((f) => !TIMESTAMPED_PATTERN.test(f.file_name));
    const timestamped = files.filter((f) => TIMESTAMPED_PATTERN.test(f.file_name));

    kept += legacy.length;
    const dailyKept = timestamped.slice(0, retention.keep_daily);
    const olderThanDaily = timestamped.slice(retention.keep_daily);
    kept += dailyKept.length;

    const weeklyKept = new Map<number, RawBackupEntry>();
    for (const file of olderThanDaily) {
      const weeksOld = Math.floor((now - file.modified_ms) / WEEK_MS);
      if (weeksOld >= retention.keep_weekly) break;
      if (!weeklyKept.has(weeksOld)) {
        weeklyKept.set(weeksOld, file);
      }
    }
    kept += weeklyKept.size;

    const keepNames = new Set<string>([
      ...legacy.map((f) => f.file_name),
      ...dailyKept.map((f) => f.file_name),
      ...Array.from(weeklyKept.values()).map((f) => f.file_name),
    ]);
    for (const file of files) {
      if (keepNames.has(file.file_name)) continue;
      const fullPath = path.join(backupDir, file.file_name);
      try {
        fs.unlinkSync(fullPath);
        removed.push(file.file_name);
      } catch {
        // Best effort — pruning failure must not break the backup job.
      }
    }
  }

  return { removed, kept };
}

/**
 * One-shot housekeeping: move pre-Grove orphan `<machine_id>.sql`
 * files at the top of the user's backup root into a sibling
 * `.legacy/` folder. Pre-Grove backups wrote directly to
 * `~/myco_backups/<vault>/`; the per-Grove split moved active
 * backups into `<vault>/<groveSlug>/` subdirs, leaving the old
 * top-level files orphaned (still on disk, but unreachable through
 * any Grove's backup directory). Sweeping them aside keeps the
 * data on disk while removing the visual noise from the user's
 * Finder/`ls` view.
 *
 * `rootDir` is the user-configured `backup.dir` (already expanded
 * + absolute). Subdirectories are skipped; only loose `.sql` files
 * at the top get moved. Idempotent.
 */
export interface LegacySweepResult {
  moved: string[];
  legacyDir: string | null;
}

export function sweepLegacyBackupRoot(rootDir: string): LegacySweepResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { moved: [], legacyDir: null };
  }
  const orphans = entries.filter(
    (e) => e.isFile() && e.name.endsWith(BACKUP_EXTENSION),
  );
  if (orphans.length === 0) return { moved: [], legacyDir: null };

  const legacyDir = path.join(rootDir, '.legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  const moved: string[] = [];
  for (const entry of orphans) {
    const src = path.join(rootDir, entry.name);
    const dest = path.join(legacyDir, entry.name);
    try {
      fs.renameSync(src, dest);
      moved.push(entry.name);
    } catch {
      // Best effort. Don't block boot on a single failed rename.
    }
  }
  return { moved, legacyDir };
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
  db.run('PRAGMA foreign_keys = OFF');
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
    db.run('PRAGMA foreign_keys = ON');
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
  db.run('PRAGMA foreign_keys = OFF');
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
    db.run('PRAGMA foreign_keys = ON');
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

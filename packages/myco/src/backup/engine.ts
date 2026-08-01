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
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import {
  ALL_PROJECTS_SCOPE,
  assertGroveProjectId,
  isGroveEraId,
  projectScope,
  type ProjectScope,
} from '@myco/grove/ids.js';
import { groveIdFromDbPath } from '@myco/grove/paths.js';

export { ALL_PROJECTS_SCOPE, projectScope, type ProjectScope };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tables included in backup dumps — EVERY project-scoped table, with no
 * exclusions, plus `team_members` which is grove-scoped (not project-scoped)
 * but still needs to round-trip through backup/restore. `entity_mentions`
 * participates as of schema v75 (it gained the `id` primary key the dump's
 * `INSERT OR IGNORE` idempotency addresses rows by). Coverage completeness
 * is gated by the per-direction residency coverage test — a project-scoped
 * backup must be able to carry the WHOLE project, because the detach
 * artifact is the only carrier in that direction.
 */
export const BACKUP_TABLES = [
  ...GROVE_PROJECT_SCOPED_TABLES,
  'team_members',
] as const;

/**
 * The table set for a DETACH artifact — the project's whole knowledge, and
 * nothing else. `team_members` is excluded: it is the HOST's machine roster,
 * and a project-scoped dump carries it in full (grove-scoped tables take no
 * project WHERE), so including it would hand every departing member the
 * host's membership records.
 */
export const DETACH_ARTIFACT_TABLES: readonly string[] =
  BACKUP_TABLES.filter((t) => t !== 'team_members');

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

/**
 * Backup uses the canonical `ProjectScope` from `@myco/grove/ids.js`:
 *   - `{ kind: 'project', id }`  — single-project dump (filter `project_id = ?`)
 *   - `{ kind: 'global' }`        — daemon-wide rows (no project filter applies
 *                                   at the dump level; project-scoped tables
 *                                   are emitted unfiltered, same as `'all'`)
 *   - `{ kind: 'all' }`           — vault-wide dump, no project filter
 *
 * For backup purposes `'global'` and `'all'` are equivalent: both produce a
 * no-op `WHERE` clause so every row of every BACKUP_TABLES table is dumped.
 */
function projectScopeClause(scope: ProjectScope): { sql: string; params: unknown[] } {
  if (scope.kind === 'project') {
    return { sql: ' WHERE project_id = ?', params: [scope.id] };
  }
  return { sql: '', params: [] };
}

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
 * Format a string as a SQL value expression: a single quoted literal
 * with embedded newlines preserved inline. The whole dump is later fed
 * to `db.exec()`, which handles multi-line literals natively.
 */
function formatSqlString(value: string): string {
  return `'${escapeSql(value)}'`;
}

/**
 * Serialize a JavaScript value into a SQL literal.
 *
 * - null / undefined → NULL
 * - number / bigint → numeric literal
 * - Buffer / Uint8Array → X'hex'
 * - string → 'escaped string' (newlines preserved inline)
 */
function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return formatSqlString(String(value));
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** Tables that carry a `project_id` column and so accept project scoping. */
const PROJECT_SCOPED_BACKUP_TABLES = new Set<string>(GROVE_PROJECT_SCOPED_TABLES);

/**
 * Create a SQL dump backup of all synced tables.
 *
 * Writes `INSERT OR IGNORE` statements for every row in BACKUP_TABLES.
 * The default scope is vault-wide; pass `projectScope(projectId)` to
 * filter every per-table SELECT by `project_id`.
 *
 * Filename scheme:
 * - all-projects: `{machineId}__{epochSeconds}.sql`
 * - single-project: `{machineId}__{projectSlug}__{epochSeconds}.sql`
 *
 * Each invocation produces a new file; old ones are reclaimed by
 * `pruneBackups` per the configured retention policy.
 *
 * @returns the absolute path of the created backup file.
 */
export function createBackup(
  db: Database,
  backupDir: string,
  machineId: string,
  scope: ProjectScope = ALL_PROJECTS_SCOPE,
  projectSlug?: string,
  tables: readonly string[] = BACKUP_TABLES,
): string {
  fs.mkdirSync(backupDir, { recursive: true });

  const lines: string[] = [];
  const timestamp = epochSeconds();
  const clause = projectScopeClause(scope);
  const scopeLabel = scope.kind === 'project'
    ? `project=${scope.id}`
    : 'all-projects';

  // Header
  lines.push(`${BACKUP_HEADER_TEMPLATE}: machine_id=${machineId}, created_at=${timestamp}`);
  lines.push(`-- Protocol version: ${SYNC_PROTOCOL_VERSION}`);
  lines.push(`-- scope: ${scopeLabel}`);
  // Grove lineage, when the source DB lives at a Grove path. Restore
  // refuses to merge a Grove's dump into a DIFFERENT Grove's DB — the
  // dump's literal AUTOINCREMENT ids only mean anything in their home
  // Grove. Non-Grove DBs (tests, ad-hoc paths) emit no lineage line.
  const sourceGroveId = groveIdFromDbPath(db.filename);
  if (sourceGroveId) lines.push(`-- grove_id: ${sourceGroveId}`);
  lines.push('');

  for (const table of tables) {
    const useScope = clause.sql !== '' && PROJECT_SCOPED_BACKUP_TABLES.has(table);
    const sql = `SELECT * FROM ${table}${useScope ? clause.sql : ''}`;
    const rows = useScope
      ? db.prepare(sql).all(...clause.params) as Record<string, unknown>[]
      : db.prepare(sql).all() as Record<string, unknown>[];
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

  const filename = scope.kind === 'project'
    ? `${machineId}__${projectSlug ?? 'unknown'}__${timestamp}${BACKUP_EXTENSION}`
    : `${machineId}__${timestamp}${BACKUP_EXTENSION}`;
  const filePath = path.join(backupDir, filename);
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
// Header
// ---------------------------------------------------------------------------

/**
 * Header metadata parsed from a snapshot file. The header is the first few
 * lines emitted by `createBackup` (before any INSERTs).
 *
 * `scope` is `null` for legacy snapshots (pre-WB-A) that omit the
 * `-- scope: ...` line — callers that require a project-scoped snapshot
 * must reject `null` explicitly.
 */
export interface SnapshotHeader {
  machine_id: string | null;
  created_at: number | null;
  protocol_version: number | null;
  scope: ProjectScope | null;
  /**
   * Grove the dump was taken from. `null` for legacy archives that
   * predate lineage recording and for dumps of non-Grove DBs.
   */
  grove_id: string | null;
}

const HEADER_SCAN_LIMIT = 16;

/**
 * Read and parse the comment header of a snapshot file. Reads a small
 * prefix from disk and stops at the first non-comment, non-blank line.
 */
export function readSnapshotHeader(snapshotPath: string): SnapshotHeader {
  const fd = fs.openSync(snapshotPath, 'r');
  let raw = '';
  try {
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    raw = buf.toString('utf-8', 0, bytes);
  } finally {
    fs.closeSync(fd);
  }

  const header: SnapshotHeader = {
    machine_id: null,
    created_at: null,
    protocol_version: null,
    scope: null,
    grove_id: null,
  };

  const lines = raw.split('\n').slice(0, HEADER_SCAN_LIMIT);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('--')) break;

    const meta = trimmed.replace(/^--\s*/, '');
    const machineMatch = /^Myco backup:\s*machine_id=([^,\s]+)(?:,\s*created_at=(\d+))?/.exec(meta);
    if (machineMatch) {
      header.machine_id = machineMatch[1];
      header.created_at = machineMatch[2] ? Number(machineMatch[2]) : null;
      continue;
    }

    const protocolMatch = /^Protocol version:\s*(\d+)/.exec(meta);
    if (protocolMatch) {
      header.protocol_version = Number(protocolMatch[1]);
      continue;
    }

    const groveMatch = /^grove_id:\s*(\S+)$/.exec(meta);
    if (groveMatch) {
      // A malformed grove id is treated as absent lineage (kept `null`)
      // rather than throwing — same posture as a malformed scope line.
      header.grove_id = isGroveEraId(groveMatch[1], 'grove') ? groveMatch[1] : null;
      continue;
    }

    const scopeMatch = /^scope:\s*(.+)$/.exec(meta);
    if (scopeMatch) {
      const value = scopeMatch[1].trim();
      if (value === 'all-projects') {
        header.scope = ALL_PROJECTS_SCOPE;
      } else if (value.startsWith('project=')) {
        const rawId = value.slice('project='.length);
        try {
          header.scope = projectScope(assertGroveProjectId(rawId));
        } catch {
          // A malformed `project=<id>` line is treated as an unknown scope
          // (kept `null`) rather than throwing — the caller chooses whether
          // an unknown scope is fatal.
          header.scope = null;
        }
      }
    }
  }

  return header;
}

// ---------------------------------------------------------------------------
// Restore helpers
// ---------------------------------------------------------------------------

/**
 * Header line marking the start of a table's INSERT block in a dump.
 * Used to discover *which* tables a given dump touches so post-restore
 * verification queries the live DB for those tables — never trusting
 * the dump's claimed row counts.
 */
const TABLE_HEADER_REGEX = /^-- Table:\s+(\w+)\s+\(/;

/** Extract the set of table names a dump claims to write to. */
function extractTableNames(content: string): string[] {
  const tables = new Set<string>();
  for (const line of content.split('\n')) {
    const match = TABLE_HEADER_REGEX.exec(line);
    if (match) tables.add(match[1]);
  }
  return Array.from(tables);
}

/** Header that records a table's row count: `-- Table: <name> (<N> rows)`. */
const TABLE_COUNT_REGEX = /-- Table:\s+(\w+)\s+\((\d+)\s+rows?\)/;

/** Per-table comparison for a non-executing restore preview. */
export interface TableContentCounts {
  table: string;
  /** Rows the backup contains for this table (from its `-- Table` header). */
  in_backup: number;
  /** Rows currently in the live DB for this table. */
  in_db: number;
}

/**
 * Cheap, non-executing restore preview.
 *
 * Restore is an additive `INSERT OR IGNORE` merge, so the useful question
 * before restoring is "what does this backup hold vs what I have now".
 * Rather than execute the (potentially multi-hundred-MB) dump in a savepoint
 * — which blocks the daemon's single thread for minutes — this streams the
 * file and reads each table's row count straight from the `-- Table: <name>
 * (<N> rows)` header the dump already records, then counts the live rows.
 * It scans chunks for the sparse `-- Table:` marker (no per-line work over
 * millions of INSERTs) and awaits between chunks, so it stays responsive
 * even on an 800MB dump.
 */
export async function previewRestoreContents(
  db: Database,
  backupPath: string,
): Promise<TableContentCounts[]> {
  const inBackup = new Map<string, number>();
  const stream = fs.createReadStream(backupPath);
  let carry = '';
  for await (const chunk of stream) {
    const text = carry + (chunk as Buffer).toString('latin1');
    let idx = 0;
    for (;;) {
      const hit = text.indexOf('-- Table:', idx);
      if (hit === -1) break;
      const eol = text.indexOf('\n', hit);
      if (eol === -1) break; // line continues into the next chunk
      const match = TABLE_COUNT_REGEX.exec(text.slice(hit, eol));
      if (match) inBackup.set(match[1], Number(match[2]));
      idx = eol + 1;
    }
    // Keep the tail after the last newline so a marker split across the
    // chunk boundary is re-scanned with the next chunk prepended.
    const lastNl = text.lastIndexOf('\n');
    carry = lastNl === -1 ? text : text.slice(lastNl + 1);
  }

  const result: TableContentCounts[] = [];
  for (const [table, count] of inBackup) {
    result.push({ table, in_backup: count, in_db: countRows(db, table) });
  }
  return result;
}

function countRows(db: Database, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  } catch {
    // Table may not exist on a brand-new target DB; treat as zero.
    return 0;
  }
}

/**
 * True if `content` has at least one non-comment, non-blank line.
 * Used as a guard before `db.exec(content)` — bun:sqlite throws on a
 * script that contains nothing but comments + blank lines, so an
 * empty-but-header-only dump (a no-rows backup) would otherwise fail.
 */
function hasSqlStatements(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('--')) continue;
    return true;
  }
  return false;
}


/**
 * Count INSERT statements in `content` that target `table`. Naive
 * substring match is safe because INSERT statements emitted by
 * `createBackup` start at column 0 of their line and the table name is
 * a SQL identifier (no spaces).
 */
function countTableInserts(content: string, table: string): number {
  const needle = `INSERT OR IGNORE INTO ${table} (`;
  let count = 0;
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Refusal raised when an archive carries Grove lineage that disagrees
 * with the restore target. A dump's literal AUTOINCREMENT ids are only
 * meaningful in the Grove they came from — merging them into another
 * Grove's DB silently drops colliding rows and attaches children to the
 * wrong project's parents.
 */
export class BackupGroveMismatchError extends Error {
  constructor(
    readonly backupGroveId: string,
    readonly targetGroveId: string,
  ) {
    super(
      `Backup was taken from Grove ${backupGroveId} but the restore target is `
      + `Grove ${targetGroveId}; cross-Grove restore is refused. Use the move `
      + `orchestrator to relocate a project between Groves.`,
    );
    this.name = 'BackupGroveMismatchError';
  }
}

/**
 * Restore a backup by feeding the entire dump to SQLite's own parser as
 * one multi-statement script. SQLite's parser understands string literals
 * with embedded newlines, so multi-line text values round-trip byte-exact.
 *
 * Per-table counts are computed by querying the live DB before and
 * after the restore — never from the dump's `(N rows)` comments. A
 * broken dump cannot fool the gate this way.
 *
 * Uses `INSERT OR IGNORE` — existing records are skipped, new records
 * are inserted.
 *
 * The whole dump runs in ONE transaction (atomic — a mid-dump failure lands
 * nothing), which holds the target DB's write lock for the duration: writers
 * to EVERY project in that Grove stall until the restore finishes. That is
 * the deliberate cost of atomicity; on a large artifact expect a multi-second
 * Grove-wide write pause.
 *
 * Grove lineage gate: an archive whose header records a `grove_id`
 * different from the target DB's Grove is refused (see
 * BackupGroveMismatchError). Same-Grove restores — including the
 * cross-machine merge restore of a teammate's dump of the same Grove —
 * pass. Legacy archives without lineage restore with a warning.
 */
export function restoreBackup(
  db: Database,
  backupPath: string,
): RestoreResult {
  const header = readSnapshotHeader(backupPath);
  const targetGroveId = groveIdFromDbPath(db.filename);
  if (header.grove_id && targetGroveId && header.grove_id !== targetGroveId) {
    throw new BackupGroveMismatchError(header.grove_id, targetGroveId);
  }
  if (!header.grove_id && targetGroveId) {
    console.warn(
      `[backup] archive ${path.basename(backupPath)} carries no grove_id lineage; `
      + `cross-Grove guard skipped for restore into Grove ${targetGroveId}`,
    );
  }

  const content = fs.readFileSync(backupPath, 'utf-8');
  const tableNames = extractTableNames(content);
  const before = new Map<string, number>();
  for (const table of tableNames) before.set(table, countRows(db, table));

  // Defer FK checks — backup may reference rows in non-synced tables (e.g. agents)
  // that don't exist yet. Re-enable after the dump runs.
  db.run('PRAGMA foreign_keys = OFF');
  try {
    if (hasSqlStatements(content)) {
      // One transaction around the whole dump (R7): SQLite auto-commits each
      // statement otherwise, so a mid-dump failure — schema mismatch, full
      // disk — would leave a partially-restored project visible to concurrent
      // readers. With the wrap the restore is atomic AND idempotent: it lands
      // whole or not at all, and a retry converges via INSERT OR IGNORE.
      db.exec('BEGIN');
      try {
        db.exec(content);
        db.exec('COMMIT');
      } catch (err) {
        // SQLite may have auto-rolled-back already (SQLITE_FULL does) — an
        // unguarded ROLLBACK would then throw "no transaction is active" and
        // MASK the real error the operator needs (e.g. disk full).
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    }
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }

  const tables: TableCounts[] = [];
  for (const table of tableNames) {
    const beforeN = before.get(table) ?? 0;
    const afterN = countRows(db, table);
    const newRows = Math.max(0, afterN - beforeN);
    const claimedInserts = countTableInserts(content, table);
    const existing = Math.max(0, claimedInserts - newRows);
    tables.push({ table, new: newRows, existing });
  }

  const total_restored = tables.reduce((sum, t) => sum + t.new, 0);
  const total_skipped = tables.reduce((sum, t) => sum + t.existing, 0);

  return { tables, total_restored, total_skipped };
}

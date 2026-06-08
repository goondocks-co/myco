/**
 * Backup service — high-level per-Grove operations shared by every caller
 * (daemon API, auto-backup PowerJob, project-delete safety snapshot).
 *
 * Each operation resolves the directory (via `location.ts`), the retention
 * policy, and the interval from the SAME per-Grove config, so create, list,
 * restore, auto-backup, and maintenance can never disagree about where a
 * Grove's backups are or how many to keep. The database handle is always
 * passed in by the caller (the daemon supplies a cached/pinned handle); the
 * service never opens or owns a connection.
 */

import path from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  createBackup,
  listBackups,
  pruneBackups,
  restorePreview,
  restoreBackup,
  type BackupMeta,
  type RestoreResult,
  type TableCounts,
} from './engine.js';
import { resolveGroveBackupDir, legacyGroveBackupLocations } from './location.js';
import { loadGroveConfig } from '../config/loader.js';
import { resolveMycoHome } from '../grove/paths.js';

const MS_PER_HOUR = 60 * 60 * 1000;

export interface BackupServiceOptions {
  mycoHome?: string;
}

/** A backup file plus the directory it actually lives in (canonical or legacy). */
export interface GroveBackupRef extends BackupMeta {
  /** Directory the file lives in — canonical or a legacy location. */
  dir: string;
  /** Absolute path to the backup file. */
  path: string;
}

function backupConfig(groveId: string, mycoHome: string) {
  return loadGroveConfig(groveId, mycoHome).backup;
}

/**
 * Every backup for a Grove, newest-first, scanning the canonical dir AND
 * any legacy locations. Deduped by file name with the canonical copy
 * winning, so a partially-completed migration never hides a backup. Each
 * entry carries its absolute path so restore opens the file wherever it
 * actually lives — not a hard-coded canonical dir.
 */
export function listGroveBackups(groveId: string, opts: BackupServiceOptions = {}): GroveBackupRef[] {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const dirs = [
    resolveGroveBackupDir(groveId, { mycoHome }),
    ...legacyGroveBackupLocations(groveId, { mycoHome }),
  ];
  const seen = new Set<string>();
  const out: GroveBackupRef[] = [];
  for (const dir of dirs) {
    for (const meta of listBackups(dir)) {
      if (seen.has(meta.file_name)) continue;
      seen.add(meta.file_name);
      out.push({ ...meta, dir, path: path.join(dir, meta.file_name) });
    }
  }
  return out.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
}

export interface CreateGroveBackupResult {
  file_path: string;
  size_bytes: number;
  pruned: number;
  kept: number;
}

/**
 * Create a whole-Grove backup in the canonical dir and prune to retention.
 * Shared by the manual API path and the auto-backup PowerJob. The caller
 * passes the database handle (cached/pinned by the daemon).
 */
export function createGroveBackup(params: {
  groveId: string;
  db: Database;
  machineId: string;
  mycoHome?: string;
}): CreateGroveBackupResult {
  const mycoHome = params.mycoHome ?? resolveMycoHome();
  const cfg = backupConfig(params.groveId, mycoHome);
  const dir = resolveGroveBackupDir(params.groveId, { mycoHome });
  const filePath = createBackup(params.db, dir, params.machineId);
  const prune = pruneBackups(dir, cfg.retention);
  const created = listBackups(dir).find((b) => b.file_name === path.basename(filePath));
  return {
    file_path: filePath,
    size_bytes: created?.size_bytes ?? 0,
    pruned: prune.removed.length,
    kept: prune.kept,
  };
}

/**
 * Cadence gate for auto-backup: true when the newest backup for this
 * machine is older than the configured interval (or none exists). Scans
 * canonical + legacy so a just-migrated Grove doesn't immediately re-backup.
 */
export function isAutoBackupDue(params: {
  groveId: string;
  machineId: string;
  now?: number;
  mycoHome?: string;
}): boolean {
  const mycoHome = params.mycoHome ?? resolveMycoHome();
  const intervalMs = backupConfig(params.groveId, mycoHome).auto_interval_hours * MS_PER_HOUR;
  const recent = listGroveBackups(params.groveId, { mycoHome }).find(
    (b) => b.machine_id === params.machineId,
  );
  if (!recent) return true;
  const ageMs = (params.now ?? Date.now()) - new Date(recent.modified_at).getTime();
  return ageMs >= intervalMs;
}

function resolveBackupFile(
  groveId: string,
  fileName: string,
  mycoHome: string,
): GroveBackupRef | undefined {
  return listGroveBackups(groveId, { mycoHome }).find((b) => b.file_name === fileName);
}

export interface GroveRestorePreview {
  ref: GroveBackupRef;
  tables: TableCounts[];
  total_new: number;
  total_existing: number;
}

/** Dry-run restore preview. Returns null when the named backup is not found. */
export function previewGroveRestore(params: {
  groveId: string;
  db: Database;
  fileName: string;
  mycoHome?: string;
}): GroveRestorePreview | null {
  const mycoHome = params.mycoHome ?? resolveMycoHome();
  const ref = resolveBackupFile(params.groveId, params.fileName, mycoHome);
  if (!ref) return null;
  const tables = restorePreview(params.db, ref.path);
  return {
    ref,
    tables,
    total_new: tables.reduce((sum, t) => sum + t.new, 0),
    total_existing: tables.reduce((sum, t) => sum + t.existing, 0),
  };
}

export interface GroveRestoreOutcome {
  ref: GroveBackupRef;
  result: RestoreResult;
}

/** Execute a restore. Returns null when the named backup is not found. */
export function restoreGroveBackup(params: {
  groveId: string;
  db: Database;
  fileName: string;
  mycoHome?: string;
}): GroveRestoreOutcome | null {
  const mycoHome = params.mycoHome ?? resolveMycoHome();
  const ref = resolveBackupFile(params.groveId, params.fileName, mycoHome);
  if (!ref) return null;
  return { ref, result: restoreBackup(params.db, ref.path) };
}

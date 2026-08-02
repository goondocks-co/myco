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

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  addToKeepList,
  createBackup,
  listBackups,
  pruneBackups,
  previewRestoreContents,
  type BackupMeta,
  type TableContentCounts,
} from './engine.js';
import { resolveGroveBackupDir, legacyGroveBackupLocations, migrationMarkerPath } from './location.js';
import { loadGroveConfig, updateTierConfigRaw } from '../config/loader.js';
import { GroveConfigSchema } from '../config/schema.js';
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
  /**
   * Pin this backup against retention pruning (the keep-list). Used by the
   * pre-migration checkpoint: it is the only artifact that spans a schema
   * gap, so an aggressive retention config must not reclaim it — including
   * the prune that runs at the end of THIS call.
   */
  pin?: boolean;
}): CreateGroveBackupResult {
  const mycoHome = params.mycoHome ?? resolveMycoHome();
  const cfg = backupConfig(params.groveId, mycoHome);
  const dir = resolveGroveBackupDir(params.groveId, { mycoHome });
  const filePath = createBackup(params.db, dir, params.machineId);
  if (params.pin) addToKeepList(dir, path.basename(filePath));

  // Suppress prune for one cycle right after a migration consolidated legacy
  // backups into this dir — see migrationMarkerPath. Consuming the marker
  // here means the suppression lasts exactly one create (manual or auto).
  let pruned = 0;
  let kept: number;
  if (consumeMigrationMarker(dir)) {
    kept = listBackups(dir).length;
  } else {
    const prune = pruneBackups(dir, cfg.retention);
    pruned = prune.removed.length;
    kept = prune.kept;
  }

  return {
    file_path: filePath,
    size_bytes: fs.statSync(filePath).size,
    pruned,
    kept,
  };
}

/** Consume the post-migration prune-suppression marker. Returns true once. */
function consumeMigrationMarker(dir: string): boolean {
  const marker = migrationMarkerPath(dir);
  if (!fs.existsSync(marker)) return false;
  try {
    fs.unlinkSync(marker);
  } catch {
    // If the unlink races another writer, treat as already consumed.
  }
  return true;
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

/** The schema's own backup defaults — the single source of truth {@link seedGroveBackupDefaults}
 *  writes onto disk, so a later schema-default change can never silently drift from what a
 *  served Grove already has pinned. */
const SCHEMA_BACKUP_DEFAULTS = GroveConfigSchema.parse({}).backup;

/**
 * Seed the default backup posture (`auto_interval_hours` + retention) onto a
 * Grove's `grove.yaml` WHEN ABSENT — never overwrites a value already on disk,
 * explicit or previously seeded. Server-mode design spec §8: "`--serve`
 * enables scheduled backups for the served Grove by default." This makes that
 * default durable and explicit in the served Grove's own config rather than
 * relying on an implicit Zod default that could change out from under an
 * already-serving box. Idempotent — safe to call on every designation (create
 * or re-verify); a Grove that already has explicit backup config is left
 * untouched. Writes through the canonical raw-doc tier writer
 * (`updateTierConfigRaw`) — never a second YAML writer.
 */
export function seedGroveBackupDefaults(groveId: string, mycoHome: string = resolveMycoHome()): void {
  updateTierConfigRaw({ kind: 'grove', groveId }, (raw) => {
    const rawBackup = (raw.backup && typeof raw.backup === 'object' && !Array.isArray(raw.backup))
      ? raw.backup as Record<string, unknown>
      : {};
    const rawRetention = (rawBackup.retention && typeof rawBackup.retention === 'object' && !Array.isArray(rawBackup.retention))
      ? rawBackup.retention as Record<string, unknown>
      : {};

    const nextRetention: Record<string, unknown> = { ...rawRetention };
    if (nextRetention.keep_daily === undefined) nextRetention.keep_daily = SCHEMA_BACKUP_DEFAULTS.retention.keep_daily;
    if (nextRetention.keep_weekly === undefined) nextRetention.keep_weekly = SCHEMA_BACKUP_DEFAULTS.retention.keep_weekly;

    const nextBackup: Record<string, unknown> = { ...rawBackup, retention: nextRetention };
    if (nextBackup.auto_interval_hours === undefined) nextBackup.auto_interval_hours = SCHEMA_BACKUP_DEFAULTS.auto_interval_hours;

    return { ...raw, backup: nextBackup };
  }, { mycoHome });
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
  tables: TableContentCounts[];
  total_in_backup: number;
  total_in_db: number;
}

/**
 * Restore preview: what the backup holds per table vs the live DB. Cheap and
 * non-blocking — it reads the dump's recorded counts instead of executing it
 * (an 800MB dump would otherwise wedge the daemon for minutes). Returns null
 * when the named backup is not found.
 */
export async function previewGroveRestore(params: {
  groveId: string;
  db: Database;
  fileName: string;
  mycoHome?: string;
}): Promise<GroveRestorePreview | null> {
  const mycoHome = params.mycoHome ?? resolveMycoHome();
  const ref = resolveBackupFile(params.groveId, params.fileName, mycoHome);
  if (!ref) return null;
  const tables = await previewRestoreContents(params.db, ref.path);
  return {
    ref,
    tables,
    total_in_backup: tables.reduce((sum, t) => sum + t.in_backup, 0),
    total_in_db: tables.reduce((sum, t) => sum + t.in_db, 0),
  };
}

/**
 * Resolve a Grove backup by file name across canonical + legacy locations.
 * Restore execution itself runs out-of-process (backup/restore-runner.ts):
 * the handler resolves the ref here, then hands its absolute path to the
 * child process. Returns undefined when not found.
 */
export function findGroveBackup(
  groveId: string,
  fileName: string,
  opts: BackupServiceOptions = {},
): GroveBackupRef | undefined {
  return resolveBackupFile(groveId, fileName, opts.mycoHome ?? resolveMycoHome());
}

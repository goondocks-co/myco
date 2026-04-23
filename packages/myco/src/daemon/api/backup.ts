/**
 * Backup API handlers — create, list, preview, and restore backups.
 *
 * Factory function injects backupDir and machineId; returns handlers
 * for POST /api/backup, GET /api/backups, POST /api/restore/preview,
 * and POST /api/restore.
 */

import type { Database } from 'bun:sqlite';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { MycoConfig } from '../../config/schema.js';
import {
  createBackup,
  listBackups,
  restorePreview,
  restoreBackup,
} from '../backup.js';
import { loadMergedConfig, updateBackupConfig } from '../../config/loader.js';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected by the daemon when registering backup routes. */
export interface BackupDeps {
  db: Database;
  machineId: string;
  vaultDir: string;
  // Holder so the dir is re-resolved on every request — a user can change
  // `backup.dir` in Settings (either scope) and the next backup writes to
  // the new location without a daemon restart.
  liveConfig: { current: MycoConfig };
}

/**
 * Resolve the effective backup directory from the current config. The user's
 * configured path may be relative or start with `~/`; absent, it falls back
 * to `<vaultDir>/backups`.
 */
export function resolveBackupDir(config: MycoConfig, vaultDir: string): string {
  const rawDir = config.backup.dir;
  if (!rawDir) return path.resolve(vaultDir, 'backups');
  const expanded = rawDir.startsWith('~/')
    ? path.join(os.homedir(), rawDir.slice(2))
    : rawDir;
  return path.resolve(expanded);
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create backup API handlers with injected dependencies.
 *
 * Returns an object with named handlers for each backup endpoint.
 */
export function createBackupHandlers(deps: BackupDeps) {
  const currentBackupDir = () => resolveBackupDir(deps.liveConfig.current, deps.vaultDir);

  /** POST /api/backup — create a new backup of all synced tables. */
  async function handleCreateBackup(_req: RouteRequest): Promise<RouteResponse> {
    const backupDir = currentBackupDir();
    const filePath = createBackup(deps.db, backupDir, deps.machineId);
    const backups = listBackups(backupDir);
    const created = backups.find((b) => b.machine_id === deps.machineId);

    return {
      body: {
        file_path: filePath,
        machine_id: deps.machineId,
        size_bytes: created?.size_bytes ?? 0,
      },
    };
  }

  /** GET /api/backups — list all backup files with metadata. */
  async function handleListBackups(_req: RouteRequest): Promise<RouteResponse> {
    const backups = listBackups(currentBackupDir());
    return { body: { backups } };
  }

  /** POST /api/restore/preview — dry-run restore to show new/existing counts. */
  async function handleRestorePreview(req: RouteRequest): Promise<RouteResponse> {
    const { machine_id } = req.body as { machine_id?: string };
    if (!machine_id) {
      return { status: 400, body: { error: 'missing_machine_id' } };
    }

    const backupDir = currentBackupDir();
    const backups = listBackups(backupDir);
    const backup = backups.find((b) => b.machine_id === machine_id);
    if (!backup) {
      return { status: 404, body: { error: 'backup_not_found' } };
    }

    const backupPath = `${backupDir}/${backup.file_name}`;
    const tables = restorePreview(deps.db, backupPath);
    const total_new = tables.reduce((sum, t) => sum + t.new, 0);
    const total_existing = tables.reduce((sum, t) => sum + t.existing, 0);

    return { body: { machine_id, tables, total_new, total_existing } };
  }

  /** POST /api/restore — execute restore from a backup file. */
  async function handleRestore(req: RouteRequest): Promise<RouteResponse> {
    const { machine_id } = req.body as { machine_id?: string };
    if (!machine_id) {
      return { status: 400, body: { error: 'missing_machine_id' } };
    }

    const backupDir = currentBackupDir();
    const backups = listBackups(backupDir);
    const backup = backups.find((b) => b.machine_id === machine_id);
    if (!backup) {
      return { status: 404, body: { error: 'backup_not_found' } };
    }

    const backupPath = `${backupDir}/${backup.file_name}`;
    const result = restoreBackup(deps.db, backupPath);

    return { body: { machine_id, ...result } };
  }

  return {
    handleCreateBackup,
    handleListBackups,
    handleRestorePreview,
    handleRestore,
  };
}

// ---------------------------------------------------------------------------
// Backup config handlers — factory
// ---------------------------------------------------------------------------

export interface BackupConfigDeps {
  vaultDir: string;
}

/**
 * Create handlers for GET/PUT /api/backup/config.
 */
export function createBackupConfigHandlers(deps: BackupConfigDeps) {
  const { vaultDir } = deps;

  /** GET /api/backup/config — read the configured backup directory (merged). */
  async function handleGetBackupConfig(): Promise<RouteResponse> {
    const cfg = loadMergedConfig(vaultDir);
    return { body: { dir: cfg.backup.dir ?? null, default_dir: path.resolve(vaultDir, 'backups') } };
  }

  /** PUT /api/backup/config — update the backup directory setting. */
  async function handlePutBackupConfig(req: RouteRequest): Promise<RouteResponse> {
    const { dir } = req.body as { dir?: string | null };
    updateBackupConfig(vaultDir, { dir: dir || undefined });
    return { body: { dir: dir || null } };
  }

  return { handleGetBackupConfig, handlePutBackupConfig };
}

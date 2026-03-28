/**
 * Backup API handlers — create, list, preview, and restore backups.
 *
 * Factory function injects backupDir and machineId; returns handlers
 * for POST /api/backup, GET /api/backups, POST /api/restore/preview,
 * and POST /api/restore.
 */

import type { Database } from 'better-sqlite3';
import type { RouteRequest, RouteResponse } from '../router.js';
import {
  createBackup,
  listBackups,
  restorePreview,
  restoreBackup,
} from '../backup.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected by the daemon when registering backup routes. */
export interface BackupDeps {
  db: Database;
  backupDir: string;
  machineId: string;
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
  /** POST /api/backup — create a new backup of all synced tables. */
  async function handleCreateBackup(_req: RouteRequest): Promise<RouteResponse> {
    const filePath = createBackup(deps.db, deps.backupDir, deps.machineId);
    const backups = listBackups(deps.backupDir);
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
    const backups = listBackups(deps.backupDir);
    return { body: { backups } };
  }

  /** POST /api/restore/preview — dry-run restore to show new/existing counts. */
  async function handleRestorePreview(req: RouteRequest): Promise<RouteResponse> {
    const { machine_id } = req.body as { machine_id?: string };
    if (!machine_id) {
      return { status: 400, body: { error: 'missing_machine_id' } };
    }

    const backups = listBackups(deps.backupDir);
    const backup = backups.find((b) => b.machine_id === machine_id);
    if (!backup) {
      return { status: 404, body: { error: 'backup_not_found' } };
    }

    const backupPath = `${deps.backupDir}/${backup.file_name}`;
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

    const backups = listBackups(deps.backupDir);
    const backup = backups.find((b) => b.machine_id === machine_id);
    if (!backup) {
      return { status: 404, body: { error: 'backup_not_found' } };
    }

    const backupPath = `${deps.backupDir}/${backup.file_name}`;
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

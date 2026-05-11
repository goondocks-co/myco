/**
 * Project-scoped HTTP handlers — standalone backup and restore for a single
 * registered project. Sibling-called by both CLI and HTTP API; neither
 * wraps the other.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import {
  assertGroveProjectId,
  projectScope,
  projectUrlSlug,
} from '@myco/grove/ids.js';
import {
  resolveBackupsRoot,
  resolveGroveDbPath,
  resolveMycoHome,
  resolveProjectVaultDir,
  resolveServiceDirName,
} from '@myco/grove/paths.js';
import { findRegisteredProject, isProjectPaused } from '@myco/grove/registry.js';
import { createBackup, readSnapshotHeader, restoreBackup } from '../backup.js';
import { getMachineId } from '../machine-id.js';
import type { RouteHandler } from '../router.js';
import { errorBody, pausedErrorResponse } from './error-envelope.js';

export interface ProjectBackupHandlerOptions {
  /** Override the backup root. Tests pass an explicit value. */
  backupsRoot?: string;
  /** Override Myco home (tests). */
  mycoHome?: string;
}

export function createProjectBackupHandler(
  options: ProjectBackupHandlerOptions = {},
  daemonStateDir: string,
): RouteHandler {
  return async (req) => {
    const projectId = req.params.projectId;
    const mycoHome = options.mycoHome ?? resolveMycoHome();
    const found = findRegisteredProject({ projectId }, mycoHome);
    if (!found) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }

    const variant = resolveServiceDirName(daemonStateDir, mycoHome);
    if (found.grove.served_by !== variant) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }

    // Project-scoped routes resolve `projectId` from the URL, so the
    // server-level pause gate (keyed on header context) does not fire here.
    const paused = isProjectPaused(projectId, mycoHome);
    if (paused.paused) {
      return pausedErrorResponse(projectId, paused);
    }

    const slug = projectUrlSlug(found.project.name, found.project.project_id);
    const backupDir = path.join(resolveBackupsRoot(options.backupsRoot), slug);
    fs.mkdirSync(backupDir, { recursive: true });

    const machineId = getMachineId(resolveProjectVaultDir(found.project.root));
    const dbPath = resolveGroveDbPath(found.grove.id, mycoHome);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    try {
      const snapshotPath = createBackup(
        db,
        backupDir,
        machineId,
        projectScope(assertGroveProjectId(projectId)),
        slug,
      );
      const sizeBytes = fs.statSync(snapshotPath).size;
      return {
        body: {
          ok: true,
          snapshot_path: snapshotPath,
          size_bytes: sizeBytes,
          machine_id: machineId,
          grove_id: found.grove.id,
          project_id: projectId,
        },
      };
    } catch (err) {
      return { status: 500, body: errorBody('backup_failed', (err as Error).message) };
    } finally {
      db.close();
    }
  };
}

export interface ProjectRestoreHandlerOptions {
  /** Override Myco home (tests). */
  mycoHome?: string;
}

export function createProjectRestoreHandler(
  options: ProjectRestoreHandlerOptions = {},
  daemonStateDir: string,
): RouteHandler {
  return async (req) => {
    const projectId = req.params.projectId;
    const body = (req.body ?? {}) as { snapshot_path?: unknown };
    const snapshotPath = typeof body.snapshot_path === 'string' ? body.snapshot_path : '';
    if (!snapshotPath) {
      return {
        status: 400,
        body: errorBody('snapshot_path_required', 'snapshot_path is required'),
      };
    }
    if (!fs.existsSync(snapshotPath)) {
      return {
        status: 404,
        body: errorBody('snapshot_not_found', `Snapshot not found: ${snapshotPath}`),
      };
    }

    const mycoHome = options.mycoHome ?? resolveMycoHome();
    const found = findRegisteredProject({ projectId }, mycoHome);
    if (!found) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }

    const variant = resolveServiceDirName(daemonStateDir, mycoHome);
    if (found.grove.served_by !== variant) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }

    const paused = isProjectPaused(projectId, mycoHome);
    if (paused.paused) {
      return pausedErrorResponse(projectId, paused);
    }

    const header = readSnapshotHeader(snapshotPath);
    if (header.scope?.kind !== 'project' || header.scope.id !== projectId) {
      const observed = header.scope?.kind === 'project'
        ? `project=${header.scope.id}`
        : (header.scope?.kind ?? 'unknown');
      return {
        status: 400,
        body: errorBody(
          'snapshot_project_mismatch',
          `Snapshot scope ${observed} does not match project ${projectId}`,
        ),
      };
    }

    const dbPath = resolveGroveDbPath(found.grove.id, mycoHome);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    try {
      const result = restoreBackup(db, snapshotPath);
      return {
        body: {
          ok: true,
          grove_id: found.grove.id,
          project_id: projectId,
          tables: result.tables,
          total_restored: result.total_restored,
          total_skipped: result.total_skipped,
        },
      };
    } catch (err) {
      return { status: 500, body: errorBody('restore_failed', (err as Error).message) };
    } finally {
      db.close();
    }
  };
}

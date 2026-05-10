/**
 * Project-scoped HTTP handlers — standalone backup and restore for a single
 * registered project. Sibling-called by both CLI and HTTP API; neither
 * wraps the other.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import {
  assertGroveProjectId,
  projectScope,
  projectUrlSlug,
} from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import { findRegisteredProject, isProjectPaused } from '@myco/grove/registry.js';
import { createBackup, readSnapshotHeader, restoreBackup } from '../backup.js';
import type { RouteHandler } from '../router.js';
import { errorBody } from './error-envelope.js';

/** Default backup root: `~/myco_backups/<projectSlug>`. */
function defaultProjectBackupDir(projectName: string, projectId: string): string {
  return path.join(os.homedir(), 'myco_backups', projectUrlSlug(projectName, projectId));
}

/**
 * Read the cached machine id from the project's vault dir, falling back to
 * a stable label when no cache exists yet. The same fallback shape used by
 * the move orchestrator — first-time backup against a fresh clone is fine.
 */
function readProjectMachineId(projectRoot: string): string {
  const cachePath = path.join(projectRoot, '.myco', 'machine_id');
  try {
    const cached = fs.readFileSync(cachePath, 'utf-8').trim();
    if (cached.length > 0) return cached;
  } catch {
    // fall through
  }
  return 'project-backup_local';
}

export interface ProjectBackupHandlerOptions {
  /** Override `~/myco_backups`. Tests pass an explicit value. */
  backupsRoot?: string;
  /** Override Myco home (tests). */
  mycoHome?: string;
}

export function createProjectBackupHandler(
  options: ProjectBackupHandlerOptions = {},
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

    // Pause gate. The server-level gate keys on `requestContext.projectId`
    // (sourced from headers); project-scoped routes resolve `projectId` from
    // the URL, so we re-check here to keep backup/restore from racing a
    // concurrent move on the same project.
    const paused = isProjectPaused(projectId, mycoHome);
    if (paused.paused) {
      return {
        status: 409,
        body: {
          ...errorBody(
            'project_paused',
            `Project ${projectId} is paused (${paused.reason})`,
          ),
          paused: {
            reason: paused.reason,
            since: paused.since,
            owner_op: paused.owner_op,
            grove_id: paused.grove_id,
          },
        },
      };
    }

    const slug = projectUrlSlug(found.project.name, found.project.project_id);
    const backupDir = options.backupsRoot
      ? path.join(options.backupsRoot, slug)
      : defaultProjectBackupDir(found.project.name, found.project.project_id);
    fs.mkdirSync(backupDir, { recursive: true });

    const machineId = readProjectMachineId(found.project.root);
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

    // Pause gate. The server-level gate keys on `requestContext.projectId`
    // (sourced from headers); project-scoped routes resolve `projectId` from
    // the URL, so we re-check here to keep backup/restore from racing a
    // concurrent move on the same project.
    const paused = isProjectPaused(projectId, mycoHome);
    if (paused.paused) {
      return {
        status: 409,
        body: {
          ...errorBody(
            'project_paused',
            `Project ${projectId} is paused (${paused.reason})`,
          ),
          paused: {
            reason: paused.reason,
            since: paused.since,
            owner_op: paused.owner_op,
            grove_id: paused.grove_id,
          },
        },
      };
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

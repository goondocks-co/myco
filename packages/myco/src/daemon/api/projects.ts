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
import {
  findRegisteredProject,
  isProjectPaused,
  loadGroveRecord,
} from '@myco/grove/registry.js';
import { assertSafeProjectRoot } from '@myco/vault/resolve.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { resolveProjectManifestPath } from '@myco/grove/paths.js';
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

export interface CommitToRepoBody {
  /**
   * Reserved for the launcher-write toggle: when true, also writes
   * `.agents/myco-run.cjs` + `.agents/myco-cli.cjs`. Not implemented in
   * this stub — the launcher-write path lands with the Wave 2 UI work.
   */
  write_launchers?: boolean;
  /**
   * Reserved for the runtime-pin toggle: when set, writes
   * `.myco/runtime.command` with this absolute path. Not implemented
   * in this stub.
   */
  runtime_command?: string;
}

/**
 * Write `<projectRoot>/.myco/project.toml` with the project's Grove
 * identity so teammates cloning the repo resolve to the same logical
 * Grove on their own machines. Idempotent: re-writing with the same
 * identity is a no-op from the file's perspective (the manifest writer
 * merges).
 *
 * The launcher-write and runtime-pin flags are accepted but deferred —
 * the API surface is reserved here so Wave 2's UI doesn't have to
 * version-bump the contract. Returns `not_implemented_flags` listing
 * any flags the caller set that aren't yet honored.
 */
export function createCommitToRepoHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const projectId = req.params.projectId;
    const mycoHome = resolveMycoHome();
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

    const projectRoot = path.resolve(found.project.root);
    try {
      assertSafeProjectRoot(projectRoot);
    } catch (err) {
      return { status: 400, body: errorBody('unsafe_project_root', (err as Error).message) };
    }

    const grove = loadGroveRecord(found.grove.id, mycoHome);
    if (!grove) {
      return {
        status: 500,
        body: errorBody('grove_record_missing', `Grove ${found.grove.id} record could not be loaded`),
      };
    }

    const projectVaultDir = resolveProjectVaultDir(projectRoot);
    try {
      saveProjectManifest(projectVaultDir, {
        project: {
          id: assertGroveProjectId(projectId),
          name: found.project.name,
        },
        grove: {
          id: grove.id,
          slug: grove.slug,
          name: grove.name,
        },
      });
    } catch (err) {
      return { status: 500, body: errorBody('manifest_write_failed', (err as Error).message) };
    }

    const body = (req.body ?? {}) as CommitToRepoBody;
    const deferred: string[] = [];
    if (body.write_launchers === true) deferred.push('write_launchers');
    if (typeof body.runtime_command === 'string' && body.runtime_command.length > 0) deferred.push('runtime_command');

    return {
      body: {
        ok: true,
        project_id: projectId,
        grove_id: grove.id,
        manifest_path: resolveProjectManifestPath(projectVaultDir),
        ...(deferred.length > 0 ? { not_implemented_flags: deferred } : {}),
      },
    };
  };
}

/**
 * Remove `<projectRoot>/.myco/project.toml`. The project stays
 * auto-registered — the registry binding lives at `~/.myco/groves/`
 * and is independent of the committed file. Idempotent: deleting an
 * already-absent file returns ok.
 */
export function createUncommitFromRepoHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const projectId = req.params.projectId;
    const mycoHome = resolveMycoHome();
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

    const projectVaultDir = resolveProjectVaultDir(path.resolve(found.project.root));
    const manifestPath = resolveProjectManifestPath(projectVaultDir);
    let removed = false;
    if (fs.existsSync(manifestPath)) {
      try {
        fs.unlinkSync(manifestPath);
        removed = true;
      } catch (err) {
        return { status: 500, body: errorBody('manifest_delete_failed', (err as Error).message) };
      }
    }

    return {
      body: {
        ok: true,
        project_id: projectId,
        manifest_path: manifestPath,
        removed,
      },
    };
  };
}

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
import {
  loadProjectLocalManifest,
  saveProjectLocalManifest,
  saveProjectManifest,
} from '@myco/config/project-manifest.js';
import { createGroveBindingId } from '@myco/grove/ids.js';
import {
  resolveProjectLocalManifestPath,
  resolveProjectManifestPath,
} from '@myco/grove/paths.js';
import { BUNDLED_TEMPLATES } from '@myco/symbionts/templates.generated.js';
import { removeProjectLaunchers } from '@myco/symbionts/installer.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
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
   * Write the project-local launchers at `.agents/myco-run.cjs` +
   * `.agents/myco-cli.cjs`. Both use the bundled `myco-run.cjs`
   * template — the file resolves its mode from its own basename, so
   * the two filenames are content-identical and a single template
   * powers both.
   */
  write_launchers?: boolean;
  /**
   * Write `.myco/runtime.command` with the supplied absolute path,
   * pinning the project to a specific Myco binary (the dogfood / beta-
   * channel use case). The path is validated as absolute; non-absolute
   * paths are rejected so the pin can't depend on the caller's PATH.
   */
  runtime_command?: string;
}

/** Project-relative paths of the active runtime launchers. */
const PROJECT_LAUNCHER_PATHS = [
  path.join('.agents', 'myco-run.cjs'),
  path.join('.agents', 'myco-cli.cjs'),
] as const;
const PROJECT_RUNTIME_COMMAND_REL = path.join('.myco', 'runtime.command');

/**
 * Write `<projectRoot>/.myco/project.toml` with the project's Grove
 * identity so teammates cloning the repo resolve to the same logical
 * Grove on their own machines. Idempotent: re-writing with the same
 * identity is a no-op from the file's perspective (the manifest writer
 * merges).
 *
 * Optional flags `write_launchers` and `runtime_command` install the
 * project-local launcher override and binary pin. Returns the
 * relative paths actually written in `wrote` so the UI can surface
 * exactly what landed on disk.
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

    const body = (req.body ?? {}) as CommitToRepoBody;
    if (body.runtime_command !== undefined) {
      if (typeof body.runtime_command !== 'string' || body.runtime_command.length === 0) {
        return {
          status: 400,
          body: errorBody('invalid_runtime_command', 'runtime_command must be a non-empty string'),
        };
      }
      if (!path.isAbsolute(body.runtime_command)) {
        return {
          status: 400,
          body: errorBody('invalid_runtime_command', 'runtime_command must be an absolute path'),
        };
      }
    }

    const projectVaultDir = resolveProjectVaultDir(projectRoot);
    const wrote: string[] = [];
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
      wrote.push(path.relative(projectRoot, resolveProjectManifestPath(projectVaultDir)));

      // Per-machine binding lives in local.toml (gitignored), not project.toml.
      // Without it, the daemon's `assertGroveBound` refuses to start against
      // this vault on subsequent boots. Preserve any existing binding the
      // user already has; otherwise mint a fresh one.
      const existingLocal = loadProjectLocalManifest(projectVaultDir);
      const bindingId = existingLocal?.grove_binding?.binding_id ?? createGroveBindingId();
      saveProjectLocalManifest(projectVaultDir, {
        grove_binding: { binding_id: bindingId, mode: 'local' },
      });
    } catch (err) {
      return { status: 500, body: errorBody('manifest_write_failed', (err as Error).message) };
    }

    if (body.write_launchers === true) {
      const template = BUNDLED_TEMPLATES['myco-run.cjs'];
      if (!template) {
        return {
          status: 500,
          body: errorBody('launcher_template_missing', 'Bundled myco-run.cjs template is unavailable'),
        };
      }
      const agentsDir = path.join(projectRoot, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      for (const rel of PROJECT_LAUNCHER_PATHS) {
        const absPath = path.join(projectRoot, rel);
        atomicWriteFileSync(absPath, template);
        wrote.push(rel);
      }
    }

    if (typeof body.runtime_command === 'string' && body.runtime_command.length > 0) {
      const absPath = path.join(projectRoot, PROJECT_RUNTIME_COMMAND_REL);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      atomicWriteFileSync(absPath, `${body.runtime_command.trim()}\n`);
      wrote.push(PROJECT_RUNTIME_COMMAND_REL);
    }

    return {
      body: {
        ok: true,
        project_id: projectId,
        grove_id: grove.id,
        manifest_path: resolveProjectManifestPath(projectVaultDir),
        wrote,
      },
    };
  };
}

export interface UncommitFromRepoBody {
  /**
   * Also remove `.agents/myco-run.cjs` + `.agents/myco-cli.cjs`. Defaults
   * to true so DELETE is symmetric with the corresponding POST (a clean
   * "uncommit" leaves no Myco artifacts behind in the project tree).
   * Set explicitly to false to keep the launchers in place — e.g. for
   * dogfood workflows that still want the project pinned to a dev binary
   * even after the Grove identity is unbound.
   */
  remove_launchers?: boolean;
  /**
   * Also remove `.myco/runtime.command`. Defaults to true for symmetry.
   */
  remove_runtime_command?: boolean;
}

/**
 * Remove `<projectRoot>/.myco/project.toml` and (by default) the
 * project-local launchers + runtime-command pin. The project stays
 * auto-registered — the registry binding lives at `~/.myco/groves/`
 * and is independent of the committed file. Idempotent: deleting
 * already-absent files returns ok with `removed: []`.
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

    const body = (req.body ?? {}) as UncommitFromRepoBody;
    const removeLaunchers = body.remove_launchers !== false;
    const removeRuntime = body.remove_runtime_command !== false;

    const projectRoot = path.resolve(found.project.root);
    const projectVaultDir = resolveProjectVaultDir(projectRoot);
    const manifestPath = resolveProjectManifestPath(projectVaultDir);
    const localManifestPath = resolveProjectLocalManifestPath(projectVaultDir);
    const removed: string[] = [];

    for (const target of [manifestPath, localManifestPath]) {
      if (!fs.existsSync(target)) continue;
      try {
        fs.unlinkSync(target);
        removed.push(path.relative(projectRoot, target));
      } catch (err) {
        return { status: 500, body: errorBody('manifest_delete_failed', (err as Error).message) };
      }
    }

    if (removeLaunchers || removeRuntime) {
      const swept = removeProjectLaunchers(projectRoot, {
        legacy: false,
        active: removeLaunchers,
        runtimeCommand: removeRuntime,
      });
      removed.push(...swept);
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

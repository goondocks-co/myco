/**
 * Backup API handlers — create, list, preview, and restore backups.
 *
 * Grove-era layout: each Grove gets its own backup directory under either
 * `<groveHome>/backups/` (default) or `<configured backup.dir>/<groveSlug>/`
 * when the user has set `backup.dir` in their config. Handlers resolve the
 * Grove from the per-request context so a daemon serving multiple Groves
 * keeps each Grove's backups in its own folder. The DB written into the
 * backup is the per-Grove DB, looked up from the request context's
 * `databasePath` via the runtime cache.
 */

import type { Database } from 'bun:sqlite';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { MycoConfig } from '../../config/schema.js';
import {
  createBackup,
  listBackups,
  pruneBackups,
  restorePreview,
  restoreBackup,
} from '../backup.js';
import { loadMergedConfig, updateBackupConfig } from '../../config/loader.js';
import { loadGroveRecord, listGroves, type GroveRecord } from '../../grove/registry.js';
import { resolveGroveDir, resolveGroveDbPath, resolveMycoHome } from '../../grove/paths.js';
import type { GroveRuntimeCache } from '../grove-runtime-cache.js';
import os from 'node:os';
import path from 'node:path';
import {
  resolveActionScope,
  actionScopeKey,
  InvalidActionScopeError,
  type ActionScope,
} from './action-scope.js';
import { ActionInflightRegistry } from './action-inflight.js';
import { errorMessage } from '@myco/utils/error-message.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupDeps {
  /** Boot-time DB used when a request arrives without a Grove request context. */
  bootDb: Database;
  /** Boot-time vault dir, used as the legacy backup root fallback. */
  bootVaultDir: string;
  /** Boot-time Grove id, used when request context is absent. */
  bootGroveId: string | null;
  /** Per-Grove runtime cache shared with the rest of the daemon. */
  cache: GroveRuntimeCache;
  machineId: string;
  /** Holder so config (`backup.dir`, retention) is re-read on every request. */
  liveConfig: { current: MycoConfig };
  /** Override Myco home (tests); production resolves via env/HOME. */
  mycoHome?: string;
}

interface BackupScope {
  db: Database;
  backupDir: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function expandHome(rawDir: string): string {
  return rawDir.startsWith('~/') ? path.join(os.homedir(), rawDir.slice(2)) : rawDir;
}

/**
 * Per-Grove backup directory.
 *
 * - When `backup.dir` is unset → `<groveHome>/backups`.
 * - When set → `<expanded backup.dir>/<groveSlug>` so a single user-chosen
 *   root hosts every Grove without colliding `<machineId>.sql` files.
 */
export function resolveGroveBackupDir(
  config: MycoConfig,
  grove: { slug: string },
  groveHome: string,
): string {
  const rawDir = config.backup.dir;
  if (!rawDir) return path.resolve(groveHome, 'backups');
  return path.join(path.resolve(expandHome(rawDir)), grove.slug);
}

// Legacy fallback for the no-Grove-in-context path (pre-Grove tests, boot fallback).
export function resolveBackupDir(config: MycoConfig, vaultDir: string): string {
  const rawDir = config.backup.dir;
  if (!rawDir) return path.resolve(vaultDir, 'backups');
  return path.resolve(expandHome(rawDir));
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
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  function resolveScope(req: RouteRequest): BackupScope {
    const groveId = req.requestContext?.groveId ?? deps.bootGroveId;
    if (groveId) {
      const grove = loadGroveRecord(groveId, mycoHome);
      if (grove) {
        const groveHome = resolveGroveDir(grove.id, mycoHome);
        const backupDir = resolveGroveBackupDir(deps.liveConfig.current, grove, groveHome);
        const databasePath = req.requestContext?.databasePath;
        const db = databasePath ? deps.cache.getDatabase(databasePath) : deps.bootDb;
        return { db, backupDir };
      }
    }
    // Legacy fallback — no Grove resolvable for this request.
    return {
      db: deps.bootDb,
      backupDir: resolveBackupDir(deps.liveConfig.current, deps.bootVaultDir),
    };
  }

  const inflight = new ActionInflightRegistry();

  function performBackupForGrove(grove: GroveRecord): {
    grove_id: string;
    grove_slug: string;
    ok: boolean;
    file_path?: string;
    size_bytes?: number;
    error?: string;
  } {
    try {
      const groveHome = resolveGroveDir(grove.id, mycoHome);
      const backupDir = resolveGroveBackupDir(deps.liveConfig.current, grove, groveHome);
      const databasePath = resolveGroveDbPath(grove.id, mycoHome);
      const db = deps.cache.getDatabase(databasePath);
      const filePath = createBackup(db, backupDir, deps.machineId);
      pruneBackups(backupDir, deps.liveConfig.current.backup.retention);
      const backups = listBackups(backupDir);
      const created = backups.find((b) => b.machine_id === deps.machineId);
      return {
        grove_id: grove.id,
        grove_slug: grove.slug,
        ok: true,
        file_path: filePath,
        size_bytes: created?.size_bytes ?? 0,
      };
    } catch (err) {
      return {
        grove_id: grove.id,
        grove_slug: grove.slug,
        ok: false,
        error: errorMessage(err),
      };
    }
  }

  /** POST /api/backup — create a new backup of all synced tables. */
  async function handleCreateBackup(req: RouteRequest): Promise<RouteResponse> {
    // Try to read explicit scope from body. If absent or malformed and
    // request context is missing, fall back to legacy single-Grove
    // resolution so old clients continue to work.
    let scope: ActionScope | null = null;
    try {
      // Backup is per-Grove, never per-project. Default-from-context
      // therefore resolves to `kind:'grove'` rather than the historical
      // `kind:'project'`, which avoided silently widening to a Grove
      // backup when the caller's request context happened to have a
      // project id. (P2 #36)
      scope = resolveActionScope({
        body: req.body,
        requestContext: req.requestContext,
        defaultKind: 'grove',
      });
    } catch (err) {
      if (err instanceof InvalidActionScopeError) {
        const raw = (req.body as { scope?: unknown } | null | undefined)?.scope;
        if (raw !== undefined) {
          return { status: 400, body: { error: 'invalid_scope', message: err.message } };
        }
        scope = null;
      } else {
        throw err;
      }
    }

    if (scope && scope.kind === 'all-groves') {
      const key = `backup:${actionScopeKey(scope)}`;
      return inflight.run(key, async (): Promise<RouteResponse> => {
        const groves = listGroves(mycoHome);
        const results = groves.map((g) => performBackupForGrove(g));
        const ok = results.filter((r) => r.ok).length;
        return {
          body: {
            scope,
            results,
            summary: { ok, failed: results.length - ok },
          },
        };
      });
    }

    if (scope && scope.kind === 'project') {
      // Backup files are per-Grove, not per-project — there is no
      // project-narrowed data plane to honor here. Reject the scope
      // explicitly rather than silently widening to the Grove backup,
      // so clients that asked for a project-scoped backup get a
      // deterministic error and can choose `kind:'grove'` instead.
      // (P2 #36)
      return {
        status: 400,
        body: {
          error: 'invalid_scope',
          message: 'Backups are taken per-Grove; pass kind: "grove" or "all-groves" instead of "project"',
        },
      };
    }

    if (scope && scope.kind === 'grove') {
      const grove = loadGroveRecord(scope.grove_id, mycoHome);
      if (!grove) return { status: 404, body: { error: 'grove_not_found' } };
      const key = `backup:${actionScopeKey(scope)}`;
      return inflight.run(key, async (): Promise<RouteResponse> => {
        const result = performBackupForGrove(grove);
        if (!result.ok) {
          return { status: 500, body: { scope, results: [result], summary: { ok: 0, failed: 1 } } };
        }
        return {
          body: {
            scope,
            results: [result],
            summary: { ok: 1, failed: 0 },
            // Legacy fields for backward compatibility.
            file_path: result.file_path,
            machine_id: deps.machineId,
            size_bytes: result.size_bytes,
          },
        };
      });
    }

    // Legacy fallback path: no scope and no resolvable Grove in context.
    const { db, backupDir } = resolveScope(req);
    const filePath = createBackup(db, backupDir, deps.machineId);
    pruneBackups(backupDir, deps.liveConfig.current.backup.retention);
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
  async function handleListBackups(req: RouteRequest): Promise<RouteResponse> {
    const { backupDir } = resolveScope(req);
    return { body: { backups: listBackups(backupDir) } };
  }

  /**
   * POST /api/restore/preview — dry-run restore to show new/existing
   * counts. Accepts `file_name` for point-in-time restore (preferred);
   * falls back to `machine_id` (newest entry for that machine) for
   * back-compat with callers that haven't been updated.
   */
  async function handleRestorePreview(req: RouteRequest): Promise<RouteResponse> {
    const { machine_id, file_name } = req.body as { machine_id?: string; file_name?: string };
    if (!file_name && !machine_id) {
      return { status: 400, body: { error: 'missing_machine_id' } };
    }

    const { db, backupDir } = resolveScope(req);
    const backups = listBackups(backupDir);
    const backup = file_name
      ? backups.find((b) => b.file_name === file_name)
      : backups.find((b) => b.machine_id === machine_id);
    if (!backup) {
      return { status: 404, body: { error: 'backup_not_found' } };
    }

    const backupPath = `${backupDir}/${backup.file_name}`;
    const tables = restorePreview(db, backupPath);
    const total_new = tables.reduce((sum, t) => sum + t.new, 0);
    const total_existing = tables.reduce((sum, t) => sum + t.existing, 0);

    return {
      body: {
        machine_id: backup.machine_id,
        file_name: backup.file_name,
        tables,
        total_new,
        total_existing,
      },
    };
  }

  /** POST /api/restore — execute restore from a backup file. */
  async function handleRestore(req: RouteRequest): Promise<RouteResponse> {
    const { machine_id, file_name } = req.body as { machine_id?: string; file_name?: string };
    if (!file_name && !machine_id) {
      return { status: 400, body: { error: 'missing_machine_id' } };
    }

    const { db, backupDir } = resolveScope(req);
    const backups = listBackups(backupDir);
    const backup = file_name
      ? backups.find((b) => b.file_name === file_name)
      : backups.find((b) => b.machine_id === machine_id);
    if (!backup) {
      return { status: 404, body: { error: 'backup_not_found' } };
    }

    const backupPath = `${backupDir}/${backup.file_name}`;
    const result = restoreBackup(db, backupPath);

    return {
      body: { machine_id: backup.machine_id, file_name: backup.file_name, ...result },
    };
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
  /** Boot-time Grove id; used to compute the default-dir hint. */
  bootGroveId: string | null;
  mycoHome?: string;
}

/**
 * Create handlers for GET/PUT /api/backup/config.
 */
export function createBackupConfigHandlers(deps: BackupConfigDeps) {
  const { vaultDir } = deps;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  function defaultDirForGrove(grove: GroveRecord | null): string {
    if (grove) return path.resolve(resolveGroveDir(grove.id, mycoHome), 'backups');
    return path.resolve(vaultDir, 'backups');
  }

  /** GET /api/backup/config — read the configured backup directory (merged). */
  async function handleGetBackupConfig(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.requestContext?.groveId ?? deps.bootGroveId;
    const cfg = loadMergedConfig(vaultDir, { groveId, mycoHome });
    const grove = groveId ? loadGroveRecord(groveId, mycoHome) : null;
    return {
      body: {
        dir: cfg.backup.dir ?? null,
        default_dir: defaultDirForGrove(grove),
      },
    };
  }

  /** PUT /api/backup/config — update the backup directory setting. */
  async function handlePutBackupConfig(req: RouteRequest): Promise<RouteResponse> {
    const { dir } = req.body as { dir?: string | null };
    updateBackupConfig(vaultDir, { dir: dir || undefined });
    return { body: { dir: dir || null } };
  }

  return { handleGetBackupConfig, handlePutBackupConfig };
}

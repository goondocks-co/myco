/**
 * Backup API handlers — create, list, preview, and restore backups.
 *
 * Every endpoint resolves the target Grove EXPLICITLY and identically:
 * create takes the Grove from the request-body `ActionScope`; list, preview,
 * and restore take it from the bearer-gated `x-myco-grove-id` request
 * context. There is no silent boot-Grove fallback — a read with no Grove in
 * context fails loud (400 `grove_required`). This is the contract that keeps
 * read and write pointed at the same Grove: previously create resolved the
 * Grove from the body while the reads resolved it from a different source
 * (header context + boot fallback), so a backup could land in one Grove
 * while the list showed another and reported "No backups yet".
 *
 * All directory/retention/file logic lives in the backup domain
 * (`@myco/backup`); these handlers only resolve scope, fetch the Grove's
 * DB handle from the runtime cache, and shape responses.
 */

import type { RouteRequest, RouteResponse } from '../router.js';
import {
  createGroveBackup,
  listGroveBackups,
  previewGroveRestore,
  findGroveBackup,
  type GroveBackupRef,
} from '@myco/backup/service.js';
import { restoreViaChild } from '@myco/backup/restore-runner.js';
import { RestoreJobRegistry } from '@myco/backup/restore-jobs.js';
import type { RestoreResult } from '@myco/backup/engine.js';
import { z } from 'zod';
import { loadMergedConfig, updateTierConfigRaw, TierConfigUnreadableError } from '../../config/loader.js';
import { setAtPath, unsetAtPath } from '../../utils/dot-path.js';
import { assertOwnedGrove, loadGroveRecord, listGroves, type GroveRecord } from '../../grove/registry.js';
import { resolveGroveDir, resolveGroveDbPath, resolveMycoHome, currentDaemonVariant } from '../../grove/paths.js';
import type { GroveRuntimeCache } from '../grove-runtime-cache.js';
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

export type RestoreRunner = (params: { dbPath: string; backupPath: string }) => Promise<RestoreResult>;

export interface BackupDeps {
  /** Per-Grove runtime cache — source of every Grove's DB handle. */
  cache: GroveRuntimeCache;
  machineId: string;
  /** Override Myco home (tests); production resolves via env/HOME. */
  mycoHome?: string;
  /**
   * How a restore is executed. Defaults to an out-of-process run via the
   * daemon's own binary (so a heavy restore never blocks the event loop).
   * Tests inject an in-process runner.
   */
  restoreRunner?: RestoreRunner;
}

interface PerGroveBackupResult {
  grove_id: string;
  grove_slug: string;
  ok: boolean;
  file_path?: string;
  size_bytes?: number;
  error?: string;
}

const GROVE_REQUIRED: RouteResponse = {
  status: 400,
  body: {
    error: 'grove_required',
    message: 'A Grove context is required (x-myco-grove-id). Select a project/Grove first.',
  },
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createBackupHandlers(deps: BackupDeps) {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const inflight = new ActionInflightRegistry();
  const restoreRunner: RestoreRunner =
    deps.restoreRunner ?? ((p) => restoreViaChild({ ...p, binaryPath: process.execPath }));
  const restoreJobs = new RestoreJobRegistry(restoreRunner);

  function databaseForGrove(groveId: string) {
    return deps.cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
  }

  function toWire(ref: GroveBackupRef) {
    return {
      machine_id: ref.machine_id,
      file_name: ref.file_name,
      size_bytes: ref.size_bytes,
      modified_at: ref.modified_at,
    };
  }

  function performBackupForGrove(grove: GroveRecord): PerGroveBackupResult {
    try {
      const result = createGroveBackup({
        groveId: grove.id,
        db: databaseForGrove(grove.id),
        machineId: deps.machineId,
        mycoHome,
      });
      return {
        grove_id: grove.id,
        grove_slug: grove.slug,
        ok: true,
        file_path: result.file_path,
        size_bytes: result.size_bytes,
      };
    } catch (err) {
      return { grove_id: grove.id, grove_slug: grove.slug, ok: false, error: errorMessage(err) };
    }
  }

  /** POST /api/backup — create a backup for one Grove (or every served Grove). */
  async function handleCreateBackup(req: RouteRequest): Promise<RouteResponse> {
    // Backups are per-Grove, never per-project, so the missing-body default
    // resolves to `kind:'grove'` from the request context rather than
    // silently widening a project request to a Grove backup.
    let scope: ActionScope;
    try {
      scope = resolveActionScope({
        body: req.body,
        requestContext: req.requestContext,
        defaultKind: 'grove',
      });
    } catch (err) {
      if (err instanceof InvalidActionScopeError) {
        const raw = (req.body as { scope?: unknown } | null | undefined)?.scope;
        // Malformed body scope → 400 invalid_scope; absent scope with no
        // resolvable Grove context → 400 grove_required (fail loud, no fallback).
        return raw !== undefined
          ? { status: 400, body: { error: 'invalid_scope', message: err.message } }
          : GROVE_REQUIRED;
      }
      throw err;
    }

    if (scope.kind === 'project') {
      return {
        status: 400,
        body: {
          error: 'invalid_scope',
          message: 'Backups are taken per-Grove; pass kind: "grove" or "all-groves" instead of "project"',
        },
      };
    }

    if (scope.kind === 'all-groves') {
      const key = `backup:${actionScopeKey(scope)}`;
      return inflight.run(key, async (): Promise<RouteResponse> => {
        // "all-groves" means every Grove THIS daemon serves; the peer daemon
        // backs up its own Groves.
        const groves = listGroves(mycoHome, { servedBy: currentDaemonVariant() });
        const results = groves.map((g) => performBackupForGrove(g));
        const ok = results.filter((r) => r.ok).length;
        return { body: { scope, results, summary: { ok, failed: results.length - ok } } };
      });
    }

    // scope.kind === 'grove'. Body-scope grove ids arrive outside the
    // request-context funnel, so existence and served_by ownership gate
    // here before the backup opens the Grove DB; throws propagate to the
    // transport (403 foreign_grove / 404 grove_not_found).
    const grove = assertOwnedGrove(scope.grove_id, mycoHome);
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
          // Legacy fields for back-compat with single-Grove clients.
          file_path: result.file_path,
          machine_id: deps.machineId,
          size_bytes: result.size_bytes,
        },
      };
    });
  }

  /** GET /api/backups — list the active Grove's backups (canonical + legacy). */
  async function handleListBackups(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.requestContext?.groveId;
    if (!groveId) return GROVE_REQUIRED;
    return { body: { backups: listGroveBackups(groveId, { mycoHome }).map(toWire) } };
  }

  /** Resolve the backup file the caller named (file_name) or implied (newest for machine_id). */
  function resolveTargetFileName(
    groveId: string,
    body: { machine_id?: string; file_name?: string },
  ): string | null {
    if (body.file_name) return body.file_name;
    if (!body.machine_id) return null;
    const newest = listGroveBackups(groveId, { mycoHome }).find((b) => b.machine_id === body.machine_id);
    return newest?.file_name ?? null;
  }

  /** POST /api/restore/preview — dry-run restore counts for one backup. */
  async function handleRestorePreview(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.requestContext?.groveId;
    if (!groveId) return GROVE_REQUIRED;
    const body = (req.body ?? {}) as { machine_id?: string; file_name?: string };
    const fileName = resolveTargetFileName(groveId, body);
    if (!fileName) return { status: 400, body: { error: 'missing_machine_id' } };

    const preview = await previewGroveRestore({
      groveId,
      db: databaseForGrove(groveId),
      fileName,
      mycoHome,
    });
    if (!preview) return { status: 404, body: { error: 'backup_not_found' } };
    return {
      body: {
        machine_id: preview.ref.machine_id,
        file_name: preview.ref.file_name,
        tables: preview.tables,
        total_in_backup: preview.total_in_backup,
        total_in_db: preview.total_in_db,
      },
    };
  }

  /**
   * POST /api/restore — start a restore. A restore of a large backup takes
   * minutes (it executes the whole dump out-of-process), so this returns a
   * job id immediately and the client polls GET /api/restore/status. Re-uses
   * the in-flight job when one is already running for the Grove.
   */
  async function handleRestore(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.requestContext?.groveId;
    if (!groveId) return GROVE_REQUIRED;
    const body = (req.body ?? {}) as { machine_id?: string; file_name?: string };
    const fileName = resolveTargetFileName(groveId, body);
    if (!fileName) return { status: 400, body: { error: 'missing_machine_id' } };

    const ref = findGroveBackup(groveId, fileName, { mycoHome });
    if (!ref) return { status: 404, body: { error: 'backup_not_found' } };

    const job = restoreJobs.start({
      groveId,
      fileName: ref.file_name,
      dbPath: resolveGroveDbPath(groveId, mycoHome),
      backupPath: ref.path,
    });
    return { status: 202, body: { job_id: job.id, status: job.status, file_name: ref.file_name } };
  }

  /** GET /api/restore/status?job_id=… — poll a restore job's progress. */
  async function handleRestoreStatus(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.requestContext?.groveId;
    if (!groveId) return GROVE_REQUIRED;
    const jobId = typeof req.query?.job_id === 'string' ? req.query.job_id : undefined;
    if (!jobId) return { status: 400, body: { error: 'missing_job_id' } };

    const job = restoreJobs.get(jobId);
    // Scope the job to the requesting Grove so a job id can't be read across
    // Grove contexts.
    if (!job || job.grove_id !== groveId) {
      return { status: 404, body: { error: 'restore_job_not_found' } };
    }
    return {
      body: {
        job_id: job.id,
        status: job.status,
        file_name: job.file_name,
        started_at: job.started_at,
        finished_at: job.finished_at ?? null,
        result: job.result ?? null,
        error: job.error ?? null,
      },
    };
  }

  return {
    handleCreateBackup,
    handleListBackups,
    handleRestorePreview,
    handleRestoreStatus,
    handleRestore,
  };
}

// ---------------------------------------------------------------------------
// Backup config handlers — factory
// ---------------------------------------------------------------------------

export interface BackupConfigDeps {
  /** Bootstrap fallback used only when a request arrives with no context. */
  bootstrapVaultDir: string;
  /** Boot-time Grove id; used to compute the default-dir hint when unset. */
  bootGroveId: string | null;
  mycoHome?: string;
}

/**
 * Create handlers for GET/PUT /api/backup/config.
 *
 * The vault dir is resolved per-request from `req.requestContext.projectVaultDir`
 * so each project's backup setting is read/written against its own
 * `myco.yaml`. `bootstrapVaultDir` is only used when no request context is
 * bound (legacy / non-daemon callers).
 */
export function createBackupConfigHandlers(deps: BackupConfigDeps) {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  function defaultDirForGrove(grove: GroveRecord | null, vaultDir: string): string {
    if (grove) return path.resolve(resolveGroveDir(grove.id, mycoHome), 'backups');
    return path.resolve(vaultDir, 'backups');
  }

  function vaultDirForRequest(req: RouteRequest): string {
    return req.requestContext?.projectVaultDir ?? deps.bootstrapVaultDir;
  }

  /** GET /api/backup/config — read the configured backup directory (merged). */
  async function handleGetBackupConfig(req: RouteRequest): Promise<RouteResponse> {
    const vaultDir = vaultDirForRequest(req);
    const groveId = req.requestContext?.groveId ?? deps.bootGroveId;
    const cfg = loadMergedConfig(vaultDir, { groveId, mycoHome });
    const grove = groveId ? loadGroveRecord(groveId, mycoHome) : null;
    return {
      body: {
        dir: cfg.backup.dir ?? null,
        default_dir: defaultDirForGrove(grove, vaultDir),
      },
    };
  }

  /**
   * PUT /api/backup/config — update the backup directory setting.
   *
   * `backup` lives at Grove tier (see `GroveConfigSchema`) — one backup
   * policy per Grove. Project myco.yaml writes for `backup.*` are
   * silently stripped by `PROJECT_TIER_LEGACY_FIELDS` on the next load,
   * so the API must persist to `~/.myco/groves/<id>/grove.yaml` to
   * survive a daemon restart.
   */
  async function handlePutBackupConfig(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.requestContext?.groveId ?? deps.bootGroveId;
    if (!groveId) {
      return { status: 404, body: { error: 'no_grove_in_context' } };
    }
    const { dir } = req.body as { dir?: string | null };
    try {
      updateTierConfigRaw({ kind: 'grove', groveId }, (rawDoc) => {
        if (dir) setAtPath(rawDoc, ['backup', 'dir'], dir);
        else unsetAtPath(rawDoc, ['backup', 'dir'], { pruneEmptyParents: true });
        return rawDoc;
      }, { mycoHome });
    } catch (err) {
      if (err instanceof TierConfigUnreadableError) {
        return {
          status: 422,
          body: {
            error: 'tier_config_unreadable',
            message: 'The on-disk grove config is invalid — fix or remove it before writing.',
            file: err.filePath,
          },
        };
      }
      if (err instanceof z.ZodError) {
        return { status: 422, body: { error: 'validation_failed', issues: err.issues } };
      }
      throw err;
    }
    return { body: { dir: dir || null } };
  }

  return { handleGetBackupConfig, handlePutBackupConfig };
}

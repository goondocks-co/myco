import fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { Logger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { GroveRuntimeCache, EmbeddingRuntimeFactory } from '../grove-runtime-cache.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { MS_PER_HOUR } from '@myco/constants.js';
import {
  forEachGrove,
  type GroveScope,
} from '../scope-iteration.js';
import {
  resolveGroveDbPath,
  resolveGroveDir,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import {
  loadGroveRecord,
  listRegisteredProjects,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { withDatabase } from '@myco/db/client.js';
import {
  getDatabaseFileStats,
  getLastDatabaseLogTimestamps,
} from '@myco/db/queries/database.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { resolveGroveBackupDir } from './backup.js';
import { listBackups } from '../backup.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaintenanceLastIntegrity {
  at: string;
  status: 'ok' | 'issues';
}

export interface GroveMaintenanceSummary {
  grove: {
    id: string;
    slug: string;
    name: string;
    mode: GroveRecord['mode'];
  };
  project_count: number;
  db_size_bytes: number;
  log_count: number;
  /**
   * Pending embedding work. `null` (rather than `0`) when the lookup
   * failed — the UI distinguishes "drained" from "broken signal" so a
   * locked DB doesn't silently render as a green Grove.
   */
  embedding_pending: number | null;
  last_backup_at: string | null;
  last_optimize_at: string | null;
  last_vacuum_at: string | null;
  last_integrity_check: MaintenanceLastIntegrity | null;
  /**
   * Set when the per-Grove gather threw. Other fields fall back to
   * neutral defaults so the UI can still render the row inline.
   */
  error: string | null;
}

export interface MaintenanceSummaryFlags {
  /** Groves whose most recent backup is older than `backup_overdue_hours`. */
  backup_overdue: number;
  /** Groves whose most recent optimize is older than `optimize_overdue_hours`. */
  optimize_overdue: number;
  /** Groves whose most recent integrity check ended with `status: 'issues'`. */
  integrity_issues: number;
  /** Groves whose body threw — for at-a-glance "is anything broken" UI. */
  error_count: number;
}

export interface MaintenanceSummaryResponse {
  groves: GroveMaintenanceSummary[];
  flags: MaintenanceSummaryFlags;
  thresholds: {
    backup_overdue_hours: number;
    optimize_overdue_hours: number;
  };
}

export interface MaintenanceHandlersDeps {
  logger: Logger;
  liveConfig: { current: MycoConfig };
  cache: GroveRuntimeCache;
  embeddingRuntimeFactory: EmbeddingRuntimeFactory;
  mycoHome?: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Auto-backup runs in idle/sleep on a daily cadence; 36h tolerates a
// long active session without false-flagging.
const BACKUP_OVERDUE_HOURS_DEFAULT = 36;

// Default optimize cadence is 24h; 72h gives multiple chances before warning.
const OPTIMIZE_OVERDUE_HOURS_DEFAULT = 72;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Filesystem mtime is the source of truth for "did backup actually write" —
// log_entries can lie if the body crashed after logging start.
//
// The summary endpoint polls every 10s; cache by directory mtime so we
// only re-stat the files when something actually changed.
interface BackupDirCacheEntry {
  dirMtimeMs: number;
  lastBackupAt: string | null;
}
const backupDirCache = new Map<string, BackupDirCacheEntry>();

function lastBackupAt(backupDir: string): string | null {
  let dirMtimeMs: number;
  try {
    dirMtimeMs = fs.statSync(backupDir).mtime.getTime();
  } catch {
    backupDirCache.delete(backupDir);
    return null;
  }
  const cached = backupDirCache.get(backupDir);
  if (cached && cached.dirMtimeMs === dirMtimeMs) return cached.lastBackupAt;

  let result: string | null = null;
  try {
    const backups = listBackups(backupDir);
    result = backups.length > 0 ? backups[0]!.modified_at : null;
  } catch {
    result = null;
  }
  backupDirCache.set(backupDir, { dirMtimeMs, lastBackupAt: result });
  return result;
}

function logCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM log_entries').get() as { c: number };
  return row.c;
}

function lastRunTimestamps(): {
  optimize: number | null;
  vacuum: number | null;
  integrity_ok: number | null;
  integrity_issues: number | null;
} {
  const lastRuns = getLastDatabaseLogTimestamps([
    LOG_KINDS.DATABASE_OPTIMIZE,
    LOG_KINDS.DATABASE_VACUUM,
    LOG_KINDS.DATABASE_INTEGRITY_CHECK,
    LOG_KINDS.DATABASE_INTEGRITY_ISSUES,
  ]);
  return {
    optimize: lastRuns.get(LOG_KINDS.DATABASE_OPTIMIZE) ?? null,
    vacuum: lastRuns.get(LOG_KINDS.DATABASE_VACUUM) ?? null,
    integrity_ok: lastRuns.get(LOG_KINDS.DATABASE_INTEGRITY_CHECK) ?? null,
    integrity_issues: lastRuns.get(LOG_KINDS.DATABASE_INTEGRITY_ISSUES) ?? null,
  };
}

function resolveLastIntegrity(
  okMs: number | null,
  issuesMs: number | null,
): MaintenanceLastIntegrity | null {
  if (okMs === null && issuesMs === null) return null;
  const o = okMs ?? 0;
  const i = issuesMs ?? 0;
  if (o >= i) return { at: new Date(o).toISOString(), status: 'ok' };
  return { at: new Date(i).toISOString(), status: 'issues' };
}

// Returns null on lookup failure so callers can distinguish "drained"
// from "broken signal" — the UI renders these distinctly.
function embeddingPending(
  cache: GroveRuntimeCache,
  factory: EmbeddingRuntimeFactory,
  scope: GroveScope,
): number | null {
  try {
    const entry = cache.getEmbeddingRuntime(scope.databasePath, factory);
    if (!entry.embeddingManager) return null;
    return withDatabase(entry.db, () => entry.embeddingManager!.totalPendingCount());
  } catch {
    return null;
  }
}

// Caller must run this inside `forEachGrove` (or equivalent withDatabase
// scope) — log-timestamp/log-count helpers go through getDatabase().
function buildGroveSummary(
  scope: GroveScope,
  config: MycoConfig,
  cache: GroveRuntimeCache,
  embeddingFactory: EmbeddingRuntimeFactory,
  mycoHome: string,
): GroveMaintenanceSummary {
  const backupDir = resolveGroveBackupDir(config, scope.grove, scope.groveHome);
  const fileStats = getDatabaseFileStats(scope.databasePath);
  const ts = lastRunTimestamps();
  const projects = listRegisteredProjects(scope.grove.id, mycoHome);
  return {
    grove: {
      id: scope.grove.id,
      slug: scope.grove.slug,
      name: scope.grove.name,
      mode: scope.grove.mode,
    },
    project_count: projects.length,
    db_size_bytes: fileStats.size_bytes,
    log_count: logCount(scope.db),
    embedding_pending: embeddingPending(cache, embeddingFactory, scope),
    last_backup_at: lastBackupAt(backupDir),
    last_optimize_at: ts.optimize ? new Date(ts.optimize).toISOString() : null,
    last_vacuum_at: ts.vacuum ? new Date(ts.vacuum).toISOString() : null,
    last_integrity_check: resolveLastIntegrity(ts.integrity_ok, ts.integrity_issues),
    error: null,
  };
}

function emptySummary(grove: GroveRecord, error: string): GroveMaintenanceSummary {
  return {
    grove: { id: grove.id, slug: grove.slug, name: grove.name, mode: grove.mode },
    project_count: 0,
    db_size_bytes: 0,
    log_count: 0,
    embedding_pending: null,
    last_backup_at: null,
    last_optimize_at: null,
    last_vacuum_at: null,
    last_integrity_check: null,
    error,
  };
}

function isOverdue(iso: string | null, hoursThreshold: number, now: number): boolean {
  if (!iso) return true;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return true;
  return now - ms > hoursThreshold * MS_PER_HOUR;
}

function computeFlags(
  groves: GroveMaintenanceSummary[],
  thresholds: { backup_overdue_hours: number; optimize_overdue_hours: number },
  now = Date.now(),
): MaintenanceSummaryFlags {
  let backup_overdue = 0;
  let optimize_overdue = 0;
  let integrity_issues = 0;
  let error_count = 0;
  for (const g of groves) {
    if (g.error) {
      error_count += 1;
      continue;
    }
    if (isOverdue(g.last_backup_at, thresholds.backup_overdue_hours, now)) backup_overdue += 1;
    if (isOverdue(g.last_optimize_at, thresholds.optimize_overdue_hours, now)) optimize_overdue += 1;
    if (g.last_integrity_check?.status === 'issues') integrity_issues += 1;
  }
  return { backup_overdue, optimize_overdue, integrity_issues, error_count };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createMaintenanceHandlers(deps: MaintenanceHandlersDeps) {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  async function handleSummary(_req: RouteRequest): Promise<RouteResponse> {
    const groves: GroveMaintenanceSummary[] = [];
    await forEachGrove(
      deps.cache,
      deps.logger,
      (scope) => {
        try {
          groves.push(
            buildGroveSummary(
              scope,
              deps.liveConfig.current,
              deps.cache,
              deps.embeddingRuntimeFactory,
              mycoHome,
            ),
          );
        } catch (err) {
          groves.push(emptySummary(scope.grove, errorMessage(err)));
        }
      },
      { mycoHome, jobName: 'maintenance-summary', parallel: true },
    );

    const thresholds = {
      backup_overdue_hours: BACKUP_OVERDUE_HOURS_DEFAULT,
      optimize_overdue_hours: OPTIMIZE_OVERDUE_HOURS_DEFAULT,
    };
    return {
      body: {
        groves,
        flags: computeFlags(groves, thresholds),
        thresholds,
      },
    };
  }

  async function handleGroveMaintenance(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.params.id;
    const grove = loadGroveRecord(groveId, mycoHome);
    if (!grove) return { status: 404, body: { error: 'grove_not_found' } };

    const databasePath = resolveGroveDbPath(grove.id, mycoHome);
    const groveHome = resolveGroveDir(grove.id, mycoHome);
    let summary: GroveMaintenanceSummary;
    try {
      const db = deps.cache.getDatabase(databasePath);
      summary = await deps.cache.withPinned(databasePath, async () =>
        withDatabase(db, () =>
          buildGroveSummary(
            { grove, groveHome, databasePath, db },
            deps.liveConfig.current,
            deps.cache,
            deps.embeddingRuntimeFactory,
            mycoHome,
          ),
        ),
      );
    } catch (err) {
      summary = emptySummary(grove, errorMessage(err));
    }
    return { body: summary };
  }

  return { handleSummary, handleGroveMaintenance };
}

// ---------------------------------------------------------------------------
// Re-exports for testing
// ---------------------------------------------------------------------------

export const __testing = {
  computeFlags,
  isOverdue,
  buildGroveSummary,
  resolveLastIntegrity,
  BACKUP_OVERDUE_HOURS_DEFAULT,
  OPTIMIZE_OVERDUE_HOURS_DEFAULT,
};

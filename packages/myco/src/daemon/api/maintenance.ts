import fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { Logger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { loadMergedConfig } from '@myco/config/loader.js';
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
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import {
  assertOwnedGrove,
  listRegisteredProjects,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { withDatabase } from '@myco/db/client.js';
import {
  getDatabaseFileStats,
  getLastDatabaseLogTimestamps,
} from '@myco/db/queries/database.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { resolveGroveBackupDir } from '@myco/backup/location.js';
import { listBackups } from '@myco/backup/engine.js';
import { listRegisteredProjects as listRegisteredProjectsForGrove } from '@myco/grove/registry.js';
import { reconcileReleaseProvenance } from '@myco/release-provenance/reconcile.js';
import { releaseProvenanceConfig } from '@myco/release-provenance/config.js';
import { refreshReleaseVectorMetadata } from '@myco/release-provenance/vector-metadata.js';
import { projectScope, type GroveProjectId } from '@myco/grove/ids.js';

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
  release_provenance?: {
    raw_count: number;
    derived_count: number;
    unreconciled_count: number;
    unknown_count: number;
    last_checked_at: string | null;
  };
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
  /** The current daemon's service dir; passed through to `forEachGrove` to enforce the served-by boundary. */
  daemonStateDir: string;
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

// Cache log_count keyed by (databasePath, max(rowid)). The summary
// endpoint polls every 10s; on a Grove with 100k+ rows the unconditional
// COUNT(*) shows up in the hot path. MAX(rowid) is an O(1) btree-rightmost
// lookup; only re-run COUNT(*) when new rows have appeared since the last
// call. Rotation deletes won't be detected immediately, but log_count is
// a display value — slight staleness during rotation is fine.
interface LogCountCacheEntry {
  maxRowid: number;
  count: number;
}
const logCountCache = new Map<string, LogCountCacheEntry>();

function logCount(db: Database, databasePath: string): number {
  const maxRow = db.prepare('SELECT MAX(rowid) AS m FROM log_entries').get() as { m: number | null };
  const maxRowid = maxRow.m ?? 0;
  const cached = logCountCache.get(databasePath);
  if (cached && cached.maxRowid === maxRowid) return cached.count;
  const row = db.prepare('SELECT COUNT(*) AS c FROM log_entries').get() as { c: number };
  logCountCache.set(databasePath, { maxRowid, count: row.c });
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

function releaseProvenanceSummary(db: Database): GroveMaintenanceSummary['release_provenance'] {
  try {
    const raw = db.prepare('SELECT COUNT(*) AS c FROM knowledge_git_provenance').get() as { c: number };
    const derived = db.prepare('SELECT COUNT(*) AS c FROM knowledge_release_state').get() as { c: number };
    const unreconciled = db.prepare(
      `SELECT COUNT(*) AS c FROM knowledge_release_state WHERE state = 'unreconciled'`,
    ).get() as { c: number };
    const unknown = db.prepare(
      `SELECT COUNT(*) AS c FROM knowledge_release_state WHERE state = 'unknown'`,
    ).get() as { c: number };
    const last = db.prepare(
      'SELECT MAX(checked_at) AS checked_at FROM knowledge_release_state',
    ).get() as { checked_at: number | null };
    return {
      raw_count: raw.c,
      derived_count: derived.c,
      unreconciled_count: unreconciled.c,
      unknown_count: unknown.c,
      last_checked_at: last.checked_at ? new Date(last.checked_at * 1000).toISOString() : null,
    };
  } catch {
    return {
      raw_count: 0,
      derived_count: 0,
      unreconciled_count: 0,
      unknown_count: 0,
      last_checked_at: null,
    };
  }
}

// Caller must run this inside `forEachGrove` (or equivalent withDatabase
// scope) — log-timestamp/log-count helpers go through getDatabase().
function buildGroveSummary(
  scope: GroveScope,
  cache: GroveRuntimeCache,
  embeddingFactory: EmbeddingRuntimeFactory,
  mycoHome: string,
): GroveMaintenanceSummary {
  const backupDir = resolveGroveBackupDir(scope.grove.id, { mycoHome });
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
    log_count: logCount(scope.db, scope.databasePath),
    embedding_pending: embeddingPending(cache, embeddingFactory, scope),
    last_backup_at: lastBackupAt(backupDir),
    last_optimize_at: ts.optimize ? new Date(ts.optimize).toISOString() : null,
    last_vacuum_at: ts.vacuum ? new Date(ts.vacuum).toISOString() : null,
    last_integrity_check: resolveLastIntegrity(ts.integrity_ok, ts.integrity_issues),
    release_provenance: releaseProvenanceSummary(scope.db),
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
    release_provenance: {
      raw_count: 0,
      derived_count: 0,
      unreconciled_count: 0,
      unknown_count: 0,
      last_checked_at: null,
    },
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
              deps.cache,
              deps.embeddingRuntimeFactory,
              mycoHome,
            ),
          );
        } catch (err) {
          groves.push(emptySummary(scope.grove, errorMessage(err)));
        }
      },
      { mycoHome, daemonStateDir: deps.daemonStateDir, jobName: 'maintenance-summary', parallel: true },
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
    // URL :id arrives outside the request-context funnel, so existence
    // and home-ownership gate here — BEFORE the cache opens (and
    // schema-migrates) the Grove DB, and outside the summary try/catch
    // below so the refusal isn't swallowed into an error summary. Throws
    // propagate to the transport (403 foreign_grove / 404 grove_not_found).
    const grove = assertOwnedGrove(groveId, mycoHome);

    const databasePath = resolveGroveDbPath(grove.id, mycoHome);
    const groveHome = resolveGroveDir(grove.id, mycoHome);
    let summary: GroveMaintenanceSummary;
    try {
      const db = deps.cache.getDatabase(databasePath);
      summary = await deps.cache.withPinned(databasePath, async () =>
        withDatabase(db, () =>
          buildGroveSummary(
            { grove, groveHome, databasePath, db },
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

  /**
   * Trigger a manual release-provenance reconcile across every project served
   * by every Grove this daemon owns. Reconciliation is idempotent and
   * rebuildable, so repeated invocations are safe. Per-project failures are
   * isolated — one bad project does not abort the rest.
   */
  async function handleReleaseProvenanceReconcile(_req: RouteRequest): Promise<RouteResponse> {
    interface PerProjectResult {
      grove_id: string;
      project_id: string;
      reconciled: number;
      scanned: number;
      unchanged: number;
      failed: number;
      error?: string;
    }
    const results: PerProjectResult[] = [];
    await forEachGrove(
      deps.cache,
      deps.logger,
      async (scope) => {
        const projects = listRegisteredProjectsForGrove(scope.grove.id, mycoHome);
        for (const project of projects) {
          const projectId = project.project_id as GroveProjectId;
          try {
            const projectVaultDir = resolveProjectVaultDir(project.root);
            const projectConfig = loadMergedConfig(projectVaultDir, { groveId: scope.grove.id, mycoHome });
            const config = releaseProvenanceConfig(projectConfig);
            if (!config.enabled) {
              results.push({
                grove_id: scope.grove.id,
                project_id: projectId,
                reconciled: 0,
                scanned: 0,
                unchanged: 0,
                failed: 0,
              });
              continue;
            }
            const entry = deps.cache.getEmbeddingRuntime(scope.databasePath, deps.embeddingRuntimeFactory);
            const vectorStore = entry.vectorStore;
            const result = await reconcileReleaseProvenance({
              projectRoot: project.root,
              projectId,
              machineId: 'local',
              scope: projectScope(projectId),
              config,
              logger: deps.logger,
              onReleaseStateChanged: vectorStore
                ? (changes) => {
                    for (const change of changes) {
                      refreshReleaseVectorMetadata({
                        store: vectorStore,
                        db: scope.db,
                        scope: projectScope(projectId),
                        sourceNamespace: change.namespace,
                        sourceRecordId: change.recordId,
                        patch: {
                          state: change.state,
                          confidence: change.confidence,
                          basis_kind: change.basisKind,
                          checked_at: change.checkedAt,
                        },
                      });
                    }
                  }
                : undefined,
            });
            results.push({
              grove_id: scope.grove.id,
              project_id: projectId,
              reconciled: result.reconciled,
              scanned: result.scanned,
              unchanged: result.unchanged,
              failed: result.failed,
            });
          } catch (err) {
            results.push({
              grove_id: scope.grove.id,
              project_id: projectId,
              reconciled: 0,
              scanned: 0,
              unchanged: 0,
              failed: 0,
              error: errorMessage(err),
            });
          }
        }
      },
      { mycoHome, daemonStateDir: deps.daemonStateDir, jobName: 'release-provenance-manual-reconcile', parallel: false },
    );
    return { body: { ok: true, results } };
  }

  return { handleSummary, handleGroveMaintenance, handleReleaseProvenanceReconcile };
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

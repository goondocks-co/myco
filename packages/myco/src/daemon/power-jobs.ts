import type { DaemonLogger, Logger } from './logger.js';
import type { PowerManager } from './power.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { SessionRegistry } from './lifecycle.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { DatabaseMaintenanceManager } from './database/manager.js';
import { runSessionMaintenance } from './jobs/session-maintenance.js';
import {
  registerCanopyJobs,
  type CanopyJobsRegistration,
  type CanopyJobsRegistry,
} from './jobs/canopy-scan.js';
import { createBackup, listBackups, pruneBackups } from './backup.js';
import { resolveGroveBackupDir } from './api/backup.js';
import { deleteOldLogs } from '@myco/db/queries/logs.js';
import { getLastDatabaseLogTimestamps } from '@myco/db/queries/database.js';
import { notify } from '@myco/notifications/notify.js';
import { errorMessage } from '@myco/utils/error-message.js';
import {
  listStaleStagingDirs,
  cleanupStagedSkill,
} from '@myco/agent/tools/skill-staging.js';
import { EMBEDDING_BATCH_SIZE, MS_PER_DAY, MS_PER_HOUR } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { POWER_JOB_NAMES, type PowerJobName } from '@myco/constants/power-jobs.js';
import {
  forEachGrove,
  forEachRegisteredProject,
  type GroveScope,
  type RegisteredProjectScope,
} from './scope-iteration.js';
import {
  resolveMycoHome,
  resolveProjectVaultDir,
  resolveGroveDbPath,
} from '@myco/grove/paths.js';
import {
  isProjectPaused,
  listGroves,
  listRegisteredProjects,
} from '@myco/grove/registry.js';
import { withDatabase } from '@myco/db/client.js';
import type { GroveRuntimeCache, EmbeddingRuntimeFactory } from './grove-runtime-cache.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Cached results for `totalPendingAcrossGroves`. The predicate fires on
// every PowerManager tick to gate sleep transitions; once the queue
// drains we don't need to re-walk every Grove for ZERO_PENDING_TTL_MS.
const ZERO_PENDING_TTL_MS = 30_000;

// Rate-limit window for per-Grove embedding-probe failures. The probe
// fires on every PowerManager tick; without throttling, a Grove with
// a persistent embedding error would log on every tick. One warn per
// hour per Grove is enough to expose the failure without flooding.
const PROBE_FAILURE_WARN_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PowerJobDeps {
  registry: SessionRegistry;
  logger: DaemonLogger;
  liveConfig: { current: MycoConfig };
  machineId: string;
  /**
   * Vault dir consulted for daemon-scope notification gating
   * (`notifications.enabled`, per-domain enabled flags). Daemon-scope
   * rows themselves carry `project_id = NULL`.
   */
  daemonVaultDir: string;
  /** Per-Grove runtime cache shared with the HTTP layer. */
  cache: GroveRuntimeCache;
  /** Lazily build a per-Grove embedding manager + vector store from an open DB. */
  embeddingRuntimeFactory: EmbeddingRuntimeFactory;
  /** Override Myco home (tests); defaults to the resolved global home. */
  mycoHome?: string;
  /** The current daemon's service dir; passed through to `forEachGrove` to enforce the served-by boundary. */
  daemonStateDir: string;
  onCanopyMassAdd?: (groveId: string, projectId: GroveProjectId) => void;
}

export interface PowerJobsResult {
  /** Handles for jobs whose runtime is exposed beyond PowerManager (e.g. delta scan from SessionStart). */
  canopy: CanopyJobsRegistration;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Tag every log entry from a per-Grove body with the Grove. Project ids
// are not tagged here — a single body may delete sessions across many
// projects and each delete logs its own project_id.
function buildLoggerForGrove(logger: Logger, scope: GroveScope): Logger {
  const tag = (data?: Record<string, unknown>) => ({
    ...data,
    grove_id: typeof data?.grove_id === 'string' ? data.grove_id : scope.grove.id,
    grove_slug: typeof data?.grove_slug === 'string' ? data.grove_slug : scope.grove.slug,
  });
  return {
    debug: (kind, message, data) => logger.debug(kind, message, tag(data)),
    info: (kind, message, data) => logger.info(kind, message, tag(data)),
    warn: (kind, message, data) => logger.warn(kind, message, tag(data)),
    error: (kind, message, data) => logger.error(kind, message, tag(data)),
  };
}

// Per-Grove memo for the logger and the projectVaultDir resolver. Both
// derive from the Grove + its registered projects which only changes
// when a project is registered/removed; recomputing per tick wastes work.
//
// A consumer whose value depends on data that *can* change between ticks
// (e.g. the registered-project list) supplies an optional `isStale`
// predicate. The cache calls it on every `get()` and rebuilds when the
// predicate returns true. This lets project register/unregister
// flow through without a daemon restart even though the daemon doesn't
// have a direct register-event hook today: the next tick after a new
// project lands invalidates the cache automatically.
class PerGroveCache<T> {
  private readonly entries = new Map<string, T>();
  constructor(
    private readonly build: (scope: GroveScope) => T,
    private readonly isStale?: (scope: GroveScope, cached: T) => boolean,
  ) {}
  get(scope: GroveScope): T {
    const cached = this.entries.get(scope.grove.id);
    if (cached !== undefined && !(this.isStale?.(scope, cached) ?? false)) {
      return cached;
    }
    const fresh = this.build(scope);
    this.entries.set(scope.grove.id, fresh);
    return fresh;
  }
  invalidate(groveId: string): void {
    this.entries.delete(groveId);
  }
}

function getGroveEmbeddingManager(
  cache: GroveRuntimeCache,
  factory: EmbeddingRuntimeFactory,
  scope: GroveScope,
): EmbeddingManager {
  const entry = cache.getEmbeddingRuntime(scope.databasePath, factory);
  if (!entry.embeddingManager) {
    throw new Error('grove embedding runtime missing manager');
  }
  return entry.embeddingManager;
}

interface PendingProbeCache {
  total: number;
  expiresAt: number;
}

// Sum of pending embedding work across every Grove. Caches the
// last-known zero state for ZERO_PENDING_TTL_MS so the deep-sleep
// predicate doesn't walk every Grove on every tick when fully drained.
function makeTotalPendingProbe(deps: PowerJobDeps): () => number {
  let cache: PendingProbeCache | null = null;
  // Per-Grove last-warn timestamps so a persistently-broken Grove
  // surfaces in logs without flooding on every tick.
  const lastWarnAt = new Map<string, number>();
  return () => {
    if (cache && Date.now() < cache.expiresAt) return cache.total;
    const mycoHome = deps.mycoHome ?? resolveMycoHome();
    let total = 0;
    for (const grove of listGroves(mycoHome)) {
      try {
        const databasePath = resolveGroveDbPath(grove.id, mycoHome);
        const entry = deps.cache.getEmbeddingRuntime(databasePath, deps.embeddingRuntimeFactory);
        const manager = entry.embeddingManager;
        if (!manager) continue;
        // withDatabase is sync (AsyncLocalStorage.run returns fn's value).
        total += withDatabase(entry.db, () => manager.totalPendingCount());
        if (total > 0) {
          cache = null;
          return total;
        }
      } catch (err) {
        // Swallow per-Grove failure — better to risk an early sleep than
        // hold the whole machine awake on a transiently-broken signal.
        // But surface the failure at warn level (rate-limited per Grove)
        // so persistent breakage is visible in the daemon log.
        const now = Date.now();
        const last = lastWarnAt.get(grove.id) ?? 0;
        if (now - last >= PROBE_FAILURE_WARN_INTERVAL_MS) {
          lastWarnAt.set(grove.id, now);
          deps.logger.warn(
            LOG_KINDS.EMBEDDING_RECONCILE,
            'Embedding pending-probe failed for Grove',
            {
              grove_id: grove.id,
              grove_slug: grove.slug,
              error: errorMessage(err),
            },
          );
        }
      }
    }
    cache = { total: 0, expiresAt: Date.now() + ZERO_PENDING_TTL_MS };
    return total;
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPowerJobs(powerManager: PowerManager, deps: PowerJobDeps): PowerJobsResult {
  const {
    registry,
    logger,
    liveConfig,
    machineId,
    cache,
    embeddingRuntimeFactory,
    onCanopyMassAdd,
    daemonVaultDir,
    daemonStateDir,
  } = deps;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  const groveLoggers = new PerGroveCache<Logger>((scope) => buildLoggerForGrove(logger, scope));
  // The resolver carries a fingerprint of the project list it was
  // built from so a project register/unregister forces a rebuild on the
  // next tick without anyone calling `invalidate(...)` explicitly.
  // The fingerprint is just `count + sorted-ids`, which is cheap to
  // recompute and stable across ticks while the registry is unchanged.
  interface ProjectVaultDirResolver {
    resolve: (projectId: string | null) => string | null;
    fingerprint: string;
  }
  const fingerprintProjects = (groveId: string): string => {
    const ids = listRegisteredProjects(groveId, mycoHome).map((p) => p.project_id);
    ids.sort();
    return `${ids.length}:${ids.join(',')}`;
  };
  const projectVaultDirResolvers = new PerGroveCache<ProjectVaultDirResolver>(
    (scope) => {
      const projects = listRegisteredProjects(scope.grove.id, mycoHome);
      const byId = new Map(
        projects.map((p) => [p.project_id, resolveProjectVaultDir(p.root)]),
      );
      const ids = projects.map((p) => p.project_id);
      ids.sort();
      return {
        resolve: (projectId) => (projectId ? byId.get(projectId) ?? null : null),
        fingerprint: `${ids.length}:${ids.join(',')}`,
      };
    },
    (scope, cached) => fingerprintProjects(scope.grove.id) !== cached.fingerprint,
  );

  const totalPendingProbe = makeTotalPendingProbe(deps);

  // Daemon-scope notification (project_id = NULL) so failures surface in
  // the dashboard regardless of which project the user is viewing.
  const notifyDaemon = (
    type: string,
    title: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): void => {
    notify(
      daemonVaultDir,
      { domain: 'daemon', type, title, message, metadata },
      undefined,
      { scope: 'daemon' },
    );
  };

  // Standard error path for Grove-DB jobs: tagged log + daemon notification.
  const notifyOnFailure = (
    scope: GroveScope,
    logKind: string,
    notifyType: string,
    titleVerb: string,
    err: unknown,
  ): void => {
    const message = errorMessage(err);
    logger.error(logKind, `${titleVerb} failed`, {
      error: message,
      grove_id: scope.grove.id,
      grove_slug: scope.grove.slug,
    });
    notifyDaemon(
      notifyType,
      `${titleVerb} failed for ${scope.grove.name}`,
      message,
      { grove_id: scope.grove.id, grove_slug: scope.grove.slug },
    );
  };

  // Project-scope analogue passed to forEachRegisteredProject. The error
  // log already happens inside the iterator's catch; this helper only
  // surfaces a daemon-scope notification so operators see the failure
  // in the dashboard, not just in the daemon log.
  const buildProjectFailureNotifier = (
    notifyType: string,
    titleVerb: string,
  ): ((scope: RegisteredProjectScope, message: string) => void) => {
    return (scope, message) => {
      notifyDaemon(
        notifyType,
        `${titleVerb} failed for ${scope.project.name ?? scope.project.project_id}`,
        message,
        {
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
          project_id: scope.project.project_id,
          project_root: scope.project.root,
        },
      );
    };
  };

  const fanOutGroves = (jobName: PowerJobName, body: (scope: GroveScope) => Promise<void>) =>
    () => forEachGrove(cache, logger, body, { mycoHome, daemonStateDir, jobName }).then(() => undefined);

  // Every tick processes one batch per Grove that has pending work; a Grove
  // with N records drains in N / batch ticks while peers drain in parallel.
  let reconcileRunning = false;
  powerManager.register({
    name: POWER_JOB_NAMES.EMBEDDING_RECONCILE,
    runIn: ['active', 'idle', 'sleep'],
    preventsDeepSleep: () => {
      if (liveConfig.current.embedding.run_in_deep_sleep === false) return false;
      try {
        return totalPendingProbe() > 0;
      } catch {
        return false;
      }
    },
    fn: async () => {
      if (reconcileRunning) return;
      reconcileRunning = true;
      try {
        await fanOutGroves(POWER_JOB_NAMES.EMBEDDING_RECONCILE, async (scope) => {
          const manager = getGroveEmbeddingManager(cache, embeddingRuntimeFactory, scope);
          await manager.reconcile(EMBEDDING_BATCH_SIZE);
        })();
      } finally {
        reconcileRunning = false;
      }
    },
  });

  powerManager.register({
    name: POWER_JOB_NAMES.SESSION_MAINTENANCE,
    runIn: ['active', 'idle', 'sleep'],
    fn: fanOutGroves(POWER_JOB_NAMES.SESSION_MAINTENANCE, async (scope) => {
      const manager = getGroveEmbeddingManager(cache, embeddingRuntimeFactory, scope);
      await runSessionMaintenance({
        logger: groveLoggers.get(scope),
        registeredSessionIds: () => [...registry.sessions],
        embeddingManager: manager,
        resolveProjectVaultDir: projectVaultDirResolvers.get(scope).resolve,
        staleThresholdMs: liveConfig.current.daemon.stale_session_threshold_ms,
      });
    }),
  });

  powerManager.register({
    name: POWER_JOB_NAMES.LOG_RETENTION,
    runIn: ['idle', 'sleep'],
    fn: fanOutGroves(POWER_JOB_NAMES.LOG_RETENTION, async (scope) => {
      const retentionDays = liveConfig.current.daemon.log_retention_days;
      const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();
      const deleted = deleteOldLogs(cutoff);
      if (deleted > 0) {
        logger.info(
          LOG_KINDS.LOG_RETENTION,
          `Deleted ${deleted} log entries older than ${retentionDays} days`,
          {
            deleted,
            retention_days: retentionDays,
            grove_id: scope.grove.id,
            grove_slug: scope.grove.slug,
          },
        );
      }
    }),
  });

  powerManager.register({
    name: POWER_JOB_NAMES.AUTO_BACKUP,
    runIn: ['idle', 'sleep'],
    fn: fanOutGroves(POWER_JOB_NAMES.AUTO_BACKUP, async (scope) => {
      try {
        const backupDir = resolveGroveBackupDir(liveConfig.current, scope.grove, scope.groveHome);

        // Cadence gate. Without this, the PowerJob fires on every
        // idle/sleep transition; a laptop cycling through dormant
        // phases burns through retention slots in hours instead of
        // spreading them across `keep_daily` days. Skip when the
        // newest backup for this machine is younger than the
        // configured interval.
        const intervalMs = liveConfig.current.backup.auto_interval_hours * MS_PER_HOUR;
        const recent = listBackups(backupDir).find((b) => b.machine_id === machineId);
        if (recent) {
          const ageMs = Date.now() - new Date(recent.modified_at).getTime();
          if (ageMs < intervalMs) return;
        }

        logger.info(LOG_KINDS.BACKUP_START, 'Auto-backup starting', {
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
        });
        const filePath = createBackup(scope.db, backupDir, machineId);
        const pruneResult = pruneBackups(backupDir, liveConfig.current.backup.retention);
        logger.info(LOG_KINDS.BACKUP_COMPLETE, 'Auto-backup complete', {
          file_path: filePath,
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
          pruned: pruneResult.removed.length,
          retained: pruneResult.kept,
        });
      } catch (err) {
        notifyOnFailure(scope, LOG_KINDS.BACKUP_ERROR, 'daemon.backup_failed', 'Backup', err);
      }
    }),
  });

  powerManager.register({
    name: POWER_JOB_NAMES.DATABASE_OPTIMIZE,
    runIn: ['idle', 'sleep'],
    fn: fanOutGroves(POWER_JOB_NAMES.DATABASE_OPTIMIZE, async (scope) => {
      const config = liveConfig.current;
      if (!config.maintenance?.auto_optimize) return;
      const intervalMs = (config.maintenance.auto_optimize_interval_hours ?? 24) * MS_PER_HOUR;
      const dbm = new DatabaseMaintenanceManager(scope.databasePath, scope.groveHome, groveLoggers.get(scope));
      const lastRun = await dbm.getLastOptimizeAt();
      if (lastRun !== null && Date.now() - lastRun < intervalMs) return;
      try {
        await dbm.optimize();
      } catch (err) {
        notifyOnFailure(scope, LOG_KINDS.DATABASE_ERROR, 'daemon.optimize_failed', 'Optimize', err);
      }
    }),
  });

  powerManager.register({
    name: POWER_JOB_NAMES.DATABASE_INTEGRITY_CHECK,
    // Heavier than optimize; only run when the user is away.
    runIn: ['sleep'],
    fn: fanOutGroves(POWER_JOB_NAMES.DATABASE_INTEGRITY_CHECK, async (scope) => {
      const config = liveConfig.current;
      if (!config.maintenance?.auto_integrity_check) return;
      const intervalMs = (config.maintenance.auto_integrity_check_interval_hours ?? 168) * MS_PER_HOUR;
      const dbm = new DatabaseMaintenanceManager(scope.databasePath, scope.groveHome, groveLoggers.get(scope));
      const lastRuns = getLastDatabaseLogTimestamps([
        LOG_KINDS.DATABASE_INTEGRITY_CHECK,
        LOG_KINDS.DATABASE_INTEGRITY_ISSUES,
      ]);
      const lastRunMs = Math.max(
        lastRuns.get(LOG_KINDS.DATABASE_INTEGRITY_CHECK) ?? 0,
        lastRuns.get(LOG_KINDS.DATABASE_INTEGRITY_ISSUES) ?? 0,
      );
      if (lastRunMs > 0 && Date.now() - lastRunMs < intervalMs) return;
      try {
        const result = await dbm.integrityCheck();
        if (result.status !== 'ok') {
          notifyDaemon(
            'daemon.integrity_issues',
            `Integrity issues in ${scope.grove.name}`,
            `${result.issues.length} issue(s), ${result.fk_violations} FK violation(s)`,
            {
              grove_id: scope.grove.id,
              grove_slug: scope.grove.slug,
              issues: result.issues.length,
              fk_violations: result.fk_violations,
            },
          );
        }
      } catch (err) {
        notifyOnFailure(scope, LOG_KINDS.DATABASE_ERROR, 'daemon.integrity_issues', 'Integrity check', err);
      }
    }),
  });

  powerManager.register({
    name: POWER_JOB_NAMES.STAGING_GC,
    runIn: ['idle', 'sleep'],
    fn: async () => {
      await forEachRegisteredProject(
        cache,
        logger,
        ({ project, projectVaultDir }: RegisteredProjectScope) => {
          const stale = listStaleStagingDirs(projectVaultDir, STAGING_MAX_AGE_MS);
          if (stale.length === 0) return;
          for (const candidateId of stale) {
            cleanupStagedSkill(projectVaultDir, candidateId);
          }
          logger.info(
            LOG_KINDS.MAINTENANCE_STAGING_GC,
            'Staging GC swept stale skill drafts',
            {
              count: stale.length,
              candidate_ids: stale,
              project_id: project.project_id,
              project_root: project.root,
            },
          );
        },
        {
          mycoHome,
          daemonStateDir,
          machineId,
          // Pause gate: a paused project's vault is owned by an in-flight
          // op (move, vacuum); skip GC against it so the op gets the
          // exclusive view it relies on.
          shouldVisit: (scope) => !isProjectPaused(scope.projectId, mycoHome).paused,
          notifyOnProjectFailure: buildProjectFailureNotifier(
            'daemon.staging_gc_failed',
            'Staging GC',
          ),
        },
      );
    },
  });

  const canopy = registerCanopyJobs(powerManager, {
    logger,
    machineId,
    liveConfig,
    resolveDb: (databasePath: string) => cache.getDatabase(databasePath),
    onCanopyMassAdd,
    dispatchBackground: (canopyRegistry: CanopyJobsRegistry, now: number) =>
      forEachRegisteredProject(
        cache,
        logger,
        async ({ databasePath, projectId, projectRoot, grove }: RegisteredProjectScope) => {
          const runner = canopyRegistry.ensureRunner({
            databasePath,
            projectId,
            projectRoot,
            groveId: grove.id,
          });
          await runner.run(now);
        },
        {
          mycoHome,
          daemonStateDir,
          machineId,
          // Pause gate: skip projects under an in-flight move/vacuum so
          // the canopy scan doesn't write to a DB the op owns exclusively.
          shouldVisit: (scope) => !isProjectPaused(scope.projectId, mycoHome).paused,
          notifyOnProjectFailure: buildProjectFailureNotifier(
            'daemon.canopy_dispatch_failed',
            'Canopy background scan',
          ),
        },
      ).then(() => undefined),
  });

  return { canopy };
}

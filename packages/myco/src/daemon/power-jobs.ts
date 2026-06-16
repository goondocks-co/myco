import type { DaemonLogger, Logger } from './logger.js';
import type { JobRunner } from './job-runner.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { SessionRegistry } from './lifecycle.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { loadMachineConfig, loadMergedConfig } from '@myco/config/loader.js';
import { DatabaseMaintenanceManager } from './database/manager.js';
import { runSessionMaintenance } from './jobs/session-maintenance.js';
import {
  registerCanopyJobs,
  type CanopyJobsRegistration,
  type CanopyJobsRegistry,
} from './jobs/canopy-scan.js';
import { isAutoBackupDue, createGroveBackup } from '@myco/backup/service.js';
import { deleteOldLogs } from '@myco/db/queries/logs.js';
import { pruneOldNotifications } from '@myco/db/queries/notifications.js';
import { getLastDatabaseLogTimestamps } from '@myco/db/queries/database.js';
import { notify } from '@myco/notifications/notify.js';
import { errorMessage } from '@myco/utils/error-message.js';
import {
  listStaleStagingDirs,
  cleanupStagedSkill,
} from '@myco/agent/tools/skill-staging.js';
import {
  EMBEDDING_BATCH_SIZE,
  MS_PER_DAY,
  MS_PER_HOUR,
  CAPTURE_BUFFER_DRAIN_INTERVAL_MS,
} from '@myco/constants.js';
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
} from '@myco/grove/paths.js';
import {
  pauseAwareShouldVisit,
  listRegisteredProjects,
} from '@myco/grove/registry.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import { withDatabase } from '@myco/db/client.js';
import { makeGrovePendingProbe } from './grove-pending-probe.js';
import type { GroveRuntimeCache, EmbeddingRuntimeFactory } from './grove-runtime-cache.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { reconcileReleaseProvenance } from '@myco/release-provenance/reconcile.js';
import { releaseProvenanceConfig } from '@myco/release-provenance/config.js';
import { refreshReleaseVectorMetadata } from '@myco/release-provenance/vector-metadata.js';
import { reconcileManagedProjectFiles } from '@myco/symbionts/reconcile.js';

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  /**
   * The buffer reconciler. The dead-session sweep consults
   * `hasUnconvergedBuffer` to defer zero-batch sessions whose buffer
   * hasn't converged — their prompts may still be sitting unreplayed on
   * disk. `runDrainPass` is the quiescence-gated drain job's per-Grove
   * body (convergence + retention/quarantine).
   */
  reconciler?: {
    hasUnconvergedBuffer(sessionId: string): boolean;
    runDrainPass(options?: { groveId?: string }): unknown;
  };
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

// Sum of pending embedding work across every Grove via the shared
// multi-Grove probe. The per-Grove count resolves this Grove's
// EmbeddingManager from the cache (runs inside the helper's
// `withDatabase`, so `totalPendingCount()` hits the right Grove DB).
function makeTotalPendingProbe(deps: PowerJobDeps): () => number {
  return makeGrovePendingProbe({
    cache: deps.cache,
    logger: deps.logger,
    daemonStateDir: deps.daemonStateDir,
    mycoHome: deps.mycoHome,
    logKind: LOG_KINDS.EMBEDDING_RECONCILE,
    countForGrove: ({ databasePath }) => {
      const entry = deps.cache.getEmbeddingRuntime(databasePath, deps.embeddingRuntimeFactory);
      return entry.embeddingManager ? entry.embeddingManager.totalPendingCount() : 0;
    },
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPowerJobs(runner: JobRunner, deps: PowerJobDeps): PowerJobsResult {
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
  const lastReleaseReconcileAt = new Map<string, number>();
  const lastRefsFingerprintByProject = new Map<string, string>();
  const lastManagedReconcileAt = new Map<string, number>();

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
      liveConfig.current,
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
  runner.register({
    name: POWER_JOB_NAMES.EMBEDDING_RECONCILE,
    runIn: ['active', 'idle', 'sleep'],
    kind: 'drain',
    drain: { slice: EMBEDDING_BATCH_SIZE },
    hold: {
      // Read the toggle live each tick — `liveConfig.current` is reassigned
      // on config save. Equivalent to the old preventsDeepSleep gate:
      // toggle off → 0 → no hold; else hold iff there is pending work.
      pending: () =>
        liveConfig.current.embedding.run_in_deep_sleep === false ? 0 : totalPendingProbe(),
    },
    fn: async (ctx) => {
      let processed = 0, remaining = 0;
      await fanOutGroves(POWER_JOB_NAMES.EMBEDDING_RECONCILE, async (scope) => {
        const manager = getGroveEmbeddingManager(cache, embeddingRuntimeFactory, scope);
        const out = await manager.reconcileSlice(ctx.sliceBudget);
        processed += out.processed;
        remaining += out.remaining;
      })();
      return { processed, remaining };
    },
  });

  runner.register({
    name: POWER_JOB_NAMES.SESSION_MAINTENANCE,
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    fn: fanOutGroves(POWER_JOB_NAMES.SESSION_MAINTENANCE, async (scope) => {
      const manager = getGroveEmbeddingManager(cache, embeddingRuntimeFactory, scope);
      await runSessionMaintenance({
        logger: groveLoggers.get(scope),
        registeredSessionIds: () => [...registry.sessions],
        embeddingManager: manager,
        resolveProjectVaultDir: projectVaultDirResolvers.get(scope).resolve,
        staleThresholdMs: liveConfig.current.daemon.stale_session_threshold_ms,
        ...(deps.reconciler
          ? { hasUnconvergedBuffer: (sessionId: string) => deps.reconciler!.hasUnconvergedBuffer(sessionId) }
          : {}),
      });
    }),
  });

  // Quiescence-gated capture-buffer drain: converge diverging buffers
  // (sessions whose buffer changed without a restart / register / event /
  // post-Stop trigger to converge them), then run convergence-aware
  // retention (cleanup + quarantine) over each Grove's buffer dirs. The
  // reconciler re-resolves buffer dirs per pass, applies the quiescence
  // gate per session, and bounds each pass with the session cap +
  // per-session failure backoff. Same power states as SESSION_MAINTENANCE;
  // cadence is the job-level 15-minute throttle (ticks fire more often).
  let lastBufferDrainAt = 0;
  if (deps.reconciler) {
    const drainReconciler = deps.reconciler;
    runner.register({
      name: POWER_JOB_NAMES.CAPTURE_BUFFER_DRAIN,
      runIn: ['active', 'idle', 'sleep'],
      kind: 'housekeeping',
      fn: async () => {
        const now = Date.now();
        if (now - lastBufferDrainAt < CAPTURE_BUFFER_DRAIN_INTERVAL_MS) return;
        lastBufferDrainAt = now;
        await fanOutGroves(POWER_JOB_NAMES.CAPTURE_BUFFER_DRAIN, async (scope) => {
          drainReconciler.runDrainPass({ groveId: scope.grove.id });
        })();
      },
    });
  }

  runner.register({
    name: POWER_JOB_NAMES.LOG_RETENTION,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
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

  runner.register({
    name: POWER_JOB_NAMES.NOTIFICATION_RETENTION,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
    fn: fanOutGroves(POWER_JOB_NAMES.NOTIFICATION_RETENTION, async (scope) => {
      const retentionDays = loadMachineConfig(mycoHome).notifications.retention_days;
      const deleted = pruneOldNotifications(retentionDays * MS_PER_DAY / 1000, ALL_PROJECTS_SCOPE);
      if (deleted > 0) {
        logger.info(
          LOG_KINDS.NOTIFICATION_RETENTION,
          `Deleted ${deleted} acknowledged notifications older than ${retentionDays} days`,
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

  runner.register({
    name: POWER_JOB_NAMES.AUTO_BACKUP,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
    fn: fanOutGroves(POWER_JOB_NAMES.AUTO_BACKUP, async (scope) => {
      try {
        // Cadence gate (per this Grove's own config). Without it the
        // PowerJob fires on every idle/sleep transition; a laptop cycling
        // through dormant phases would burn retention slots in hours
        // instead of spreading them across `keep_daily` days.
        if (!isAutoBackupDue({ groveId: scope.grove.id, machineId })) return;

        logger.info(LOG_KINDS.BACKUP_START, 'Auto-backup starting', {
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
        });
        const result = createGroveBackup({ groveId: scope.grove.id, db: scope.db, machineId });
        logger.info(LOG_KINDS.BACKUP_COMPLETE, 'Auto-backup complete', {
          file_path: result.file_path,
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
          pruned: result.pruned,
          retained: result.kept,
        });
      } catch (err) {
        notifyOnFailure(scope, LOG_KINDS.BACKUP_ERROR, 'daemon.backup_failed', 'Backup', err);
      }
    }),
  });

  runner.register({
    name: POWER_JOB_NAMES.DATABASE_OPTIMIZE,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
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

  runner.register({
    name: POWER_JOB_NAMES.DATABASE_INTEGRITY_CHECK,
    // Heavier than optimize; only run when the user is away.
    runIn: ['sleep'],
    kind: 'housekeeping',
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

  // Periodic symbiont detection. Walks the manifest registry and installs
  // Myco's global config into any agent whose `detectionDir` appeared
  // since the last tick. Throttled to a 1-hour cadence so newly-installed
  // agents land within the hour without burning ticks on a stable system.
  // Newly-detected symbionts emit a notification.
  //
  // NB: this tick does NOT run the project-local → global migration
  // walker. Migration is fire-once-per-project: daemon first-start
  // sweeps every registered project, auto-Grove-create sweeps the new
  // project, and `myco doctor --fix` retries failed projects. Re-running
  // the walker hourly would normalize failure as ongoing operational
  // state.
  let lastSymbiontDetectionAt = 0;
  const SYMBIONT_DETECTION_INTERVAL_MS = 60 * 60 * 1000;
  runner.register({
    name: POWER_JOB_NAMES.SYMBIONT_DETECTION,
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    fn: async () => {
      const now = Date.now();
      if (now - lastSymbiontDetectionAt < SYMBIONT_DETECTION_INTERVAL_MS) return;
      lastSymbiontDetectionAt = now;
      try {
        const { runSymbiontDetection } = await import('../cli/bootstrap.js');
        const symbionts = runSymbiontDetection();
        // Delete retired launcher trampolines LAST — after detection rewrote
        // every detected agent's config onto the binary this tick. Deleting
        // before the rewrites would orphan a not-yet-rewritten config.
        try {
          const { removeRetiredGlobalLaunchers } = await import('../grove/launcher-cleanup.js');
          removeRetiredGlobalLaunchers();
        } catch { /* cleanup is best-effort; a lingering launcher is inert */ }
        const newlyInstalled = symbionts.filter((r) => r.status === 'installed');
        if (newlyInstalled.length > 0) {
          logger.info(LOG_KINDS.DAEMON_START, 'Symbiont detection wired in new agent(s)', {
            installed: newlyInstalled.map((r) => r.symbiont),
          });
          for (const r of newlyInstalled) {
            notifyDaemon(
              'daemon.symbiont_detected',
              `Detected ${r.symbiont}`,
              `Myco is now wired in for ${r.symbiont}.`,
              { symbiont: r.symbiont },
            );
          }
        }
        for (const r of symbionts.filter((s) => s.status === 'error')) {
          logger.warn(LOG_KINDS.DAEMON_START, 'Symbiont detection install failed', {
            symbiont: r.symbiont, error: r.error,
          });
        }
      } catch (err) {
        logger.error(LOG_KINDS.DAEMON_START, 'Symbiont detection tick failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  runner.register({
    name: POWER_JOB_NAMES.STAGING_GC,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
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
          // Skip projects under an in-flight move/vacuum so GC doesn't
          // race the op's exclusive view of the DB.
          shouldVisit: pauseAwareShouldVisit(mycoHome),
          notifyOnProjectFailure: buildProjectFailureNotifier(
            'daemon.staging_gc_failed',
            'Staging GC',
          ),
        },
      );
    },
  });

  runner.register({
    name: POWER_JOB_NAMES.RELEASE_PROVENANCE_RECONCILE,
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    fn: async () => {
      const now = Date.now();
      const visited = new Set<string>();
      await forEachRegisteredProject(
        cache,
        logger,
        ({ grove, projectId, projectRoot, projectVaultDir, databasePath }: RegisteredProjectScope) => {
          const projectConfig = loadMergedConfig(projectVaultDir, { groveId: grove.id, mycoHome });
          const config = releaseProvenanceConfig(projectConfig);
          if (!config.enabled) return;
          const intervalMs = config.reconcile_interval_minutes * 60 * 1000;
          const key = `${grove.id}:${projectId}`;
          visited.add(key);
          const lastRun = lastReleaseReconcileAt.get(key) ?? 0;
          if (now - lastRun < intervalMs) return;
          const projectScopeValue = projectScope(projectId);
          const entry = cache.getEmbeddingRuntime(databasePath, embeddingRuntimeFactory);
          const vectorStore = entry.vectorStore;
          const recordDb = cache.getDatabase(databasePath);
          return reconcileReleaseProvenance({
            projectRoot,
            projectId,
            machineId,
            scope: projectScopeValue,
            config,
            logger,
            lastRefsFingerprint: lastRefsFingerprintByProject.get(key),
            onReleaseStateChanged: vectorStore
              ? (changes) => {
                  for (const change of changes) {
                    refreshReleaseVectorMetadata({
                      store: vectorStore,
                      db: recordDb,
                      scope: projectScopeValue,
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
          }).then((result) => {
            lastReleaseReconcileAt.set(key, now);
            if (result.refsFingerprint !== undefined) {
              lastRefsFingerprintByProject.set(key, result.refsFingerprint);
            }
            if (result.reconciled > 0) {
              logger.info(
                LOG_KINDS.RELEASE_PROVENANCE_RECONCILE,
                'Release provenance reconcile processed rows',
                { project_id: projectId, reconciled: result.reconciled, scanned: result.scanned },
              );
            }
          });
        },
        {
          mycoHome,
          daemonStateDir,
          machineId,
          shouldVisit: pauseAwareShouldVisit(mycoHome),
          notifyOnProjectFailure: buildProjectFailureNotifier(
            'daemon.release_provenance_failed',
            'Release provenance reconcile',
          ),
        },
      );
      // Drop throttle entries for projects no longer registered so the maps
      // can't grow unbounded across long-running daemons.
      for (const key of lastReleaseReconcileAt.keys()) {
        if (!visited.has(key)) lastReleaseReconcileAt.delete(key);
      }
      for (const key of lastRefsFingerprintByProject.keys()) {
        if (!visited.has(key)) lastRefsFingerprintByProject.delete(key);
      }
    },
  });

  // Periodically re-sync each registered project's managed local files
  // (AGENTS.md guidance block + `.gitignore` Myco block) against its merged
  // config. This replaces the write-time fan-out, which only reconciled the
  // one project just edited: machine-scoped `capture.*` settings affect every
  // project's `.gitignore`/AGENTS.md, so a single project's write can't be the
  // trigger. The sweep walks all registered projects through the same
  // single-writer reconciler and is idempotent — a project already in sync is
  // a no-op.
  runner.register({
    name: POWER_JOB_NAMES.MANAGED_FILES_RECONCILE,
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    fn: async () => {
      const now = Date.now();
      const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
      const visited = new Set<string>();
      await forEachRegisteredProject(
        cache,
        logger,
        ({ grove, projectId, projectRoot, projectVaultDir }: RegisteredProjectScope) => {
          const key = `${grove.id}:${projectId}`;
          visited.add(key);
          const lastRun = lastManagedReconcileAt.get(key) ?? 0;
          if (now - lastRun < RECONCILE_INTERVAL_MS) return;
          lastManagedReconcileAt.set(key, now);
          const result = reconcileManagedProjectFiles(projectRoot, projectVaultDir, grove.id);
          if (result && (result.gitignore || result.agentsMd)) {
            logger.info(
              LOG_KINDS.MANAGED_FILES_RECONCILE,
              'Reconciled managed project files',
              { project_id: projectId, gitignore: result.gitignore, agents_md: result.agentsMd },
            );
          }
        },
        {
          mycoHome,
          daemonStateDir,
          machineId,
          shouldVisit: pauseAwareShouldVisit(mycoHome),
          notifyOnProjectFailure: buildProjectFailureNotifier(
            'daemon.managed_files_reconcile_failed',
            'Managed files reconcile',
          ),
        },
      );
      // Drop throttle entries for projects no longer registered so the map
      // can't grow unbounded across long-running daemons.
      for (const key of lastManagedReconcileAt.keys()) {
        if (!visited.has(key)) lastManagedReconcileAt.delete(key);
      }
    },
  });

  const canopy = registerCanopyJobs(runner, {
    logger,
    machineId,
    liveConfig,
    resolveDb: (databasePath: string) => cache.getDatabase(databasePath),
    onCanopyMassAdd,
    dispatchBackground: (canopyRegistry: CanopyJobsRegistry, now: number) =>
      forEachRegisteredProject(
        cache,
        logger,
        async ({ databasePath, projectId, projectRoot, projectVaultDir, grove }: RegisteredProjectScope) => {
          try {
            const projectConfig = loadMergedConfig(projectVaultDir, { groveId: grove.id, mycoHome });
            if (!capabilityEnabled(projectConfig, 'canopy')) return;
          } catch {
            // Unreadable config → skip the scan (fail-closed), consistent with
            // canopy-inject. Registered projects always have a vault, so this
            // only fires on a transient read error.
            return;
          }
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
          // Skip projects under an in-flight move/vacuum so the canopy
          // scan doesn't write to a DB the op owns exclusively.
          shouldVisit: pauseAwareShouldVisit(mycoHome),
          notifyOnProjectFailure: buildProjectFailureNotifier(
            'daemon.canopy_dispatch_failed',
            'Canopy background scan',
          ),
        },
      ).then(() => undefined),
  });

  return { canopy };
}

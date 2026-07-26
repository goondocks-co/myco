import type { DaemonLogger, Logger } from './logger.js';
import type { JobRunner } from './job-runner.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { SessionRegistry } from './lifecycle.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { loadGroveConfig, loadMachineConfig, loadMergedConfig } from '@myco/config/loader.js';
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
import { pruneOldAgentRuns } from '@myco/db/queries/runs.js';
import { expireStaleContentClaims, pruneTerminalContentClaims } from '@myco/db/queries/content-claims.js';
import { pruneRoutedEventDedup } from '@myco/db/queries/routed-event-dedup.js';
import { getSession, STATUS_COMPLETED } from '@myco/db/queries/sessions.js';
import type { SessionCompletionMiner } from './session-completion.js';
import {
  listRoutedTranscriptSessionDirs,
  newestRoutedTranscriptMtimeMs,
  pruneRoutedTranscriptSessionDir,
} from '@myco/host/routed-transcript.js';
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
  CONTENT_CLAIM_RETENTION_MS,
  ROUTED_EVENT_DEDUP_RETENTION_MS,
  ROUTED_TRANSCRIPT_GC_QUIESCENCE_MS,
  POWER_DEEP_SLEEP_THRESHOLD_MS,
  MS_PER_SECOND,
  epochSeconds,
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
import { withDatabase, getDatabase } from '@myco/db/client.js';
import { hasActivitySince } from '@myco/db/queries/project-activity.js';
import type { AssertionSource } from './power.js';
import { makeGrovePendingProbe } from './grove-pending-probe.js';
import type { GroveRuntimeCache, EmbeddingRuntimeFactory } from './grove-runtime-cache.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { reconcileReleaseProvenance } from '@myco/release-provenance/reconcile.js';
import { releaseProvenanceConfig } from '@myco/release-provenance/config.js';
import { refreshReleaseVectorMetadata } from '@myco/release-provenance/vector-metadata.js';
import { reconcileManagedProjectFiles } from '@myco/symbionts/reconcile.js';
import {
  checkAndStage,
  buildAdoptJobFn,
  isDevBuildVersion,
  type AutoAdoptDeps,
} from '@myco/upgrade/auto-check.js';
import { resolveMycoBinary, readUpdateConfig } from './update-checker.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Required deps for the upgrade auto-check + adopt jobs (supplied by main.ts). */
export interface UpgradeJobDeps {
  /** The version currently running (daemon's own `server.version`). */
  currentVersion: string;
  /** Myco home directory (`~/.myco`). */
  home: string;
  /** Target platform. */
  platform: NodeJS.Platform;
  /** %LOCALAPPDATA% on win32; ignored on non-win32. */
  localAppData?: string;
  /** Daemon state dir — home of the `update.in-progress` sentinel. */
  stateDir: string;
  /** Canonical daemon port. */
  daemonPort: number;
  /**
   * Myco binary path used for the direct-spawn restart fallback.
   * Defaults to `resolveMycoBinary()` (i.e. `process.execPath` when it is the myco binary, else `'myco'`).
   */
  mycoBinary?: string;
  /** Project root for direct-spawn restart cwd. */
  projectRoot: string;
}

export interface PowerJobDeps {
  registry: SessionRegistry;
  logger: DaemonLogger;
  liveConfig: { current: MycoConfig };
  machineId: string;
  /**
   * The completion chokepoint's mining seam (`daemon/session-completion.ts`),
   * threaded into the session-maintenance stale sweep: a stale-swept session
   * got no SessionEnd, so its transcript tail must be mined before the
   * status flip — the routed-transcript cache GC's "completed implies mined"
   * invariant depends on every completion path mining first.
   */
  transcriptMiner: SessionCompletionMiner;
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
  lockNamespace?: PerUserLockNamespace;
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
  /**
   * When provided, registers the upgrade auto-check and adopt jobs.
   * Omitted in tests that don't need upgrade wiring (existing test
   * suites remain unaffected).
   */
  upgrade?: UpgradeJobDeps;
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

/**
 * Agent-liveness source: asserts `sleep` depth while any Grove has seen tool
 * activity inside the freshness window.
 *
 * A PowerManager assertion rather than a job hold, because the two answer
 * different questions. A hold asks "is there queued work to flush?" — an
 * agent hammering tool calls produces no queue depth, since capture writes
 * are synchronous, so every hold correctly reports zero while the agent is
 * plainly busy. This asks "is an agent mid-turn?" and reads the only table
 * that keeps ticking through a long turn.
 *
 * `maxDepth: 'sleep'`, never `'active'`: the assertion's whole job is to
 * prevent the full stop of deep sleep. Pinning `active` would starve the
 * twelve jobs that only run in `idle`/`sleep` — retention, backup, DB
 * optimize and integrity check, and both upgrade jobs — for the entire
 * length of a long agentic run. Natural decay still moves the daemon through
 * `idle` and `sleep` during the lulls every long run has.
 *
 * Reuses the multi-Grove probe so it inherits the same TTL cache,
 * first-positive short-circuit, and per-Grove error isolation as the drains.
 */
export function makeAgentLivenessSource(
  deps: Pick<PowerJobDeps, 'cache' | 'logger' | 'daemonStateDir' | 'mycoHome'>,
  windowMs: number = POWER_DEEP_SLEEP_THRESHOLD_MS,
): AssertionSource {
  const windowSeconds = Math.floor(windowMs / MS_PER_SECOND);
  const probe = makeGrovePendingProbe({
    cache: deps.cache,
    logger: deps.logger,
    daemonStateDir: deps.daemonStateDir,
    mycoHome: deps.mycoHome,
    logKind: LOG_KINDS.POWER_STATE,
    // Runs inside the helper's `withDatabase`, so `getDatabase()` resolves
    // to the Grove being walked.
    countForGrove: () =>
      hasActivitySince(getDatabase(), epochSeconds() - windowSeconds) ? 1 : 0,
  });

  return {
    name: 'liveness',
    probe: () => (probe() > 0
      ? [{
          name: 'agent-session',
          maxDepth: 'sleep',
          reason: `tool activity within ${windowSeconds}s`,
        }]
      : []),
  };
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
    lockNamespace,
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
    () => forEachGrove(
      cache,
      logger,
      body,
      { mycoHome, jobName, lockNamespace },
    ).then(() => undefined);

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
        liveConfig.current.embedding.prevent_deep_sleep === false ? 0 : totalPendingProbe(),
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
        transcriptMiner: deps.transcriptMiner,
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
    name: POWER_JOB_NAMES.AGENT_RUN_RETENTION,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
    fn: fanOutGroves(POWER_JOB_NAMES.AGENT_RUN_RETENTION, async (scope) => {
      const retentionDays = loadGroveConfig(scope.grove.id, mycoHome).agent.run_retention_days;
      const deleted = pruneOldAgentRuns(retentionDays * MS_PER_DAY / 1000, ALL_PROJECTS_SCOPE);
      if (deleted > 0) {
        logger.info(
          LOG_KINDS.AGENT_RUN_RETENTION,
          `Deleted ${deleted} terminal agent runs older than ${retentionDays} days`,
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

  // content-claim-expiry: active && expires_at < now -> expired, THEN prune
  // terminal (released/published/expired) rows older than the retention
  // window. The expiry sweep is the backstop that frees an abandoned
  // publication lock — a row can arrive via backup-restore/project-copy with
  // expires_at already past, so this never assumes active implies unexpired.
  // The prune is the terminal-row GC (spec §2/§8): audit breadcrumbs, not
  // content history, so they don't accumulate forever. Runs in active too (a
  // stale lock should clear promptly for someone waiting to claim, not only
  // on idle/sleep).
  runner.register({
    name: POWER_JOB_NAMES.CONTENT_CLAIM_EXPIRY,
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    fn: fanOutGroves(POWER_JOB_NAMES.CONTENT_CLAIM_EXPIRY, async (scope) => {
      const now = epochSeconds();
      const expired = expireStaleContentClaims(now);
      if (expired > 0) {
        logger.info(LOG_KINDS.CONTENT_CLAIM_EXPIRY, 'Expired stale content claims', {
          expired,
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
        });
      }

      const pruned = pruneTerminalContentClaims(Math.floor(CONTENT_CLAIM_RETENTION_MS / 1000), now);
      if (pruned > 0) {
        logger.info(LOG_KINDS.CONTENT_CLAIM_PRUNE, 'Pruned terminal content claims', {
          pruned,
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
        });
      }
    }),
  });

  // routed-transcript-cache-gc (consolidation Task C-1): the host-materialized
  // transcript cache (~/.myco-team/host/routed-transcripts/<machine>/<session>/)
  // is a MINING CACHE, not the source of truth — but until a routed session is
  // BOTH fully mined and session-terminal, the host may be the only durable
  // copy of its transcript (the member can rotate/trim its own file at any
  // time), so this NEVER TTLs a tree by age. "Session-terminal" is
  // `sessions.status = 'completed'`, and "completed implies fully mined"
  // holds because EVERY daemon completion path — SessionEnd, the manual
  // complete route, AND the stale-session sweep — routes through the
  // completion chokepoint (`completeSessionWithMining`,
  // `daemon/session-completion.ts`), which runs the final mining convergence
  // against the stamped `transcript_path` (host-substituted for a routed
  // session, and guaranteed caught-up at SessionEnd by the member's
  // `flushBeforeForward` before that terminal route is dispatched) BEFORE
  // the status flip. A completed session with NO stamped `transcript_path`
  // had no mine source at close (degraded-missing at every Stop, or no Stop
  // at all) — its tree may hold unmined bytes, so it is never pruned (kept
  // forever; data preservation over disk). Pruning additionally requires
  // APPEND QUIESCENCE (the late-append TOCTOU guard — see the in-loop
  // comment): the tree's newest write must predate the session's completion
  // AND be older than ROUTED_TRANSCRIPT_GC_QUIESCENCE_MS. The candidate
  // list is walked
  // ONCE per tick (bounded by the cache's own size, not total session
  // history) and resolved against every Grove this daemon serves — a
  // candidate whose session cannot be found in ANY served Grove is left
  // alone (conservative: it is either not yet visible or belongs to a Grove
  // this daemon no longer serves, and this job never guesses).
  runner.register({
    name: POWER_JOB_NAMES.ROUTED_TRANSCRIPT_CACHE_GC,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
    fn: async () => {
      const candidates = listRoutedTranscriptSessionDirs();
      if (candidates.length === 0) return;
      // Keyed on (machineId, sessionId), NOT sessionId alone: session ids are
      // agent-supplied UUIDs, not structurally guaranteed unique across two
      // different member machines, so a sessionId-only key could collapse two
      // distinct candidate directories onto one map entry and silently drop
      // one from consideration. `getSession` still looks up by sessionId
      // (its only key), but each compound entry is checked independently.
      const unresolved = new Map(candidates.map((c) => [`${c.machineId}/${c.sessionId}`, c]));
      let pruned = 0;
      await fanOutGroves(POWER_JOB_NAMES.ROUTED_TRANSCRIPT_CACHE_GC, async () => {
        if (unresolved.size === 0) return;
        for (const [key, candidate] of [...unresolved]) {
          const session = getSession(candidate.sessionId, ALL_PROJECTS_SCOPE);
          if (!session) continue; // not in this Grove — try the next
          // Defense in depth: a mismatch means this row is not the one that
          // owns the directory (e.g. a sessionId collision across two
          // members' UUIDs) — leave BOTH the row's grove and this candidate
          // unresolved rather than ever deleting on an unverified match.
          if (session.machine_id !== candidate.machineId) continue;
          unresolved.delete(key); // owning Grove found regardless of status
          if (session.status !== STATUS_COMPLETED) continue; // still in flight — never touch
          // No stamped transcript_path = the completion chokepoint had no
          // mine source at close — the tree may hold unmined bytes. Keep it
          // forever rather than guess (data preservation over disk).
          if (!session.transcript_path) continue;
          // Positive proof the final mining pass actually read the transcript.
          // `completed` alone never carried it: the completion chokepoint closes
          // a session even when mining throws, and an unreadable transcript
          // parsed as zero events looked exactly like a mined-empty one. NULL
          // means no outcome was recorded (pre-v74 row completed by an older
          // binary, or a close that never reached the chokepoint) — unproven,
          // so keep the bytes.
          if (session.final_mine_ok !== 1) continue;
          // Late-append TOCTOU guard (prune-only-when-quiet): the transcript
          // ingest route appends purely by offset and never touches the
          // sessions row, so a reconnecting member's drain backstop can land
          // tail bytes AFTER the stale sweep completed (and mined) this
          // session — no event, no reactivation, no new mining trigger.
          // Refuse when the tree's newest write is at/after the session's
          // completion time (bytes newer than the last mine) OR within the
          // quiescence window of now (an append may be in flight). A null
          // ended_at (legacy/imported row) or unreadable dir is never
          // provably quiet — keep the tree.
          const newestWriteMs = newestRoutedTranscriptMtimeMs(candidate.dirPath);
          if (newestWriteMs === null || session.ended_at === null) continue;
          if (newestWriteMs >= session.ended_at * 1000) continue;
          if (Date.now() - newestWriteMs < ROUTED_TRANSCRIPT_GC_QUIESCENCE_MS) continue;
          pruneRoutedTranscriptSessionDir(candidate.dirPath);
          pruned += 1;
        }
      })();
      if (pruned > 0) {
        logger.info(
          LOG_KINDS.ROUTED_TRANSCRIPT_CACHE_PRUNE,
          'Pruned fully-mined, session-terminal routed-transcript cache trees',
          { pruned },
        );
      }
    },
  });

  // routed-event-dedup-prune (consolidation Task C-1): age-based prune of the
  // routed `/events` idempotency ledger. The ledger carries no `session_id`
  // (host-local dedup keyed on the source-assigned `event_id` alone), so —
  // unlike the cache GC above — there is no terminal signal to gate on;
  // retention is purely `created_at` age past ROUTED_EVENT_DEDUP_RETENTION_MS
  // (constants.ts documents the conservative reasoning for the window).
  runner.register({
    name: POWER_JOB_NAMES.ROUTED_EVENT_DEDUP_PRUNE,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
    fn: fanOutGroves(POWER_JOB_NAMES.ROUTED_EVENT_DEDUP_PRUNE, async (scope) => {
      const pruned = pruneRoutedEventDedup(Math.floor(ROUTED_EVENT_DEDUP_RETENTION_MS / 1000));
      if (pruned > 0) {
        logger.info(LOG_KINDS.ROUTED_EVENT_DEDUP_PRUNE, 'Pruned aged routed-event dedup rows', {
          pruned,
          grove_id: scope.grove.id,
          grove_slug: scope.grove.slug,
        });
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
          lockNamespace,
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
        ({ grove, projectId, projectRoot, projectVaultDir, databasePath, treeAvailable }: RegisteredProjectScope) => {
          const projectConfig = loadMergedConfig(projectVaultDir, {
            groveId: grove.id,
            mycoHome,
            // A Team Host iterating a member's registered project has no
            // local working tree — degrade to machine+grove tiers instead of
            // throwing "myco.yaml not found". Git provenance itself already
            // degrades on a missing tree: `runGitAsync` returns `ok: false`
            // rather than throwing, and with no configured release refs
            // (the default) `classify()` never shells out to git at all.
            projectTierOptional: !treeAvailable,
          });
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
          lockNamespace,
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
        ({ grove, projectId, projectRoot, projectVaultDir, treeAvailable }: RegisteredProjectScope) => {
          // A Team Host never writes a member's working tree — and there is
          // no tree here to write to regardless (the host has no local
          // checkout of a member's registered project).
          if (!treeAvailable) return;
          const key = `${grove.id}:${projectId}`;
          visited.add(key);
          const lastRun = lastManagedReconcileAt.get(key) ?? 0;
          if (now - lastRun < RECONCILE_INTERVAL_MS) return;
          lastManagedReconcileAt.set(key, now);
          const result = reconcileManagedProjectFiles(projectRoot, projectVaultDir, grove.id);
          if (result && (result.gitignore || result.agentsMd || result.skillSymlinks)) {
            logger.info(
              LOG_KINDS.MANAGED_FILES_RECONCILE,
              'Reconciled managed project files',
              {
                project_id: projectId,
                gitignore: result.gitignore,
                agents_md: result.agentsMd,
                skill_symlinks: result.skillSymlinks,
              },
            );
          }
        },
        {
          mycoHome,
          daemonStateDir,
          machineId,
          lockNamespace,
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

  // ---------------------------------------------------------------------------
  // Upgrade: background auto-check+stage + idle auto-adopt
  // ---------------------------------------------------------------------------
  // Only registered when the caller supplies upgrade deps (not available in
  // tests that exercise power-jobs without upgrade wiring). This keeps
  // existing test suites stable while cleanly extending the production path.
  if (deps.upgrade) {
    const upg = deps.upgrade;

    // Both upgrade jobs no-op on a dev build (isDevBuildVersion inside
    // checkAndStage/buildAdoptJobFn) — say so once at registration, or a dev
    // box that never auto-updates looks like a broken checker.
    if (isDevBuildVersion(upg.currentVersion)) {
      logger.info(LOG_KINDS.DAEMON_START, 'Dev build — upgrade auto-check/auto-adopt disabled (update by explicit operator action only)', {
        current_version: upg.currentVersion,
      });
    }

    // upgrade-auto-check: hit GitHub at most once per configured interval;
    // stage the binary if a newer version is available.
    let lastAutoCheckAt = 0;
    runner.register({
      name: POWER_JOB_NAMES.UPGRADE_AUTO_CHECK,
      runIn: ['idle', 'sleep'],
      kind: 'housekeeping',
      fn: async () => {
        const config = readUpdateConfig();
        const intervalMs = config.check_interval_hours * MS_PER_HOUR;
        const now = Date.now();
        // Job-level cadence gate: tick fires more often than the check interval.
        if (now - lastAutoCheckAt < intervalMs) return;
        lastAutoCheckAt = now;
        const result = await checkAndStage(
          upg.currentVersion,
          {
            home: upg.home,
            platform: upg.platform,
            localAppData: upg.localAppData,
            logger,
            channel: config.channel,
          },
        );
        if (result.status === 'staged') {
          logger.info(LOG_KINDS.DAEMON_START, 'Auto-check staged new version', {
            version: result.version,
          });
        } else if (result.status === 'error') {
          logger.warn(LOG_KINDS.DAEMON_START, 'Auto-check stage error', {
            error: result.error,
          });
        }
      },
    });

    // upgrade-adopt: when idle/sleep and a staged version > current exists,
    // spawn the adopt orchestrator. The inFlight sentinel is the idempotency gate.
    const adoptDeps: AutoAdoptDeps = {
      currentVersion: upg.currentVersion,
      home: upg.home,
      platform: upg.platform,
      localAppData: upg.localAppData,
      stateDir: upg.stateDir,
      daemonPort: upg.daemonPort,
      // Resolve the service-managed label lazily at adopt time (async, only
      // runs when we actually have a staged version ready to adopt).
      resolveServiceLabel: async () => {
        const { getServiceManager } = await import('../service/manager.js');
        const { resolveRestartServiceLabel } = await import('./api/restart.js');
        return resolveRestartServiceLabel(getServiceManager());
      },
      mycoBinary: upg.mycoBinary ?? resolveMycoBinary(),
      projectRoot: upg.projectRoot,
      logger,
    };
    runner.register({
      name: POWER_JOB_NAMES.UPGRADE_ADOPT,
      runIn: ['idle', 'sleep'],
      kind: 'housekeeping',
      fn: buildAdoptJobFn(adoptDeps),
    });
  }

  // service-reconcile: a daemon that direct-spawned (detached from its launchd
  // job) keeps the lock and serves while the supervisor job hot-loops respawning
  // step-aside daemons. This job — which only runs INSIDE the lock-holding
  // daemon — detects that signature and hands off to the supervisor by spawning
  // `myco service reconcile` (cooperative stop + re-bootstrap of one tracked
  // daemon). See POWER_JOB_NAMES.SERVICE_RECONCILE.
  let serviceReconcileLatched = false;
  runner.register({
    name: POWER_JOB_NAMES.SERVICE_RECONCILE,
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
    fn: async () => {
      // Only a daemon that believes it is supervisor-managed (marker set in the
      // unit env, inherited across an orchestrator direct-spawn) is a candidate;
      // a hand-run `myco daemon` (no marker) is never auto-reconciled.
      if (!process.env.MYCO_DAEMON_MANAGED?.trim()) { serviceReconcileLatched = false; return; }
      const { getServiceManager } = await import('../service/manager.js');
      const mgr = getServiceManager();
      if (!mgr.supported) { serviceReconcileLatched = false; return; }
      const { findInstalledServiceLabel } = await import('./api/restart.js');
      const found = await findInstalledServiceLabel(mgr, mycoHome);
      // Detached-usurper signature: a unit is installed and running, but the
      // supervisor-tracked PID is NOT us (we are the live lock-holder). Any other
      // shape (no unit, not running, or the supervisor already tracks us) is
      // healthy. Only the clear "running under a different PID" case acts.
      const detached = !!found && found.status.running
        && found.status.pid !== null && found.status.pid !== process.pid;
      if (!detached) { serviceReconcileLatched = false; return; }
      // Two-tick latch so a single transient launchctl status read can't trigger
      // a needless self-restart.
      if (!serviceReconcileLatched) { serviceReconcileLatched = true; return; }
      serviceReconcileLatched = false;
      logger.warn(LOG_KINDS.DAEMON_START, 'Detached from supervisor job — spawning `service reconcile`', {
        tracked_pid: found!.status.pid, my_pid: process.pid, label: found!.label,
      });
      const { spawnDetached } = await import('../upgrade/orchestrator.js');
      spawnDetached(resolveMycoBinary(), ['service', 'reconcile'], mycoHome);
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
        async ({ databasePath, projectId, projectRoot, projectVaultDir, grove, treeAvailable }: RegisteredProjectScope) => {
          // Canopy scan walks the working tree — a Team Host iterating a
          // member's registered project has none. Skip before ever touching
          // config or the scanner; without this the scan would throw ENOENT
          // walking a nonexistent root and log a CANOPY_ERROR every tick.
          if (!treeAvailable) return;
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
          lockNamespace,
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

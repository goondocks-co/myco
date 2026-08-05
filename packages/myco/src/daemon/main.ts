/**
 * Myco daemon — global capture, API, MCP, and scheduled-work runtime.
 *
 * The daemon is the per-machine authority for event ingestion, session
 * recording, Grove-scoped API handling, in-process MCP HTTP, and recurring
 * project work.
 */

import { DaemonServer } from './server.js';
import { resolveHostServeConfig } from './host-serve.js';
import { EXTERNAL_MCP_PATH, ExternalMcpListener, defaultFunnelOffRunner, defaultFunnelOnRunner, resolveExternalMcpSocketPath } from './external-listener.js';
import { activateTeamFunnel, teamFunnelContainmentSockets, teamFunnelIntentFor } from '@myco/team-host/funnel.js';
import { readHostState, writeHostState } from '@myco/team-host/state.js';
import {
  ExternalMcpContainmentAuthority,
  type ExternalMcpListenerControl,
} from './external-mcp-containment.js';
import type { RouteRequest } from './router.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger, type Logger } from './logger.js';
import { loadMachineConfig, loadMergedConfig, setTierParseFailureListener } from '../config/loader.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { createPerProjectAdapter } from '../symbionts/adapter.js';
import { claudeCodeAdapter } from '../symbionts/claude-code.js';
import { findCorePackageRoot } from '../utils/find-package-root.js';
import { hasEmbeddedUi } from './static.js';
import { attemptDaemonStartup, type LockHandle } from './lifecycle-lock-startup.js';
import * as updateInProgress from '@myco/upgrade/in-progress.js';
import { resolveVaultDir, resolveProjectRoot, projectTreeAvailable } from '../vault/resolve.js';
import { EventBuffer } from '../capture/buffer.js';
import { listAllProjectBufferDirs } from '../capture/buffer-location.js';
import { runGlobalBootstrap, shouldRunGlobalBootstrap } from '../cli/bootstrap.js';
import { resolveMycoHome, resolveGroveDbPath, resolveProjectVaultDir } from '../grove/paths.js';
import { installPreMigrationCheckpoint } from '@myco/backup/pre-migration-checkpoint.js';
import { stampHarnessRedirectEpoch } from '@myco/agent/harness/redirect-epoch.js';
import { loadManifests } from '../symbionts/detect.js';
import type { PlanWatchConfig } from './plan-capture.js';
import {
  handleGetGroveConfig,
  handlePutGroveConfig,
  handleGetMachineConfig,
  handlePutMachineConfig,
  createPlanDirHandlers,
} from './api/config.js';
import { registerConfigRoutes } from './api/register-config-routes.js';
import { installProcessGuards } from './process-guards.js';
import { handleLogSearch, handleLogStream, handleLogDetail, createLogIngestionHandler } from './api/log-explorer.js';
import { handleRestart } from './api/restart.js';
import { createIntentHandlers } from './api/intent.js';
import { createUpgradeHandlers } from './api/upgrade.js';
import { resolveGlobalPrefix, resolveMycoBinary } from './update-checker.js';
import { getMachineId } from '@myco/machine-id.js';
import { createBackupHandlers, createBackupConfigHandlers } from './api/backup.js';
import { migrateLegacyBackups } from '@myco/backup/migrate.js';
import { createSessionLifecycleHandlers } from './api/session-lifecycle.js';
import {
  handleListCandidates,
  handleGetCandidate,
  handleUpdateCandidate,
  handleListSkillRecords,
  handleGetSkillRecord,
  handleDeleteCandidate,
  createSkillRecordDeleteHandler,
} from './api/skills.js';
import { initTeamContext } from '@myco/team/context.js';
import { ProgressTracker, handleGetProgress } from './api/progress.js';
import { handleGetModels } from './api/models.js';
import { computeConfigHash, createLiveStatsHandler } from './api/stats.js';
import {
  createArchiveProjectHandler,
  createCreateGroveHandler,
  createDeleteGroveHandler,
  createDeleteProjectHandler,
  createListGroveProjectsHandler,
  createListGrovesHandler,
  createMoveProjectHandler,
  createRenameGroveHandler,
  createSetDefaultGroveHandler,
  createUnarchiveProjectHandler,
  servedGroveScopeForDaemon,
} from './api/groves.js';
import {
  handleListSessions,
  createGetSessionHandler,
  handleGetSessionBatches,
  handleGetBatchActivities,
  handleGetSessionAttachments,
  handleGetSessionPlans,
  createSessionMutationHandlers,
} from './api/sessions.js';
import { createReleaseProvenanceHandlers } from './api/release-provenance.js';
import {
  handleListSpores,
  createGetSporeHandler,
  handleListEntities,
  handleGetGraphSeeds,
  handleGetGraph,
  handleGetFullGraph,
  handleGetDigest,
} from './api/mycelium.js';
import { createSearchHandler } from './api/search.js';
import {
  createSessionContextHandler,
  createPromptContextHandler,
  createResumeContextHandler,
  createSubagentContextHandler,
} from './api/context.js';
import { createCortexHandlers } from './api/cortex.js';
import { registerContentClaimRoutes } from './api/content-claims.js';
import { registerContentClaimMaterializeRoute } from './api/content-claims-materialize.js';
import { registerContentClaimFileStatusRoute } from './api/content-claims-file-status.js';
import { registerDrainHealthRoute } from './api/drain-health.js';
import { registerHostMembershipRoutes } from './api/host-membership.js';
import { registerHostServeStatusRoute } from './api/host-serve-status.js';
import { reconcileHostRollbackBearers } from '../host/registry.js';
import { registerTeamConfigRoutes } from './api/team-config.js';
import { registerTeamAgentTaskRoutes } from './api/team-agent-tasks.js';
import { defaultDial, proxyLoggerFrom } from './host-proxy.js';
import { tenantRoute } from './api/route-helpers.js';
import { createCanopyInjectHandler } from './api/canopy-inject.js';
import { handleGetFeed } from './api/feed.js';
import {
  handleListSymbionts,
  handleDetectSymbionts,
  handleDrainMigration,
  createProjectSymbiontsPatchHandler,
  createProjectSymbiontsCustomizationHandler,
} from './api/symbionts.js';
import { registerCanopyReadRoutes } from './api/canopy-read.js';
import { handleGetGitStatus } from './api/git-status.js';
import {
  createEmbeddingStatusHandler,
  createEmbeddingDetailsHandler,
  createEmbeddingActionHandlers,
} from './api/embedding.js';
import { createCanopyDescribeBacklogReader } from '../canopy/describe-backlog.js';
import { createDatabaseMaintenanceHandlers } from './api/database.js';
import { createMaintenanceHandlers } from './api/maintenance.js';
import { createProjectsActivityHandler } from './api/projects-activity.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { EmbeddingManager, SqliteVecVectorStore, EmbeddingProviderAdapter, SqliteRecordSource } from './embedding/index.js';
import { DatabaseMaintenanceManager } from './database/manager.js';
import { registerBuiltinDomains } from '../notifications/domains.js';
import { createEmbeddingProvider } from '../intelligence/llm.js';
import {
  handleListTasks,
  handleGetTask,
  handleGetTaskYaml,
  handleUpdateTask,
  handleCreateTask,
  handleCopyTask,
  handleDeleteTask,
  handleGetTaskConfig,
  handleUpdateTaskConfig,
} from './api/agent-tasks.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerScheduledTasks } from './task-scheduling.js';
import { initDatabase, closeDatabase, getDatabase, setOwnedServiceDirForCurrentProcess, withDatabase, type Database } from '../db/client.js';
import { GroveRuntimeCache } from './grove-runtime-cache.js';
import { forEachGrove, forEachRegisteredProject, isProjectActive } from './scope-iteration.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';
import type { CanopyJobsRegistry } from './jobs/canopy-scan.js';
import {
  ProjectPowerStateTracker,
  readProjectActivitySeed,
} from './project-power-state.js';
import { pauseAwareShouldVisit, isProjectPaused } from '../grove/registry.js';
import { createSchema, SchemaVersionTooNewError } from '../db/schema.js';
import { clearSchemaRefusalMarker, handleBootSchemaRefusal } from './schema-refusal.js';
import { stampSupportedSchemaVersion } from '../upgrade/schema-gap.js';
import { insertLogEntry, getMaxTimestamp } from '../db/queries/logs.js';
import { createStreamableMcpHttpHandler } from '../mcp/http.js';
import { createAgentRunHandlers } from './api/agent-runs.js';
import { createDigestRevisionHandlers } from './api/digest-revisions.js';
import { createAttachmentHandler } from './api/attachments.js';
import { reconcileLogBuffer } from './log-reconcile.js';
import { logEntryToInsert } from './log-entry-insert.js';
import { markRunningRunsInterrupted, sweepStaleSupersededRuns, listStaleSweepProjectIds } from '../db/queries/runs.js';
import {
  POWER_IDLE_THRESHOLD_MS,
  POWER_SLEEP_THRESHOLD_MS,
  POWER_DEEP_SLEEP_THRESHOLD_MS,
  POWER_ACTIVE_INTERVAL_MS,
  POWER_SLEEP_INTERVAL_MS,
  RESTART_RESPONSE_FLUSH_MS,
  JOB_RUNNER_CONCURRENCY,
  epochSeconds,
  EXTERNAL_MCP_ACTIVATION_POSTURE,
  EXTERNAL_MCP_ACTIVE_POSTURE,
  EXTERNAL_MCP_FUNNEL_PORT,
} from '../constants.js';
import { RESTART_REASON_FILENAME } from '../constants/update.js';
import { drainUpdateEvents } from '../upgrade/update-events.js';
import { buildScopedConfigSaveNotification } from '../config/focus.js';
import { notify } from '../notifications/notify.js';
import { agentRunNotificationLink } from '../notifications/links.js';
import { PowerManager } from './power.js';
import { JobRunner } from './job-runner.js';
import { EventLoopLagProbe } from './event-loop-lag.js';
import { InflightRunRegistry } from './inflight-runs.js';
import { registerPowerJobs, makeAgentLivenessSource } from './power-jobs.js';
import { startSelfReconcileLoop } from './self-reconcile-wiring.js';
import { createDaemonStateAuthority } from './daemon-state-authority.js';
import {
  handleUserPrompt, handleToolUse, handleStopBatches, handleToolFailure,
  handleSubagentStart, handleSubagentStop, handleStopFailure,
  handleTaskCompleted, handleCompact, syncTranscriptPromptBatches,
} from './event-handlers.js';
import { createReconciler } from './reconciliation.js';
import { EventDedupCache } from './event-dedup-cache.js';
import { reEnrichSessionFromTranscript } from './session-reenrich.js';
import { runPendingMigrationTasks } from './migration-tasks.js';
import { createStopProcessor } from './stop-processing.js';
import { captureBatchImages } from './capture-images.js';
import { createEventDispatcher } from './event-dispatch.js';
import { createRoutedTranscriptHandler } from '../host/routed-transcript.js';
import { createRoutedPlanHandler } from '../host/routed-plan.js';
import { createRoutedResidencyHandler } from '../host/routed-residency.js';
import { createRoutedDetachArtifactHandler, createRoutedDetachCompleteHandler } from '../host/routed-residency-detach.js';
import type { RemoteTarget } from '../host/routing.js';
import { pruneHostedProjects } from '../host/hosted-projects.js';
import { abortResidency, beginAttachResidency, beginDetachResidency, residencyStatus, type ResidencyDaemonDeps } from '../host/residency-transition.js';
import { countResidencyInFlight, createResidencyKicker, runResidencyTransitions } from '../host/residency-drain.js';
import { createTranscriptDrainQueue } from '../capture/transcript-drain.js';
import { createPlanDrainQueue } from '../capture/plan-drain.js';
import { createEventReplayDrainQueue } from '../capture/event-replay-drain.js';
import { createLiveReconcile } from './live-reconcile.js';
import { createConfigReactionRegistry, computeTouchedPaths, loadReactionContext } from './config-reactions/index.js';
import { createPlanWatchReaction } from './plan-watch-reaction.js';
import { resolveDaemonDataPaths, resolveVectorsPathForRequestContext } from './data-paths.js';
import {
  type GroveProjectId,
  type ProjectScope,
  isGroveEraId,
  assertGroveProjectId,
} from '../grove/ids.js';
import { rowProjectIdFromRequestContext, requireProjectId, type MycoRequestContext } from '../grove/request-context.js';
import {
  daemonStateMtimeMs,
  readDaemonState,
  assertGroveBound,
  resolveDaemonLogDir,
  resolveDaemonServiceState,
  type DaemonServiceState,
} from './service-state.js';
export {
  handleUserPrompt, handleToolUse, handleStopBatches, handleToolFailure,
  handleSubagentStart, handleSubagentStop, handleStopFailure,
  handleTaskCompleted, handleCompact,
} from './event-handlers.js';
import { loadLayeredSecrets } from '../config/secrets.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { MS_PER_DAY } from '../constants.js';
import type { MycoConfig } from '@myco/config/schema.js';
import {
  DAEMON_EVICT_POLL_MS,
  DAEMON_EVICT_TIMEOUT_MS,
  DAEMON_HEALTH_CHECK_TIMEOUT_MS,
  DAEMON_STALE_GRACE_PERIOD_MS,
  RECONCILE_COOPERATIVE_GRACE_MS,
  RECONCILE_POLL_MS,
  RECONCILE_SIGKILL_GRACE_MS,
  RECONCILE_SIGTERM_GRACE_MS,
} from '../constants.js';
import { isProcessAlive, waitForProcessExit, readProcessCommandLine } from '@goondocks/myco-shared';
import { getPluginVersion } from '../version.js';
import {
  findPidsListeningOn,
  isRetiredExternalMcpDaemon,
  probeMycoDaemon,
  terminateProcess,
} from './eviction.js';
import {
  requestCooperativeShutdownAcceptance,
  type CooperativeShutdownAcceptance,
} from '../service/cooperative-shutdown.js';
import { terminateDaemonProcess } from '../service/daemon-termination.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Sibling probe
// ---------------------------------------------------------------------------

/**
 * True when `127.0.0.1:<port>/health` responds with a myco daemon heartbeat.
 * Used during startup to distinguish a concurrent sibling (step-aside
 * candidate) from an unrelated port squatter.
 *
 * Version discipline lives at the call site: only a SAME-version sibling is
 * a step-aside candidate. A myco daemon on a different version is a stale
 * orphan (e.g. an old binary image that survived a package replacement) —
 * stepping aside from it would leave the old version serving forever while
 * every new boot exits 0.
 */
export async function isHealthyMycoSibling(port: number): Promise<boolean> {
  return (await probeMycoDaemon(port)) !== null;
}

// ---------------------------------------------------------------------------
// Stale daemon cleanup
// ---------------------------------------------------------------------------

/** Test seam for reconcileExistingDaemon: production callers pass nothing. */
export interface ReconcileDeps {
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Returns the process's cmdline string (e.g. "node /path/to/myco daemon")
   * or null when the pid cannot be read (foreign uid, transient
   * /proc absence). Used to distinguish a cross-uid live myco daemon
   * (preserve step-aside) from a recycled foreign pid (take over).
   */
  readProcessCommandLine?: (pid: number) => string | null;
  /**
   * Ask the predecessor to shut down gracefully over HTTP before we resort to
   * signals. Retirement-required callers may continue protected termination
   * when an activation-capable predecessor refuses.
   */
  requestShutdown?: (port: number, timeoutMs: number) => Promise<CooperativeShutdownAcceptance>;
  /** Require proof that any surviving predecessor cannot activate external MCP. */
  requireRetiredExternalMcp?: boolean;
  /** How long to let an ACCEPTED cooperative shutdown drain before escalating
   *  to signals (ms). Defaults to RECONCILE_COOPERATIVE_GRACE_MS. */
  cooperativeGraceMs?: number;
  sigtermGraceMs?: number;
  sigkillGraceMs?: number;
  pollMs?: number;
}

/**
 * Default {@link ReconcileDeps.requestShutdown}: POST `/api/shutdown` on the
 * predecessor's loopback port. A 202 is accepted, a 409 is an explicit
 * refusal. The caller's retirement policy decides whether a refusal can safely
 * leave the predecessor running.
 */
async function requestDaemonShutdown(
  port: number,
  timeoutMs: number,
): Promise<CooperativeShutdownAcceptance> {
  return requestCooperativeShutdownAcceptance(port, { timeoutMs });
}

/**
 * Reconcile with any existing daemon for this vault before starting a new one.
 *
 * - If no daemon.json or the recorded pid is dead → 'ok' (take over).
 * - If the recorded daemon is recent, healthy, and compatible with the
 *   requested retirement policy → 'step-aside'.
 * - Otherwise (stale, unhealthy, or version-mismatch) → SIGTERM, poll for
 *   exit, escalate to SIGKILL if needed. If the pid survives both signals,
 *   return 'step-aside' only when the retirement policy permits it; otherwise
 *   return 'blocked' so the caller keeps containment held.
 *
 * **Succession via atomic overwrite, not delete-then-write.** When this
 * function returns 'ok' the caller proceeds to `server.start()`, whose
 * `listen` callback atomically rewrites daemon.json with the successor's
 * state. The atomic rename inside `atomicWriteFileSync` means readers
 * see either the predecessor's contents or the successor's — never an
 * absent file. We therefore do NOT delete the predecessor's record here.
 *
 * History: the prior shape unlinked daemon.json in all four take-over
 * branches, opening a multi-second absence window that masked capture
 * regressions until the self-reconciler caught up. The deletion was
 * never structurally necessary — the successor's write already overwrites
 * — and removing it closes the window without weakening any invariant.
 * Stale state in the rare server-start-failure case is recovered by the
 * next daemon-startup pass through this same function.
 *
 * Self-mutation-discipline tenet: pid alive ⇔ daemon.json exists.
 * Enforcement lives in `daemon-state-authority.ts` (Phase 4: drop raw
 * unlink access entirely).
 */
export async function reconcileExistingDaemon(
  daemonService: DaemonServiceState,
  logger: DaemonLogger,
  deps: ReconcileDeps = {},
): Promise<'ok' | 'step-aside' | 'blocked'> {
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const cmdlineReader = deps.readProcessCommandLine ?? readProcessCommandLine;
  const requestShutdown = deps.requestShutdown ?? requestDaemonShutdown;
  const cooperativeGraceMs = deps.cooperativeGraceMs ?? RECONCILE_COOPERATIVE_GRACE_MS;
  const sigtermGraceMs = deps.sigtermGraceMs ?? RECONCILE_SIGTERM_GRACE_MS;
  const sigkillGraceMs = deps.sigkillGraceMs ?? RECONCILE_SIGKILL_GRACE_MS;
  const pollMs = deps.pollMs ?? RECONCILE_POLL_MS;
  let retiredExternalMcpProven = false;

  const daemonJsonPath = daemonService.statePath;
  let info: { pid?: number; port?: number; command?: string | null };
  let mtimeMs: number;
  try {
    const current = readDaemonState(daemonJsonPath);
    if (!current) return 'ok';
    mtimeMs = daemonStateMtimeMs(daemonJsonPath) ?? 0;
    info = current;
  } catch {
    // Unreadable daemon state — treat as absent.
    return 'ok';
  }

  if (!info.pid) return 'ok';
  if (info.pid === process.pid) return 'ok';

  // Is the recorded process actually alive? Use the dependency-injected
  // probe so tests can simulate "still alive after SIGKILL".
  if (!alive(info.pid)) {
    // Dead — succeed it via the caller's upcoming server.start() write.
    logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Predecessor pid dead; proceeding to take over', {
      predecessor_pid: info.pid,
    });
    return 'ok';
  }

  // Alive. If it's recent AND healthy AND the same version AND on the
  // canonical port, step aside rather than racing it. Without this guard,
  // two concurrent spawns kill each other in sequence and the surviving PID
  // is whichever one ran last.
  //
  // The canonical-port check is load-bearing: if the sibling fell back to
  // `canonical+1` because an orphan was squatting the canonical port, we
  // must NOT step aside — we need to proceed through eviction, kill the
  // orphan, and bind the canonical port ourselves.
  const recent = Date.now() - mtimeMs < DAEMON_STALE_GRACE_PERIOD_MS;
  const canonicalPort = daemonService.canonicalPort;
  if (recent && typeof info.port === 'number' && info.port === canonicalPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = await res.json() as {
          myco?: boolean;
          version?: string;
          external_mcp_activation?: string;
        };
        const existingCommand = info.command ?? null;
        // Use process.execPath, not process.argv[1]: under the bun-compiled
        // standalone, argv[1] is a virtual /$bunfs/... path that never
        // matches what daemon.json stores (the on-disk binary path).
        const currentCommand = process.execPath ?? null;
        const runtimeMismatch = Boolean(existingCommand && currentCommand && existingCommand !== currentCommand);
        retiredExternalMcpProven = isRetiredExternalMcpDaemon(data, info.pid);
        const safeToStepAside = !deps.requireRetiredExternalMcp
          || retiredExternalMcpProven;
        if (
          data.myco
          && safeToStepAside
          && (data.version === getPluginVersion() || runtimeMismatch)
        ) {
          logger.info(LOG_KINDS.DAEMON_START, 'Sibling daemon already healthy — stepping aside', {
            existing_pid: info.pid,
            existing_port: info.port,
            existing_command: existingCommand,
            current_command: currentCommand,
            runtime_mismatch: runtimeMismatch,
          });
          return 'step-aside';
        }
      }
    } catch { /* health probe failed — fall through and replace */ }
  }

  // Stale, unhealthy, or version mismatch: take over. We MUST confirm the
  // predecessor pid is dead before proceeding — otherwise a wedged
  // shutdown leaves a live daemon racing the new one for the port.
  //
  // Cooperative shutdown first, when we know the port: let the predecessor run
  // its own graceful drain (in-flight runs, team-sync outbox, DB close) and
  // exit. This is the ONLY graceful path on Windows, where the SIGTERM below
  // maps to an uncatchable TerminateProcess that would abort the drain. If
  // accepted, wait the drain-aware budget (the wait returns the instant the pid
  // exits, so a clean drain costs milliseconds); only a predecessor still alive
  // past that budget — its drain genuinely wedged — falls through to signals.
  if (typeof info.port === 'number') {
    const cooperativeResult = await requestShutdown(info.port, DAEMON_HEALTH_CHECK_TIMEOUT_MS);
    if (cooperativeResult.kind === 'refused') {
      if (!deps.requireRetiredExternalMcp || retiredExternalMcpProven) {
        logger.error(LOG_KINDS.DAEMON_RECONCILE, 'Predecessor refused shutdown; stepping aside without signalling', {
          pid: info.pid,
          port: info.port,
          status: cooperativeResult.status,
        });
        return 'step-aside';
      }
      logger.warn(LOG_KINDS.DAEMON_RECONCILE, 'Activation-capable predecessor refused shutdown; continuing protected termination', {
        pid: info.pid,
        port: info.port,
        status: cooperativeResult.status,
      });
    }
    if (cooperativeResult.kind === 'accepted') {
      logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Requested cooperative shutdown of stale daemon', {
        pid: info.pid,
        port: info.port,
      });
      if (await waitForExit(info.pid, alive, cooperativeGraceMs, pollMs)) {
        logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Predecessor exited on cooperative shutdown; proceeding to take over', {
          predecessor_pid: info.pid,
        });
        return 'ok';
      }
    }
  }

  try {
    kill(info.pid, 'SIGTERM');
    logger.info(LOG_KINDS.DAEMON_RECONCILE, 'SIGTERM sent to stale daemon', { pid: info.pid });
  } catch { /* already dead between alive() and kill() */ }

  if (await waitForExit(info.pid, alive, sigtermGraceMs, pollMs)) {
    logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Predecessor exited on SIGTERM; proceeding to take over', {
      predecessor_pid: info.pid,
    });
    return 'ok';
  }

  logger.warn(LOG_KINDS.DAEMON_RECONCILE, 'Predecessor ignored SIGTERM — escalating to SIGKILL', {
    pid: info.pid,
    grace_ms: sigtermGraceMs,
  });
  try {
    kill(info.pid, 'SIGKILL');
  } catch { /* already dead */ }

  if (await waitForExit(info.pid, alive, sigkillGraceMs, pollMs)) {
    logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Predecessor exited on SIGKILL; proceeding to take over', {
      predecessor_pid: info.pid,
    });
    return 'ok';
  }

  // Pid survived SIGKILL. Two distinct shapes:
  //   (a) A live Myco daemon owned by a different uid (EPERM made
  //       SIGTERM/SIGKILL no-ops). Stepping aside is the right call —
  //       supervisor owns lifecycle, we're not authorized to touch it.
  //   (b) A FOREIGN process that recycled the pid that daemon.json
  //       records. Stepping aside here would loop forever: the file
  //       describes a "live daemon" that isn't ours, the supervisor
  //       respawns us, we re-enter this branch, repeat. Distinguish
  //       by reading the cmdline — if it's non-null and doesn't
  //       reference myco, this slot was stolen by an unrelated process
  //       and we can safely evict the stale state file.
  // Conservative default: when cmdline is unreadable (null — common
  // for cross-uid processes on some platforms), assume the pid is
  // unknown rather than foreign, and preserve the existing step-aside
  // posture. Only the "we can prove this is NOT a myco process" path
  // takes over.
  const cmdline = cmdlineReader(info.pid);
  const provenForeign = cmdline !== null && !/\bmyco\b/i.test(cmdline);
  if (provenForeign) {
    logger.warn(
      LOG_KINDS.DAEMON_RECONCILE,
      `Pid ${info.pid} survived SIGKILL but its cmdline does not look like a myco daemon — treating as a recycled foreign pid and taking over`,
      {
        pid: info.pid,
        cmdline,
        sigterm_grace_ms: sigtermGraceMs,
        sigkill_grace_ms: sigkillGraceMs,
      },
    );
    // Recycled foreign pid: the upcoming server.start() write will
    // overwrite the stale record atomically. No delete needed.
    return 'ok';
  }

  // Cmdline unreadable (null) AND the record is stale. The conservative
  // step-aside below loops forever against a recycled foreign pid when the
  // cmdline probe is unavailable — e.g. PowerShell blocked/absent on Windows
  // makes `readProcessCommandLine` return null, so every supervisor respawn
  // re-reads the same record and steps aside again. Break the loop on
  // staleness: any LIVE daemon (every uid, including a cross-uid one we can't
  // signal) refreshes daemon.json's mtime each heartbeat, so a record that has
  // gone stale past DAEMON_STALE_GRACE_PERIOD_MS is not backed by a running
  // daemon — the pid is dead-and-recycled or an unrecoverable wedge. Taking
  // over with a fresh daemon beats stranding ourselves indefinitely.
  const recordIsStale = Date.now() - mtimeMs >= DAEMON_STALE_GRACE_PERIOD_MS;
  if (cmdline === null && recordIsStale) {
    logger.warn(
      LOG_KINDS.DAEMON_RECONCILE,
      `Pid ${info.pid} survived SIGKILL with an unreadable cmdline, but daemon.json has not heartbeat in over ${Math.round(DAEMON_STALE_GRACE_PERIOD_MS / 1000)}s — treating as a dead/recycled slot and taking over to break the strand loop`,
      {
        pid: info.pid,
        record_age_ms: Date.now() - mtimeMs,
        sigterm_grace_ms: sigtermGraceMs,
        sigkill_grace_ms: sigkillGraceMs,
      },
    );
    // The upcoming server.start() write overwrites the stale record atomically.
    return 'ok';
  }

  logger.error(
    LOG_KINDS.DAEMON_RECONCILE,
    `Refusing to remove daemon.json: prior daemon pid ${info.pid} is unkillable (cmdline ${cmdline === null ? 'unreadable' : 'references myco'} — likely cross-uid live daemon)`,
    {
      pid: info.pid,
      cmdline,
      sigterm_grace_ms: sigtermGraceMs,
      sigkill_grace_ms: sigkillGraceMs,
    },
  );
  return deps.requireRetiredExternalMcp && !retiredExternalMcpProven
    ? 'blocked'
    : 'step-aside';
}

async function waitForExit(
  pid: number,
  alive: (pid: number) => boolean,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  if (alive === isProcessAlive) {
    return waitForProcessExit(pid, timeoutMs, pollMs);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !alive(pid);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loggerForProject(logger: Logger, projectId: GroveProjectId | null): Logger {
  const addProject = (data?: Record<string, unknown>) => ({
    ...data,
    project_id: typeof data?.project_id === 'string' ? data.project_id : projectId,
  });
  return {
    debug: (kind, message, data) => logger.debug(kind, message, addProject(data)),
    info: (kind, message, data) => logger.info(kind, message, addProject(data)),
    warn: (kind, message, data) => logger.warn(kind, message, addProject(data)),
    error: (kind, message, data) => logger.error(kind, message, addProject(data)),
  };
}

/**
 * Build a `scheduleShutdown` closure that records its caller label
 * and a stack snapshot in the daemon log on every invocation. Makes
 * shutdown-triggered events attributable to a specific call site.
 */
function scheduleShutdownWithAttribution(callerLabel: string, logger: DaemonLogger): () => void {
  return () => {
    const stack = new Error().stack?.split('\n').slice(1, 6).join('\n').trim() ?? '';
    logger.info(LOG_KINDS.DAEMON_START, 'Shutdown scheduled', {
      caller: callerLabel,
      stack,
    });
    setTimeout(() => {
      void terminateDaemonProcess(process.pid, 'SIGTERM').catch((error) => {
        logger.error(LOG_KINDS.DAEMON_START, 'Shutdown termination blocked', {
          caller: callerLabel,
          error: errorMessage(error),
        });
      });
    }, RESTART_RESPONSE_FLUSH_MS);
  };
}

/**
 * Write admission for the boot stale-run sweeps: the project ids among
 * the sweeps' candidate rows whose write lease is held, to be excluded
 * from the UPDATE.
 *
 * The sweeps rewrite `agent_runs` grove-wide with no project filter, so a
 * project mid-residency-transition at daemon restart would have its rows
 * rewritten inside the push window and deleted unshipped by
 * `deleteAfterAck`. Must run inside the Grove DB binding being swept.
 *
 * An unreadable lease counts as held (Write Admission G4) — a torn record
 * excludes the project rather than admitting the sweep.
 *
 * KNOWN GAP, stated rather than implied: unlike the other admission sites in
 * this batch, exclusion here is ABANDONMENT, not deferral. These two sweeps
 * run only at boot — there is no timer and no re-run — so an excluded
 * project's `running` rows are not re-swept when the lease releases; they
 * stay `running` until the next daemon restart, and are never marked
 * `resumable`, so that work is dropped rather than resumed. Dispatch is NOT
 * wedged (`getRunningRunForTask` treats a stale row as stale and the
 * executor proceeds), so the visible symptom is a run stuck at "running" in
 * the UI. The release-provenance reconcile's "skipping is safe because the
 * next pass re-derives it" argument does NOT transfer here, which is why it
 * is written out instead of assumed. Closing it needs a re-sweep on lease
 * release; tracked with the W4 stranded-lease work rather than bolted on
 * here.
 */
function leaseHeldProjectIdsForSweep(scope: ProjectScope, logger: DaemonLogger): string[] {
  const held: string[] = [];
  for (const projectId of listStaleSweepProjectIds(scope)) {
    let paused: boolean;
    try {
      paused = isProjectPaused(projectId).paused;
    } catch {
      paused = true;
    }
    if (paused) held.push(projectId);
  }
  if (held.length > 0) {
    logger.info(LOG_KINDS.AGENT_RUN, 'Stale-run sweep excluding projects whose write lease is held', {
      excluded: held.length,
      project_ids: held.join(','),
    });
  }
  return held;
}

/**
 * Fan out canopy initial-populate across every registered project on
 * boot. Cold projects (no recent activity) defer to their next
 * SessionStart's delta scan so idle Groves don't pay a full-scan cost
 * for projects nobody has used in weeks. Errors per project are isolated.
 */
export async function runInitialCanopyPopulateAcrossProjects(
  cache: GroveRuntimeCache,
  logger: DaemonLogger,
  machineId: string,
  registry: CanopyJobsRegistry,
  liveConfig: { current: MycoConfig },
  daemonStateDir: string,
  lockNamespace?: PerUserLockNamespace,
): Promise<void> {
  try {
    const thresholdDays = liveConfig.current.agent.cold_project_threshold_days ?? 14;
    const cutoffSeconds = thresholdDays > 0
      ? Math.floor((Date.now() - thresholdDays * MS_PER_DAY) / 1000)
      : 0;
    const mycoHome = resolveMycoHome();
    await forEachRegisteredProject(
      cache,
      logger,
      async ({ databasePath, projectId, projectRoot, grove, db, treeAvailable }) => {
        // Canopy populate walks the working tree — a Team Host iterating a
        // member's registered project has none. Skip rather than throw
        // ENOENT walking a nonexistent root.
        if (!treeAvailable) return;
        if (cutoffSeconds > 0 && !isProjectActive(db, projectId, cutoffSeconds)) {
          // Cold project — let SessionStart trigger when the user returns.
          return;
        }
        await registry.initialPopulate({ databasePath, projectId, projectRoot, groveId: grove.id });
      },
      {
        machineId,
        daemonStateDir,
        lockNamespace,
        // Skip projects under an in-flight move/vacuum so the initial
        // populate doesn't write to a DB the op owns exclusively.
        shouldVisit: pauseAwareShouldVisit(mycoHome),
      },
    );
  } catch (err) {
    logger.warn(LOG_KINDS.CANOPY_ERROR, 'Initial canopy populate fan-out failed', {
      error: errorMessage(err),
    });
  }
}

export async function main(): Promise<void> {
  // Last-resort process guards go in BEFORE any async work: Bun exits on
  // the first unhandled rejection, and everything below this line schedules
  // background promises. The daemon logger doesn't exist yet — the guards
  // fall back to stderr until `bindLogger` below.
  const processGuards = installProcessGuards();

  const mycoHome = resolveMycoHome();

  // Stamp the harness redirect epoch at boot rather than on first harness use.
  // Redirection is in effect for every harness run this process will start, so
  // boot is the moment after which a transcript in the user's session tree
  // cannot be an agent run. Deferring the stamp to the first run leaves a
  // window — as long as the gap to the next scheduled task — in which
  // redirection is active but nothing can be dated against it.
  stampHarnessRedirectEpoch(mycoHome);

  const daemonService = resolveDaemonServiceState(mycoHome, {
    env: process.env,
  });
  let externalMcpListener: ExternalMcpListener | undefined;
  const externalMcpListenerControl: ExternalMcpListenerControl = {
    get isBound() {
      return externalMcpListener?.isBound ?? false;
    },
    get boundTarget() {
      return externalMcpListener?.boundTarget ?? null;
    },
    async unbind() {
      await externalMcpListener?.unbind();
    },
    async bind(target) {
      if (!externalMcpListener) return { ok: false, error: 'external MCP listener not yet constructed' };
      return await externalMcpListener.bind(target);
    },
  };
  const externalMcpContainment = new ExternalMcpContainmentAuthority({
    mycoHome,
    stateDir: daemonService.stateDir,
    listener: externalMcpListenerControl,
    runFunnelOff: defaultFunnelOffRunner,
    runFunnelOn: defaultFunnelOnRunner,
    // This ONE authority serves both boot and the daemon's own shutdown, and
    // the two want opposite answers for a serving host: boot leaves an intended
    // Funnel alone (it is verified after the listener binds, below), shutdown
    // withdraws it so nothing answers the public URL while the daemon is down.
    // Deriving the intent from the operation is what keeps them apart — a fixed
    // 'retire' here meant shutdown withdrew nothing.
    additionalFunnelSockets: (operation) => teamFunnelContainmentSockets({
      mycoHome,
      intent: teamFunnelIntentFor(operation),
    }),
  });
  return await externalMcpContainment.containWhile('reconcile', async (externalMcpBootState) => {
  const reconciledHostBearers = reconcileHostRollbackBearers();

  // `bootstrapVaultDir` is a *transitional* concept.
  //
  // In the Grove world, the daemon serves many projects and the per-request
  // vault directory comes from `req.requestContext.projectVaultDir`. The
  // daemon process itself, though, still has to bootstrap from somewhere on
  // disk to load secrets, identify the machine, resolve the merged config,
  // open the daemon log dir, and so on — all before any HTTP traffic
  // arrives. `resolveVaultDir()` walks up from cwd (worktree-aware) to find
  // the enclosing `.myco/` and we treat that as the bootstrap fallback.
  //
  // Almost every downstream callsite below either:
  //   (a) genuinely needs the bootstrap dir (logger init, secrets load,
  //       machine-id, daemon-service files, plan-watch, restart marker), or
  //   (b) prefers the per-request projectVaultDir but falls back to
  //       `bootstrapVaultDir` when no request context is bound (typically
  //       global handlers or singleton subsystems that haven't been
  //       Grove-aware-ified yet).
  //
  // Once every handler/subsystem takes a ProjectScope (auto-registered
  // at first hook), the bootstrap fallback in case (b) goes away and
  // case (a) handlers move to a dedicated daemon-paths struct. Until
  // then, do NOT use this value as a stand-in for the request-scoped
  // vault.
  const { resolveBootstrapVaultDirOrPhantom } = await import('../vault/bootstrap.js');
  const { vaultDir: bootstrapVaultDir, isPhantom: bootstrapIsPhantom } =
    resolveBootstrapVaultDirOrPhantom();
  // The global, multi-tenant daemon (run under a service supervisor, which
  // sets MYCO_DAEMON_MANAGED=1 in the unit env) has no bootstrap project. It
  // always boots phantom (home-scoped to MYCO_HOME) and serves every tenant by
  // request context — it never anchors to, nor rebinds to, a registered project.
  const isGlobalDaemon = (process.env.MYCO_DAEMON_MANAGED?.trim() ?? '') !== '';

  // --- Machine identity (resolved early so config load can use the Grove id) ---
  // BEFORE the first getMachineId() call mints a fresh value, scan every
  // registered project the daemon serves for a legacy project-scope
  // machine_id and propagate the FIRST hit into ~/.myco/machine_id.
  // Without this guard, a brownfield upgrade silently abandons the legacy
  // identity (per-project migration that runs later sees the global file
  // already exists and bails). Idempotent — no-op once the global cache
  // is populated. /code-review finding C2.
  try {
    const { propagateLegacyMachineIdAtStartup } = await import('../grove/global-install-migration.js');
    propagateLegacyMachineIdAtStartup();
  } catch {
    // Best-effort: if registry scan fails (e.g. greenfield daemon with
    // no Groves yet), fall through to fresh derivation via getMachineId.
  }
  const machineId = getMachineId();
  const dataPaths = resolveDaemonDataPaths(
    bootstrapVaultDir,
    {
      ...process.env,
      MYCO_MACHINE_ID: machineId,
    },
    // Phantom boot uses the project-less daemon-global context (projectId null).
    { daemonGlobal: bootstrapIsPhantom },
  );

  // Relocate any legacy project-vault `secrets.env` into machine secrets
  // BEFORE loading. The provider-secrets dashboard no longer reads the
  // `project` scope, so a project `secrets.env` that materializes after
  // the one-shot global-install migration sentinel (hand-placed file,
  // resurrected branch) would otherwise be loaded here yet stay invisible
  // and undeletable in the UI — an orphaned-and-consumed credential. This
  // relocate is the same lift+purge the migration performs, but idempotent
  // and sentinel-independent, so the window can never persist. Skip in the
  // phantom/global daemon, where bootstrapVaultDir IS the machine home.
  if (!bootstrapIsPhantom && path.resolve(bootstrapVaultDir) !== path.resolve(mycoHome)) {
    try {
      const { relocateLegacyProjectSecrets } = await import('../config/secrets.js');
      relocateLegacyProjectSecrets(bootstrapVaultDir, mycoHome);
    } catch {
      // Best-effort: a failed relocate falls through to the legacy
      // load-as-fallback below and retries on the next boot.
    }
  }

  // Load file-backed provider secrets before any provider init. Legacy project
  // `.myco/secrets.env` remains a fallback, while machine secrets are the
  // forward path for daemon-wide provider credentials. Existing process env
  // vars still win.
  loadLayeredSecrets([
    bootstrapVaultDir,
    mycoHome,
  ]);

  // Merged = machine + grove + project + personal. Any gate downstream
  // of this needs to see all four tiers, so the daemon loads the merged
  // view (sourced from `~/.myco/config.yaml`, `~/.myco/groves/<id>/config.yaml`,
  // `<project>/.myco/myco.yaml`, and `<project>/.myco/local.yaml`).
  const config = loadMergedConfig(bootstrapVaultDir, {
    groveId: dataPaths.requestContext.groveId,
    mycoHome: undefined, // resolve from env at call time
  });
  // Mutable holder that reactions update after each scoped-config write, so
  // runtime gates (scheduled-task registration, event triggers) observe the
  // flipped value without a daemon restart.
  const liveConfig: { current: typeof config } = { current: config };

  const manifests = loadManifests();
  const symbiontPlanDirs = manifests.flatMap((m) => m.capture?.planDirs ?? []);
  const symbiontPlanTags = [...new Set(manifests.flatMap((m) => m.capture?.planTags ?? []))];
  // In greenfield (phantom) mode there is no project on disk yet — anchor
  // plan watch to MYCO_HOME so the watcher has a real directory but no
  // false-positive matches. The registry watcher below restarts the
  // daemon as soon as a real project registers.
  const projectRoot = bootstrapIsPhantom ? resolveMycoHome() : resolveProjectRoot(bootstrapVaultDir);
  const planWatchConfig: PlanWatchConfig = {
    watchDirs: [...new Set([...symbiontPlanDirs, ...(config.capture.plan_dirs ?? [])])],
    projectRoot,
    extensions: config.capture.artifact_extensions,
  };
  // Skip the Grove-binding assertion in greenfield: the phantom vault
  // intentionally has no manifest. The first hook-driven registration
  // triggers a restart that re-runs this path against a real vault.
  if (!bootstrapIsPhantom) {
    assertGroveBound(bootstrapVaultDir, {
      requestContext: dataPaths.requestContext,
      env: process.env,
    });
  }
  setOwnedServiceDirForCurrentProcess(daemonService.stateDir, resolveMycoHome());
  const logger = new DaemonLogger(resolveDaemonLogDir(bootstrapVaultDir, {
    requestContext: dataPaths.requestContext,
    env: process.env,
  }), {
    level: config.daemon.log_level,
  });
  // Process guards installed at the top of main() were stderr-only until
  // now; route them through the real (never-throw) logger.
  processGuards.bindLogger(logger);
  logger.info(LOG_KINDS.DAEMON_START, 'Machine ID resolved', { machine_id: machineId });
  if (bootstrapIsPhantom && isGlobalDaemon) {
    logger.info(LOG_KINDS.DAEMON_START, 'Global daemon home resolved (MYCO_HOME); serving tenants by request context', {
      home_vault: bootstrapVaultDir,
    });
  } else if (bootstrapIsPhantom) {
    logger.info(LOG_KINDS.DAEMON_START, 'No project bound; polling registry from unbound bootstrap', {
      unbound_vault: bootstrapVaultDir,
    });
  } else {
    logger.info(LOG_KINDS.DAEMON_START, 'Bound to project vault', {
      vault: bootstrapVaultDir,
    });
  }

  // The sole capability for mutating daemon.json. Constructed once and
  // threaded into every subsystem that writes state (server, self-
  // reconciler). See `daemon-state-authority.ts` for the structural
  // invariant this encapsulates.
  const daemonStateAuthority = createDaemonStateAuthority(daemonService, logger);

  // Self-install as a managed OS service so launchd / systemd starts the
  // daemon at every login. Idempotent: no-ops when the unit is already
  // installed; logs and continues on failure (lazy spawn stays usable).
  const { ensureSelfInstalledAsService } = await import('../service/self-install.js');
  await ensureSelfInstalledAsService(logger);

  // When debug logging is on, surface per-turn tool_use / tool_result detail
  // from the agent executor. The executor reads this env var directly because
  // it has no logger handle. Used to diagnose turn-budget exhaustion (e.g.
  // local-model rejection loops in skill-generate).
  if (config.daemon.log_level === 'debug') {
    process.env.MYCO_AGENT_DEBUG = '1';
  }

  // Single-instance enforcement via OS file lock. The flock attempt is
  // the first I/O — no SQLite open, schema work, or HTTP bind precedes
  // it. The process holding the lock IS the daemon; nothing downstream
  // is consulted as a source of truth for "who owns this."
  //
  // waitForReleaseMs tolerates the brief window where the prior holder
  // is mid-SIGTERM (e.g. `myco update` post-install respawn, `launchctl
  // bootout` followed by `myco daemon`). The bounded poll lets the
  // handoff complete without each side hitting the legacy reconcile
  // path's HTTP probe.
  let daemonLifecycleLock: LockHandle | null = null;
  while (daemonLifecycleLock === null) {
    const lockResult = await attemptDaemonStartup({
      lockPath: daemonService.lockPath,
      databasePath: dataPaths.databasePath,
      waitForReleaseMs: 2000,
    });

    if (lockResult.outcome === 'acquired') {
      daemonLifecycleLock = lockResult.lock;
      logger.info(LOG_KINDS.DAEMON_START, 'Lifecycle lock acquired', {
        lock_path: daemonService.lockPath,
      });
      break;
    }

    logger.info(LOG_KINDS.DAEMON_START, 'Lifecycle lock held by another process', {
      holder_pid: lockResult.holderPid,
      reason: lockResult.reason,
    });
    const reconcileResult = await reconcileExistingDaemon(daemonService, logger, {
      requireRetiredExternalMcp: true,
    });
    if (reconcileResult === 'step-aside') {
      process.exit(0);
    }
    if (reconcileResult === 'blocked') {
      logger.error(
        LOG_KINDS.DAEMON_START,
        'Activation-capable predecessor remains alive; containment stays held',
      );
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_POLL_MS));
    }
  }

  logger.info(LOG_KINDS.DAEMON_CONFIG, 'Config loaded', {
    vault: bootstrapVaultDir,
    daemon_state: daemonService.statePath,
    embedding_provider: config.embedding.provider,
  });
  if (reconciledHostBearers > 0) {
    logger.info(LOG_KINDS.DAEMON_START, 'Reconciled rollback-readable host bearers', {
      count: reconciledHostBearers,
    });
  }
  logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan watch directories', { dirs: planWatchConfig.watchDirs });
  if (symbiontPlanTags.length > 0) {
    logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan transcript tags', { tags: symbiontPlanTags });
  }

  // --- Resolve npm global prefix ---
  // globalPrefix is used for installed-version detection in the status handler.
  let globalPrefix: string | null = null;
  try {
    globalPrefix = resolveGlobalPrefix();
    logger.debug(LOG_KINDS.DAEMON_START, 'npm global prefix resolved', { prefix: globalPrefix });
  } catch (err) {
    logger.warn(LOG_KINDS.DAEMON_START, 'Failed to resolve npm global prefix', {
      error: errorMessage(err),
    });
  }

  // --- SQLite initialization ---
  // Pre-migration checkpoint for every pending schema migration this
  // process performs (boot DB here; lazy Grove opens and agent runs pick
  // it up through the same hook): dump the Grove to its canonical backup
  // dir first, and abort the migration if the dump fails. The checkpoint
  // is the one recovery artifact that spans a schema gap — rollback to an
  // older binary across a migration is refused.
  installPreMigrationCheckpoint({ mycoHome });
  const db = initDatabase(dataPaths.databasePath);
  try {
    createSchema(db, machineId);
  } catch (err) {
    if (err instanceof SchemaVersionTooNewError) {
      // The vault was written by a NEWER binary (rollback residue). The DB
      // has not been touched. Exiting non-zero would crash-loop under every
      // supervisor with zero signal — the listener never binds, so there is
      // no /health and no log drain. Instead: durable marker (doctor reads
      // it), one stderr line (daemon.err.log keeps it), then the deliberate
      // step-aside exit(0) that supervisors leave down. The next successful
      // boot clears the marker below.
      handleBootSchemaRefusal(err, daemonService.stateDir, getPluginVersion(), {
        exit: process.exit,
        stderr: (line) => console.error(line),
      });
    }
    throw err;
  }
  clearSchemaRefusalMarker(daemonService.stateDir);
  // Self-stamp this binary's supported schema version into its own
  // versions/<v>/ slot (best-effort; skipped when the slot doesn't exist).
  // A future rollback/downgrade decision reads the stamp to evaluate this
  // version without running it.
  stampSupportedSchemaVersion(
    mycoHome,
    process.platform as NodeJS.Platform,
    getPluginVersion(),
    process.env.LOCALAPPDATA,
  );
  registerBuiltinDomains();
  // Boot-DB sweep only — the Grove fan-out for any other registered
  // Groves runs after `runtimeCache` is built (see "interrupt stale runs
  // across registered Groves" below).
  const bootSweepExclusions = leaseHeldProjectIdsForSweep({ kind: 'all' }, logger);
  const interruptedRuns = markRunningRunsInterrupted('Daemon restarted before the run completed', { kind: 'all' }, bootSweepExclusions);
  if (interruptedRuns > 0) {
    logger.warn(LOG_KINDS.AGENT_RUN, 'Marked stale running runs as resumable after daemon restart', {
      count: interruptedRuns,
      grove_id: dataPaths.requestContext.groveId,
    });
  }
  // One-time backfill (Part 1 of the resume-admission gate): the
  // completion-time sweep only fires on FUTURE completions, so a vault
  // upgrading onto this release can still hold stale resumable rows a
  // completed equivalent run already superseded. Safe on every boot — a
  // fully-swept vault matches zero rows.
  const supersededRuns = sweepStaleSupersededRuns({ kind: 'all' }, bootSweepExclusions);
  if (supersededRuns > 0) {
    logger.warn(LOG_KINDS.AGENT_RUN, 'Marked stale resumable runs as superseded on boot', {
      count: supersededRuns,
      grove_id: dataPaths.requestContext.groveId,
    });
  }

  logger.info(LOG_KINDS.DAEMON_START, 'SQLite initialized', {
    vault: bootstrapVaultDir,
    database_path: dataPaths.databasePath,
    grove_id: dataPaths.requestContext.groveId,
  });

  // --- Check for restart-reason signal file (left by version sync restart script) ---
  {
    const reasonPath = path.join(bootstrapVaultDir, RESTART_REASON_FILENAME);
    try {
      if (fs.existsSync(reasonPath)) {
        const raw = JSON.parse(fs.readFileSync(reasonPath, 'utf-8')) as {
          reason?: string;
          from_version?: string;
          to_version?: string;
          local_update_ran?: boolean;
        };
        fs.unlinkSync(reasonPath);

        if (raw.reason === 'version_sync' && raw.to_version) {
          const message = raw.local_update_ran
            ? 'Restarted and updated local project hooks.'
            : 'Restarted to pick up the latest version.';

          notify(bootstrapVaultDir, {
            domain: 'daemon',
            type: 'daemon.version_sync',
            title: `Updated to v${raw.to_version}`,
            message,
            metadata: {
              from_version: raw.from_version ?? 'unknown',
              to_version: raw.to_version,
              local_update_ran: raw.local_update_ran ?? false,
            },
          }, liveConfig.current, { scope: 'daemon' });

          logger.info(LOG_KINDS.DAEMON_START, 'Version sync restart detected', {
            from: raw.from_version,
            to: raw.to_version,
            local_update: raw.local_update_ran,
          });
        }
      }
    } catch (err) {
      logger.warn(LOG_KINDS.DAEMON_START, 'Failed to read restart-reason file', {
        error: errorMessage(err),
      });
    }
  }

  // --- Team context ---
  initTeamContext(machineId);

  // Wire logger to SQLite persistence. Log rows take the entry's explicit
  // project_id when present, else this daemon fallback (NULL for a groveless
  // anchor). logEntryToInsert maps a log entry to a row for both this live
  // path and buffer replay.
  const daemonLogProjectId = rowProjectIdFromRequestContext(dataPaths.requestContext);
  logger.setPersistFn((entry) => {
    insertLogEntry(logEntryToInsert(entry, daemonLogProjectId));
  });

  // --- Replay adopt-orchestrator events into log_entries ---
  // The detached adopt orchestrator (stdio:'ignore') cannot write the grove DB
  // it is restarting, so it appends its restart / health-watch / rollback events
  // to a side-channel. Drain them here — AFTER persistFn is wired — so the whole
  // self-upgrade sequence lands in log_entries (and the log viewer) under
  // `upgrade.adopt`, instead of vanishing into /dev/null. Mirrors the
  // restart-reason ingestion above.
  for (const ev of drainUpdateEvents()) {
    logger.log(ev.level, LOG_KINDS.UPGRADE_ADOPT, ev.message, { ...ev.data, orchestrator_ts: ev.ts });
  }

  // Reconcile log entries missed while daemon was down
  const lastLogTimestamp = getMaxTimestamp();
  if (lastLogTimestamp) {
    const logDir = resolveDaemonLogDir(bootstrapVaultDir, {
      requestContext: dataPaths.requestContext,
      env: process.env,
    });
    const replayedCount = reconcileLogBuffer(logDir, lastLogTimestamp, daemonLogProjectId);
    if (replayedCount > 0) {
      logger.info(LOG_KINDS.DAEMON_RECONCILE, `Replayed ${replayedCount} log entries from buffer`, { replayed: replayedCount });
    }
  }

  // --- Embedding lifecycle manager ---
  const vectorsDbPath = dataPaths.vectorsPath;
  const vectorStore = new SqliteVecVectorStore(vectorsDbPath);
  const llmProvider = createEmbeddingProvider(config.embedding);
  const embeddingProvider = new EmbeddingProviderAdapter(llmProvider, config.embedding);
  const recordSource = new SqliteRecordSource();
  const embeddingManager = new EmbeddingManager(vectorStore, embeddingProvider, recordSource, logger);
  logger.info(LOG_KINDS.EMBEDDING_EMBED, 'EmbeddingManager initialized', { vectors_db: vectorsDbPath });
  const databaseManagerForRequest = (req: RouteRequest) => new DatabaseMaintenanceManager(
    req.requestContext?.databasePath ?? dataPaths.databasePath,
    req.requestContext?.projectVaultDir ?? bootstrapVaultDir,
    loggerForProject(logger, rowProjectIdFromRequestContext(req.requestContext) ?? daemonLogProjectId),
  );
  const runtimeCache = new GroveRuntimeCache();
  const databaseHandlers = createDatabaseMaintenanceHandlers({
    createManager: databaseManagerForRequest,
    cache: runtimeCache,
    logger,
    vaultDir: bootstrapVaultDir,
    daemonStateDir: daemonService.stateDir,
  });
  /**
   * Build a per-Grove embedding runtime for any DB handle the runtime
   * cache opens. Used both by Phase-1 power-job fan-out (one tick body
   * per Grove) and by per-request HTTP handlers below. The vectors file
   * is co-located with the DB (both Grove home and legacy vault layouts
   * follow that convention).
   */
  const buildGroveEmbeddingRuntime = (db: Database, databasePath: string) => {
    const scopedVectorsPath = path.join(path.dirname(databasePath), 'vectors.db');
    const scopedVectorStore = new SqliteVecVectorStore(scopedVectorsPath);
    return {
      vectorStore: scopedVectorStore,
      embeddingManager: new EmbeddingManager(
        scopedVectorStore,
        embeddingProvider,
        new SqliteRecordSource(db),
        logger,
      ),
    };
  };
  const getEmbeddingRuntime = (requestContext?: MycoRequestContext): { manager: EmbeddingManager; db?: Database } => {
    if (!requestContext) return { manager: embeddingManager };
    const scopedVectorsPath = resolveVectorsPathForRequestContext(requestContext);
    if (requestContext.databasePath === dataPaths.databasePath && scopedVectorsPath === dataPaths.vectorsPath) {
      return { manager: embeddingManager, db };
    }
    const entry = runtimeCache.getEmbeddingRuntime(requestContext.databasePath, buildGroveEmbeddingRuntime);
    return { manager: entry.embeddingManager!, db: entry.db };
  };
  const getRequestEmbeddingRuntime = (req: RouteRequest): { manager: EmbeddingManager; db: Database } => {
    const runtime = getEmbeddingRuntime(req.requestContext);
    if (!runtime.db) {
      throw new Error('Embedding runtime requires a caller-supplied Grove request context');
    }
    return { manager: runtime.manager, db: runtime.db };
  };

  // --- Register built-in agents and tasks ---
  let definitionsDir: string | undefined;
  try {
    const { registerBuiltInAgentsAndTasks, resolveDefinitionsDir } = await import('../agent/loader.js');
    definitionsDir = resolveDefinitionsDir();
    await registerBuiltInAgentsAndTasks(definitionsDir, bootstrapVaultDir);
    logger.info(LOG_KINDS.AGENT_TASK, 'Built-in agents and tasks registered');
  } catch (err) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to register built-in agents/tasks', { error: errorMessage(err) });
  }

  // Clean up stale "running" agent runs from previous daemon — they'll never complete
  try {
    const staleDb = getDatabase();
    // SQLite doesn't support RETURNING — query first, then update
    const staleRows = staleDb.prepare(
      `SELECT id, task FROM agent_runs WHERE status = 'running'`,
    ).all() as Array<{ id: string; task: string | null }>;

    if (staleRows.length > 0) {
      const completedAt = epochSeconds();
      staleDb.prepare(
        `UPDATE agent_runs SET status = 'failed', completed_at = ?, error = 'Daemon restarted while run was in progress' WHERE status = 'running'`,
      ).run(completedAt);
      for (const row of staleRows) {
        notify(bootstrapVaultDir, {
          domain: 'agents',
          type: 'agent.task.failure',
          title: `Task failed: ${row.task ?? 'agent run'}`,
          message: 'Daemon restarted while run was in progress',
          link: agentRunNotificationLink(row.id),
          metadata: { taskName: row.task, runId: row.id, reason: 'daemon_restart' },
        }, liveConfig.current);
      }
      logger.info(LOG_KINDS.AGENT_RUN, 'Cleaned stale running agent runs', {
        count: staleRows.length,
        ids: staleRows.map((r) => r.id),
      });
    }
  } catch (err) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to clean stale runs', { error: errorMessage(err) });
  }

  // Resolve dist/ui/ from @goondocks/myco core. Two candidate origins —
  // `import.meta.url` works under tsx/bun run and the tsup output;
  // `process.execPath` is needed in the Bun-compiled binary where
  // `import.meta.url` is a `/$bunfs/` virtual path. `dist/ui/` only
  // ships in core, never in the platform sub-package.
  let uiDir: string | null = null;
  const uiDevProxyTarget = process.env.MYCO_UI_DEV_PROXY_TARGET || null;
  {
    const origins: string[] = [];
    try {
      origins.push(path.dirname(new URL(import.meta.url).pathname));
    } catch { /* bunfs URL — fall through to execPath */ }
    try {
      origins.push(path.dirname(fs.realpathSync(process.execPath)));
    } catch { /* no real path — ignore */ }

    for (const origin of origins) {
      const root = findCorePackageRoot(origin);
      if (!root) continue;
      const candidate = path.join(root, 'dist', 'ui');
      if (fs.existsSync(candidate)) { uiDir = candidate; break; }
    }
  }
  if (uiDevProxyTarget) {
    logger.info(LOG_KINDS.DAEMON_START, 'UI dev proxy enabled', { target: uiDevProxyTarget });
  }
  if (uiDir) {
    logger.debug(LOG_KINDS.DAEMON_START, 'Static UI directory found', { path: uiDir });
  } else if (hasEmbeddedUi()) {
    // Standalone binary: no adjacent dist/ui/ on disk, but the dashboard
    // bundle was compiled in. The server serves it from BUNDLED_UI.
    logger.debug(LOG_KINDS.DAEMON_START, 'Serving embedded UI bundle (no disk dist/ui)');
  }

  // Always-on diagnostic for event-loop pinning. Catches stalls regardless
  // of cause (sync bun:sqlite, multi-MB JSON.parse, microtask cascade in a
  // streaming SDK aggregator). Stopped during shutdown alongside the
  // PowerManager. Constructed before PowerManager so PowerManager can wire
  // it in for per-job lag attribution.
  const eventLoopLagProbe = new EventLoopLagProbe(logger);

  const jobRunner = new JobRunner({
    concurrency: JOB_RUNNER_CONCURRENCY,
    logger,
    lagProbe: eventLoopLagProbe,
    onError: (jobName, err) =>
      logger.error(LOG_KINDS.POWER_JOB_ERROR, `Job "${jobName}" failed`, { error: errorMessage(err) }),
  });
  const powerManager = new PowerManager({
    idleThresholdMs: POWER_IDLE_THRESHOLD_MS,
    sleepThresholdMs: POWER_SLEEP_THRESHOLD_MS,
    deepSleepThresholdMs: POWER_DEEP_SLEEP_THRESHOLD_MS,
    activeIntervalMs: POWER_ACTIVE_INTERVAL_MS,
    sleepIntervalMs: POWER_SLEEP_INTERVAL_MS,
    logger,
    onTick: (state) => jobRunner.dispatch(state),
    deepSleepHolder: () => jobRunner.providesHold(),
  });

  // Per-project power state. Pre-Grove, each project ran in its own
  // daemon with its own PowerManager. With one global daemon hosting
  // many projects, each project still needs its own active/idle/sleep/
  // deep_sleep machine — the user expects symbionts on project B to
  // keep running while they view project A. The global PowerManager
  // above still drives Grove-level housekeeping (embedding-reconcile,
  // backup, …); per-project state is consulted by scheduled-task
  // dispatch.
  const projectStateTracker = new ProjectPowerStateTracker({
    idleThresholdMs: POWER_IDLE_THRESHOLD_MS,
    sleepThresholdMs: POWER_SLEEP_THRESHOLD_MS,
    deepSleepThresholdMs: POWER_DEEP_SLEEP_THRESHOLD_MS,
  });

  // Tracks fire-and-forget Cortex runs so daemon shutdown can await them
  // before exiting. Without this, SIGTERM orphans in-flight runs — leaving
  // non-terminal agent_runs rows and costing real money on reasoning-heavy
  // providers.
  const inflightRuns = new InflightRunRegistry();

  // Team Host: resolve this machine's opt-in to serving its Grove(s) over the
  // overlay (Task 2.3). Read from the machine tier directly — host-serve is a
  // per-machine daemon mechanic, never project/grove-overridable. Returns null
  // (host serving off) when disabled or misconfigured, always with a clear log.
  const hostServe = resolveHostServeConfig({
    machineConfig: loadMachineConfig(mycoHome),
    mycoHome,
    logger,
  });

  // External read-only MCP (Task 10, server-mode design spec §7): one
  // dedicated listener instance for the daemon's lifetime. Constructed
  // unconditionally (like the overlay listener, its BIND is what's
  // conditional) so `PUT /api/team/external-mcp/toggle` always has a live
  // instance to bind/unbind. `resolveDatabase` mirrors the loopback `/mcp`
  // handler's wiring below so both surfaces reuse the SAME cached DB
  // handles rather than opening a private one per external call.
  externalMcpListener = new ExternalMcpListener({
    vaultDir: bootstrapVaultDir,
    hostServe,
    resolveDatabase: (databasePath) => databasePath === dataPaths.databasePath
      ? db
      : runtimeCache.getDatabase(databasePath),
    logger,
    mycoHome,
    onRequest: (requestClass) => {
      if (requestClass === 'interaction') powerManager.wake();
    },
  });

  // Boot RE-BIND (spec R-B3b, second phase of the reconcile): the contain
  // phase above DECIDED activation is intended; the bind happens here — the
  // first point a listener exists — still inside the containment lock the
  // continuation holds, so socket reclaim stays serialized against every
  // other authority. Failure is loud-but-alive: the daemon boots, status
  // surfaces report unbound, and `myco doctor` flags the incoherence — a
  // crash-loop would be strictly worse than a host that serves everything
  // except the public MCP surface.
  if (externalMcpBootState.enabled) {
    const externalMcpSocketPath = resolveExternalMcpSocketPath(mycoHome);
    const rebind = await externalMcpListener.bind({ kind: 'socket', path: externalMcpSocketPath });
    if (!rebind.ok) {
      logger.warn(LOG_KINDS.EXTERNAL_MCP, 'External MCP re-bind failed at boot — enabled but not serving', {
        socket: externalMcpSocketPath,
        error: rebind.error,
      });
    } else {
      const funnelRepair = await defaultFunnelOnRunner(
        { kind: 'socket', path: externalMcpSocketPath },
        { mount: EXTERNAL_MCP_PATH, publicPort: EXTERNAL_MCP_FUNNEL_PORT },
      );
      if (!funnelRepair.ok) {
        logger.warn(LOG_KINDS.EXTERNAL_MCP, 'External MCP Funnel verify/repair failed at boot', {
          detail: funnelRepair.detail,
        });
      }
    }
  }

  // Team Host: the MEMBER-side transcript-content drain (capture-push C1). Ships
  // an attached session's transcript byte-deltas over the overlay to the host
  // materializer (C2), offset-authoritative + multi-host. Its `proxyDeps()` are
  // threaded into BOTH dispatch chokepoints (this server + the /mcp handler) so
  // pending bytes flush before a terminal mining-trigger route, and its
  // `pendingCount` inhibits deep sleep while a drain is outstanding.
  const transcriptDrain = createTranscriptDrainQueue({ machineId, logger });

  // Team Host: the MEMBER-side plan-content companion push (capture-push §5.5, C7).
  // A routed session's plan FILE is member-local and the proxy is byte-opaque, so
  // plan content rides its OWN channel (parallel to the transcript drain, whole-file):
  // on a plan-dir write the member reads its plan file and POSTs the content to the
  // host `POST /routed-capture/plan`. Its `proxyDeps()` fan into the SAME dispatch
  // chokepoints as the transcript drain (below) so plan content flushes before the
  // plan-triggering Stop backstop, and its `pendingCount` inhibits deep sleep while a
  // plan push is outstanding.
  const planDrain = createPlanDrainQueue({ machineId, logger, planWatchConfig });

  // Team Host: the MEMBER-side attach-aware live-event replay drain (capture-push
  // C5). When a host is unreachable the collect proxy buffers live capture events
  // to the DB-free collector buffer; this drain enumerates the attach registry and
  // re-forwards those buffered events over each host's proxy on reconnect. Its
  // `pendingCount` inhibits deep sleep while capture is un-shipped, mirroring the
  // transcript drain. Distinct from the LOCAL buffer reconciler, which enumerates
  // local Groves only and never sees an attached project's buffer.
  const eventReplayDrain = createEventReplayDrainQueue({ machineId, logger });

  // Both capture drains plug the SAME host-proxy seams (flush-before-terminal
  // route + collect-event enqueue + session-terminal prune); fan each seam out to
  // every drain queue so neither channel regresses another. The drain modules stay
  // independent — this is pure wiring composition, threaded into both dispatch
  // chokepoints below. The event-replay drain has no flush/enqueue seam of its own
  // (it is backstop-only — see its class doc) but DOES plug into the
  // session-terminal prune (consolidation Task C-2, item 6).
  const transcriptProxyDeps = transcriptDrain.proxyDeps();
  const planProxyDeps = planDrain.proxyDeps();
  const captureProxyDeps = {
    flushBeforeForward: async (target: RemoteTarget): Promise<void> => {
      await transcriptProxyDeps.flushBeforeForward(target);
      await planProxyDeps.flushBeforeForward(target);
    },
    noteCollectEvent: (target: RemoteTarget, event: Record<string, unknown>): void => {
      transcriptProxyDeps.noteCollectEvent(target, event);
      planProxyDeps.noteCollectEvent(target, event);
    },
    noteSessionEnded: async (target: RemoteTarget, sessionId: string): Promise<void> => {
      transcriptProxyDeps.noteSessionEnded(target, sessionId);
      planProxyDeps.noteSessionEnded(target, sessionId);
      // The event-replay drain has no flushBeforeForward of its own — its
      // noteSessionEnded performs its OWN catch-up drain before pruning (see
      // its class doc), so it is the one leg here worth awaiting.
      await eventReplayDrain.noteSessionEnded(target, sessionId);
    },
  };

  const server = new DaemonServer({
    vaultDir: bootstrapVaultDir,
    logger,
    daemonStateAuthority,
    // /health posture: `active` iff the explicit config says enabled — the
    // takeover handshake accepts any KNOWN posture (eviction.ts), and a
    // pre-activation binary meeting `active` refuses to step-aside politely,
    // terminates, then disavows at its own boot (documented downgrade path).
    externalMcpPosture: () => (
      loadMachineConfig(mycoHome).daemon.external_mcp.enabled
        ? EXTERNAL_MCP_ACTIVE_POSTURE
        : EXTERNAL_MCP_ACTIVATION_POSTURE
    ),
    uiDir: uiDir ?? undefined,
    uiDevProxyTarget: uiDevProxyTarget ?? undefined,
    runtimeCache,
    hostServe,
    hostProxyDeps: captureProxyDeps,
    // The daemon's single wake edge. This was deliberately left unwired, on
    // the reasoning that recording activity for every HTTP request would let
    // UI polling hold the PowerManager out of 'idle' and starve the idle-only
    // scheduled tasks. That diagnosis was correct; the conclusion — record
    // activity on prompts instead — is what let the daemon deep-sleep through
    // hours of agent tool calls, because a prompt is the rarest signal in the
    // system.
    //
    // Both halves are addressed now. Clients declare whether a request means
    // someone is actually doing something (`RequestClass`), so idle polling
    // and liveness probes no longer count. And waking only advances the
    // activity clock: natural decay still carries the daemon through 'idle'
    // and 'sleep' during lulls, so the idle-only tasks keep their windows.
    // What the liveness assertion prevents is the full stop of deep sleep,
    // nothing shallower.
    onRequest: (requestClass) => {
      if (requestClass === 'interaction') powerManager.wake();
    },
    // Per-project liveness. Same class gate as the global edge, applied once
    // the request's owning Grove and project are known.
    onRequestContext: (requestContext, requestClass) => {
      if (requestClass !== 'interaction') return;
      const { groveId, projectId } = requestContext;
      if (!groveId || !projectId || !isGroveEraId(projectId, 'project')) return;
      projectStateTracker.recordActivity(groveId, assertGroveProjectId(projectId));
    },
  });

  // The daemon serves the dashboard UI and must stay running regardless of
  // active sessions. No auto-shutdown — runs until explicitly killed.
  const registry = new SessionRegistry({
    gracePeriod: 0,
    onEmpty: () => {},
  });

  const transcriptMiner = new TranscriptMiner({
    additionalAdapters: config.capture.transcript_paths.map((p) =>
      createPerProjectAdapter(p, claudeCodeAdapter.parseTurns),
    ),
    logger,
    // Manifest plan tags — the miner strips plan envelopes from every
    // response it persists (plan extraction reads raw turns, so Plan
    // records survive intact).
    planTags: symbiontPlanTags,
    // Mining-path image capture: the same shared routine the Stop and
    // plugin paths use; tenancy comes from the matched batch's project_id.
    captureImages: (input) => captureBatchImages({ ...input, logger }),
  });

  const sessionBuffers = new Map<string, EventBuffer>();

  // One duplicate cache shared between the live /events dispatcher and the
  // buffer reconciler: live duplicates are suppressed AND replayed events
  // reject their own late live copies.
  const eventDedupCache = new EventDedupCache();

  const reconciler = createReconciler({
    // Every registered project's buffer dir under the global Grove tree,
    // re-resolved per pass so a project registered after boot is visible
    // without a restart. No legacy bootstrap path — there is exactly one
    // canonical home for a project's buffer, and the reconciler scans
    // those and only those.
    bufferDirs: () => listAllProjectBufferDirs(),
    logger,
    projectRoot,
    onSessionReconciled: (sessionId) => reEnrichSessionFromTranscript(sessionId, { transcriptMiner, logger, planTags: symbiontPlanTags }),
    eventDedupCache,
    registry,
    machineId,
    // Per-dir Grove DB binding through the shared runtime cache — the same
    // handles the HTTP layer serves requests with. Without this, boot-time
    // reconciliation (no ambient request scope) reads/writes the
    // bootstrap/anchor vault: Grove tombstones invisible, resurrections
    // landing in the anchor. existsSync guards against materializing an
    // empty DB for a registered-but-unprovisioned Grove.
    resolveGroveDb: (groveId) => {
      const groveDbPath = resolveGroveDbPath(groveId);
      return fs.existsSync(groveDbPath) ? runtimeCache.getDatabase(groveDbPath) : null;
    },
    // The completion chokepoint's mining seam: a resurrected-stale close
    // mines the stamped transcript before the status flip, upholding the
    // "completed implies mined" invariant the routed-transcript cache GC
    // relies on (daemon/session-completion.ts).
    transcriptMiner,
  });
  reconciler.runStartupReconciliation();

  // Runtime migration tasks (vector reindex, file rewrites, etc.) — idempotent,
  // gated by the migration_tasks ledger in the DB so each task runs once per
  // vault regardless of how many times the daemon starts.
  await runPendingMigrationTasks({ db: getDatabase(), embeddingManager, logger });

  // First-start auto-bootstrap. Runs when this home lacks a default Grove
  // — the durable "has this home bootstrapped" signal. Each MYCO_HOME has
  // its own `groves/` tree. PowerManager tick handles re-detection thereafter.
  try {
    const decision = shouldRunGlobalBootstrap(resolveMycoHome());
    if (decision.shouldRun) {
      logger.info(LOG_KINDS.DAEMON_START, 'First-start global bootstrap required', {
        myco_home: decision.mycoHome,
        default_grove_absent: decision.defaultGroveAbsent,
      });
      const result = runGlobalBootstrap();
      const installed = result.symbionts.filter((r) => r.status === 'installed');
      const notDetected = result.symbionts.filter((r) => r.status === 'not-detected');
      const errored = result.symbionts.filter((r) => r.status === 'error');
      logger.info(LOG_KINDS.DAEMON_START, 'First-start global bootstrap complete', {
        launchers_removed: result.launchers.removed.length,
        symbionts_installed: installed.length,
        symbionts_not_detected: notDetected.length,
        symbionts_errored: errored.length,
        installed_names: installed.map((r) => r.symbiont),
        projects_cleaned: result.migration.projectsCleaned,
        projects_errored: result.migration.projectsErrored,
      });
      // Persist the migration pass to the bounded audit log so doctor
      // can surface any per-project errors. Same code path the
      // PowerManager tick uses.
      try {
        const { recordMigrationPass } = await import('../db/queries/migration-log.js');
        recordMigrationPass(getDatabase(), result.migration);
      } catch (err) {
        logger.warn(LOG_KINDS.DAEMON_START, 'Migration audit log write failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error(LOG_KINDS.DAEMON_START, 'First-start global bootstrap failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // --- Stop processor (created early so triggerTitleSummary is available to /events route) ---
  const stopProcessor = createStopProcessor({
    registry,
    sessionBuffers,
    transcriptMiner,
    embeddingManager,
    resolveEmbeddingManager: (rc) => getEmbeddingRuntime(rc).manager,
    logger,
    liveConfig,
    vaultDir: bootstrapVaultDir,
    projectId: rowProjectIdFromRequestContext(dataPaths.requestContext),
    machineId,
    planTags: symbiontPlanTags,
    planWatchConfig,
    // Post-Stop convergence trigger: re-converge THIS session's buffer at
    // the turn boundary when its converged mark is stale (identity-aware
    // skip inside reconcileSession makes the matching case a no-op).
    // Recovers wedge-buffered events that arrived mid-turn without
    // waiting for a restart or the 15-minute drain cadence.
    onStopProcessed: (sessionId) => reconciler.reconcileSession(sessionId),
  });

  // --- Session routes ---
  // The deps object is mutated after registerPowerJobs so the canopy delta
  // runner becomes visible to SessionStart triggers.
  const sessionLifecycleDeps = {
    registry, sessionBuffers, reconciler, stopProcessor, transcriptMiner,
    server, machineId, logger, liveConfig, vaultDir: bootstrapVaultDir,
    projectStateTracker,
  };
  const sessionLifecycle = createSessionLifecycleHandlers(sessionLifecycleDeps);
  server.registerRoute('POST', '/sessions/register', sessionLifecycle.handleRegister);
  server.registerRoute('POST', '/sessions/unregister', sessionLifecycle.handleUnregister);

  // --- Event routes ---

  // Live mid-turn capture: re-mine the transcript on tool events (throttled)
  // so queued prompts + in-flight responses surface during a long turn instead
  // of only at Stop. Shares the same transcriptMiner the Stop path uses.
  const liveReconcile = createLiveReconcile({
    reconcile: (sessionId, input) => transcriptMiner.reconcileAndAttributeResponses(sessionId, input),
    logger,
  });

  const eventDispatcher = createEventDispatcher({
    registry,
    sessionBuffers,
    logger,
    machineId,
    liveConfig,
    vaultDir: bootstrapVaultDir,
    reconcileSession: reconciler.reconcileSession,
    // Handler-failure recovery: the dispatcher answers `persisted:false,
    // buffered:true` and clears the converged mark so the daemon-appended
    // buffer copy replays at the next quiescent boundary (post-Stop
    // trigger / drain pass / boot) instead of relying on hook re-buffering.
    clearConvergedMark: reconciler.clearSession,
    liveReconcile,
    planWatchConfig,
    triggerTitleSummary: stopProcessor.triggerTitleSummary,
    projectStateTracker,
    eventDedupCache,
  });
  server.registerRoute('POST', '/events', eventDispatcher);

  // --- Transcript-prompt sync (Antigravity-class symbionts) ---
  //
  // Hooks for symbionts whose payload does not carry the user prompt POST
  // the full transcript-derived prompt list here; the server inserts only
  // prompts beyond the count already captured for the session. Count-based
  // diff makes the call idempotent across repeated PreInvocation fires.
  server.registerRoute('POST', '/events/sync-transcript-prompts', async (req) => {
    const body = req.body as { session_id?: unknown; prompts?: unknown };
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    const prompts = Array.isArray(body.prompts)
      ? body.prompts.filter((p): p is string => typeof p === 'string')
      : [];
    if (!sessionId) {
      return { status: 400, body: { error: 'session_id required' } };
    }
    const result = syncTranscriptPromptBatches(sessionId, prompts);
    return { body: result };
  });

  // --- Stop route ---

  server.registerRoute('POST', '/events/stop', stopProcessor.handleStopRoute);

  // --- Routed transcript ingest (Team Host receive side; capture-push §5.2) ---
  //
  // A routed session's transcript lives on the MEMBER's disk but the miner runs
  // on the HOST. The member drains the transcript's append-only bytes here; the
  // host materializes them to a host-local file the miner reconciles unchanged.
  // Stamped `collect` in host/routing.ts, so it rides the overlay bearer/version
  // gate and is served locally on the host (never re-proxied).
  server.registerRoute('POST', '/routed-capture/transcript', createRoutedTranscriptHandler());
  // Team Host — routed plan-content companion push (capture-push §5.5, C7). A
  // routed session's plan FILE is member-local and the proxy is byte-opaque, so the
  // member reads the file and POSTs its content here; the host runs the SAME
  // capturePlan against its Grove DB (bound by the request's tenancy headers).
  // Stamped `collect` in host/routing.ts, so it rides the overlay bearer/version
  // gate and is served locally on the host (never re-proxied).
  server.registerRoute('POST', '/routed-capture/plan', createRoutedPlanHandler({ logger }));
  // Team Host — routed residency-rows ingest (Phase F T2). A with-history attach
  // drains a project's rows here, one allow-listed table per request; the host
  // applies them to its served Grove DB under the per-table residency apply rules.
  // Stamped `collect` in host/routing.ts (as ROUTED_RESIDENCY_ROWS_PATH), so it
  // rides the overlay bearer/version gate and is served locally on the host. The
  // path is written as a literal here (the route-stamp completeness scanner only
  // parses literal registerRoute paths); it MUST equal ROUTED_RESIDENCY_ROWS_PATH,
  // pinned by tests/host/routed-residency.test.ts.
  server.registerRoute('POST', '/routed-capture/residency-rows', createRoutedResidencyHandler({ logger }));
  // Team Host — hybrid detach (replaces the page-pull): the member fetches one
  // digest-verified project artifact, restores it locally, then sends the
  // goodbye that runs the host-side effects. Literals must equal
  // ROUTED_DETACH_ARTIFACT_PATH / ROUTED_DETACH_COMPLETE_PATH (pinned by tests).
  // The retired page-pull path answers 410 with guidance instead of a bare
  // router 404: an OLD member mid-detach stalls here with an actionable
  // message (cancel the move, update, detach again) rather than a mystery.
  server.registerRoute('POST', '/routed-capture/residency-pull', async () => ({
    status: 410,
    body: {
      ok: false,
      error: 'residency_pull_retired',
      message: 'This host no longer serves the page-pull detach. Cancel the move on your machine, update Myco, then disconnect again.',
    },
  }));
  server.registerRoute('POST', '/routed-capture/residency-detach-artifact', createRoutedDetachArtifactHandler({ logger }));
  server.registerRoute('POST', '/routed-capture/residency-detach-complete', createRoutedDetachCompleteHandler({ logger }));

  // --- Context injection (cortex brief + semantic spore search) ---
  const contextDeps = {
    vaultDir: bootstrapVaultDir,
    // Per-request grove resolution — never the bootstrap manager (anchor-leak
    // Variant A). Mirrors how /api/search and /api/embedding resolve runtime.
    resolveEmbeddingManager: (rc: MycoRequestContext | undefined) => getEmbeddingRuntime(rc).manager,
    liveConfig,
    logger,
  };
  server.registerRoute('POST', '/context', createSessionContextHandler(contextDeps));
  server.registerRoute('POST', '/context/resume', createResumeContextHandler(contextDeps));
  server.registerRoute('POST', '/context/prompt', createPromptContextHandler(contextDeps));
  server.registerRoute('POST', '/context/subagent', createSubagentContextHandler(contextDeps));

  // --- Canopy injection (PreToolUse/Read hook-bridge endpoint) ---
  server.registerRoute('POST', '/canopy/inject', createCanopyInjectHandler({
    liveConfig,
    getDatabase,
  }));

  // --- Dashboard API routes ---
  const progressTracker = new ProgressTracker();
  let configHash = computeConfigHash(bootstrapVaultDir);
  const cortexHandlers = createCortexHandlers({
    liveConfig,
    resolveEmbeddingManager: (rc) => getEmbeddingRuntime(rc).manager,
    logger,
    registerInflightRun: (p) => inflightRuns.register(p),
  });

  server.registerRoute('GET', '/api/symbionts', async (req) => handleListSymbionts(
    req.requestContext?.projectVaultDir ?? bootstrapVaultDir,
    req.requestContext?.groveId ?? dataPaths.requestContext.groveId,
  ));
  server.registerRoute('POST', '/api/symbionts/detect', async (req) => handleDetectSymbionts(
    req.requestContext?.projectVaultDir ?? bootstrapVaultDir,
    req.requestContext?.groveId ?? dataPaths.requestContext.groveId,
  ));
  server.registerRoute('POST', '/api/symbionts/drain-migration', async () => handleDrainMigration());
  const cortexTenant = { machineId, logger };
  server.registerRoute('GET', '/api/cortex/instructions', tenantRoute(cortexTenant, cortexHandlers.handleGetInstructions));
  server.registerRoute('POST', '/api/cortex/instructions/refresh', tenantRoute(cortexTenant, cortexHandlers.handleRefreshInstructions));
  server.registerRoute('POST', '/api/cortex/prompt-builder', tenantRoute(cortexTenant, cortexHandlers.handleBuildPrompt));
  server.registerRoute('GET', '/api/cortex/prompt-builder/:runId', tenantRoute(cortexTenant, cortexHandlers.handleGetPromptResult));
  registerContentClaimRoutes(server, cortexTenant);
  registerContentClaimMaterializeRoute(server, {
    cache: runtimeCache,
    dial: defaultDial,
    logger: proxyLoggerFrom(logger, LOG_KINDS.CONTENT_CLAIM_MATERIALIZE),
    machineId,
    mycoHome,
  });
  registerContentClaimFileStatusRoute(server, {
    logger: proxyLoggerFrom(logger, LOG_KINDS.CONTENT_CLAIM_FILE_STATUS),
    mycoHome,
  });
  // Team Host member drain health (consolidation Task C-5): the SAME three
  // queue instances the backstop jobs below drive, exposing their `health()`
  // derived-counters summary for the member's own dashboard. No new state —
  // reads the drains' already-persisted queue stores.
  registerDrainHealthRoute(server, { transcriptDrain, planDrain, eventReplayDrain });

  // Residency transition (Phase F) daemon capabilities, shared by the attach
  // API handler (which starts a with-history transition) and the drain job
  // (which ships it and, on full ack, purges locally). `withGroveDb` pins +
  // scopes a Grove connection so the transition/backfill helpers' `getDatabase()`
  // resolves to it.
  const residencyDeps: ResidencyDaemonDeps = {
    machineId,
    mycoHome,
    logger,
    withGroveDb: <T,>(groveId: string, fn: (db: Database) => T): T => {
      const dbPath = resolveGroveDbPath(groveId, mycoHome);
      return runtimeCache.withPinned(dbPath, () =>
        withDatabase(runtimeCache.getDatabase(dbPath), () => fn(runtimeCache.getDatabase(dbPath))),
      );
    },
  };
  // One serialized runner drives BOTH the immediate kick (on begin/abort) and the
  // periodic job, so a user-initiated transition starts in milliseconds instead
  // of waiting out the housekeeping round-robin — with no overlapping passes.
  const residencyKicker = createResidencyKicker(() => runResidencyTransitions({
    ...residencyDeps,
    // Daemon-scope on purpose: a mid-transition project is registered in no
    // Grove, so a project-scoped row could not be written for exactly the
    // project that needs it.
    notifyStalledTransition: (journal, stalledForMs) => {
      const minutes = Math.max(1, Math.round(stalledForMs / 60_000));
      const direction = journal.direction === 'attach'
        ? 'moving to the team host'
        : 'returning to this machine';
      // Past the detach flip there is no cancel control (abort refuses, and
      // the Team page hides it), so the closing sentence must not point at
      // one. The raw last_error stays in metadata — the visible copy keeps
      // mechanism strings out of banners; the Team page shows the detail on
      // hover, matching the rest of the residency surfaces.
      const pastFlip = journal.direction === 'detach'
        && (journal.phase === 'applying' || journal.phase === 'rehoming');
      const action = pastFlip
        ? 'It finishes on its own once the underlying issue clears — nothing is lost in the meantime.'
        : 'You can cancel the move from the Team page.';
      // Daemon-scope dedup (5-minute window) collapses two projects stalling
      // in the same window into one banner — accepted: simultaneous stalls
      // are rare, the Team page shows per-project stall state, and the 6-hour
      // re-surface names each survivor.
      notify(bootstrapVaultDir, {
        domain: 'team',
        type: 'team.residency.stalled',
        title: 'Project move stalled',
        message: `"${journal.project_name}" has been ${direction} for ${minutes} minutes and is still retrying.`
          + ' New work on this project waits until the move finishes. '
          + action,
        metadata: {
          project_id: journal.project_id,
          host_id: journal.host_id,
          phase: journal.phase,
          direction: journal.direction,
          stalled_for_minutes: minutes,
          last_error: journal.last_error ?? null,
        },
      }, liveConfig.current, { scope: 'daemon' });
    },
  }));
  residencyDeps.kickResidencyDrain = residencyKicker.kick;

  // Team Host MEMBERSHIP lifecycle (consolidation Task D-2): join/leave/
  // attach/detach as daemon API, the Team page's primary write surface (the
  // CLI wrappers become a thin fallback over this same route set).
  registerHostMembershipRoutes(server, {
    mycoHome,
    logger,
    beginResidency: (ctx) => beginAttachResidency(ctx, residencyDeps),
    beginDetachResidency: (ctx) => beginDetachResidency(ctx, residencyDeps),
    residencyStatus: (projectId) => residencyStatus(projectId, residencyDeps),
    residencyAbort: (projectId) => abortResidency(projectId, residencyDeps),
  });

  // Pre-compute symbiont plan dirs for the config endpoint (manifests don't change at runtime)
  const symbiontPlanDirsByAgent: Record<string, string[]> = {};
  for (const m of manifests) {
    const dirs = m.capture?.planDirs ?? [];
    if (dirs.length > 0) symbiontPlanDirsByAgent[m.displayName] = dirs;
  }

  // --- Config-change reaction registry ---
  // Reactions register once at daemon startup. `fire(touchedPaths, ctx)` runs
  // every matching reaction after a successful scoped-config write, passing
  // the freshly merged config so reactions don't reload it themselves. See
  // packages/myco/src/daemon/config-reactions/registry.ts for the contract.
  const reactions = createConfigReactionRegistry(logger);

  // Refresh the live-stats configHash on every write.
  reactions.on([], () => { configHash = computeConfigHash(bootstrapVaultDir); });

  // Keep liveConfig pointed at the latest merged config so runtime gates
  // (agent.scheduled_tasks_enabled, agent.event_tasks_enabled) pick up
  // toggle flips immediately.
  reactions.on([], (ctx) => { liveConfig.current = ctx; });

  // Managed project files (AGENTS.md guidance + `.gitignore` Myco block) are no
  // longer reconciled at write time. A write only knows the one project it
  // touched, but machine-scoped `capture.*` settings affect every project's
  // managed files — so reconciliation is a periodic all-projects PowerManager
  // sweep (POWER_JOB_NAMES.MANAGED_FILES_RECONCILE) instead.

  // Refresh the in-memory plan-watch list on capture changes.
  reactions.on(['capture'], createPlanWatchReaction({
    symbiontPlanDirs,
    planWatchConfig,
  }));

  // Live-reconfigure the logger on daemon.log_level change.
  reactions.on(['daemon.log_level'], (ctx) => {
    logger.setLevel(ctx.daemon.log_level);
    if (ctx.daemon.log_level === 'debug') {
      process.env.MYCO_AGENT_DEBUG = '1';
    } else {
      delete process.env.MYCO_AGENT_DEBUG;
    }
  });

  let scheduledTaskKicker: {
    kick: (taskName: string, target?: { groveId: string; projectId: GroveProjectId }) => void;
  } = {
    kick: () => {},
  };

  async function syncScheduledTasks() {
    scheduledTaskKicker = await registerScheduledTasks(jobRunner, {
      definitionsDir,
      vaultDir: bootstrapVaultDir,
      // Per-run grove resolution — the agent's vector/canopy search tools must
      // hit the run's grove store, never the bootstrap anchor (anchor-leak A).
      resolveEmbeddingManager: (rc) => getEmbeddingRuntime(rc).manager,
      logger,
      cache: runtimeCache,
      mycoHome,
      daemonStateDir: daemonService.stateDir,
      machineId,
      projectStateTracker,
    });
  }

  reactions.on(['agent.tasks'], async () => {
    await syncScheduledTasks();
  });

  // Tier config files that exist but can't be honored (corrupt YAML, value
  // violations, unreadable personal overlay) silently revert their tier to
  // defaults — surface each one as a settings notification. The loader
  // dedupes per file+reason and notify()'s 5-minute window absorbs repeats.
  setTierParseFailureListener((filePath, reason) => {
    notify(bootstrapVaultDir, {
      domain: 'settings',
      type: 'settings.config_unreadable',
      title: 'Config file could not be honored',
      message: `${filePath}: ${reason}`,
      metadata: { filePath, reason },
    }, liveConfig.current, { scope: 'daemon' });
  });

  async function applyConfigWriteReactions(
    touchedPaths: string[],
    scope: { vaultDir: string; groveId: string | null },
  ) {
    const reactionContext = loadReactionContext(scope.vaultDir, logger, {
      groveId: scope.groveId,
    });
    if (!reactionContext) {
      configHash = computeConfigHash(scope.vaultDir);
      return null;
    }
    await reactions.fire(touchedPaths, reactionContext, {
      vaultDir: scope.vaultDir,
      groveId: scope.groveId,
    });
    return reactionContext;
  }

  registerConfigRoutes(server, {
    bootstrapVaultDir,
    bootGroveId: dataPaths.requestContext.groveId ?? null,
    onScopedWrite: async ({ body, vaultDir, groveId }) => {
      const touchedPaths = computeTouchedPaths(body.patch, body.clear);
      const reactionContext = await applyConfigWriteReactions(touchedPaths, {
        vaultDir,
        groveId,
      });
      if (reactionContext) {
        const summary = buildScopedConfigSaveNotification(body.scope, touchedPaths);
        notify(vaultDir, {
          domain: 'settings',
          type: 'settings.saved',
          title: summary.title,
          message: summary.message,
          link: summary.link ?? undefined,
          metadata: summary.metadata,
        }, reactionContext);
      } else {
        configHash = computeConfigHash(vaultDir);
      }
    },
  });

  // Grove-tier config (~/.myco/groves/<id>/grove.yaml) — separate tier
  // from project/local. The handler reads groveId from the request
  // context (x-myco-grove-id header).
  server.registerRoute('GET', '/api/grove-config', async (req) =>
    handleGetGroveConfig(req.requestContext?.groveId ?? null));

  server.registerRoute('PUT', '/api/grove-config', async (req) => {
    const { response, touchedPaths } = await handlePutGroveConfig(
      req.requestContext?.groveId ?? null,
      req.body,
    );
    if ((!response.status || response.status < 400) && touchedPaths.length > 0) {
      await applyConfigWriteReactions(touchedPaths, {
        vaultDir: req.requestContext?.projectVaultDir ?? bootstrapVaultDir,
        groveId: req.requestContext?.groveId ?? dataPaths.requestContext.groveId,
      });
    }
    return response;
  });

  // `team-write` route class (Task 8): the served grove's team config/secrets,
  // reached by a member through their own daemon's proxy. Only ever answers
  // for real on the one machine designated as this Grove's Team Host —
  // elsewhere `hostServe` is null and every handler refuses `not_serving`.
  const teamWriteDeps = {
    hostServe,
    mycoHome,
    onConfigWrite: async (touchedPaths: string[], groveId: string) => {
      await applyConfigWriteReactions(touchedPaths, { vaultDir: bootstrapVaultDir, groveId });
    },
    externalMcp: {
      listener: externalMcpListener,
      containment: externalMcpContainment,
    },
  };
  registerTeamConfigRoutes(server, teamWriteDeps);
  // Per-task table (spec §6.3) — the team-write counterpart to the
  // config-lock-stamped `/api/agent/tasks/:id/config` registered below.
  registerTeamAgentTaskRoutes(server, teamWriteDeps);
  // Team Host operator-side serving status (Task T4, decision-ef693c71 D3):
  // `localhost-only`, unlike the team-write routes above — reuses the SAME
  // boot-resolved `hostServe` runtime + external MCP listener, never
  // re-parsed per request.
  // Team Host administration (E1 §4): enable/disable as progress-tracked
  // in-daemon jobs + explicit join-key minting. The restart a job requests
  // is DEFERRED through the detached-child pattern and scheduled only after
  // the tracker's terminal state is written (the tracker dies with us).
  {
    const { registerHostAdminRoutes } = await import('./api/host-admin.js');
    const { scheduleDetachedSelfRestart, resolveRestartServiceLabel } = await import('./api/restart.js');
    const { getServiceManager: getMgr } = await import('../service/manager.js');
    registerHostAdminRoutes(server, {
      tracker: progressTracker,
      mycoHome,
      startedAt: () => server.startedAtIso(),
      scheduleRestart: ({ token }) => {
        // The same guard POST /api/restart enforces (diff review C2): the
        // host-admin job itself is already terminal by contract, so any
        // active operation here is a DIFFERENT job (backup, agent run,
        // upgrade) that a restart would SIGTERM mid-flight. Defer, say so
        // in the step log, and let the operator restart when it settles.
        if (progressTracker.hasActiveOperations()) {
          progressTracker.appendStep(token,
            'Daemon restart DEFERRED: other operations are in progress. Restart when they finish (`myco restart`) — host-serve config is written and a restart applies it.');
          return;
        }
        void resolveRestartServiceLabel(getMgr(), mycoHome)
          .then((label) => scheduleDetachedSelfRestart({ serviceManagedLabel: label, vaultDir: bootstrapVaultDir }))
          .catch((err: unknown) => {
            logger.warn(LOG_KINDS.HOST_SERVE, 'host-admin restart scheduling failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      },
    });
  }

  registerHostServeStatusRoute(server, {
    hostServe,
    mycoHome,
    externalMcp: { listener: externalMcpListener },
    // Live feeds (E1 §4.1 rev 6): the observed listener bind (gate 4 — the
    // config-derived `serving` flag survives every bind failure) and the
    // process start stamp (the enable job's restart discriminator).
    overlayListenerBound: () => server.isOverlayListenerBound(),
    startedAt: () => server.startedAtIso(),
  });

  // Machine-tier config (~/.myco/config.yaml) — port, log policy, update
  // channel. One daemon per machine, so the route is global (no scope
  // header required). Reactions fire so liveConfig and dependent runtime
  // surfaces (logger level, configHash) refresh on write.
  server.registerRoute('GET', '/api/machine-config', async () =>
    handleGetMachineConfig());

  server.registerRoute('PUT', '/api/machine-config', async (req) => {
    const { response, touchedPaths } = await handlePutMachineConfig(req.body);
    if ((!response.status || response.status < 400) && touchedPaths.length > 0) {
      await applyConfigWriteReactions(touchedPaths, {
        vaultDir: req.requestContext?.projectVaultDir ?? bootstrapVaultDir,
        groveId: req.requestContext?.groveId ?? dataPaths.requestContext.groveId,
      });
    }
    return response;
  });

  const planDirHandlers = createPlanDirHandlers({
    symbiontPlanDirsByAgent,
  });
  server.registerRoute('GET', '/api/config/plan-dirs', planDirHandlers.handleGetPlanDirs);

  // V2 stats — vault counts, embedding coverage, agent status, digest freshness
  const configHashRef = { get: () => configHash };
  server.registerRoute('GET', '/api/stats', createLiveStatsHandler({
    vaultDir: bootstrapVaultDir,
    registry,
    server,
    configHash: configHashRef,
  }));
  const groveScope = servedGroveScopeForDaemon();
  const groveDaemonStateDir = daemonService.stateDir;
  server.registerRoute('GET', '/api/groves', createListGrovesHandler(groveScope, groveDaemonStateDir, logger));
  server.registerRoute('GET', '/api/groves/:id/projects', createListGroveProjectsHandler(groveScope, groveDaemonStateDir, logger));
  server.registerRoute('POST', '/api/groves', createCreateGroveHandler(groveDaemonStateDir));
  server.registerRoute('PATCH', '/api/groves/:id', createRenameGroveHandler(groveDaemonStateDir));
  server.registerRoute('DELETE', '/api/groves/:id', createDeleteGroveHandler(groveDaemonStateDir));
  server.registerRoute('POST', '/api/groves/:id/projects/:projectId', createMoveProjectHandler(groveDaemonStateDir));
  server.registerRoute('POST', '/api/groves/:id/projects/:projectId/archive', createArchiveProjectHandler(groveDaemonStateDir));
  server.registerRoute('POST', '/api/groves/:id/projects/:projectId/unarchive', createUnarchiveProjectHandler(groveDaemonStateDir));
  server.registerRoute('DELETE', '/api/groves/:id/projects/:projectId', createDeleteProjectHandler(groveDaemonStateDir));
  server.registerRoute('POST', '/api/groves/:id/default', createSetDefaultGroveHandler(groveDaemonStateDir));
  server.registerRoute('PATCH', '/api/projects/:projectId/symbionts', createProjectSymbiontsPatchHandler(groveDaemonStateDir));
  server.registerRoute('PUT', '/api/projects/:projectId/symbionts-customization', createProjectSymbiontsCustomizationHandler(groveDaemonStateDir));

  server.registerRoute('GET', '/api/logs', handleLogStream);
  server.registerRoute('GET', '/api/logs/search', handleLogSearch);
  server.registerRoute('GET', '/api/logs/stream', handleLogStream);
  server.registerRoute('GET', '/api/logs/:id', handleLogDetail);

  // External log ingestion: allows MCP server (separate process) to write through the daemon logger
  server.registerRoute('POST', '/api/log', createLogIngestionHandler(logger));

  server.registerRoute('GET', '/api/models', async (req) => handleGetModels(req, logger));
  server.registerRoute('GET', '/api/git/status', handleGetGitStatus);
  // Power inventory: current state, what is holding it there, and the last
  // transition. Answers "why didn't my daemon sleep" and "why did it sleep
  // while I was working" without reading logs out of the anchor DB.
  server.registerRoute('GET', '/api/power', async () => {
    const report = powerManager.report();
    return {
      body: {
        state: report.state,
        idle_ms: report.idleMs,
        last_transition: report.lastTransition && {
          from: report.lastTransition.from,
          to: report.lastTransition.to,
          at: new Date(report.lastTransition.atMs).toISOString(),
          idle_ms: report.lastTransition.idleMs,
        },
        assertions: report.assertions.map((a) => ({
          source: a.source,
          name: a.name,
          max_depth: a.maxDepth,
          min_depth: a.minDepth ?? null,
          reason: a.reason ?? null,
          expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
        })),
      },
    };
  });
  server.registerRoute('POST', '/api/restart', async (req) => handleRestart({ vaultDir: bootstrapVaultDir, progressTracker }, req.body));

  // Intent surface: read + write the per-section intent files behind
  // `myco restart`. Surfacing these via HTTP lets MCP tool callers and
  // the UI drive daemon restart without shelling to the CLI. Reconciler
  // still owns convergence.
  //
  // Binary upgrade intents ([update]) were removed — use `api/upgrade`
  // and `myco upgrade [<version>]` instead.
  const intentHandlers = createIntentHandlers(daemonService);
  server.registerRoute('GET',    '/api/daemon/intent',         intentHandlers.status);
  server.registerRoute('POST',   '/api/daemon/intent/restart', intentHandlers.requestRestart);
  server.registerRoute('DELETE', '/api/daemon/intent/restart', intentHandlers.cancelRestart);

  // --- Upgrade routes ---
  const upgradeProjectRoot = resolveProjectRoot(bootstrapVaultDir);
  const upgradeHandlers = createUpgradeHandlers({
    vaultDir: bootstrapVaultDir,
    projectRoot: upgradeProjectRoot,
    currentVersion: server.version,
    daemonPort: server.port,
    globalPrefix,
    daemonStateDir: daemonService.stateDir,
    scheduleShutdown: scheduleShutdownWithAttribution('api/upgrade', logger),
    home: mycoHome,
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA,
  });

  server.registerRoute('GET', '/api/upgrade/status', async (req) => upgradeHandlers.handleUpgradeStatus(req));
  server.registerRoute('POST', '/api/upgrade/check', async (req) => upgradeHandlers.handleUpgradeCheck(req));
  server.registerRoute('POST', '/api/upgrade/apply', async (req) => upgradeHandlers.handleUpgradeApply(req));
  server.registerRoute('PUT', '/api/upgrade/channel', async (req) => upgradeHandlers.handleUpgradeChannel(req));

  server.registerRoute('GET', '/api/progress/:token', async (req) => handleGetProgress(progressTracker, req.params.token));

  server.registerRoute('GET', '/api/sessions', handleListSessions);

  server.registerRoute('GET', '/api/sessions/:id', createGetSessionHandler());
  const sessionMutations = createSessionMutationHandlers({ embeddingManager, resolveEmbeddingManager: (rc) => getEmbeddingRuntime(rc).manager, vaultDir: bootstrapVaultDir, logger, liveConfig, reconciler, registry, transcriptMiner });
  server.registerRoute('GET', '/api/sessions/:id/impact', sessionMutations.handleGetSessionImpact);
  server.registerRoute('POST', '/api/sessions/:id/complete', sessionMutations.handleCompleteSession);
  server.registerRoute('DELETE', '/api/sessions/:id', sessionMutations.handleDeleteSession);
  server.registerRoute('DELETE', '/api/plans/:id', sessionMutations.handleDeletePlan);
  server.registerRoute('PATCH', '/api/plans/:id', sessionMutations.handlePatchPlan);
  server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
  server.registerRoute('GET', '/api/batches/:id/activities', handleGetBatchActivities);
  server.registerRoute('GET', '/api/sessions/:id/attachments', handleGetSessionAttachments);
  server.registerRoute('GET', '/api/sessions/:id/plans', handleGetSessionPlans);
  const releaseProvenanceHandlers = createReleaseProvenanceHandlers({ liveConfig, logger });
  server.registerRoute(
    'GET',
    '/api/release-provenance/:namespace/:recordId',
    tenantRoute({ machineId, logger }, releaseProvenanceHandlers.handleGetReleaseProvenanceDetail),
  );

  // --- Canopy read-side API routes ---
  registerCanopyReadRoutes(server, {
    resolveProjectId: (req) => {
      const ctx = req.requestContext;
      if (!ctx) throw new Error('canopy read requires a resolved request context');
      return requireProjectId(ctx, 'canopy read');
    },
    resolveMachineId: (req) => req.requestContext?.machineId ?? getMachineId(),
    runCanopyMapTask: async ({ task, params }) => {
      // Mirror the dispatch shape used by /api/agent/run (see
      // createAgentRunHandlers.handleRun): build the instruction,
      // pre-generate the run id, and fire runAgent with it via
      // RunOptions.runId. This matches how the scheduler enqueues
      // canopy-map and keeps a single source of truth for instruction
      // assembly.
      //
      // Use the *detailed* builder so we keep the skip reason: the
      // /api/agent/run dispatcher path collapses skips to undefined and
      // short-circuits via isInstructionRequiredTask, but this regenerate
      // route has no such guard — running the agent without instruction
      // or runContext makes the render phase succeed (default YAML prompt
      // + fs_read) and then finalizeCanopyMap crashes because
      // runContext.canopy_map_inputs_hash is unset.
      const { buildCanopyMapInstructionDetailed } = await import('../agent/instruction-builders.js');
      const { dispatchAgentRun } = await import('../agent/runner-host.js');
      const { DEFAULT_AGENT_ID } = await import('../constants.js');

      const mycoConfig = liveConfig.current;
      const requestContext = dataPaths.requestContext;
      const projectId = rowProjectIdFromRequestContext(requestContext);
      if (projectId == null) {
        return { skipped: true, reason: 'canopy-map regenerate requires a project-scoped daemon context' };
      }
      const projectRoot = requestContext.projectRoot;
      // Whether this project's working tree is present on THIS machine —
      // false for a Team Host serving a member's registered project. Fed
      // into RunOptions.treeAvailable below (same signal + mechanism as
      // `task-scheduling.ts` / `agent-runs.ts`'s handleRun) so a
      // user-triggered regenerate for a served treeless project degrades
      // its tree-requiring phases instead of running them un-degraded.
      const treeAvailable = projectTreeAvailable(resolveProjectVaultDir(projectRoot));
      const built = await buildCanopyMapInstructionDetailed(params, projectRoot, mycoConfig);

      if (built.kind === 'skip') {
        return { skipped: true, reason: built.reason };
      }

      // Pre-generated and passed through RunOptions — reading the latest
      // row back after dispatch races the executor's insert (it happens
      // after awaits). Same pattern as handleRun.
      const runId = crypto.randomUUID();
      const resultPromise = dispatchAgentRun(bootstrapVaultDir, {
        task,
        instruction: built.instruction,
        runContext: built.context,
        taskParams: params,
        agentId: DEFAULT_AGENT_ID,
        runId,
        embeddingManager,
        requestContext,
        logger,
        treeAvailable,
      });

      // Fire-and-forget — caller already has the run id; we don't block
      // the HTTP response on the LLM round-trip. Errors are logged so
      // they don't vanish.
      resultPromise.catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'canopy-map regenerate threw', {
          error: errorMessage(err),
        });
      });

      return { run_id: runId };
    },
    runCanopyDescribeTask: async ({ task, params }) => {
      // Single-row canopy-describe dispatch — same shape as
      // runCanopyMapTask above. Map-phase source.args uses
      // params.canopy_entry_path to filter to that one entry.
      const { buildTaskInstruction } = await import('../agent/instruction-builders.js');
      const { dispatchAgentRun } = await import('../agent/runner-host.js');
      const { DEFAULT_AGENT_ID } = await import('../constants.js');

      const mycoConfig = liveConfig.current;
      const requestContext = dataPaths.requestContext;
      const projectId = rowProjectIdFromRequestContext(requestContext);
      if (projectId == null) {
        throw new Error('canopy-describe regenerate requires a project-scoped daemon context');
      }
      const projectRoot = requestContext.projectRoot;
      // See the identical comment in runCanopyMapTask above.
      const treeAvailable = projectTreeAvailable(resolveProjectVaultDir(projectRoot));
      const built = await buildTaskInstruction(
        task,
        params,
        DEFAULT_AGENT_ID,
        projectRoot,
        embeddingManager,
        mycoConfig,
        requestContext,
        treeAvailable,
      );

      // Pre-generated and passed through RunOptions — reading the latest
      // row back after dispatch races the executor's insert (it happens
      // after awaits). Same pattern as handleRun.
      const runId = crypto.randomUUID();
      const resultPromise = dispatchAgentRun(bootstrapVaultDir, {
        task,
        instruction: built?.instruction,
        runContext: built?.context,
        taskParams: params,
        agentId: DEFAULT_AGENT_ID,
        runId,
        embeddingManager,
        requestContext,
        logger,
        treeAvailable,
      });

      resultPromise.catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'canopy-describe redescribe threw', {
          error: errorMessage(err),
        });
      });

      return { run_id: runId };
    },
    // Drain bypass for /describe/retry-stuck. Captures the `scheduledTaskKicker`
    // let-binding by reference (reassigned in syncScheduledTasks before any
    // request lands), mirroring the onCanopyMassAdd kicker closure below.
    kickCanopyDescribe: (target) => scheduledTaskKicker.kick('canopy-describe', target),
  });

  // --- Skill lifecycle API routes ---
  //
  // Every skill-candidate/skill-record route is tenant-scoped: candidates and
  // records carry a project_id, and a read/mutate must only ever see the
  // REQUEST's own project. Wrap each in tenantRoute so a synthesized/anchor
  // context is rejected (400 + tenancy.violation) before the handler derives
  // its scope from the authorized principal — never the daemon's bootstrap
  // anchor.
  server.registerRoute('GET', '/api/skill-candidates', tenantRoute({ machineId, logger }, handleListCandidates));
  server.registerRoute('GET', '/api/skill-candidates/:id', tenantRoute({ machineId, logger }, handleGetCandidate));
  server.registerRoute('PUT', '/api/skill-candidates/:id', tenantRoute({ machineId, logger }, handleUpdateCandidate));
  server.registerRoute('GET', '/api/skill-records', tenantRoute({ machineId, logger }, handleListSkillRecords));
  server.registerRoute('GET', '/api/skill-records/:id', tenantRoute({ machineId, logger }, handleGetSkillRecord));
  server.registerRoute('DELETE', '/api/skill-candidates/:id', tenantRoute({ machineId, logger }, handleDeleteCandidate));
  server.registerRoute('DELETE', '/api/skill-records/:id', tenantRoute({ machineId, logger }, createSkillRecordDeleteHandler({ logger })));

  // --- Mycelium API routes ---
  server.registerRoute('GET', '/api/spores', handleListSpores);
  server.registerRoute('GET', '/api/spores/:id', createGetSporeHandler());
  server.registerRoute('GET', '/api/entities', handleListEntities);
  server.registerRoute('GET', '/api/graph/seeds', handleGetGraphSeeds);
  server.registerRoute('GET', '/api/graph', handleGetFullGraph);
  server.registerRoute('GET', '/api/graph/:id', handleGetGraph);
  server.registerRoute('GET', '/api/digest', handleGetDigest);

  const attachments = createAttachmentHandler();
  // Tenancy-scoped path for browser <img>/lightbox loads: a plain <img> can't
  // send the x-myco-* tenancy headers, so it carries (Grove, project) in the
  // URL and the server resolves scope from the path. The legacy unscoped route
  // is kept for header-authenticated callers and the pre-migration disk fallback.
  server.registerRoute('GET', '/api/g/:groveId/p/:projectId/attachments/:filename', attachments.handleGetAttachment);
  server.registerRoute('GET', '/api/attachments/:filename', attachments.handleGetAttachment);

  // --- Agent API routes ---
  const agentRunHandlers = createAgentRunHandlers({
    vaultDir: bootstrapVaultDir,
    // Per-request grove resolution — never the bootstrap manager (anchor-leak A).
    resolveEmbeddingManager: (rc) => getEmbeddingRuntime(rc).manager,
    logger,
  });
  server.registerRoute('POST', '/api/agent/run', agentRunHandlers.handleRun);
  server.registerRoute('GET', '/api/agent/runs', agentRunHandlers.handleListRuns);
  server.registerRoute('GET', '/api/agent/runs/:id', agentRunHandlers.handleGetRun);
  server.registerRoute('POST', '/api/agent/runs/:id/resume', agentRunHandlers.handleResumeRun);
  server.registerRoute('GET', '/api/agent/runs/:id/reports', agentRunHandlers.handleGetRunReports);
  server.registerRoute('GET', '/api/agent/runs/:id/turns', agentRunHandlers.handleGetRunTurns);
  server.registerRoute('GET', '/api/agent/runs/:id/write-intents', agentRunHandlers.handleGetRunWriteIntents);
  server.registerRoute('GET', '/api/agent/runs/:id/audit', agentRunHandlers.handleGetRunAudit);
  server.registerRoute('GET', '/api/agent/runs/:id/events', agentRunHandlers.handleGetRunEvents);

  const digestRevisionHandlers = createDigestRevisionHandlers({ vaultDir: bootstrapVaultDir, logger });
  server.registerRoute('GET', '/api/digest/revisions', digestRevisionHandlers.handleList);
  server.registerRoute('POST', '/api/digest/revisions/:id/restore', digestRevisionHandlers.handleRestore);

  const taskVaultDir = (req: RouteRequest) => req.requestContext?.projectVaultDir ?? bootstrapVaultDir;
  server.registerRoute('GET', '/api/agent/tasks', async (req) => handleListTasks(req, taskVaultDir(req)));
  server.registerRoute('GET', '/api/agent/tasks/:id', async (req) => handleGetTask(req, taskVaultDir(req)));
  server.registerRoute('GET', '/api/agent/tasks/:id/yaml', async (req) => handleGetTaskYaml(req, taskVaultDir(req)));
  server.registerRoute('PUT', '/api/agent/tasks/:id', async (req) => {
    const result = await handleUpdateTask(req, taskVaultDir(req));
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('POST', '/api/agent/tasks', async (req) => {
    const result = await handleCreateTask(req, taskVaultDir(req));
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('POST', '/api/agent/tasks/:id/copy', async (req) => {
    const result = await handleCopyTask(req, taskVaultDir(req));
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('DELETE', '/api/agent/tasks/:id', async (req) => {
    const result = await handleDeleteTask(req, taskVaultDir(req));
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('GET', '/api/agent/tasks/:id/config', async (req) => handleGetTaskConfig(req, taskVaultDir(req)));
  server.registerRoute('PUT', '/api/agent/tasks/:id/config', async (req) => {
    const requestVaultDir = taskVaultDir(req);
    const requestGroveId = req.requestContext?.groveId ?? dataPaths.requestContext.groveId;
    const result = await handleUpdateTaskConfig(req, requestVaultDir, requestGroveId);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions([`agent.tasks.${req.params.id}`], {
        vaultDir: requestVaultDir,
        groveId: requestGroveId,
      });
    }
    return result;
  });

  // --- Provider detection, testing, and machine-scoped secrets ---
  registerProviderRoutes(server, { logger });

  // --- In-process MCP server (streamable HTTP) ---
  // Stdio agents are bridged to this endpoint by `myco-run mcp`; HTTP-native
  // agents (codex) connect to it directly. Tool execution happens in-process
  // via the shared tool runtime — no internal HTTP RPC layer.
  server.registerRawRoute('/mcp', createStreamableMcpHttpHandler(bootstrapVaultDir, {
    resolveDatabase: (databasePath) => databasePath === dataPaths.databasePath
      ? db
      : runtimeCache.getDatabase(databasePath),
    logger,
    // Chokepoint 2 of the capture-drain flush wiring (capture-push C1 + C7). The
    // /mcp path is serve-only (never a collect/terminal route), so the flush is
    // inert here today, but both chokepoints thread the real deps so the
    // guarantee can never silently regress if /mcp ever carries a flush route.
    hostProxyDeps: captureProxyDeps,
    // Chokepoint 2 of the served-grove fail-closed filter (Task 2). Same
    // `hostServe` resolved above and threaded into `DaemonServer` — required
    // so `servedGroveRefusal` can run here too, since /mcp bypasses router
    // dispatch (chokepoint 1) entirely.
    hostServe,
  }));

  // --- Backup routes ---
  // One-shot migration: relocate each served Grove's whole-Grove backups
  // into its canonical dir (honoring backup.dir), so list/restore find them
  // where new backups land. Idempotent; never deletes; suppresses the first
  // prune after a consolidation so retention can't drop just-moved backups.
  try {
    for (const m of migrateLegacyBackups()) {
      if (m.moved > 0 || m.quarantined > 0 || m.deduped > 0) {
        logger.info(
          'backup.migrate',
          `Relocated ${m.moved} backup(s) into the canonical dir for ${m.grove_slug}`,
          { grove_id: m.grove_id, moved: m.moved, quarantined: m.quarantined, deduped: m.deduped },
        );
      }
    }
  } catch (err) {
    logger.warn('backup.migrate_failed', errorMessage(err));
  }

  const backupHandlers = createBackupHandlers({
    cache: runtimeCache,
    machineId,
  });
  server.registerRoute('POST', '/api/backup', backupHandlers.handleCreateBackup);
  server.registerRoute('GET', '/api/backups', backupHandlers.handleListBackups);
  server.registerRoute('POST', '/api/restore/preview', backupHandlers.handleRestorePreview);
  server.registerRoute('POST', '/api/restore', backupHandlers.handleRestore);
  server.registerRoute('GET', '/api/restore/status', backupHandlers.handleRestoreStatus);

  const backupConfigHandlers = createBackupConfigHandlers({
    bootstrapVaultDir,
    bootGroveId: dataPaths.requestContext.groveId ?? null,
  });
  server.registerRoute('GET', '/api/backup/config', backupConfigHandlers.handleGetBackupConfig);
  server.registerRoute('PUT', '/api/backup/config', async (req) => {
    const result = await backupConfigHandlers.handlePutBackupConfig(req);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions(['backup.dir'], {
        vaultDir: req.requestContext?.projectVaultDir ?? bootstrapVaultDir,
        groveId: req.requestContext?.groveId ?? dataPaths.requestContext.groveId,
      });
    }
    return result;
  });

  // --- Search, activity feed, and embedding status ---

  // Dual-mode read: a caller-supplied context scopes to its project; a
  // context-less request scopes to GLOBAL_SCOPE and returns no project rows.
  // Fail-loud on unresolved tenancy is enforced in the tools layer, not here.
  const searchHandler = createSearchHandler({
    embeddingManager,
    resolveEmbeddingManager: (requestContext) => getEmbeddingRuntime(requestContext).manager,
  });
  server.registerRoute('GET', '/api/search', searchHandler);
  server.registerRoute('GET', '/api/activity', handleGetFeed);
  const embeddingStatusHandler = createEmbeddingStatusHandler({
    resolveRequestRuntime: getRequestEmbeddingRuntime,
  });
  server.registerRoute('GET', '/api/embedding/status', tenantRoute({ machineId, logger }, async (req) => {
    return embeddingStatusHandler(req);
  }));
  const embeddingDetailsHandler = createEmbeddingDetailsHandler({
    resolveRequestRuntime: getRequestEmbeddingRuntime,
    canopyDescribeBacklog: createCanopyDescribeBacklogReader(),
  });
  server.registerRoute('GET', '/api/embedding/details', tenantRoute(
    { machineId, logger },
    async (req) => embeddingDetailsHandler(req),
  ));
  const embeddingActionHandlers = createEmbeddingActionHandlers({
    cache: runtimeCache,
    embeddingRuntimeFactory: buildGroveEmbeddingRuntime,
    logger,
    resolveRequestRuntime: getRequestEmbeddingRuntime,
    daemonStateDir: daemonService.stateDir,
  });
  server.registerRoute('POST', '/api/embedding/rebuild', embeddingActionHandlers.handleRebuild);
  server.registerRoute('POST', '/api/embedding/reconcile', embeddingActionHandlers.handleReconcile);
  server.registerRoute('POST', '/api/embedding/clean-orphans', embeddingActionHandlers.handleCleanOrphans);
  server.registerRoute('POST', '/api/embedding/reembed-stale', embeddingActionHandlers.handleReembedStale);
  server.registerRoute('GET', '/api/database/details', databaseHandlers.handleDetails);
  server.registerRoute('POST', '/api/database/optimize', databaseHandlers.handleOptimize);
  server.registerRoute('POST', '/api/database/vacuum', databaseHandlers.handleVacuum);
  server.registerRoute('POST', '/api/database/reindex', databaseHandlers.handleReindex);
  server.registerRoute('POST', '/api/database/integrity-check', databaseHandlers.handleIntegrityCheck);

  // --- Multi-Grove operator surface ---
  //
  // /api/maintenance/summary aggregates per-Grove backup, optimize,
  // integrity, and embedding-pending status into a single payload so
  // the Operations dashboard renders a multi-Grove overview without
  // fanning out per-Grove HTTP calls itself.
  // /api/groves/:id/maintenance returns one Grove's full status with
  // 404 on unknown id (UI distinguishes "Grove gone" from "Grove broken").
  // /api/projects/activity returns daemon-global active vs cold project
  // status backed by the same window the scheduler uses.
  const maintenanceHandlers = createMaintenanceHandlers({
    logger,
    liveConfig,
    cache: runtimeCache,
    embeddingRuntimeFactory: buildGroveEmbeddingRuntime,
    daemonStateDir: daemonService.stateDir,
  });
  server.registerRoute('GET', '/api/maintenance/summary', maintenanceHandlers.handleSummary);
  server.registerRoute('GET', '/api/groves/:id/maintenance', maintenanceHandlers.handleGroveMaintenance);
  server.registerRoute('POST', '/api/maintenance/release-provenance/reconcile', maintenanceHandlers.handleReleaseProvenanceReconcile);

  const projectsActivityHandler = createProjectsActivityHandler({
    logger,
    liveConfig,
    cache: runtimeCache,
    daemonStateDir: daemonService.stateDir,
  });
  server.registerRoute('GET', '/api/projects/activity', projectsActivityHandler);

  // --- Notification API routes ---
  registerNotificationRoutes(server, { machineId, logger });

  // --- Start server ---
  //
  // The canonical port is the single source of truth: derivePort(serviceDir)
  // for grove-bound projects, derivePort(vaultDir) for the rare legacy case.
  // No config override and no silent fallback — if the port is unavailable
  // after eviction, either a concurrent sibling won the race (step aside)
  // or something unrelated is squatting (fail loudly). Ghost daemons on
  // surprise ports come from fallbacks, so we don't have any.

  await server.evictExistingDaemon();
  const canonicalPort = daemonService.canonicalPort;

  // One evict-and-retry round for the stale-orphan case below; anything
  // still holding the port after that fails loudly.
  let bindAttemptsLeft = 2;
  while (true) {
    try {
      await server.start(canonicalPort);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EADDRINUSE') throw err;
      bindAttemptsLeft--;

      const sibling = await probeMycoDaemon(canonicalPort);
      if (
        sibling !== null
        && sibling.version === getPluginVersion()
        && isRetiredExternalMcpDaemon(sibling)
      ) {
        // A same-version sibling won a concurrent-startup race — its serving
        // is indistinguishable from ours. Step aside.
        logger.info(LOG_KINDS.DAEMON_START, 'Sibling claimed canonical port during startup — stepping aside', {
          port: canonicalPort,
          sibling_version: sibling.version ?? null,
        });
        process.exit(0);
      }

      if (sibling !== null && bindAttemptsLeft > 0) {
        // A myco daemon on a DIFFERENT version is a stale orphan — e.g. an
        // old binary image that survived a package replacement. Stepping
        // aside would leave the old version serving forever while every new
        // boot exits 0. Evict it and retry the bind once.
        logger.warn(LOG_KINDS.DAEMON_PORT, 'Stale myco daemon (version mismatch) holds the canonical port — evicting', {
          port: canonicalPort,
          orphan_version: sibling.version ?? null,
          our_version: getPluginVersion(),
        });
        const squatters = findPidsListeningOn([canonicalPort]).filter((s) => s.pid !== process.pid);
        await Promise.all(squatters.map((s) => terminateProcess(s.pid, { graceMs: DAEMON_EVICT_TIMEOUT_MS, pollMs: DAEMON_EVICT_POLL_MS, logger })));
        continue;
      }

      logger.error(LOG_KINDS.DAEMON_PORT, 'Canonical port is held by another process — cannot start', {
        port: canonicalPort,
        hint: `Run \`lsof -iTCP:${canonicalPort}\` to identify the owner and stop it.`,
      });
      process.stderr.write(
        `Myco daemon cannot bind port ${canonicalPort} (held by another process). ` +
          `Run \`lsof -iTCP:${canonicalPort}\` to investigate.\n`,
      );
      process.exit(1);
    }
  }
  daemonLifecycleLock?.update({
    port: server.port,
    authToken: server.getAuthToken(),
  });

  logger.info(LOG_KINDS.DAEMON_READY, 'Daemon ready', { vault: bootstrapVaultDir, port: server.port });

  // Team Host: publish the team socket, and PROVE it serves.
  //
  // Placed after start() because the socket has to exist first, and it is the
  // daemon that binds it — `myco host enable` writes the config and restarts;
  // it cannot activate a Funnel onto a socket that does not exist yet. Running
  // here every boot also makes activation self-healing: an operator who renamed
  // their machine, or whose serve config was cleared out of band, gets the URL
  // re-established and re-recorded rather than silently serving nobody.
  //
  // Loud-but-alive, matching the external-MCP repair above: a host that cannot
  // publish still runs everything else, and the failure is recorded where the
  // Team page reads it instead of crash-looping the daemon.
  //
  // NOT awaited. Publishing runs the operator's vendor `tailscale` (up to three
  // invocations, 10s each), then a DNS lookup, an HTTPS probe and a TCP
  // control-connect — tens of seconds on a machine whose network or Tailscale
  // is unhealthy. Awaiting it here would hold every later boot step behind
  // that, including `syncScheduledTasks`, so a sick Funnel would starve the
  // scheduler. Fire-and-forget, same posture as the module pre-warm below;
  // members simply cannot reach the host until it resolves, which is already
  // true while it is running.
  if (hostServe && server.teamSocketPath) {
    const socketPath = server.teamSocketPath;
    void (async () => {
      const activation = await activateTeamFunnel(socketPath, { runFunnelOn: defaultFunnelOnRunner });
      // Read state AFTER the await: activation takes real time, and a
      // concurrent `host enable` may have written it in the meantime.
      //
      // A missing state file is not a reason to discard what was observed.
      // `resolveHostServeConfig` never consults host state, so `host_serve`
      // enabled with no `state.json` is representable — and dropping the URL
      // there left the dashboard telling an operator no address had been
      // published about a host that was live on the public internet. The
      // record is created from what we know instead.
      const state = readHostState();
      const base = state ?? {
        host_id: hostServe.hostId ?? '',
        enabled_at: new Date().toISOString(),
        label: hostServe.label ?? undefined,
        platform: process.platform,
      };
      if (!state) {
        logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host state file was missing at publish — recreating it from the resolved config', {
          host_id: base.host_id || null,
        });
      }
      if (activation.ok && activation.hostUrl) {
        logger.info(LOG_KINDS.HOST_SERVE, 'Team Host published', { host_url: activation.hostUrl });
        if (base.host_url !== activation.hostUrl || base.funnel_error) {
          writeHostState({ ...base, host_url: activation.hostUrl, funnel_error: undefined });
        }
      } else {
        logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host could not publish its public URL', {
          detail: activation.detail,
        });
        // The URL is kept, not cleared: members already hold it, and a transient
        // activation failure does not make the address wrong. The error rides
        // alongside so the Team page can say what is broken.
        writeHostState({ ...base, funnel_error: activation.detail });
      }
    })().catch((err) => {
      logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host publish failed unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Clear any update-in-progress sentinel left by the orchestrator
  // that triggered this restart. If the sentinel's target version
  // matches what we're running, the update succeeded — drop the
  // sentinel so future updates aren't blocked. If it doesn't match
  // (the install errored before reaching the target), the stale-age
  // sweep in `update-in-progress.inFlight()` will drop it eventually.
  {
    const sentinel = updateInProgress.read(daemonService.stateDir);
    if (sentinel && sentinel.targetVersion === server.version) {
      updateInProgress.clear(daemonService.stateDir);
      logger.info(LOG_KINDS.DAEMON_START, 'Update sentinel cleared on target-version match', {
        target_version: sentinel.targetVersion,
        initiator: sentinel.initiator,
      });
    } else if (sentinel) {
      // An adopt was attempted but the daemon came back on a DIFFERENT version —
      // the adopt failed (crash / restore). Mark the target version failed so the
      // idle adopt job never re-adopts a known-bad release (otherwise it loops
      // every ~10-min sentinel stale-window), then clear the sentinel now.
      const { markAdoptFailed } = await import('../upgrade/auto-check.js');
      markAdoptFailed(mycoHome, process.platform, sentinel.targetVersion, process.env.LOCALAPPDATA);
      updateInProgress.clear(daemonService.stateDir);
      logger.warn(LOG_KINDS.DAEMON_START, 'Adopt did not reach target version — marked failed, sentinel cleared', {
        target_version: sentinel.targetVersion,
        running_version: server.version,
        initiator: sentinel.initiator,
      });
    }
  }

  // Pre-warm modules that are dynamically imported from daemon hot paths.
  // tsup compiles `await import('@myco/...')` into a chunk filename with a
  // content hash baked in (e.g. `./executor-ABC123.js`). When the bundle is
  // rebuilt during dev, chunk hashes churn — but the running daemon still
  // has the OLD filename baked into its code. The first late dynamic import
  // at that path then fails with `Cannot find module './executor-<OLD>.js'`.
  // Warming the imports now puts the resolved URLs into Node's ES module
  // cache; every subsequent `import()` at those call sites returns the cached
  // module without touching disk, so disk churn no longer matters.
  void Promise.all([
    import('../agent/executor.js'),
    import('../agent/registry.js'),
    import('../agent/tools/skill-staging.js'),
    import('../db/queries/turns.js'),
    import('../symbionts/installer.js'),
  ]).catch((err) => {
    logger.warn(LOG_KINDS.DAEMON_START, 'Pre-warm of dynamic imports failed', {
      error: errorMessage(err),
    });
  });

  // -- Dynamic task scheduling --
  // Seed the per-project power state tracker from durable state across
  // every Grove. Without this, a daemon restart collapses every project
  // to `deep_sleep` for 90 minutes after boot — dropping warm projects
  // out of `runIn: ['active', 'idle', 'sleep']` task lists until a fresh
  // session or prompt arrives. Best-effort: an empty seed is fine on
  // first launch; recordActivity hooks below will populate live.
  try {
    await forEachGrove(runtimeCache, logger, ({ grove, db }) => {
      projectStateTracker.seed(readProjectActivitySeed(db, grove.id));
    }, { daemonStateDir: daemonService.stateDir });
  } catch (err) {
    logger.warn(LOG_KINDS.DAEMON_START, 'Project power-state seed failed', {
      error: errorMessage(err),
    });
  }

  // Registered first so its kicker is available as a normal dep when
  // power jobs register below.
  await syncScheduledTasks();

  // --- Register power-managed jobs ---
  // The canopy mass-add callback feeds the scheduler kicker so a fresh
  // populate or recovery scan drains immediately on the next compatible
  // tick instead of waiting one full canopy-describe interval.
  const powerJobs = registerPowerJobs(jobRunner, {
    registry,
    logger,
    liveConfig,
    machineId,
    transcriptMiner,
    cache: runtimeCache,
    embeddingRuntimeFactory: buildGroveEmbeddingRuntime,
    onCanopyMassAdd: (groveId, projectId) =>
      scheduledTaskKicker.kick('canopy-describe', { groveId, projectId }),
    daemonVaultDir: bootstrapVaultDir,
    daemonStateDir: daemonService.stateDir,
    reconciler,
    // Upgrade auto-check + idle-adopt jobs. No-op on manual-channel machines
    // inside the job fns themselves, so these are safe to register unconditionally.
    upgrade: {
      currentVersion: server.version,
      home: mycoHome,
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA,
      stateDir: daemonService.stateDir,
      daemonPort: server.port,
      mycoBinary: resolveMycoBinary(),
      projectRoot,
    },
  });
  const selfReconcileLoop = startSelfReconcileLoop(logger, {
    daemonService,
    stateAuthority: daemonStateAuthority,
    server,
  });

  // Team Host transcript-drain backstop (capture-push C1). The mid-turn drain
  // rides its own ~3 s throttle (fired from the collect path) and terminal routes
  // flush synchronously, so this job is the catch-up sweep for anything a throttle
  // missed (e.g. a host that was unreachable at flush time) and — via `hold.pending`
  // — the deep-sleep inhibitor so the machine never sleeps on an un-shipped turn
  // (mirrors job-runner's `providesHold`).
  jobRunner.register({
    name: 'team-host-transcript-drain',
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    hold: { pending: () => transcriptDrain.pendingCount() },
    fn: async () => {
      await transcriptDrain.drainAll();
    },
  });

  // Agent liveness. Registered as a PowerManager assertion rather than a job
  // hold because it answers a different question than every `hold.pending`
  // below: those ask "is there queued work to flush", this asks "is an agent
  // mid-turn". Capture writes are synchronous, so an agent running tool calls
  // for hours produces no queue depth and every hold correctly reports zero —
  // which is precisely how the daemon used to deep-sleep through active work.
  powerManager.registerAssertionSource(makeAgentLivenessSource({
    cache: runtimeCache,
    logger,
    daemonStateDir: daemonService.stateDir,
    mycoHome,
  }));

  // Team Host plan-content companion-push backstop (capture-push §5.5, C7). The
  // sibling of the transcript drain for whole-file plan content: the throttled
  // mid-turn drain + the flush-before-Stop guarantee the common case, and this job
  // is the catch-up sweep for anything a throttle missed (host unreachable at flush
  // time). Via `hold.pending` it inhibits deep sleep while a plan push is un-shipped.
  jobRunner.register({
    name: 'team-host-plan-drain',
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    hold: { pending: () => planDrain.pendingCount() },
    fn: async () => {
      await planDrain.drainAll();
    },
  });

  // Team Host attach-aware live-event replay drain (capture-push C5). Re-forwards
  // an attached project's buffered live capture events to its host when the host
  // is reachable — retry-on-tick IS the reconnect trigger, so a host that was down
  // at capture time converges on the next tick. Runs PARALLEL to the local buffer
  // reconciler's drain (`CAPTURE_BUFFER_DRAIN`), which is listGroves-scoped and
  // never touches an attached buffer, so there is no double-forward. `hold.pending`
  // keeps the machine awake while capture is un-shipped.
  jobRunner.register({
    name: 'team-host-event-replay-drain',
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    hold: { pending: () => eventReplayDrain.pendingCount() },
    fn: async () => {
      await eventReplayDrain.drainAll();
    },
  });

  // Residency transition drain (Phase F). Carries a transition the rest of the
  // way in both directions: attach re-drives `parking` → `pushing` → push → local
  // delete; the hybrid detach drives `fetching` (resumable artifact download)
  // → `restoring` (atomic restore through the backup engine, then flip) →
  // `rehoming` → done. `hold.pending` keeps the machine awake while
  // any transition is unfinished, so a half-moved project is never abandoned to
  // sleep. Runs in every power state, like the other member drains.
  //
  // This periodic job is the retry/resume backstop; the on-begin/abort
  // kick (residencyDeps.kickResidencyDrain) drives the SAME serialized runner for
  // immediate progress.
  jobRunner.register({
    name: 'residency-transition',
    runIn: ['active', 'idle', 'sleep'],
    kind: 'housekeeping',
    hold: { pending: () => countResidencyInFlight() },
    fn: async () => {
      await residencyKicker.run();
    },
  });

  // Team Host hosted-project prune (E-4 W2 T1e / decision D-W2-5). Registration-
  // on-ingest can leave an EMPTY hosted (synthetic-root) registry row when a
  // forwarded capture registered the project but never landed a DB write. This
  // GC removes such rows once they age past HOSTED_PROJECT_PRUNE_TTL_MS AND hold
  // zero sessions/spores/plans in the served Grove — delete-only-if-empty, so a
  // row with any data structurally survives regardless of age. No-op unless this
  // daemon is a designated host; idle/sleep-only (never latency-sensitive).
  jobRunner.register({
    name: 'team-host-hosted-project-prune',
    runIn: ['idle', 'sleep'],
    kind: 'housekeeping',
    fn: async () => {
      const servedGroveId = hostServe?.servedGroveId;
      if (!servedGroveId) return;
      const dbPath = resolveGroveDbPath(servedGroveId, mycoHome);
      if (!fs.existsSync(dbPath)) return;
      await runtimeCache.withPinned(dbPath, async () => {
        pruneHostedProjects({
          servedGroveId,
          db: runtimeCache.getDatabase(dbPath),
          mycoHome,
          logger,
        });
      });
    },
  });

  // Startup auto-check: fire once in the background immediately after boot
  // so the user doesn't wait for the first idle/sleep tick to discover a
  // new version. The periodic job (upgrade-auto-check) applies the cadence
  // gate on subsequent ticks; this call always runs (dev-build no-op inside).
  void (async () => {
    try {
      const { checkAndStage: doCheckAndStage } = await import('../upgrade/auto-check.js');
      const { readUpdateConfig: readCfg } = await import('./update-checker.js');
      const cfg = readCfg();
      const result = await doCheckAndStage(
        server.version,
        {
          home: mycoHome,
          platform: process.platform,
          localAppData: process.env.LOCALAPPDATA,
          logger,
          channel: cfg.channel,
        },
      );
      if (result.status === 'staged') {
        logger.info(LOG_KINDS.DAEMON_START, 'Startup auto-check staged new version', {
          version: result.version,
        });
      } else if (result.status === 'error') {
        logger.warn(LOG_KINDS.DAEMON_START, 'Startup auto-check stage error', {
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn(LOG_KINDS.DAEMON_START, 'Startup auto-check failed', {
        error: errorMessage(err),
      });
    }
  })();

  // Wire the project-keyed canopy registry into the session-register path.
  // Each SessionStart looks up (or materializes) the right project's runner
  // and triggers a fire-and-forget delta refresh; the runner debounces.
  (sessionLifecycleDeps as {
    canopyRegistry?: typeof powerJobs.canopy.registry;
  }).canopyRegistry = powerJobs.canopy.registry;

  // Initial canopy populate fans out across every registered project. The
  // populate is a no-op for projects that already have canopy rows; on a
  // fresh vault the first scan adds every file (well above the mass-add
  // threshold), so onCanopyMassAdd kicks canopy-describe and descriptions
  // start draining on the next tick.
  void runInitialCanopyPopulateAcrossProjects(
    runtimeCache,
    logger,
    machineId,
    powerJobs.canopy.registry,
    liveConfig,
    daemonService.stateDir,
  );

  // Fan markRunningRunsInterrupted across every registered Grove so a
  // crash on Grove A doesn't leave Grove B's runs hanging in `running`.
  // Boot-DB sweep already ran above; this catches the rest.
  void (async () => {
    try {
      const { markRunningRunsInterrupted: markStale, sweepStaleSupersededRuns: sweepStale } = await import('../db/queries/runs.js');
      await forEachGrove(
        runtimeCache,
        logger,
        ({ grove }) => {
          if (grove.id === dataPaths.requestContext.groveId) return;
          const exclusions = leaseHeldProjectIdsForSweep({ kind: 'all' }, logger);
          const count = markStale('Daemon restarted before the run completed', { kind: 'all' }, exclusions);
          if (count > 0) {
            logger.warn(LOG_KINDS.AGENT_RUN, 'Marked stale running runs as resumable after daemon restart', {
              count,
              grove_id: grove.id,
            });
          }
          const supersededCount = sweepStale({ kind: 'all' }, exclusions);
          if (supersededCount > 0) {
            logger.warn(LOG_KINDS.AGENT_RUN, 'Marked stale resumable runs as superseded on boot', {
              count: supersededCount,
              grove_id: grove.id,
            });
          }
        },
        { daemonStateDir: daemonService.stateDir, jobName: 'mark-stale-running-runs' },
      );
    } catch (err) {
      logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to fan stale-run sweep across Groves', {
        error: errorMessage(err),
      });
    }
  })();

  // No orphan-pause sweep here any more (write-admission W4). A lease is now
  // held only while its holder is alive OR its operation is unfinished, both
  // evaluated when the lease is READ, so an abandoned one resolves as free the
  // moment anyone asks — there is nothing to sweep. The sweeper it replaced
  // enumerated `listGroves` → `listRegisteredProjects`, which structurally
  // could not see a project mid-residency-transition (deregistered from every
  // Grove while its lease is held) — precisely the one that could strand.
  // `forceResumeProject` remains as the operator escape hatch.

  // Greenfield rebind: when a *variant-less* daemon booted without a vault
  // (phantom bootstrap), poll the Grove registry every 5s. The first
  // hook-driven auto-Grove-create writes a project under the default
  // Grove; once a registered project shows up, restart so the next boot
  // resolves a real vault via `resolveBootstrapVaultDir()` and brings up
  // the full Grove-bound surface (sqlite, embeddings, scope iteration).
  //
  // The GLOBAL daemon (MYCO_DAEMON_MANAGED set) is excluded: it has no
  // bootstrap project and never rebinds to one. Its home is MYCO_HOME and
  // every request carries its own tenancy, so it stays phantom (home-
  // scoped) for its whole lifetime. Running the rebind poll for the global
  // daemon would be pointless (the resolver returns null by design) and
  // misleading — it must not "rebind to the first registered project",
  // that anchor is exactly the tenant-scope leak we removed.
  let phantomRebindWatcher: ReturnType<typeof setInterval> | null = null;
  if (bootstrapIsPhantom && isGlobalDaemon) {
    logger.info(LOG_KINDS.DAEMON_START, 'Global daemon — home-scoped (MYCO_HOME), serving tenants by request context', {
      home_vault: bootstrapVaultDir,
    });
  } else if (bootstrapIsPhantom) {
    const { resolveBootstrapVaultDir } = await import('../vault/bootstrap.js');
    logger.info(LOG_KINDS.DAEMON_START, 'Greenfield daemon — bootstrapped with phantom vault, watching registry for first project', {
      phantom_vault: bootstrapVaultDir,
    });
    const rebindShutdown = scheduleShutdownWithAttribution('phantom-rebind', logger);
    phantomRebindWatcher = setInterval(() => {
      try {
        const resolved = resolveBootstrapVaultDir();
        if (!resolved) return;
        logger.info(LOG_KINDS.DAEMON_START, 'Greenfield rebind — first project registered, restarting to bind', {
          resolved_vault: resolved,
        });
        if (phantomRebindWatcher) {
          clearInterval(phantomRebindWatcher);
          phantomRebindWatcher = null;
        }
        rebindShutdown();
      } catch (err) {
        // Variant-pinned throws would never happen here (we are by definition
        // in the variant-less greenfield branch), but log if the registry
        // read itself blew up so the watcher is observable.
        logger.warn(LOG_KINDS.DAEMON_START, 'Phantom-rebind registry probe failed', {
          error: errorMessage(err),
        });
      }
    }, 5000);
    if (typeof phantomRebindWatcher.unref === 'function') phantomRebindWatcher.unref();
  }

  powerManager.start();
  eventLoopLagProbe.start();

  // --- Shutdown ---

  // Guard against SIGTERM + SIGINT (or repeated signals) running the
  // shutdown body twice. Without this, the second invocation re-enters
  // closeDatabase() / runtimeCache.closeAll() against already-closed
  // better-sqlite3 handles, which throws inside libuv. We capture the
  // first invocation's promise so subsequent signals just await the same
  // settled outcome.
  let shutdownPromise: Promise<void> | null = null;
  let shutdownPreparationPromise: Promise<void> | null = null;
  let shutdownPrepared = false;
  const prepareShutdown = (signal: string): Promise<void> => {
    if (shutdownPrepared) return Promise.resolve();
    if (shutdownPreparationPromise) return shutdownPreparationPromise;
    logger.info(LOG_KINDS.DAEMON_START, `${signal} received`);
    shutdownPreparationPromise = externalMcpContainment.contain('shutdown')
      .then(() => {
        shutdownPrepared = true;
      })
      .finally(() => {
        shutdownPreparationPromise = null;
      });
    return shutdownPreparationPromise;
  };

  const runPreparedShutdown = async () => {
    selfReconcileLoop.stop();
    powerManager.stop();
    eventLoopLagProbe.stop();
    if (phantomRebindWatcher) {
      clearInterval(phantomRebindWatcher);
      phantomRebindWatcher = null;
    }
    // Wait for any active stop processing to finish before shutting down
    const activeStopProcessing = stopProcessor.getActiveProcessing();
    if (activeStopProcessing) {
      logger.info(LOG_KINDS.DAEMON_START, 'Waiting for active stop processing to complete...');
      await activeStopProcessing;
    }
    // Drain fire-and-forget Cortex runs so we don't orphan non-terminal
    // agent_runs rows or abandon reasoning-token spend. Bounded by a 30s
    // default — longer runs continue in the background but we still exit.
    if (inflightRuns.size > 0) {
      logger.info(LOG_KINDS.DAEMON_START, 'Draining in-flight agent runs before shutdown...', {
        inflight_count: inflightRuns.size,
      });
      const outcome = await inflightRuns.drain();
      if (!outcome.settled) {
        logger.warn(LOG_KINDS.DAEMON_START, 'Some in-flight runs did not settle before shutdown timeout', {
          remaining: outcome.remaining,
        });
      }
    }
    registry.destroy();
    await server.stop();
    runtimeCache.closeAll();
    vectorStore.close();
    closeDatabase();
    // Release the lifecycle lock as the last visible step so a respawn
    // can acquire it without depending on Node's `exit` handler ordering.
    if (daemonLifecycleLock) {
      daemonLifecycleLock.release();
      logger.info(LOG_KINDS.DAEMON_START, 'Lifecycle lock released');
    }
    logger.close();
    process.exit(0);
  };

  const beginPreparedShutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) {
      logger.info(LOG_KINDS.DAEMON_START, `${signal} received during in-progress shutdown; awaiting prior signal`);
      return shutdownPromise;
    }
    shutdownPromise = runPreparedShutdown().catch((error) => {
      shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  };

  const shutdown = async (signal: string): Promise<void> => {
    await prepareShutdown(signal);
    await beginPreparedShutdown(signal);
  };

  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error) => {
      logger.error(LOG_KINDS.DAEMON_START, 'Shutdown blocked by external MCP containment', {
        signal,
        error: errorMessage(error),
      });
    });
  };
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));

  // Cooperative cross-process shutdown. A successor daemon (reconcile takeover)
  // or the updater POSTs /api/shutdown to run THIS graceful path on Windows,
  // where a cross-process SIGTERM is an uncatchable TerminateProcess and the
  // signal handlers above never fire. Wired here, after `shutdown` exists.
  server.onShutdownRequest(async () => {
    await prepareShutdown('shutdown-request');
    return () => beginPreparedShutdown('shutdown-request');
  });
  });
}

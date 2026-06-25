/**
 * Myco daemon — global capture, API, MCP, and scheduled-work runtime.
 *
 * The daemon is the per-machine authority for event ingestion, session
 * recording, Grove-scoped API handling, in-process MCP HTTP, and recurring
 * project work.
 */

import { DaemonServer } from './server.js';
import type { RouteRequest } from './router.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger, type Logger } from './logger.js';
import { loadMergedConfig, setTierParseFailureListener } from '../config/loader.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { createPerProjectAdapter } from '../symbionts/adapter.js';
import { claudeCodeAdapter } from '../symbionts/claude-code.js';
import { findCorePackageRoot } from '../utils/find-package-root.js';
import { hasEmbeddedUi } from './static.js';
import { attemptDaemonStartup, type LockHandle } from './lifecycle-lock-startup.js';
import * as updateInProgress from '@myco/upgrade/in-progress.js';
import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { EventBuffer } from '../capture/buffer.js';
import { listAllProjectBufferDirs } from '../capture/buffer-location.js';
import { runGlobalBootstrap, shouldRunGlobalBootstrap } from '../cli/bootstrap.js';
import { resolveMycoHome, resolveGroveDbPath } from '../grove/paths.js';
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
import { createTeamHandlers } from './api/team-connect.js';
import { createTeamSelectionHandlers } from './api/team-selection.js';
import { createListTeamMembersHandler } from './api/team-members.js';
import { createCollectiveHandlers } from './api/collective.js';
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
import { initTeamSync } from './team-sync-init.js';
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
import { initDatabase, closeDatabase, getDatabase, setOwnedServiceDirForCurrentProcess, type Database } from '../db/client.js';
import { GroveRuntimeCache } from './grove-runtime-cache.js';
import { forEachGrove, forEachRegisteredProject, isProjectActive } from './scope-iteration.js';
import type { CanopyJobsRegistry } from './jobs/canopy-scan.js';
import {
  ProjectPowerStateTracker,
  readProjectActivitySeed,
} from './project-power-state.js';
import { pauseAwareShouldVisit } from '../grove/registry.js';
import { resumeOrphanedPauses } from './startup-pauses.js';
import { createSchema } from '../db/schema.js';
import { insertLogEntry, getMaxTimestamp } from '../db/queries/logs.js';
import { createStreamableMcpHttpHandler } from '../mcp/http.js';
import { createAgentRunHandlers } from './api/agent-runs.js';
import { createDigestRevisionHandlers } from './api/digest-revisions.js';
import { createAttachmentHandler } from './api/attachments.js';
import { reconcileLogBuffer } from './log-reconcile.js';
import { logEntryToInsert } from './log-entry-insert.js';
import { markRunningRunsInterrupted } from '../db/queries/runs.js';
import {
  POWER_IDLE_THRESHOLD_MS,
  POWER_SLEEP_THRESHOLD_MS,
  POWER_DEEP_SLEEP_THRESHOLD_MS,
  POWER_ACTIVE_INTERVAL_MS,
  POWER_SLEEP_INTERVAL_MS,
  RESTART_RESPONSE_FLUSH_MS,
  JOB_RUNNER_CONCURRENCY,
  epochSeconds,
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
import { registerPowerJobs } from './power-jobs.js';
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
import { createLiveReconcile } from './live-reconcile.js';
import { createConfigReactionRegistry, computeTouchedPaths, loadReactionContext } from './config-reactions/index.js';
import { createPlanWatchReaction } from './plan-watch-reaction.js';
import { resolveDaemonDataPaths, resolveVectorsPathForRequestContext } from './data-paths.js';
import { type GroveProjectId } from '../grove/ids.js';
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
import { probeMycoDaemon, findPidsListeningOn, terminateProcess } from './eviction.js';
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
   * signals. Resolves true if the daemon accepted (HTTP 202). This is the only
   * graceful drain path on Windows, where a cross-process SIGTERM maps to an
   * uncatchable TerminateProcess that would abort the drain mid-flight.
   */
  requestShutdown?: (port: number, timeoutMs: number) => Promise<boolean>;
  /** How long to let an ACCEPTED cooperative shutdown drain before escalating
   *  to signals (ms). Defaults to RECONCILE_COOPERATIVE_GRACE_MS. */
  cooperativeGraceMs?: number;
  sigtermGraceMs?: number;
  sigkillGraceMs?: number;
  pollMs?: number;
}

/**
 * Default {@link ReconcileDeps.requestShutdown}: POST `/api/shutdown` on the
 * predecessor's loopback port. Accepted ONLY on the daemon's 202 ack — a non-202
 * (a foreign loopback service answering 200, or a daemon too old to expose the
 * route) is NOT treated as "draining", so the caller doesn't wait out the
 * cooperative grace and falls straight through to the signal escalation. Any
 * error resolves false for the same reason.
 */
async function requestDaemonShutdown(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

/**
 * Reconcile with any existing daemon for this vault before starting a new one.
 *
 * - If no daemon.json or the recorded pid is dead → 'ok' (take over).
 * - If the recorded daemon is recent, healthy, and running the same plugin
 *   version → 'step-aside' (a sibling just started; don't kill it). The caller
 *   exits cleanly. This is what stops the concurrent-spawn cascade where each
 *   new process SIGTERMs the last one standing.
 * - Otherwise (stale, unhealthy, or version-mismatch) → SIGTERM, poll for
 *   exit, escalate to SIGKILL if needed. If the pid survives both signals,
 *   log an error and return 'step-aside' — leaving the file in place is
 *   structurally safer than orphaning a live daemon.
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
): Promise<'ok' | 'step-aside'> {
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const cmdlineReader = deps.readProcessCommandLine ?? readProcessCommandLine;
  const requestShutdown = deps.requestShutdown ?? requestDaemonShutdown;
  const cooperativeGraceMs = deps.cooperativeGraceMs ?? RECONCILE_COOPERATIVE_GRACE_MS;
  const sigtermGraceMs = deps.sigtermGraceMs ?? RECONCILE_SIGTERM_GRACE_MS;
  const sigkillGraceMs = deps.sigkillGraceMs ?? RECONCILE_SIGKILL_GRACE_MS;
  const pollMs = deps.pollMs ?? RECONCILE_POLL_MS;

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
        const data = await res.json() as { myco?: boolean; version?: string };
        const existingCommand = info.command ?? null;
        // Use process.execPath, not process.argv[1]: under the bun-compiled
        // standalone, argv[1] is a virtual /$bunfs/... path that never
        // matches what daemon.json stores (the on-disk binary path).
        const currentCommand = process.execPath ?? null;
        const runtimeMismatch = Boolean(existingCommand && currentCommand && existingCommand !== currentCommand);
        if (data.myco && (data.version === getPluginVersion() || runtimeMismatch)) {
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
  if (typeof info.port === 'number' && await requestShutdown(info.port, DAEMON_HEALTH_CHECK_TIMEOUT_MS)) {
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
  return 'step-aside';
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
      process.kill(process.pid, 'SIGTERM');
    }, RESTART_RESPONSE_FLUSH_MS);
  };
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
      async ({ databasePath, projectId, projectRoot, grove, db }) => {
        if (cutoffSeconds > 0 && !isProjectActive(db, projectId, cutoffSeconds)) {
          // Cold project — let SessionStart trigger when the user returns.
          return;
        }
        await registry.initialPopulate({ databasePath, projectId, projectRoot, groveId: grove.id });
      },
      {
        machineId,
        daemonStateDir,
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
  const mycoHome = resolveMycoHome();
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
  const daemonService = resolveDaemonServiceState(bootstrapVaultDir, {
    requestContext: dataPaths.requestContext,
    env: process.env,
  });
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
  const lockResult = await attemptDaemonStartup({
    lockPath: daemonService.lockPath,
    databasePath: dataPaths.databasePath,
    waitForReleaseMs: 2000,
  });

  if (lockResult.outcome === 'refused') {
    // Holder is still alive after the wait window. Defer to the
    // existing reconcile path for the health decision. If healthy:
    // step aside. If not: evict and retry the lock (another
    // contender may take it during the eviction window — still a
    // step-aside outcome for us).
    logger.info(LOG_KINDS.DAEMON_START, 'Lifecycle lock held by another process', {
      holder_pid: lockResult.holderPid,
      reason: lockResult.reason,
    });
    const reconcileResult = await reconcileExistingDaemon(daemonService, logger);
    if (reconcileResult === 'step-aside') {
      process.exit(0);
    }
    const retry = await attemptDaemonStartup({
      lockPath: daemonService.lockPath,
      databasePath: dataPaths.databasePath,
      waitForReleaseMs: 2000,
    });
    if (retry.outcome === 'refused') {
      logger.info(LOG_KINDS.DAEMON_START, 'Lifecycle lock taken by another contender during eviction — stepping aside', {
        holder_pid: retry.holderPid,
      });
      process.exit(0);
    }
    daemonLifecycleLock = retry.lock;
    logger.info(LOG_KINDS.DAEMON_START, 'Lifecycle lock acquired after eviction', { lock_path: daemonService.lockPath });
  } else {
    // Acquired on the first try (or during the wait window). Skip the
    // legacy reconcile path — flock denied none.
    daemonLifecycleLock = lockResult.lock;
    logger.info(LOG_KINDS.DAEMON_START, 'Lifecycle lock acquired', { lock_path: daemonService.lockPath });
  }

  logger.info(LOG_KINDS.DAEMON_CONFIG, 'Config loaded', {
    vault: bootstrapVaultDir,
    daemon_state: daemonService.statePath,
    embedding_provider: config.embedding.provider,
  });
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
  const db = initDatabase(dataPaths.databasePath);
  createSchema(db, machineId);
  registerBuiltinDomains();
  // Boot-DB sweep only — the Grove fan-out for any other registered
  // Groves runs after `runtimeCache` is built (see "interrupt stale runs
  // across registered Groves" below).
  const interruptedRuns = markRunningRunsInterrupted('Daemon restarted before the run completed', { kind: 'all' });
  if (interruptedRuns > 0) {
    logger.warn(LOG_KINDS.AGENT_RUN, 'Marked stale running runs as resumable after daemon restart', {
      count: interruptedRuns,
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

  const server = new DaemonServer({
    vaultDir: bootstrapVaultDir,
    logger,
    daemonStateAuthority,
    uiDir: uiDir ?? undefined,
    uiDevProxyTarget: uiDevProxyTarget ?? undefined,
    runtimeCache,
    // Don't record activity on every HTTP request — UI polling (every 3-10s)
    // would prevent the PowerManager from ever reaching 'idle' state, blocking
    // all idle-only scheduled tasks (skill-survey, skill-generate, skill-evolve).
    // Activity is recorded on meaningful events below (session register, prompt capture, etc.).
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
    server, powerManager, machineId, logger, liveConfig, vaultDir: bootstrapVaultDir,
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
    powerManager,
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

  // --- Context injection (cortex brief + semantic spore search) ---
  let teamSync!: ReturnType<typeof initTeamSync>;
  const contextDeps = {
    vaultDir: bootstrapVaultDir,
    // Per-request grove resolution — never the bootstrap manager (anchor-leak
    // Variant A). Mirrors how /api/search and /api/embedding resolve runtime.
    resolveEmbeddingManager: (rc: MycoRequestContext | undefined) => getEmbeddingRuntime(rc).manager,
    liveConfig,
    logger,
    getTeamClient: () => teamSync.getTeamClient(),
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
    getTeamClient: () => teamSync.getTeamClient(),
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
      getTeamClient: () => teamSync.getTeamClient(),
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
  server.registerRoute('GET', '/api/groves', createListGrovesHandler(groveScope, groveDaemonStateDir));
  server.registerRoute('GET', '/api/groves/:id/projects', createListGroveProjectsHandler(groveScope, groveDaemonStateDir));
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

  const teamFallbackDeps = { getTeamClient: () => teamSync.getTeamClient(), machineId };
  server.registerRoute('GET', '/api/sessions/:id', createGetSessionHandler(teamFallbackDeps));
  const sessionMutations = createSessionMutationHandlers({ embeddingManager, resolveEmbeddingManager: (rc) => getEmbeddingRuntime(rc).manager, vaultDir: bootstrapVaultDir, logger, liveConfig, reconciler, registry });
  server.registerRoute('GET', '/api/sessions/:id/impact', sessionMutations.handleGetSessionImpact);
  server.registerRoute('POST', '/api/sessions/:id/complete', sessionMutations.handleCompleteSession);
  server.registerRoute('DELETE', '/api/sessions/:id', sessionMutations.handleDeleteSession);
  server.registerRoute('DELETE', '/api/plans/:id', sessionMutations.handleDeletePlan);
  server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
  server.registerRoute('GET', '/api/batches/:id/activities', handleGetBatchActivities);
  server.registerRoute('GET', '/api/sessions/:id/attachments', handleGetSessionAttachments);
  server.registerRoute('GET', '/api/sessions/:id/plans', handleGetSessionPlans);

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
      // createAgentRunHandlers.handleRun): build the instruction, fire
      // runAgent, then look up the run id that runAgent inserted
      // synchronously before its first await. This matches how the
      // scheduler enqueues canopy-map and keeps a single source of truth
      // for instruction assembly.
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
      const { getLatestRunId } = await import('../db/queries/runs.js');
      const { DEFAULT_AGENT_ID } = await import('../constants.js');

      const mycoConfig = liveConfig.current;
      const requestContext = dataPaths.requestContext;
      const projectId = rowProjectIdFromRequestContext(requestContext);
      if (projectId == null) {
        return { skipped: true, reason: 'canopy-map regenerate requires a project-scoped daemon context' };
      }
      const projectRoot = requestContext.projectRoot;
      const built = await buildCanopyMapInstructionDetailed(params, projectRoot, mycoConfig);

      if (built.kind === 'skip') {
        return { skipped: true, reason: built.reason };
      }

      const resultPromise = dispatchAgentRun(bootstrapVaultDir, {
        task,
        instruction: built.instruction,
        runContext: built.context,
        taskParams: params,
        agentId: DEFAULT_AGENT_ID,
        embeddingManager,
        requestContext,
        logger,
      });

      // runAgent inserts the agent_runs row synchronously before its first
      // await. Capture the id before letting the promise run unsupervised.
      const runId = getLatestRunId(DEFAULT_AGENT_ID, task, { kind: 'project', id: projectId });

      // Fire-and-forget — caller already has the run id; we don't block
      // the HTTP response on the LLM round-trip. Errors are logged so
      // they don't vanish.
      resultPromise.catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'canopy-map regenerate threw', {
          error: errorMessage(err),
        });
      });

      return { run_id: runId ?? '' };
    },
    runCanopyDescribeTask: async ({ task, params }) => {
      // Single-row canopy-describe dispatch — same shape as
      // runCanopyMapTask above. Map-phase source.args uses
      // params.canopy_entry_path to filter to that one entry.
      const { buildTaskInstruction } = await import('../agent/instruction-builders.js');
      const { dispatchAgentRun } = await import('../agent/runner-host.js');
      const { getLatestRunId } = await import('../db/queries/runs.js');
      const { DEFAULT_AGENT_ID } = await import('../constants.js');

      const mycoConfig = liveConfig.current;
      const requestContext = dataPaths.requestContext;
      const projectId = rowProjectIdFromRequestContext(requestContext);
      if (projectId == null) {
        throw new Error('canopy-describe regenerate requires a project-scoped daemon context');
      }
      const projectRoot = requestContext.projectRoot;
      const built = await buildTaskInstruction(
        task,
        params,
        DEFAULT_AGENT_ID,
        projectRoot,
        embeddingManager,
        mycoConfig,
        () => teamSync.getTeamClient(),
        requestContext,
      );

      const resultPromise = dispatchAgentRun(bootstrapVaultDir, {
        task,
        instruction: built?.instruction,
        runContext: built?.context,
        taskParams: params,
        agentId: DEFAULT_AGENT_ID,
        embeddingManager,
        requestContext,
        logger,
      });

      const runId = getLatestRunId(DEFAULT_AGENT_ID, task, { kind: 'project', id: projectId });

      resultPromise.catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'canopy-describe redescribe threw', {
          error: errorMessage(err),
        });
      });

      return { run_id: runId ?? '' };
    },
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
  server.registerRoute('GET', '/api/spores/:id', createGetSporeHandler(teamFallbackDeps));
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
    getTeamClient: () => teamSync.getTeamClient(),
  });
  server.registerRoute('POST', '/api/agent/run', agentRunHandlers.handleRun);
  server.registerRoute('GET', '/api/agent/runs', agentRunHandlers.handleListRuns);
  server.registerRoute('GET', '/api/agent/runs/:id', agentRunHandlers.handleGetRun);
  server.registerRoute('POST', '/api/agent/runs/:id/resume', agentRunHandlers.handleResumeRun);
  server.registerRoute('GET', '/api/agent/runs/:id/reports', agentRunHandlers.handleGetRunReports);
  server.registerRoute('GET', '/api/agent/runs/:id/turns', agentRunHandlers.handleGetRunTurns);
  server.registerRoute('GET', '/api/agent/runs/:id/write-intents', agentRunHandlers.handleGetRunWriteIntents);
  server.registerRoute('GET', '/api/agent/runs/:id/audit', agentRunHandlers.handleGetRunAudit);

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

  // --- Team sync ---
  teamSync = initTeamSync({
    liveConfig,
    machineId,
    logger,
    vaultDir: bootstrapVaultDir,
    serverVersion: server.version,
    daemonStateDir: daemonService.stateDir,
    requestContext: dataPaths.requestContext,
  });
  reactions.on(['team'], async () => {
    await teamSync.reconcileClient();
  });
  await teamSync.reconcileClient();

  const teamHandlers = createTeamHandlers({
    vaultDir: bootstrapVaultDir,
    machineId,
    logger,
    getTeamClient: (requestContext) => teamSync.getTeamClient(requestContext),
    getTeamClientForId: (teamId) => teamSync.getTeamClientById(teamId),
    globalPrefix,
  });
  async function reconcileTeamRoute(req: RouteRequest): Promise<void> {
    await teamSync.reconcileClient(req.requestContext);
  }
  const listTeamMembersHandler = createListTeamMembersHandler({
    getTeamClientForId: (teamId) => teamSync.getTeamClientById(teamId),
  });
  const teamSelectionHandlers = createTeamSelectionHandlers();
  server.registerRoute('GET', '/api/team/registry', async (req) => teamSelectionHandlers.handleListTeams(req));
  server.registerRoute('GET', '/api/team/projects', async (req) => teamSelectionHandlers.handleListProjects(req));
  server.registerRoute('POST', '/api/team/project-membership', async (req) => {
    const result = teamSelectionHandlers.handleSetProjectMembership(req);
    if (!result.status || result.status < 400) {
      // Reconcile the Grove that actually owns the (re)assigned project, not the
      // ambient request Grove — membership is machine-wide on the Team page, so a
      // project can be assigned/removed from any Grove. reconcileGrove targets
      // that Grove (a no-op when the Grove lives in another daemon's home) and runs the
      // full backfill + flush so an assigned project starts syncing immediately
      // and a removed project's rows are purged immediately.
      const groveId = (req.body as { grove_id?: string } | undefined)?.grove_id ?? null;
      if (groveId) {
        await teamSync.reconcileGrove(runtimeCache, groveId);
      }
    }
    return result;
  });
  server.registerRoute('POST', '/api/team/connect', async (req) => {
    const result = await teamHandlers.handleConnect(req);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions(['team.enabled', 'team.worker_url'], {
        vaultDir: bootstrapVaultDir,
        groveId: req.requestContext?.groveId ?? dataPaths.requestContext.groveId,
      });
      await teamSync.reconcileClient(req.requestContext);
    }
    return result;
  });
  server.registerRoute('POST', '/api/team/join', async (req) => {
    const result = await teamHandlers.handleJoin(req);
    if (!result.status || result.status < 400) {
      await teamSync.reconcileClient(req.requestContext);
    }
    return result;
  });
  server.registerRoute('POST', '/api/team/forget', async (req) => {
    const result = await teamHandlers.handleForget(req);
    if (!result.status || result.status < 400) {
      await teamSync.reconcileClient(req.requestContext);
    }
    return result;
  });
  server.registerRoute('POST', '/api/team/disconnect', async (req) => {
    const result = await teamHandlers.handleDisconnect(req);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions(['team.enabled', 'team.worker_url'], {
        vaultDir: bootstrapVaultDir,
        groveId: req.requestContext?.groveId ?? dataPaths.requestContext.groveId,
      });
      await teamSync.reconcileClient(req.requestContext);
    }
    return result;
  });
  server.registerRoute('GET', '/api/team/status', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleStatus(req);
  });
  server.registerRoute('GET', '/api/team/members', async (req) => {
    await reconcileTeamRoute(req);
    return listTeamMembersHandler(req);
  });
  server.registerRoute('POST', '/api/team/backfill', async (req) => {
    const startedAt = Date.now();
    await reconcileTeamRoute(req);
    const result = await teamHandlers.handleBackfill(req);
    if (result.status && result.status >= 400) return result;
    const flush = await teamSync.flushPending(req.requestContext);
    const durationMs = Date.now() - startedAt;
    const resultBody = result.body as Record<string, unknown>;
    logger.info(LOG_KINDS.TEAM_SYNC_HANDOFF, 'Team sync handoff complete', {
      mode: typeof resultBody.mode === 'string' ? resultBody.mode : null,
      enqueued: typeof resultBody.enqueued === 'number' ? resultBody.enqueued : null,
      flushed: flush.handedOff,
      rejected: flush.rejected,
      batches: flush.batches,
      duration_ms: durationMs,
      error: flush.error ?? null,
    });
    return {
      ...result,
      body: {
        ...resultBody,
        flushed: flush.handedOff,
        rejected: flush.rejected,
        batches: flush.batches,
        duration_ms: durationMs,
        flush_error: flush.error ?? null,
      },
    };
  });
  server.registerRoute('POST', '/api/team/rotate-mcp-token', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleRotateMcpToken(req);
  });
  server.registerRoute('GET', '/api/team/queue-stats', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleQueueStats(req);
  });
  server.registerRoute('GET', '/api/team/sync-summary', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleSyncSummary(req);
  });
  server.registerRoute('GET', '/api/team/dlq', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleDlqList(req);
  });
  server.registerRoute('POST', '/api/team/dlq/retry', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleDlqRetry(req);
  });
  server.registerRoute('POST', '/api/team/dlq/discard', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleDlqDiscard(req);
  });
  // POST /api/team/rebuild — destructive one-way repair: truncate this
  // machine's cloud mirror (D1 + Vectorize), then re-push the full local
  // Grove. The local Grove is the source of truth; we re-push rather than
  // reconcile. Retired the old drift-reconciler endpoint in favour of this.
  server.registerRoute('POST', '/api/team/rebuild', async (req) => {
    await reconcileTeamRoute(req);
    const result = await teamSync.rebuildFromLocal(req.requestContext);
    return { status: result.error ? 502 : 200, body: { ok: !result.error, ...result } };
  });
  // POST /api/team/reconcile — operator-confirmed symmetric reconcile. Runs the
  // count-first reconcile across every owned (grove, project) partition with
  // operatorConfirmed=true: the settledness guards (empty local set, unseeded
  // membership) still block, but the magnitude caps (per-partition floor,
  // fraction, aggregate) are bypassed so an operator can heal large genuine
  // drift the automatic path leaves for a human. The automatic path runs
  // continuously via reconcileClient triggers + the team-sync-reconcile backstop.
  server.registerRoute('POST', '/api/team/reconcile', async (req) => {
    await reconcileTeamRoute(req);
    const result = await teamSync.reconcileAllGroves(runtimeCache, true);
    return { status: 200, body: { ok: true, deletes: result.deletes } };
  });

  const collectiveHandlers = createCollectiveHandlers({
    getTeamClient: () => teamSync.getTeamClient(),
  });
  server.registerRoute('GET', '/api/collective/status', collectiveHandlers.handleStatus);
  server.registerRoute('GET', '/api/collective/search', collectiveHandlers.handleSearch);
  server.registerRoute('GET', '/api/collective/projects', collectiveHandlers.handleProjects);
  server.registerRoute('GET', '/api/collective/project', collectiveHandlers.handleProject);
  server.registerRoute('GET', '/api/collective/settings', collectiveHandlers.handleSettings);

  // --- Search, activity feed, and embedding status ---

  // Dual-mode read: a caller-supplied context scopes to its project; a
  // context-less request scopes to GLOBAL_SCOPE and returns no project rows.
  // Fail-loud on unresolved tenancy is enforced in the tools layer, not here.
  const searchHandler = createSearchHandler({
    embeddingManager,
    resolveEmbeddingManager: (requestContext) => getEmbeddingRuntime(requestContext).manager,
    getTeamClient: (requestContext) => teamSync.getTeamClient(requestContext),
    machineId,
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

  // Reconcile team_sync_state.enabled for every registered Grove BEFORE the
  // port is bound. reconcileClient() above only arms the boot Grove's flag;
  // non-boot Groves' flags stay at their persisted default until their first
  // flush tick — a window where deletes on those Groves are not journaled to
  // team_outbox (the AFTER DELETE triggers gate on this flag, and deletes have
  // no backfill safety net, so an un-journaled delete is permanently
  // un-mirrored). Awaiting this before server.start() guarantees every Grove's
  // delete triggers are armed before any HTTP traffic can issue a delete. The
  // flag writes fan out concurrently (parallel) and a single Grove's failure is
  // isolated + logged inside forEachGrove, so this neither blocks startup long
  // nor aborts on one bad Grove. No push, no client creation.
  try {
    await teamSync.reconcileAllGroveFlags(runtimeCache);
  } catch (err) {
    logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Boot-time Grove flag reconcile failed', {
      error: errorMessage(err),
    });
  }

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
      if (sibling !== null && sibling.version === getPluginVersion()) {
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
  teamSync.registerFlushJob(jobRunner, runtimeCache);

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
      const { markRunningRunsInterrupted: markStale } = await import('../db/queries/runs.js');
      await forEachGrove(
        runtimeCache,
        logger,
        ({ grove }) => {
          if (grove.id === dataPaths.requestContext.groveId) return;
          const count = markStale('Daemon restarted before the run completed', { kind: 'all' });
          if (count > 0) {
            logger.warn(LOG_KINDS.AGENT_RUN, 'Marked stale running runs as resumable after daemon restart', {
              count,
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

  // Sweep orphaned per-project pauses before any worker loops start.
  // A pause older than the staleness threshold is by definition abandoned —
  // the previous daemon held the lock and died without resuming. See
  // startup-pauses.ts for the carve-out + remove-when condition.
  try {
    const sweep = resumeOrphanedPauses(logger);
    if (sweep.resumed > 0 || sweep.preserved > 0) {
      logger.info(LOG_KINDS.DAEMON_START, 'Orphan pause sweep complete', {
        scanned: sweep.scanned,
        resumed: sweep.resumed,
        preserved: sweep.preserved,
      });
    }
  } catch (err) {
    logger.warn(LOG_KINDS.DAEMON_START, 'Orphan pause sweep failed', {
      error: errorMessage(err),
    });
  }

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
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) {
      logger.info(LOG_KINDS.DAEMON_START, `${signal} received during in-progress shutdown; awaiting prior signal`);
      return shutdownPromise;
    }
    shutdownPromise = runShutdown(signal);
    return shutdownPromise;
  };

  const runShutdown = async (signal: string) => {
    logger.info(LOG_KINDS.DAEMON_START, `${signal} received`);
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
    // Drain pending team-sync outbox rows across every Grove before
    // closing DBs. Without this, SIGTERM/suspend leaves rows queued
    // locally with no trigger to retry until the next daemon boot. The
    // RunnerJob fans out the same way (see team-sync-init.ts:registerFlushJob).
    try {
      const aggregate = await teamSync.flushAllGroves(runtimeCache);
      if (aggregate.flushed > 0 || aggregate.rejected > 0 || aggregate.errors > 0) {
        logger.info(LOG_KINDS.TEAM_SYNC_COMPLETE, 'Team-sync drain at shutdown', {
          groves: aggregate.groves,
          flushed: aggregate.flushed,
          rejected: aggregate.rejected,
          batches: aggregate.batches,
          errors: aggregate.errors,
        });
      }
    } catch (err) {
      logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Team-sync drain at shutdown failed', {
        error: errorMessage(err),
      });
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

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Cooperative cross-process shutdown. A successor daemon (reconcile takeover)
  // or the updater POSTs /api/shutdown to run THIS graceful path on Windows,
  // where a cross-process SIGTERM is an uncatchable TerminateProcess and the
  // signal handlers above never fire. Wired here, after `shutdown` exists.
  server.onShutdownRequest(() => { void shutdown('shutdown-request'); });
}

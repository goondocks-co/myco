/**
 * Session register/unregister route handlers.
 *
 * Factory pattern: `createSessionLifecycleHandlers(deps)` returns handlers
 * that close over the daemon's shared state for session management.
 *
 * Route overview:
 *   POST /sessions/register   — register a new or reloaded session
 *   POST /sessions/unregister — unregister a session (authoritative close)
 */

import { z } from 'zod';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { SessionRegistry } from '../lifecycle.js';
import type { DaemonLogger } from '../logger.js';
import type { DaemonServer } from '../server.js';
import type { PowerManager } from '../power.js';
import type { EventBuffer } from '@myco/capture/buffer.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { resolveTenantConfig } from '../request-config.js';
import { cleanStaleBuffers } from '@myco/capture/buffer.js';
import { closeSession, updateSession, getSession } from '@myco/db/queries/sessions.js';
import { ensureSession, ENSURE_SESSION_SOURCE } from '../session-lifecycle.js';
import { notify } from '@myco/notifications/notify.js';
import { epochSeconds, STALE_BUFFER_MAX_AGE_MS } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { projectScopeFromRequestContext, rowProjectIdFromRequestContext } from '@myco/tools/request-context.js';
import { errorMessage } from '@myco/utils/error-message.js';
import type { CanopyJobsRegistry } from '../jobs/canopy-scan.js';
import { assertGroveProjectId, isGroveEraId, ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import type { ProjectPowerStateTracker } from '../project-power-state.js';
import { deferGitProvenance } from '@myco/release-provenance/capture.js';
import { primaryProductionRef } from '@myco/release-provenance/config.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const RegisterBody = z.object({
  session_id: z.string(),
  agent: z.string().optional(),
  branch: z.string().optional(),
  started_at: z.string().optional(),
});

export const UnregisterBody = z.object({ session_id: z.string() });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionLifecycleDeps {
  registry: SessionRegistry;
  sessionBuffers: Map<string, EventBuffer>;
  reconciler: { reconcileSession: (sessionId: string) => void; clearSession: (sessionId: string) => void };
  stopProcessor: { clearSession: (sessionId: string) => void };
  /**
   * The authoritative "converge DB to transcript" operation, shared with the
   * Stop and live-reconcile paths. Run at SessionEnd so the FINAL turn's
   * response is attributed even when that turn produced no trailing tool event
   * and fired no clean per-turn Stop (interrupt + /exit, force-quit). Without
   * this, a response sitting complete in the transcript is never lifted into
   * `response_summary` — the steering/final-summary capture gap.
   */
  transcriptMiner: { reconcileAndAttributeResponses: (sessionId: string, input: { agent: string; transcriptPath: string }) => unknown };
  server: DaemonServer;
  powerManager: PowerManager;
  machineId: string;
  logger: DaemonLogger;
  // Holder so notify() consults the current merged config — a user toggling
  // notifications.enabled or a domain's enabled flag sees the next event gate
  // respect the change without a daemon restart.
  liveConfig: { current: MycoConfig };
  vaultDir: string;
  /**
   * Holder for the project-keyed canopy registry. Populated after
   * `registerPowerJobs` has run. The register handler looks up (or
   * materializes) the runner for the request's project and triggers a
   * fire-and-forget delta refresh so the index stays current with on-disk
   * changes that happened between sessions.
   */
  canopyRegistry?: CanopyJobsRegistry;
  /**
   * Per-project power state. SessionStart counts as activity for the
   * request's project, lifting it back to `active` if it had drifted
   * to `idle`/`sleep`/`deep_sleep`. The global PowerManager still
   * receives `recordActivity()` so Grove-level housekeeping ticks
   * stay responsive too.
   */
  projectStateTracker?: ProjectPowerStateTracker;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionLifecycleHandlers(deps: SessionLifecycleDeps) {
  const {
    registry,
    sessionBuffers,
    reconciler,
    stopProcessor,
    transcriptMiner,
    server,
    powerManager,
    machineId,
    logger,
    liveConfig,
    vaultDir,
  } = deps;

  // Read through `deps` on every register call so the holder set after
  // registerPowerJobs becomes visible to subsequent SessionStart events.
  const canopyRegistryHolder = (): CanopyJobsRegistry | undefined => deps.canopyRegistry;

  /** POST /sessions/register */
  async function handleRegister(req: RouteRequest): Promise<RouteResponse> {
    powerManager.recordActivity();
    // Per-project activity: SessionStart counts as foreground attention
    // on this project. The global recordActivity above keeps the
    // PowerManager's tick loop responsive; the per-project tracker keeps
    // *this* project's state machine warm so its scheduled tasks fire.
    {
      const ctxProjectId = req.requestContext?.projectId;
      const ctxGroveId = req.requestContext?.groveId;
      if (
        deps.projectStateTracker &&
        ctxProjectId &&
        isGroveEraId(ctxProjectId, 'project') &&
        ctxGroveId
      ) {
        deps.projectStateTracker.recordActivity(
          ctxGroveId,
          assertGroveProjectId(ctxProjectId),
        );
      }
    }
    const { session_id, agent, branch, started_at } = RegisterBody.parse(req.body);
    const resolvedStartedAt = started_at ?? new Date().toISOString();
    const projectId = rowProjectIdFromRequestContext(req.requestContext);
    const projectRoot = req.requestContext?.projectRoot ?? resolveProjectRoot(vaultDir);
    const requestMachineId = req.requestContext?.machineId ?? machineId;
    // Persist + register through the single lifecycle helper. Pre-fix this
    // call site registered in memory FIRST and upserted second, which
    // poisoned the registry whenever the DB persist later threw.
    ensureSession({
      sessionId: session_id,
      agent: agent ?? 'claude-code',
      projectId,
      projectRoot,
      machineId: requestMachineId,
      startedAt: resolvedStartedAt,
      registry,
      logger,
      source: ENSURE_SESSION_SOURCE.API,
    });
    // `branch` is only carried on this API path (hooks discover it via
    // git provenance separately). Apply it as a follow-up update so the
    // ensureSession contract stays minimal.
    if (branch) {
      updateSession(session_id, { branch }, projectScopeFromRequestContext(req.requestContext));
    }
    server.updateDaemonJsonSessions(registry.sessions);
    // Clear ended_at if session was previously completed (reload scenario)
    updateSession(session_id, { ended_at: null, status: 'active' }, projectScopeFromRequestContext(req.requestContext));

    // Reconcile buffer against DB — recover prompts lost if daemon was down mid-session.
    reconciler.reconcileSession(session_id);

    const scope = projectScopeFromRequestContext(req.requestContext);
    deferGitProvenance(
      {
        projectRoot,
        projectId,
        machineId: requestMachineId,
        sessionId: session_id,
        capturePoint: 'session_start',
        productionRef: primaryProductionRef(resolveTenantConfig(req.requestContext, liveConfig.current)),
        logger,
      },
      (provenance) => {
        if (!branch && provenance?.branch) {
          updateSession(session_id, { branch: provenance.branch }, scope);
        }
      },
    );

    logger.info(LOG_KINDS.LIFECYCLE_REGISTER, 'Session registered', { session_id, branch: branch ?? null, started_at: started_at ?? null });

    notify(vaultDir, {
      domain: 'sessions',
      type: 'session.started',
      title: 'Session started',
      message: branch ? `Branch: ${branch}` : undefined,
      link: `/sessions/${session_id}`,
      metadata: { sessionId: session_id, agent: agent ?? 'claude-code', branch },
    }, liveConfig.current);

    // Fire-and-forget canopy delta refresh for the project this session
    // belongs to. The runner debounces internally, so multiple registers
    // (re-attaches, fast switches) collapse cleanly. Only triggers when
    // the request context carries a fully-resolved Grove project; the
    // legacy `LOCAL_PROJECT_ID` boot path keeps quiet because its runner
    // identity isn't tied to a registered project entry.
    const canopyRegistry = canopyRegistryHolder();
    const requestProjectId = req.requestContext?.projectId ?? null;
    const requestDatabasePath = req.requestContext?.databasePath ?? null;
    const requestGroveId = req.requestContext?.groveId ?? null;
    if (canopyRegistry && requestProjectId && requestDatabasePath && requestGroveId) {
      try {
        const groveProjectId = assertGroveProjectId(requestProjectId);
        const runner = canopyRegistry.ensureRunner({
          databasePath: requestDatabasePath,
          projectId: groveProjectId,
          projectRoot,
          groveId: requestGroveId,
        });
        runner.run().catch((err) => {
          logger.warn(LOG_KINDS.LIFECYCLE_REGISTER, 'Canopy delta scan failed on register', {
            error: errorMessage(err),
            project_id: groveProjectId,
          });
        });
      } catch {
        // Boot/legacy contexts use a non-Grove project id (e.g.
        // LOCAL_PROJECT_ID); skip silently rather than re-thrread an
        // identity check the boot path is intentionally lax about.
      }
    }

    return { body: { ok: true, sessions: registry.sessions } };
  }

  /** POST /sessions/unregister */
  async function handleUnregister(req: RouteRequest): Promise<RouteResponse> {
    const { session_id } = UnregisterBody.parse(req.body);
    deferGitProvenance({
      projectRoot: req.requestContext?.projectRoot ?? resolveProjectRoot(vaultDir),
      projectId: rowProjectIdFromRequestContext(req.requestContext),
      machineId: req.requestContext?.machineId ?? machineId,
      sessionId: session_id,
      capturePoint: 'session_end',
      productionRef: primaryProductionRef(resolveTenantConfig(req.requestContext, liveConfig.current)),
      logger,
    });
    registry.unregister(session_id);
    // Opportunistically clean stale buffers for OTHER sessions (>24h).
    // We do NOT delete THIS session's buffer — session reload reuses the same ID.
    const bufferDir = `${vaultDir}/buffer`;
    cleanStaleBuffers(bufferDir, STALE_BUFFER_MAX_AGE_MS, session_id);

    // Final convergence at the authoritative turn boundary. The per-turn Stop
    // hook converges each COMPLETED turn, but a turn interrupted mid-response
    // (the user steers/aborts, then the session ends) fires no clean Stop — so
    // its response, though already complete in the transcript, was never
    // attributed. SessionEnd is the last boundary at which we can lift it.
    // Best-effort and idempotent: re-running over an already-attributed
    // transcript is a no-op. Runs BEFORE closeSession so the converged rows are
    // in place when the session is marked ended.
    try {
      const ending = getSession(session_id, ALL_PROJECTS_SCOPE);
      if (ending?.agent && ending.transcript_path) {
        transcriptMiner.reconcileAndAttributeResponses(session_id, {
          agent: ending.agent,
          transcriptPath: ending.transcript_path,
        });
      }
    } catch (err) {
      logger.warn(LOG_KINDS.LIFECYCLE_UNREGISTER, 'SessionEnd transcript convergence failed', {
        session_id, error: errorMessage(err),
      });
    }

    // Close the session in SQLite — this is the authoritative end-of-session.
    // The Stop hook fires per-turn and does NOT close the session.
    closeSession(session_id, epochSeconds());

    // Prune in-memory state
    sessionBuffers.delete(session_id);
    stopProcessor.clearSession(session_id);
    reconciler.clearSession(session_id);
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info(LOG_KINDS.LIFECYCLE_UNREGISTER, 'Session unregistered', { session_id });

    notify(vaultDir, {
      domain: 'sessions',
      type: 'session.ended',
      title: 'Session ended',
      link: `/sessions/${session_id}`,
      metadata: { sessionId: session_id },
    }, liveConfig.current);

    return { body: { ok: true, sessions: registry.sessions } };
  }

  return { handleRegister, handleUnregister };
}

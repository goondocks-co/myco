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
import type { RouteResponse } from '../router.js';
import type { SessionRegistry } from '../lifecycle.js';
import type { DaemonLogger } from '../logger.js';
import type { DaemonServer } from '../server.js';
import type { PowerManager } from '../power.js';
import type { EventBuffer } from '@myco/capture/buffer.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { cleanStaleBuffers } from '@myco/capture/buffer.js';
import { upsertSession, closeSession, updateSession } from '@myco/db/queries/sessions.js';
import { notify } from '@myco/notifications/notify.js';
import { epochSeconds, STALE_BUFFER_MAX_AGE_MS } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

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
  server: DaemonServer;
  powerManager: PowerManager;
  machineId: string;
  logger: DaemonLogger;
  // Holder so notify() consults the current merged config — a user toggling
  // notifications.enabled or a domain's enabled flag sees the next event gate
  // respect the change without a daemon restart.
  liveConfig: { current: MycoConfig };
  vaultDir: string;
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
    server,
    powerManager,
    machineId,
    logger,
    liveConfig,
    vaultDir,
  } = deps;

  /** POST /sessions/register */
  async function handleRegister(req: { body: unknown }): Promise<RouteResponse> {
    powerManager.recordActivity();
    const { session_id, agent, branch, started_at } = RegisterBody.parse(req.body);
    const resolvedStartedAt = started_at ?? new Date().toISOString();
    registry.register(session_id, { started_at: resolvedStartedAt, branch });
    server.updateDaemonJsonSessions(registry.sessions);

    // Upsert session in SQLite — always reset to active on register
    const now = epochSeconds();
    const startedEpoch = Math.floor(new Date(resolvedStartedAt).getTime() / 1000);
    upsertSession({
      id: session_id,
      agent: agent ?? 'claude-code',
      user: null,
      project_root: process.cwd(),
      branch: branch ?? null,
      started_at: startedEpoch,
      created_at: now,
      status: 'active',
      machine_id: machineId,
    });
    // Clear ended_at if session was previously completed (reload scenario)
    updateSession(session_id, { ended_at: null, status: 'active' });

    // Reconcile buffer against DB — recover prompts lost if daemon was down mid-session.
    reconciler.reconcileSession(session_id);

    logger.info(LOG_KINDS.LIFECYCLE_REGISTER, 'Session registered', { session_id, branch, started_at: started_at ?? null });

    notify(vaultDir, {
      domain: 'sessions',
      type: 'session.started',
      title: 'Session started',
      message: branch ? `Branch: ${branch}` : undefined,
      link: `/sessions/${session_id}`,
      metadata: { sessionId: session_id, agent: agent ?? 'claude-code', branch },
    }, liveConfig.current);

    return { body: { ok: true, sessions: registry.sessions } };
  }

  /** POST /sessions/unregister */
  async function handleUnregister(req: { body: unknown }): Promise<RouteResponse> {
    const { session_id } = UnregisterBody.parse(req.body);
    registry.unregister(session_id);
    // Opportunistically clean stale buffers for OTHER sessions (>24h).
    // We do NOT delete THIS session's buffer — session reload reuses the same ID.
    const bufferDir = `${vaultDir}/buffer`;
    cleanStaleBuffers(bufferDir, STALE_BUFFER_MAX_AGE_MS, session_id);
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

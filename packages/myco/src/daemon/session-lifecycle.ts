/**
 * Single source of truth for registering a session with the daemon.
 *
 * Background — the bug this exists to prevent:
 * Before this helper, two separate paths could add a session to the
 * in-memory `SessionRegistry`:
 *   1. `event-dispatch.ts` on user_prompt — also called `upsertSession()`
 *      so the DB row existed.
 *   2. `stop-processing.ts` on stop — registered in memory but did NOT
 *      call `upsertSession()`.
 *
 * When Codex's first event after a daemon restart was a Stop, path (2)
 * left the registry holding a session_id with no matching `sessions` row.
 * The very next prompt then took path (1)'s early-return branch (because
 * the registry already had the session), skipped its upsert, and tried to
 * insert a `prompt_batches` row whose FK referenced a session that didn't
 * exist. Every downstream write failed with `FOREIGN KEY constraint
 * failed` for the rest of the session's life.
 *
 * The invariant — "session in registry ⇒ session row exists in DB" — was
 * implicit. It now has a name and one enforced entry point. Anything that
 * mutates the registry must go through `ensureSession`. Tests assert
 * direct `registry.register` calls don't appear outside this file.
 *
 * Failure semantics:
 *   - DB persistence is attempted first; the registry is updated only on
 *     success. If the DB upsert throws (cross-grove rejection, locked
 *     database, schema constraint), the registry is NOT poisoned with a
 *     ghost entry, and the error is logged at ERROR level so it surfaces
 *     in `myco logs` immediately.
 *   - The error is then re-thrown so the calling route returns 500 and
 *     the hook caller can retry rather than silently dropping events.
 */
import type { Logger } from '@myco/log/logger.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { epochSeconds } from '@myco/constants.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { SessionRegistry } from './lifecycle.js';

export interface EnsureSessionParams {
  sessionId: string;
  agent: string;
  projectId?: string | null;
  projectRoot?: string | null;
  machineId: string;
  /** ISO 8601 timestamp from the inbound event; falls back to `now`. */
  startedAt?: string;
  registry: SessionRegistry;
  logger: Logger;
  /**
   * Tag identifying which code path invoked this — included in logs so
   * post-mortem analysis can tell whether the session was first seen via
   * a Prompt, a Stop, a session-start hook, or a manual API call.
   */
  source: 'user_prompt' | 'stop' | 'session_start' | 'tool_use' | 'api' | 'backfill';
}

/**
 * Persist the session row, then add it to the in-memory registry.
 *
 * Idempotent: subsequent calls for the same `sessionId` re-upsert (which
 * is a no-op when the row already exists) and re-`register` (which is a
 * no-op when the registry already has the id).
 *
 * Throws on DB failure after logging — callers should let the throw
 * propagate so the HTTP layer returns 500 rather than fabricating success.
 */
export function ensureSession(params: EnsureSessionParams): void {
  const startedEpoch = params.startedAt
    ? Math.floor(new Date(params.startedAt).getTime() / 1000)
    : epochSeconds();
  const now = epochSeconds();

  try {
    upsertSession({
      id: params.sessionId,
      project_id: params.projectId ?? null,
      agent: params.agent,
      project_root: params.projectRoot ?? null,
      status: 'active',
      started_at: startedEpoch,
      created_at: now,
      machine_id: params.machineId,
    });
  } catch (err) {
    params.logger.error(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'ensureSession: failed to persist session row', {
      session_id: params.sessionId,
      source: params.source,
      project_id: params.projectId ?? null,
      machine_id: params.machineId,
      error: (err as Error).message,
    });
    throw err;
  }

  params.registry.register(params.sessionId, {
    started_at: params.startedAt ?? new Date().toISOString(),
  });
}

/**
 * Session-lifecycle invariants.
 *
 * # Source-of-truth ordering (read this if you're tempted to gate writes on
 * # `registry.getSession()`)
 *
 * Inbound events + the SQLite DB are the **only** sources of truth for
 * capture data. The on-disk event buffer is the durability fallback that
 * survives daemon restarts. The in-memory `SessionRegistry` is a **cache**
 * — useful for cheap "is this session active in this daemon's runtime"
 * checks, but it must **never** gate a side effect that would otherwise
 * persist data.
 *
 * Concretely:
 *
 *   1. **DB is the source of truth.** Every FK-dependent write
 *      (prompt_batches, activities, etc.) requires its `sessions.id`
 *      parent to exist. That row must be persisted **before** the write
 *      attempts the FK.
 *   2. **Registry is an optimization.** It can be wrong (stale entries,
 *      missing entries after restart, missing entries after a failed
 *      upsert). A cache miss should never cause data loss; a cache hit
 *      should never be the reason a persist step is skipped.
 *   3. **Buffer is the durability fallback.** Events persist to disk
 *      before any in-memory state changes, so a daemon crash mid-event
 *      doesn't drop the inbound payload.
 *
 * # Why this file exists
 *
 * Pre-fix, two separate paths could add a session to the registry:
 *
 *   - `event-dispatch.ts` on user_prompt / tool_use — also called
 *     `upsertSession()`, so the DB row existed.
 *   - `stop-processing.ts` on Stop — registered in memory but did **not**
 *     call `upsertSession()`.
 *
 * When Codex's first event after a daemon restart was a Stop (its normal
 * pattern between sub-invocations), path 2 left the registry holding a
 * `session_id` with no matching `sessions` row. The very next prompt took
 * path 1's "skip-because-registry-has-it" early-return branch, skipped
 * its upsert, and tried to insert a `prompt_batches` row whose FK
 * referenced a session that didn't exist. Every downstream insert failed
 * with `FOREIGN KEY constraint failed` for the rest of the session's
 * life.
 *
 * That bug was the symptom. The real problem was the implicit invariant
 * "session in registry ⇒ session row exists in DB" — load-bearing on
 * developer memory across multiple files with no compiler check.
 *
 * # Contract
 *
 * - `ensureSession()` — explicit lifecycle event (start / Stop /
 *   /sessions/register API call). Upserts the row with full metadata,
 *   then caches in the registry. Errors loudly and re-throws.
 * - `ensureSessionRowExists()` — defensive, idempotent INSERT-IF-MISSING
 *   meant to be called at the top of every event handler **before** any
 *   FK-dependent write. Cheap (PK lookup), safe (writes nothing when the
 *   row exists), and does NOT trust the registry. The whole point of
 *   this function is that "the cache says we know about this session" is
 *   not allowed to skip the persist step.
 *
 * Failure semantics:
 *   - DB persistence is attempted first; the registry is updated only on
 *     success.
 *   - If the DB write throws (cross-grove rejection, locked database,
 *     schema constraint), the registry is NOT poisoned, the error is
 *     logged at ERROR level, and the throw propagates so the HTTP layer
 *     returns 500. We never fabricate success for a failed persist.
 */
import type { Logger } from '@myco/log/logger.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { epochSeconds, DEFAULT_SYMBIONT_NAME } from '@myco/constants.js';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
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

export interface EnsureSessionRowExistsParams {
  sessionId: string;
  /** Best-effort agent label, used only when we have to create the row. */
  agent?: string;
  projectId?: string | null;
  projectRoot?: string | null;
  machineId: string;
  logger: Logger;
  /**
   * Where in the pipeline this defensive ensure was called from — surfaces
   * in the WARN log so post-mortems can tell which upstream handler missed
   * its responsibility.
   */
  source: 'user_prompt' | 'tool_use' | 'activity' | 'batch';
}

/**
 * Defensive idempotent "make sure the sessions.id row exists" check.
 *
 * Call this at the top of every event handler **before** any FK-dependent
 * insert. It does not trust the in-memory registry: the whole point is
 * that "cache says we know about this session" is not allowed to skip the
 * persist step. A cheap PK lookup decides whether to no-op (row already
 * persisted upstream — the happy path) or to create a minimal row (row
 * was missing despite cache claim — log a WARN so the upstream gap
 * surfaces, then keep the FK insert from failing).
 *
 * This pairs with `ensureSession()`: the explicit lifecycle path
 * (session_start / Stop / API register) should run first and supply rich
 * metadata. This function is the belt-and-suspenders layer in case any
 * future code path forgets.
 *
 * Returns `true` if the row was just created (an upstream miss was just
 * recovered), `false` if it already existed (the common case).
 */
export function ensureSessionRowExists(params: EnsureSessionRowExistsParams): boolean {
  // PK lookup — cheap, returns null if the row is missing.
  const existing = getSession(params.sessionId, ALL_PROJECTS_SCOPE);
  if (existing) return false;

  // The row is missing. Upstream auto-register didn't run (or threw). Log
  // loudly so the gap doesn't repeat silently, then persist a minimal
  // row so the immediately-following FK-dependent insert can proceed.
  params.logger.warn(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'ensureSessionRowExists: row missing despite event arrival — defensive insert', {
    session_id: params.sessionId,
    source: params.source,
    project_id: params.projectId ?? null,
  });

  const now = epochSeconds();
  try {
    upsertSession({
      id: params.sessionId,
      project_id: params.projectId ?? null,
      agent: params.agent ?? DEFAULT_SYMBIONT_NAME,
      project_root: params.projectRoot ?? null,
      status: 'active',
      started_at: now,
      created_at: now,
      machine_id: params.machineId,
    });
  } catch (err) {
    params.logger.error(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'ensureSessionRowExists: defensive insert failed', {
      session_id: params.sessionId,
      source: params.source,
      error: (err as Error).message,
    });
    throw err;
  }
  return true;
}

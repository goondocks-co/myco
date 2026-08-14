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
import type { Logger } from './logger.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { epochSeconds, DEFAULT_SYMBIONT_NAME } from '@myco/constants.js';
import { upsertSession, getSession, updateSession } from '@myco/db/queries/sessions.js';
import { hasSessionTombstone } from '@myco/db/queries/session-tombstones.js';
import { findTranscriptFor } from '@myco/symbionts/transcript-discovery.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import type { SessionRegistry } from './lifecycle.js';

/**
 * Tags identifying which code path invoked one of the session-ensure
 * helpers. Surfaced in WARN logs so post-mortems can tell which
 * upstream handler missed its responsibility. Magic-string unions
 * have repeatedly drifted in this codebase — keeping the canonical
 * list here behind a typed constant matches the same discipline as
 * `BATCH_KIND` / `PROMPT_BATCH_ORIGIN` / `CANDIDATE_STATUS`.
 */
export const ENSURE_SESSION_SOURCE = {
  /** Upstream `/events/user_prompt` route or its dispatcher branch. */
  USER_PROMPT: 'user_prompt',
  /** Stop hook processing. */
  STOP: 'stop',
  /** SessionStart hook (or symbiont-equivalent). */
  SESSION_START: 'session_start',
  /** Activity insert / tool_use event. */
  TOOL_USE: 'tool_use',
  /** Catch-all for synthetic activity rows (e.g. injections). */
  ACTIVITY: 'activity',
  /** Batch insert. */
  BATCH: 'batch',
  /** Manual API call (e.g. `/api/sessions/:id/complete`). */
  API: 'api',
  /** Backfill / migration code paths. */
  BACKFILL: 'backfill',
  /** `/context` cortex serve path (race against `/sessions/register`). */
  CONTEXT: 'context',
  /** Buffer reconciler resurrecting a gate-passing session from its buffer. */
  RECONCILE: 'reconcile',
} as const;

export type EnsureSessionSource = (typeof ENSURE_SESSION_SOURCE)[keyof typeof ENSURE_SESSION_SOURCE];

export interface EnsureSessionParams {
  sessionId: string;
  agent: string;
  projectId?: string | null;
  projectRoot?: string | null;
  machineId: string;
  /** ISO 8601 timestamp from the inbound event; falls back to `now`. */
  startedAt?: string;
  /**
   * Structural slice of SessionRegistry — only `register` is consumed, so
   * callers without the daemon's full registry (the buffer reconciler) can
   * satisfy the contract with the registry handle they were given.
   */
  registry: Pick<SessionRegistry, 'register'>;
  logger: Logger;
  /** Code path that invoked this — see {@link ENSURE_SESSION_SOURCE}. */
  source: EnsureSessionSource;
  /**
   * `transcript_path` carried by the event driving this ensure. Preferred over
   * manifest discovery — see {@link ensureTranscriptPath}.
   */
  transcriptPath?: string;
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
/**
 * Sessions this process has already attempted a transcript lookup for.
 *
 * The lookup walks a bounded set of manifest-declared paths, but it is disk
 * I/O on an event path, and a session that legitimately has no transcript
 * (plugin-reported agents) would otherwise repeat it on every event.
 */
const transcriptLookupAttempted = new Set<string>();

/**
 * Fill in `sessions.transcript_path`, preferring the path the hook already sent.
 *
 * Capture learns a transcript's location from the hook payload field named by
 * `hookFields.transcriptPath`. Two sources can supply it, in this order:
 *
 * 1. `hookTranscriptPath` — the value carried by the inbound event. Every
 *    Claude Code event carries one, and it is authoritative: it is the path
 *    the agent is writing to right now, whereas discovery only infers a path
 *    from the session id. Preferring it also covers the case discovery cannot
 *    reach at all — a transcript the agent has not flushed to disk yet, which
 *    is the normal state at SessionStart for a freshly-forked session.
 * 2. Manifest-declared discovery, when no event has carried a path. An agent
 *    that stores no transcript resolves to null and is not retried.
 *
 * Both sources write only into a row with NO path. Overwriting a set value is
 * the Stop path's job (`stop-processing.ts`), which owns the multi-phase
 * symbiont case; a passing tool_use event must never redirect mining at a
 * different file mid-session.
 */
export function ensureTranscriptPath(params: {
  sessionId: string;
  agent: string;
  logger: Logger;
  /** `transcript_path` carried by the inbound event, when it had one. */
  hookTranscriptPath?: string;
}): void {
  if (params.hookTranscriptPath) {
    stampHookTranscriptPath(params.sessionId, params.hookTranscriptPath, params.logger);
    return;
  }

  if (transcriptLookupAttempted.has(params.sessionId)) return;
  transcriptLookupAttempted.add(params.sessionId);

  try {
    const existing = getSession(params.sessionId, ALL_PROJECTS_SCOPE);
    if (!existing || existing.transcript_path) return;

    const resolved = findTranscriptFor(params.agent, params.sessionId);
    if (!resolved) return;

    updateSession(params.sessionId, { transcript_path: resolved }, ALL_PROJECTS_SCOPE);
    params.logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'resolved transcript path from manifest discovery', {
      session_id: params.sessionId,
      agent: params.agent,
      transcript_path: resolved,
    });
  } catch (err) {
    // Best-effort enrichment: capture proceeds without a path exactly as before.
    params.logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'transcript path resolution failed', {
      session_id: params.sessionId,
      agent: params.agent,
      error: (err as Error).message,
    });
  }
}

/**
 * Write an event-supplied transcript path into a row that has none.
 *
 * Reads the row every call rather than memoizing: a session id can be deleted
 * and re-registered (`deleteSessionCascade` then an explicit register, which
 * clears the tombstone), and the recreated row starts with no path. A
 * process-lifetime memo would refuse to stamp it for as long as the daemon
 * lives, leaving mining, lineage and re-enrichment off for that session.
 *
 * The row is left alone once it has a path, so a later event can never
 * redirect mining at a different file. A missing row is a no-op — the event
 * that creates it carries the same path.
 */
function stampHookTranscriptPath(sessionId: string, transcriptPath: string, logger: Logger): void {
  try {
    const existing = getSession(sessionId, ALL_PROJECTS_SCOPE);
    if (!existing || existing.transcript_path) return;

    updateSession(sessionId, { transcript_path: transcriptPath }, ALL_PROJECTS_SCOPE);
    logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'stamped transcript path from hook payload', {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
  } catch (err) {
    // Best-effort enrichment: capture proceeds without a path exactly as before.
    logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'transcript path stamp failed', {
      session_id: sessionId,
      error: (err as Error).message,
    });
  }
}

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
      // Carried into the upsert rather than stamped afterwards so a
      // re-registered session id gets its path back in the same statement.
      // `upsertSession` COALESCEs this column, so a null here preserves a
      // path already on the row.
      transcript_path: params.transcriptPath ?? null,
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

  ensureTranscriptPath({
    sessionId: params.sessionId,
    agent: params.agent,
    logger: params.logger,
    hookTranscriptPath: params.transcriptPath,
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
  /** Code path that invoked this — see {@link ENSURE_SESSION_SOURCE}. */
  source: EnsureSessionSource;
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

  // A missing row with a deletion tombstone is deleted-on-purpose, not an
  // upstream gap — the defensive insert must not passively resurrect it.
  // Explicit lifecycle paths (ensureSession via /sessions/register, the
  // reconciler) own their own gating and deliberately supersede.
  if (hasSessionTombstone(params.sessionId)) {
    params.logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'ensureSessionRowExists skipped — session tombstoned', {
      session_id: params.sessionId,
      source: params.source,
    });
    return false;
  }

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

/**
 * Injection-only phantom session reaper.
 *
 * A symbiont launch that fires SessionStart but exits before any prompt
 * still receives a Cortex/spores injection; the injection is recorded as
 * an activity (`myco:inject_<type>`), which forces `ensureOpenBatch` to
 * fabricate a RECOVERED-sentinel batch to satisfy the activities FK. The
 * result is a visible 1-prompt "(implicit batch — capture recovered)"
 * session that never had agent work and has no transcript on disk.
 *
 * The reaper deletes exactly that class — nothing else. The predicate is
 * conservative on purpose (data preservation is the core contract):
 *
 *   1. Every batch is a RECOVERED-kind sentinel row.
 *   2. Every activity is a Myco-origin injection (`myco:inject_%`).
 *   3. No transcript exists: `sessions.transcript_path` is NULL AND
 *      manifest-driven discovery (`findTranscriptFor`) resolves nothing.
 *
 * Deletion goes through `deleteSessionCascade` — the ONLY session
 * deletion path — with its own tombstone source, so buffer replay and
 * defensive inserts cannot resurrect the row.
 *
 * Two entry points share the predicate:
 *   - `createUnregisterPhantomReap` — SessionEnd, after the completion
 *     chokepoint has run final mining (a last-moment transcript vetoes).
 *   - `findPhantomCandidates` — the session-maintenance sweep, which
 *     also collects phantoms from before this code shipped.
 */

import { getDatabase } from '@myco/db/client.js';
import { getSession, deleteSessionCascade, type DeleteCascadeResult } from '@myco/db/queries/sessions.js';
import { RECOVERED_BATCH_SENTINEL, BATCH_KIND } from '@myco/db/queries/batches.js';
import { SESSION_TOMBSTONE_SOURCE } from '@myco/db/queries/session-tombstones.js';
import { findTranscriptFor } from '@myco/symbionts/transcript-discovery.js';
import { INJECTION_TOOL_NAME_PREFIX } from './injection-records.js';
import { cleanupAfterSessionCascade } from './jobs/session-cleanup.js';
import { resolveBufferDirForProjectId } from '@myco/capture/buffer-location.js';
import { resolveProjectBufferDir } from '@myco/grove/paths.js';
import { ALL_PROJECTS_SCOPE, isGroveEraId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { EmbeddingManager } from './embedding/manager.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { epochSeconds } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';

/** Minimal logger surface — matches DaemonLogger without importing it. */
interface ReaperLogger {
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
}

/**
 * Sweep-path age guard: a phantom must have been over (ended or created)
 * this many seconds before the maintenance sweep may reap it. The
 * unregister path needs no age guard — SessionEnd plus final mining just
 * proved the session over.
 */
export const PHANTOM_REAP_MIN_AGE_SECONDS = 10 * 60;

export interface PhantomCandidate {
  id: string;
  agent: string;
  project_id: string | null;
}

/**
 * SQL LIKE pattern for Myco injection activities, derived from the SAME
 * constant the writer uses (`injection-records.ts`) so predicate and
 * producer cannot silently diverge. The `_` in the prefix is escaped —
 * LIKE treats a bare underscore as a single-char wildcard.
 */
const INJECTION_TOOL_LIKE = `${INJECTION_TOOL_NAME_PREFIX.replaceAll('_', '\\_')}%`;

/**
 * The phantom DB shape, expressed ONCE and interpolated into both the
 * single-session predicate and the sweep's candidate query (data-deletion
 * predicates must never fork — a tightening that lands in one copy makes
 * the two entry points reap different session classes).
 *
 * A session matches when ALL hold:
 *  - no recorded transcript path;
 *  - at least one batch, and every batch is a RECOVERED-kind sentinel
 *    whose `response_summary` is still NULL — a sentinel that captured a
 *    real assistant response (Stop's `last_assistant_message` lands on it
 *    via `setResponseSummary`) is preserved content, never phantom;
 *  - every activity is a Myco-origin injection.
 */
const PHANTOM_SHAPE_SQL = `
       s.transcript_path IS NULL
       AND EXISTS (SELECT 1 FROM prompt_batches pb WHERE pb.session_id = s.id)
       AND NOT EXISTS (
         SELECT 1 FROM prompt_batches pb
         WHERE pb.session_id = s.id
           AND NOT (pb.kind = ? AND pb.user_prompt = ? AND pb.response_summary IS NULL)
       )
       AND NOT EXISTS (
         SELECT 1 FROM activities a
         WHERE a.session_id = s.id
           AND a.tool_name NOT LIKE '${INJECTION_TOOL_LIKE}' ESCAPE '\\'
       )`;

/**
 * DB-shape half of the phantom predicate. The on-disk transcript veto and
 * the unconverged-buffer veto live in `sessionQualifiesForPhantomReap` —
 * callers must not skip it.
 */
export function sessionLooksInjectionOnly(sessionId: string): boolean {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1 AS phantom
     FROM sessions s
     WHERE s.id = ?
       AND ${PHANTOM_SHAPE_SQL}`,
  ).get(sessionId, BATCH_KIND.RECOVERED, RECOVERED_BATCH_SENTINEL) as { phantom: number } | undefined;
  return !!row;
}

/**
 * Set-based candidate query for the maintenance sweep. Applies the same
 * DB-shape predicate plus sweep-only gates: not active, not currently
 * registered, and past the age guard. Candidates are a SNAPSHOT — the
 * sweep must route each one through `reapPhantomSession`, which re-runs
 * the full predicate synchronously with the delete, so a session that
 * gained real work (or re-registered) between snapshot and delete is
 * never reaped from stale data.
 */
export function findPhantomCandidates(
  registeredSessionIds: string[],
  minAgeSeconds: number = PHANTOM_REAP_MIN_AGE_SECONDS,
): PhantomCandidate[] {
  const db = getDatabase();
  const excludePlaceholders = registeredSessionIds.length > 0
    ? `AND s.id NOT IN (${registeredSessionIds.map(() => '?').join(', ')})`
    : '';
  const cutoff = epochSeconds() - minAgeSeconds;

  return db.prepare(
    `SELECT s.id, s.agent, s.project_id
     FROM sessions s
     WHERE s.status != 'active'
       AND COALESCE(s.ended_at, s.started_at) <= ?
       AND ${PHANTOM_SHAPE_SQL}
       ${excludePlaceholders}`,
  ).all(cutoff, BATCH_KIND.RECOVERED, RECOVERED_BATCH_SENTINEL, ...registeredSessionIds) as PhantomCandidate[];
}

export interface PhantomReapOptions {
  logger: ReaperLogger;
  /** Injectable transcript discovery — tests stub this; production uses manifest discovery. */
  findTranscript?: (agent: string, sessionId: string) => string | null;
  /**
   * The reconciler's convergence probe. An unconverged buffer may hold the
   * ONLY copy of real prompt events the DB hasn't seen (daemon wedged
   * mid-session, failed startup replay) — the DB shape then lies about the
   * session being injection-only, and the cascade would delete the journal.
   * When the probe reports unconverged (or is absent at a call site that
   * cannot supply it but buffers may exist), the reap is vetoed.
   */
  hasUnconvergedBuffer?: (sessionId: string) => boolean;
}

/**
 * Full predicate: DB shape plus the on-disk transcript veto. A transcript
 * that exists anywhere (recorded path or manifest discovery) means the
 * session had, or may still gain, real content — never reap it.
 */
export function sessionQualifiesForPhantomReap(sessionId: string, opts: PhantomReapOptions): boolean {
  if (!sessionLooksInjectionOnly(sessionId)) return false;
  const row = getSession(sessionId, ALL_PROJECTS_SCOPE);
  if (!row) return false;
  // Unconverged-buffer veto: the buffer journal may hold the only copy of
  // real prompt events the DB never converged — the DB shape alone cannot
  // prove the session is injection-only. Defer; the next reconcile either
  // replays the events (session stops qualifying) or proves it empty.
  try {
    if (opts.hasUnconvergedBuffer?.(sessionId)) return false;
  } catch {
    // A failing probe is not proof of convergence — refuse to reap.
    return false;
  }
  const discover = opts.findTranscript ?? findTranscriptFor;
  try {
    if (discover(row.agent, sessionId)) return false;
  } catch {
    // Discovery failure is not proof of absence — refuse to reap.
    return false;
  }
  return true;
}

/**
 * Reap one phantom through the cascade. Returns the cascade result when a
 * row was deleted (caller owns post-cascade cleanup — its deps differ per
 * call site), null when the session did not qualify.
 */
export function reapPhantomSession(sessionId: string, opts: PhantomReapOptions): DeleteCascadeResult | null {
  if (!sessionQualifiesForPhantomReap(sessionId, opts)) return null;
  const result = deleteSessionCascade(sessionId, SESSION_TOMBSTONE_SOURCE.PHANTOM_REAP);
  if (!result.deleted) return null;
  opts.logger.info(LOG_KINDS.LIFECYCLE_REAP, 'Reaped injection-only phantom session', {
    session_id: sessionId,
    project_id: result.projectId,
    counts: result.counts,
  });
  return result;
}

export interface UnregisterPhantomReapDeps {
  logger: ReaperLogger;
  resolveEmbeddingManager: (requestContext: MycoRequestContext | undefined) => EmbeddingManager;
  /** Bootstrap vault dir fallback when the request context carries no project vault. */
  fallbackVaultDir: string;
  findTranscript?: (agent: string, sessionId: string) => string | null;
  /** See {@link PhantomReapOptions.hasUnconvergedBuffer} — REQUIRED at the
   *  unregister site in production wiring; typed optional only so minimal
   *  test constructions compile. */
  hasUnconvergedBuffer?: (sessionId: string) => boolean;
}

/**
 * Unregister-path entry point: predicate → cascade → fire-and-forget
 * cleanup (embeddings, vault files, buffer journal), mirroring the
 * user-delete route's tenancy rules. Returns true when the session was
 * reaped so the caller can skip the session-ended notification for a
 * session that no longer exists.
 */
export function createUnregisterPhantomReap(deps: UnregisterPhantomReapDeps) {
  return function reapAtUnregister(
    sessionId: string,
    requestContext: MycoRequestContext | undefined,
  ): boolean {
    let result: DeleteCascadeResult | null = null;
    try {
      result = reapPhantomSession(sessionId, {
        logger: deps.logger,
        findTranscript: deps.findTranscript,
        hasUnconvergedBuffer: deps.hasUnconvergedBuffer,
      });
    } catch (err) {
      deps.logger.warn(LOG_KINDS.LIFECYCLE_REAP, 'Phantom reap check failed — session left in place', {
        session_id: sessionId,
        error: errorMessage(err),
      });
      return false;
    }
    if (!result) return false;

    // Buffer journal lives under the GROVE project dir: resolve from the
    // request context, falling back to the deleted row's project id; an
    // unresolvable dir is skipped (the tombstone keeps the file inert).
    const ctxIsGroveBound = !!requestContext?.groveId && !!requestContext?.projectId
      && isGroveEraId(requestContext.groveId, 'grove') && isGroveEraId(requestContext.projectId, 'project');
    const bufferDir = ctxIsGroveBound
      ? resolveProjectBufferDir(requestContext!.groveId!, requestContext!.projectId!)
      : resolveBufferDirForProjectId(result.projectId);

    cleanupAfterSessionCascade(
      sessionId,
      result,
      deps.resolveEmbeddingManager(requestContext),
      requestContext?.projectVaultDir ?? deps.fallbackVaultDir,
      bufferDir,
    ).catch((err) => {
      deps.logger.warn(LOG_KINDS.LIFECYCLE_REAP, 'Post-reap cascade cleanup failed', {
        session_id: sessionId,
        error: errorMessage(err),
      });
    });
    return true;
  };
}

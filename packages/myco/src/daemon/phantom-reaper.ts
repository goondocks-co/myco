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
 * DB-shape half of the phantom predicate: at least one batch, every batch
 * a RECOVERED sentinel, every activity a Myco injection, no recorded
 * transcript path. The on-disk transcript veto lives in
 * `sessionQualifiesForPhantomReap` — callers must not skip it.
 */
export function sessionLooksInjectionOnly(sessionId: string): boolean {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1 AS phantom
     FROM sessions s
     WHERE s.id = ?
       AND s.transcript_path IS NULL
       AND EXISTS (SELECT 1 FROM prompt_batches pb WHERE pb.session_id = s.id)
       AND NOT EXISTS (
         SELECT 1 FROM prompt_batches pb
         WHERE pb.session_id = s.id
           AND NOT (pb.kind = ? AND pb.user_prompt = ?)
       )
       AND NOT EXISTS (
         SELECT 1 FROM activities a
         WHERE a.session_id = s.id
           AND a.tool_name NOT LIKE 'myco:inject\\_%' ESCAPE '\\'
       )`,
  ).get(sessionId, BATCH_KIND.RECOVERED, RECOVERED_BATCH_SENTINEL) as { phantom: number } | undefined;
  return !!row;
}

/**
 * Set-based candidate query for the maintenance sweep. Applies the same
 * DB-shape predicate plus sweep-only gates: not active, not currently
 * registered, and past the age guard. The caller applies the transcript
 * veto and paused-project skip per candidate.
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
       AND s.transcript_path IS NULL
       AND COALESCE(s.ended_at, s.started_at) <= ?
       AND EXISTS (SELECT 1 FROM prompt_batches pb WHERE pb.session_id = s.id)
       AND NOT EXISTS (
         SELECT 1 FROM prompt_batches pb
         WHERE pb.session_id = s.id
           AND NOT (pb.kind = ? AND pb.user_prompt = ?)
       )
       AND NOT EXISTS (
         SELECT 1 FROM activities a
         WHERE a.session_id = s.id
           AND a.tool_name NOT LIKE 'myco:inject\\_%' ESCAPE '\\'
       )
       ${excludePlaceholders}`,
  ).all(cutoff, BATCH_KIND.RECOVERED, RECOVERED_BATCH_SENTINEL, ...registeredSessionIds) as PhantomCandidate[];
}

export interface PhantomReapOptions {
  logger: ReaperLogger;
  /** Injectable transcript discovery — tests stub this; production uses manifest discovery. */
  findTranscript?: (agent: string, sessionId: string) => string | null;
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
      result = reapPhantomSession(sessionId, { logger: deps.logger, findTranscript: deps.findTranscript });
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

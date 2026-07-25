/**
 * The daemon-level session-completion chokepoint.
 *
 * `closeSession` (`db/queries/sessions.ts`) is the raw DB write — it flips
 * `status = 'completed'`, stamps `ended_at`, and closes open batches, but it
 * knows nothing about transcripts. Before this module existed, only ONE of
 * its callers (`handleUnregister`) ran the final transcript-mining
 * reconciliation first; the stale-session sweep and the manual complete
 * route flipped status with no mining pass. That broke the invariant the
 * Team Host routed-transcript cache GC relies on — "status = 'completed'
 * implies the transcript is fully mined" — with a real data-loss failure
 * mode: member crashes mid-turn → no Stop/SessionEnd → stale sweep completes
 * the session unmined → the GC deletes the host's only transcript copy.
 *
 * `completeSessionWithMining` makes the chokepoint honest: it runs the final
 * mining convergence (when the session row carries a transcript source) and
 * THEN closes. Every daemon completion path routes through it —
 * `handleUnregister` (`daemon/api/session-lifecycle.ts`), the manual
 * complete route (`daemon/api/sessions.ts`), the stale-session sweep
 * (`daemon/jobs/session-maintenance.ts`), and (when wired) the buffer
 * reconciler's resurrected-stale close (`daemon/reconciliation.ts`).
 *
 * Mining is best-effort and idempotent (re-running over an unchanged
 * transcript is a no-op): a mining failure is logged and the close still
 * proceeds, matching the pre-existing `handleUnregister` semantics — a
 * session must never be left a zombie `active` because its transcript
 * could not be read.
 *
 * Closing anyway is only safe because the outcome is RECORDED. The session
 * carries `final_mine_ok`, and the routed-transcript cache GC prunes a tree
 * only when it is 1. So a failed or unattempted mine no longer looks like a
 * successful one to the job that deletes the host's only copy — the session
 * still closes, and the bytes are kept. The GC keeps its own independent
 * conservativeness for the no-source case (a routed session with no stamped
 * `transcript_path` is never pruned — see `daemon/power-jobs.ts`
 * ROUTED_TRANSCRIPT_CACHE_GC).
 */

import { closeSession, getSession, setFinalMineOk, type SessionRow } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

/**
 * The transcript-miner seam the completion chokepoint mines through — the
 * same structural subset `daemon/api/session-lifecycle.ts` already depends
 * on (`TranscriptMiner.reconcileAndAttributeResponses`). Narrow so tests
 * can assert routing with a recording fake instead of a real miner.
 */
export interface SessionCompletionMiner {
  reconcileAndAttributeResponses(
    sessionId: string,
    input: { agent: string; transcriptPath: string },
  ): { readTranscript: boolean };
}

export interface SessionCompletionDeps {
  transcriptMiner: SessionCompletionMiner;
  logger?: { warn(kind: string, message: string, data?: Record<string, unknown>): void };
}

/**
 * Complete a session through the honest chokepoint: final transcript-mining
 * convergence first (when the row has both an `agent` and a stamped
 * `transcript_path` — for a routed session that path is the HOST-materialized
 * file, substituted at Stop time), then the raw `closeSession` write.
 *
 * Returns `closeSession`'s result (the closed row, or null when the session
 * does not exist).
 */
export function completeSessionWithMining(
  sessionId: string,
  endedAt: number,
  deps: SessionCompletionDeps,
): SessionRow | null {
  // Unattempted stays unproven: a session with no mine source never earns the
  // GC's proof, which is what keeps its tree on disk.
  let minedOk = false;
  try {
    const ending = getSession(sessionId, ALL_PROJECTS_SCOPE);
    if (ending?.agent && ending.transcript_path) {
      minedOk = deps.transcriptMiner.reconcileAndAttributeResponses(sessionId, {
        agent: ending.agent,
        transcriptPath: ending.transcript_path,
      }).readTranscript;
    }
  } catch (err) {
    deps.logger?.warn(
      LOG_KINDS.SESSION_COMPLETE,
      'Final transcript convergence failed at session completion — closing anyway',
      { session_id: sessionId, error: err instanceof Error ? err.message : String(err) },
    );
  }
  setFinalMineOk(sessionId, minedOk);
  return closeSession(sessionId, endedAt);
}

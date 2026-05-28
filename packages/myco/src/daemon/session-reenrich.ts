/**
 * Post-reconcile transcript enrichment for session + prompt_batches rows.
 *
 * Updates a session by mining its transcript and replacing buffer-derived
 * fallback values with parser-derived values. Every UPDATE is gated on
 * the row still carrying the fallback (recovery sentinel / empty / NULL),
 * so a session that the live path captured cleanly is a no-op.
 *
 * Touches: `sessions.title`, `sessions.prompt_count`,
 * `prompt_batches.user_prompt`, `prompt_batches.response_summary`.
 * Does NOT touch `activities`.
 */

import type { TranscriptMiner } from '../capture/transcript-miner.js';
import type { DaemonLogger } from './logger.js';
import {
  RECOVERED_BATCH_SENTINEL,
  listBatchesBySession,
  replaceRecoveredBatchUserPrompt,
  setResponseSummary,
} from '../db/queries/batches.js';
import { getSession, updateSession } from '../db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '../grove/ids.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { TITLE_PREVIEW_CHARS } from './event-handlers.js';
import { classifyNextPromptOrigin } from '../capture/prompt-kind.js';

export interface ReEnrichDeps {
  transcriptMiner: TranscriptMiner;
  logger: DaemonLogger;
}

export interface ReEnrichResult {
  changed: boolean;
  titleUpdated: boolean;
  promptsReplaced: number;
  summarySet: boolean;
  promptCountUpdated: boolean;
}

/**
 * Re-enrich a single session from its transcript. Idempotent and best-effort.
 */
export function reEnrichSessionFromTranscript(
  sessionId: string,
  deps: ReEnrichDeps,
): ReEnrichResult {
  const empty: ReEnrichResult = {
    changed: false,
    titleUpdated: false,
    promptsReplaced: 0,
    summarySet: false,
    promptCountUpdated: false,
  };

  const session = getSession(sessionId, ALL_PROJECTS_SCOPE);
  if (!session) return empty;

  let mined;
  try {
    mined = deps.transcriptMiner.getAllTurnsWithSource(sessionId, undefined);
  } catch (err) {
    deps.logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'transcript mining failed during re-enrichment', {
      session_id: sessionId, error: String(err),
    });
    return empty;
  }
  const turns = mined?.turns ?? [];
  if (turns.length === 0) return empty;

  let titleUpdated = false;
  let promptsReplaced = 0;
  let summarySet = false;
  let promptCountUpdated = false;

  const currentTitle = session.title ?? '';
  if ((currentTitle === RECOVERED_BATCH_SENTINEL || currentTitle === '') && turns[0]!.prompt) {
    updateSession(sessionId, { title: turns[0]!.prompt.slice(0, TITLE_PREVIEW_CHARS) }, ALL_PROJECTS_SCOPE);
    titleUpdated = true;
  }

  // Cached `sessions.prompt_count` is now atomically maintained by
  // `insertBatchStateless` — every batch insert bumps the column in
  // the same transaction. Re-writing the cache here from
  // `turns.length` would diverge it from the real batch row count
  // (the cache would claim turns.length while the table still has
  // whatever was actually inserted). Drop the override — the real
  // fix when batches are missing is to insert them via the existing
  // reconciler path, which will bump the cache for free.

  const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
  for (let i = 0; i < Math.min(batches.length, turns.length); i++) {
    const batch = batches[i]!;
    const turnPrompt = turns[i]!.prompt;
    if (!turnPrompt || batch.user_prompt !== RECOVERED_BATCH_SENTINEL) continue;
    // Re-evaluate manifest rules so a sentinel claimed by a synthesized envelope
    // (e.g. <task-notification>) inherits its non-human origin instead of
    // silently regressing the v49 backfill on every session close.
    const origin = classifyNextPromptOrigin(session.agent ?? undefined, turnPrompt);
    if (replaceRecoveredBatchUserPrompt(batch.id, turnPrompt, origin)) promptsReplaced++;
  }

  const lastBatch = batches[batches.length - 1];
  const lastTurnReply = turns[turns.length - 1]?.aiResponse?.trim();
  if (lastBatch && lastTurnReply && !lastBatch.response_summary) {
    setResponseSummary(lastBatch.id, lastTurnReply);
    summarySet = true;
  }

  const changed = titleUpdated || promptsReplaced > 0 || summarySet || promptCountUpdated;
  if (changed) {
    deps.logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Re-enriched session from transcript', {
      session_id: sessionId,
      title_updated: titleUpdated,
      prompts_replaced: promptsReplaced,
      summary_set: summarySet,
      prompt_count_updated: promptCountUpdated,
      transcript_source: mined?.source ?? 'unknown',
    });
  }

  return { changed, titleUpdated, promptsReplaced, summarySet, promptCountUpdated };
}

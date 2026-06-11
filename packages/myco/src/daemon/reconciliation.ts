/**
 * Buffer reconciliation factory for the Myco daemon.
 *
 * The buffer is the authoritative event log — JSONL files on disk. The DB
 * (prompt_batches + activities) is a derived view. After a daemon restart,
 * reconciliation replays missed events from buffer files to keep the DB in sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listBufferSessionIds, cleanStaleBuffers } from '@myco/capture/buffer.js';
import {
  listBatchesBySession,
  getLatestBatch,
  setResponseSummary,
  toPromptBatchOrigin,
  PROMPT_PREFIX_MATCH_CHARS,
  type BatchRow,
} from '@myco/db/queries/batches.js';
import { listActivities, latestActivityTimestampForBatch } from '@myco/db/queries/activities.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import {
  STALE_BUFFER_MAX_AGE_MS,
  STOP_REPLAY_OPEN_BATCH_FRESHNESS_MS,
  DEFAULT_SYMBIONT_NAME,
  MS_PER_SECOND,
} from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { DaemonLogger } from './logger.js';
import type { EventDedupCache } from './event-dedup-cache.js';
import { handleUserPrompt, handleToolUse, handleToolFailure } from './event-handlers.js';
import { classifyNextPromptDecision } from '@myco/capture/prompt-kind.js';
import {
  eventDedupKey,
  eventTimestampMs,
  EVENT_DEDUP_WINDOW_MS,
  convergenceEventKey,
  dedupKeyFromPromptBatch,
  dedupKeyFromActivity,
  isBookkeepingActivity,
} from '@myco/capture/dedup.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event types replayed during buffer reconciliation. */
const REPLAYABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user_prompt',
  'tool_use',
  'tool_failure',
  // `stop` events carry the last assistant message and need to survive daemon
  // downtime so response_summary isn't lost when the TUI fires idle during a
  // restart window. Replay sets the summary on the session's latest batch
  // without re-running full stop processing (which already ran live).
  'stop',
]);

/**
 * Row-fetch bound for the convergence multiset. A session's buffer file holds
 * at most a few hundred events; this just keeps the query bounded against a
 * pathological session without ever truncating a realistic one (the default
 * list limits — 200 batches / 100 activities — WOULD truncate and silently
 * re-insert the tail as duplicates).
 */
const CONVERGENCE_QUERY_LIMIT = 100_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
  /**
   * Every buffer directory the reconciler should scan. One per registered
   * project under the global install at
   * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/`. There is NO
   * legacy fallback — `capture/buffer-location.ts` enforces the
   * no-divergent-location invariant structurally, and the reconciler
   * trusts that contract. Derived from `listAllProjectBufferDirs()`.
   *
   * Order matters only for log determinism; per-session lookup tries each
   * directory in order and uses the first match (a session's events live
   * in exactly one dir).
   */
  bufferDirs: string[];
  logger: DaemonLogger;
  /** Canonical project root — derived from vaultDir, never cwd. */
  projectRoot: string;
  /**
   * Fires once after `reconcileSession` finishes for a session. Wrapped in
   * try/catch by the reconciler — thrown errors are logged and swallowed.
   */
  onSessionReconciled?: (sessionId: string) => void;
  /**
   * Shared live duplicate cache (same instance the /events dispatcher
   * consults). Every replayed event's key is recorded into it at replay
   * time so a late live POST of the same physical event is rejected as a
   * duplicate instead of double-inserting.
   */
  eventDedupCache?: EventDedupCache;
}

export interface Reconciler {
  reconcileSession(sessionId: string): void;
  replayEvent(sessionId: string, event: Record<string, unknown>): 'prompt' | 'activity' | null;
  runStartupReconciliation(): void;
  /** Clear reconciliation state for a session (call on unregister). */
  clearSession(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reconciler instance bound to the given buffer directory and logger.
 *
 * The returned object exposes `reconcileSession`, `replayEvent`, and
 * `runStartupReconciliation` — all of which share the internal
 * `reconciledSessions` set so that each session is only reconciled once
 * per daemon lifetime.
 */
export function createReconciler({ bufferDirs, logger, projectRoot, onSessionReconciled, eventDedupCache }: ReconcilerDeps): Reconciler {
  // Track sessions already reconciled this daemon lifetime to avoid
  // redundant file reads (startup scan + register + event can all fire).
  // A session is only added after a pass converges (zero replay errors,
  // unchanged file identity) — failed or aborted passes stay eligible.
  const reconciledSessions = new Set<string>();

  // Sessions whose idle buffer contained unparseable lines that were
  // excluded (converge-with-loss). WARN once per session per daemon
  // lifetime so a persistently-torn file doesn't spam the log.
  const tornLineWarnedSessions = new Set<string>();

  /** Snapshot of the byte-level identity of a buffer file. */
  interface BufferIdentity { size: number; mtimeMs: number }

  function statBufferIdentity(filePath: string): BufferIdentity | null {
    try {
      const stat = fs.statSync(filePath);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * Locate the buffer file for a session across all known buffer dirs.
   * Returns the first dir whose buffer file exists and is non-empty, or
   * `null` when no buffer holds this session. The PR #346 invariant —
   * "don't mark reconciled if buffer absent" — lifts cleanly across
   * multiple dirs: a session whose buffer hasn't surfaced in any of them
   * is genuinely absent, and the caller returns without marking it.
   *
   * The file is stat'ed BEFORE it is read; the caller re-stats after the
   * pass and treats any identity change (size or mtime) as "events arrived
   * mid-pass" — the pass is then not considered converged.
   */
  function locateBufferContent(
    sessionId: string,
  ): { dir: string; path: string; content: string; identity: BufferIdentity } | null {
    for (const dir of bufferDirs) {
      const bufferPath = path.join(dir, `${sessionId}.jsonl`);
      const identity = statBufferIdentity(bufferPath);
      if (!identity) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(bufferPath, 'utf-8').trim();
      } catch {
        continue;
      }
      if (raw) return { dir, path: bufferPath, content: raw, identity };
    }
    return null;
  }

  /**
   * Replay a single buffer event into the DB via the appropriate handler.
   *
   * Shared between reconcileSession (buffer replay) and the live /events
   * route to eliminate dispatch duplication.
   *
   * `passCreatedBatchIds` collects the batch ids this reconciliation pass
   * creates (prompt replays) and exempts them from the stop-replay
   * freshness guard — a batch fabricated from buffered history moments ago
   * is not a live turn, even though its created_at is "now".
   *
   * @returns 'prompt' | 'activity' | null indicating what was created.
   */
  function replayEvent(
    sessionId: string,
    event: Record<string, unknown>,
    passCreatedBatchIds?: Set<number>,
  ): 'prompt' | 'activity' | null {
    if (event.type === 'user_prompt') {
      // Live hooks forward `origin` from the manifest decision; pre-v49 buffer
      // files have no `origin` field. Re-evaluate the manifest rule on the
      // prompt text in that case so a buffered <task-notification> /
      // <teammate-message> from before the upgrade still lands with the right
      // origin instead of silently defaulting to 'human'. Forwarded values win.
      const promptText = String(event.prompt ?? '');
      const agent = typeof event.agent === 'string' ? event.agent : undefined;
      if (typeof event.origin === 'string') {
        // Post-rule hooks apply the drop decision BEFORE buffering, so a
        // forwarded origin means the event passed the rules; trust it.
        const { batchId } = handleUserPrompt(sessionId, promptText, { origin: toPromptBatchOrigin(event.origin) });
        passCreatedBatchIds?.add(batchId);
        return 'prompt';
      }
      // Pre-rule buffer (no forwarded origin): re-evaluate the manifest rule
      // with full drop-awareness. A buffered <command-name> / <local-command-
      // stdout> envelope must be DROPPED here too — classifyNextPromptOrigin
      // collapses drop→'human', which would re-insert a prompt the user never
      // typed. Honor rewrite as well so a preamble-stripped prompt replays
      // identically to the live path.
      const decision = classifyNextPromptDecision(agent, promptText);
      if (decision.action === 'drop') return null;
      const replayText = decision.action === 'rewrite' ? decision.prompt : promptText;
      const { batchId } = handleUserPrompt(sessionId, replayText, { origin: toPromptBatchOrigin(decision.origin ?? 'human') });
      passCreatedBatchIds?.add(batchId);
      return 'prompt';
    }
    if (event.type === 'tool_use') {
      handleToolUse(
        sessionId,
        typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.output_preview === 'string' ? event.output_preview : undefined,
        projectRoot,
        typeof event.transcript_path === 'string' ? event.transcript_path : undefined,
      );
      return 'activity';
    }
    if (event.type === 'tool_failure') {
      handleToolFailure(
        sessionId,
        typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.error === 'string' ? event.error : undefined,
        !!event.is_interrupt,
      );
      return 'activity';
    }
    if (event.type === 'stop') {
      const summary = typeof event.last_assistant_message === 'string'
        ? event.last_assistant_message.trim()
        : '';
      if (!summary) return null;
      const latest = getLatestBatch(sessionId);
      if (!latest || latest.response_summary) return null;
      // Staleness-qualified open-batch guard. A FRESH open batch is a turn
      // that may still be live — a replayed stop landing on it would
      // attribute a buffered assistant message to a turn it may not belong
      // to. A STALE open batch is the missed-Stop shape itself: the Stop is
      // what closes batches, so a turn whose Stop the daemon never received
      // stays open forever — its buffered summary IS the recovery target.
      // Batches THIS pass created are exempt: they were fabricated from
      // buffered history seconds ago (created_at = now, so they'd always
      // read as fresh) but are by construction not live turns — the
      // full-turn-missed shape needs its stop to land on exactly such a
      // batch. Freshness reads the batch's last sign of life: the latest
      // activity row attached to it, falling back to the batch's own
      // created_at. created_at alone would misclassify a long-running live
      // turn (old batch, activities still flowing) as stale; the
      // MAX(timestamp) is a single indexed query on this rare replay-only
      // path. Write the summary only — the batch is deliberately NOT
      // closed here.
      if (latest.ended_at === null && !passCreatedBatchIds?.has(latest.id)) {
        const lastActivitySec = latestActivityTimestampForBatch(latest.id) ?? latest.created_at;
        const lastSignOfLifeSec = Math.max(lastActivitySec, latest.created_at);
        if (Date.now() - lastSignOfLifeSec * MS_PER_SECOND < STOP_REPLAY_OPEN_BATCH_FRESHNESS_MS) {
          return null;
        }
      }
      setResponseSummary(latest.id, summary);
      return 'activity';
    }
    return null;
  }

  /**
   * Second-chance prompt match for the miner tail-rewrite shape ONLY: true
   * when an existing batch's prompt and the buffered text are BOTH at least
   * PROMPT_PREFIX_MATCH_CHARS long and identical across that full window
   * (the same window `findBatchByPromptPrefix` uses for attachment
   * matching). Catches the Stop-time transcript miner rewriting a stored
   * LONG prompt's tail while the buffer holds the original hook-delivered
   * text (or vice versa). Texts shorter than the window are deliberately
   * excluded: they are fully covered by the exact 256-char key, so a
   * mismatch there means a genuinely different — or genuinely repeated —
   * prompt ("continue", "y") that must replay, not be absorbed by an
   * earlier turn's batch. Matches only against the PRE-PASS batch snapshot
   * so a prompt replayed earlier in this pass can't absorb a later genuine
   * same-text turn.
   */
  function hasPrefixMatchedBatch(batches: ReadonlyArray<BatchRow>, bufferedText: string): boolean {
    if (bufferedText.length < PROMPT_PREFIX_MATCH_CHARS) return false;
    const bufferedPrefix = bufferedText.slice(0, PROMPT_PREFIX_MATCH_CHARS);
    for (const batch of batches) {
      const rowPrompt = batch.user_prompt;
      if (!rowPrompt || rowPrompt.length < PROMPT_PREFIX_MATCH_CHARS) continue;
      if (rowPrompt.startsWith(bufferedPrefix)) return true;
    }
    return false;
  }

  /**
   * Reconcile buffer events against DB state for a session by CONTENT.
   *
   * The buffer is the authoritative event log. The DB (prompt_batches +
   * activities) is a derived view. After a daemon restart, the DB may be
   * missing events the daemon didn't process while it was down — and the
   * buffer may hold copies of events the daemon DID process (the hook CLI
   * appends its own copy whenever the daemon's response didn't confirm
   * processing), so position- or count-based divergence misidentifies the
   * replay point whenever the two sides drifted asymmetrically.
   *
   * Convergence instead keys every stored row and every buffer event with
   * the shared content fingerprint (`@myco/capture/dedup.js`) and walks the
   * buffer chronologically: an event whose key still has an unconsumed DB
   * row converged already; everything else replays through the normal
   * handler flow (prompts open batches, tool events attach to the open
   * batch). The session is marked reconciled only when the pass completes
   * with zero replay errors against an unchanged buffer file.
   */
  function reconcileSession(sessionId: string): void {
    if (reconciledSessions.has(sessionId)) return;

    // Locate the session's buffer across every known dir. Buffer file
    // absent in every dir → return WITHOUT marking reconciled so a later
    // call (after the buffer appears) can replay it.
    const located = locateBufferContent(sessionId);
    if (!located) return;
    const content = located.content;

    // Session row absent (deleted, or not yet created by an /events
    // POST). Return WITHOUT marking reconciled — if the row later
    // appears, the next call must be free to replay.
    if (!getSession(sessionId, ALL_PROJECTS_SCOPE)) {
      logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Skipping reconciliation — session row absent', { session_id: sessionId });
      return;
    }

    // Tolerant per-line parse with aging. A torn line on a FRESH file (an
    // append may still be in flight) aborts the pass — the next trigger
    // retries once the write completes. A torn line on an idle file is
    // permanent damage: exclude it, warn once per session per daemon
    // lifetime, and converge what remains.
    const allEvents: Array<Record<string, unknown>> = [];
    let tornLines = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        allEvents.push(JSON.parse(trimmed));
      } catch {
        tornLines++;
      }
    }
    if (tornLines > 0) {
      if (Date.now() - located.identity.mtimeMs < EVENT_DEDUP_WINDOW_MS) {
        logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation deferred — unparseable line on a fresh buffer', {
          session_id: sessionId,
          torn_lines: tornLines,
        });
        return;
      }
      if (!tornLineWarnedSessions.has(sessionId)) {
        tornLineWarnedSessions.add(sessionId);
        logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: excluding unparseable lines from idle buffer', {
          session_id: sessionId,
          torn_lines: tornLines,
          buffer_path: located.path,
        });
      }
    }

    let replayErrors = 0;

    // DB-side content multiset: every stored prompt and every stored
    // non-bookkeeping activity, keyed with the convergence projections of
    // the shared fingerprint. Multiset (key → count) so N genuine
    // same-text turns consume N matches. Bookkeeping rows (subagent_*,
    // task_completed, compact, stop_failure) come from non-replayable
    // events and must never absorb a tool match.
    const existingBatches = listBatchesBySession(sessionId, {
      scope: ALL_PROJECTS_SCOPE,
      limit: CONVERGENCE_QUERY_LIMIT,
    });
    const dbKeyCounts = new Map<string, number>();
    for (const batch of existingBatches) {
      const key = dedupKeyFromPromptBatch(batch);
      dbKeyCounts.set(key, (dbKeyCounts.get(key) ?? 0) + 1);
    }
    for (const activity of listActivities({
      session_id: sessionId,
      scope: ALL_PROJECTS_SCOPE,
      limit: CONVERGENCE_QUERY_LIMIT,
    })) {
      if (isBookkeepingActivity(activity.tool_name)) continue;
      const key = dedupKeyFromActivity(activity);
      dbKeyCounts.set(key, (dbKeyCounts.get(key) ?? 0) + 1);
    }

    // Match-and-consume chronologically. Three guards apply before a
    // prompt / tool event reaches replayEvent:
    //
    //   1. Intra-buffer collapse — the live dispatcher's content+window
    //      dedup applied over the whole file, so the daemon-appended copy
    //      and the hook CLI's duplicate copy (written whenever the daemon
    //      returns `ignored: 'duplicate'` — see `hooks/send-event.ts`)
    //      count as ONE logical event.
    //   2. Exact content match — the event's convergence key consumes one
    //      unconsumed DB row with the same key. user_prompt events key on
    //      the candidate replay text (the rewritten form the live hook
    //      stored and replay would insert), not the raw buffered text.
    //   3. Second-chance prefix match (user_prompt only) — catches miner
    //      tail-rewrites of LONG prompts where exact text diverged. Skips
    //      WITHOUT consuming a multiset count.
    //
    // Stop events take none of these: they have no DB-row projection and
    // their fingerprint carries no content (every stop in a session shares
    // one key, so collapse would eat a rapid second turn's summary). Each
    // is replayed at its chronological position — after the prompts that
    // precede it — so getLatestBatch resolves the batch the turn actually
    // ended on, including a batch this same pass just recovered. The write
    // is NULL-only idempotent.
    //
    // Replayed activities attach via insertActivityWithBatch's latest-open
    // fallback — recovered-but-possibly-misattributed-across-turns is
    // accepted for P1.
    let promptsRecovered = 0;
    let activitiesRecovered = 0;
    let duplicatesSuppressed = 0;
    let eventsConverged = 0;
    let summariesRecovered = 0;
    const seenKeys = new Map<string, number>();
    const passCreatedBatchIds = new Set<number>();

    for (const event of allEvents) {
      const type = String(event.type);
      if (!REPLAYABLE_EVENT_TYPES.has(type)) continue;

      if (type === 'stop') {
        try {
          if (replayEvent(sessionId, event, passCreatedBatchIds) === 'activity') summariesRecovered++;
        } catch (err) {
          replayErrors++;
          logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: stop replay failed', {
            session_id: sessionId,
            error: String(err),
          });
        }
        continue;
      }

      const eventWithSession = {
        ...event,
        type,
        session_id: sessionId,
      } as Record<string, unknown> & { type: string; session_id: string };
      const exactKey = eventDedupKey(eventWithSession);
      const ts = eventTimestampMs(event) ?? Date.now();
      const lastSeen = seenKeys.get(exactKey);
      if (lastSeen !== undefined && ts - lastSeen < EVENT_DEDUP_WINDOW_MS) {
        duplicatesSuppressed++;
        continue;
      }
      seenKeys.set(exactKey, ts);

      // Mirror replayEvent's user_prompt gate so a pre-rule event the
      // manifest would DROP neither consumes a DB row nor replays, and so
      // both match layers compare the text replay WOULD insert.
      let candidateText: string | null = null;
      if (type === 'user_prompt') {
        const promptText = String(event.prompt ?? '');
        if (typeof event.origin === 'string') {
          candidateText = promptText;
        } else {
          const decision = classifyNextPromptDecision(
            typeof event.agent === 'string' ? event.agent : undefined,
            promptText,
          );
          if (decision.action === 'drop') continue;
          candidateText = decision.action === 'rewrite' ? decision.prompt : promptText;
        }
      }

      const matchKey = type === 'user_prompt'
        ? convergenceEventKey({ ...eventWithSession, prompt: candidateText ?? '' })
        : convergenceEventKey(eventWithSession);
      const remaining = dbKeyCounts.get(matchKey) ?? 0;
      if (remaining > 0) {
        dbKeyCounts.set(matchKey, remaining - 1);
        eventsConverged++;
        continue;
      }

      if (type === 'user_prompt' && candidateText && hasPrefixMatchedBatch(existingBatches, candidateText)) {
        eventsConverged++;
        continue;
      }

      try {
        const result = replayEvent(sessionId, event, passCreatedBatchIds);
        if (result === 'prompt') promptsRecovered++;
        else if (result === 'activity') activitiesRecovered++;
        // Mirror the replay into the live duplicate cache (replay-time
        // stamp) so a late live POST of the same physical event is
        // rejected by the dispatcher instead of double-inserting.
        if (result !== null) eventDedupCache?.record(exactKey, Date.now());
      } catch (err) {
        replayErrors++;
        logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: failed to replay event', {
          type,
          error: String(err),
        });
      }
    }

    // Converged only if no replay failed AND the buffer file is byte-
    // identical to the pre-read snapshot (no events arrived mid-pass).
    // Anything else leaves the session eligible for the next trigger.
    const after = statBufferIdentity(located.path);
    const identityUnchanged = after !== null
      && after.size === located.identity.size
      && after.mtimeMs === located.identity.mtimeMs;
    if (replayErrors === 0 && identityUnchanged) {
      reconciledSessions.add(sessionId);
    } else {
      logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation pass not converged — session stays eligible', {
        session_id: sessionId,
        replay_errors: replayErrors,
        buffer_changed: !identityUnchanged,
      });
    }

    if (promptsRecovered > 0 || activitiesRecovered > 0 || duplicatesSuppressed > 0 || summariesRecovered > 0) {
      logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Buffer reconciliation complete', {
        session_id: sessionId,
        prompts_recovered: promptsRecovered,
        activities_recovered: activitiesRecovered,
        duplicates_suppressed: duplicatesSuppressed,
        events_converged: eventsConverged,
        summaries_recovered: summariesRecovered,
      });
    }
    tryReEnrich(sessionId);
  }

  /** Invoke `onSessionReconciled` if provided, swallowing + logging any error. */
  function tryReEnrich(sessionId: string): void {
    if (!onSessionReconciled) return;
    try {
      onSessionReconciled(sessionId);
    } catch (err) {
      logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Post-reconcile re-enrichment threw', {
        session_id: sessionId,
        error: String(err),
      });
    }
  }

  /**
   * Run startup reconciliation: clean stale buffers, then reconcile all
   * buffer sessions found on disk.
   */
  function runStartupReconciliation(): void {
    // Clean up stale buffer files (>24h) on startup across every known dir.
    let totalCleaned = 0;
    for (const dir of bufferDirs) {
      totalCleaned += cleanStaleBuffers(dir, STALE_BUFFER_MAX_AGE_MS);
    }
    if (totalCleaned > 0) {
      logger.info(LOG_KINDS.CAPTURE_BUFFER, 'Buffer cleanup complete', { stale_removed: totalCleaned });
    }

    // Reconcile every remaining buffer file across all known dirs. A
    // session shows up at most once even if its buffer lives in only one
    // dir — `reconcileSession` is idempotent across multiple invocations
    // via the `reconciledSessions` set.
    const seen = new Set<string>();
    for (const dir of bufferDirs) {
      for (const sessionId of listBufferSessionIds(dir)) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        try {
          reconcileSession(sessionId);
        } catch (err) {
          logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Startup reconciliation failed', { session_id: sessionId, error: String(err) });
        }
      }
    }
  }

  function clearSession(sessionId: string): void {
    reconciledSessions.delete(sessionId);
  }

  return { reconcileSession, replayEvent, runStartupReconciliation, clearSession };
}

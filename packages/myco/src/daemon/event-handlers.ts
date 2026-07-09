/**
 * Stateless event handler functions for the Myco daemon capture layer.
 *
 * These handlers are pure/stateless — they have no closure dependencies on
 * main() and are extracted here for testability and modularity.
 */

import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { closeOpenBatches, insertBatchStateless, incrementActivityCount, findOpenParentBatch, hasAnyBatch, countBatchesBySession, listBatchesBySession, getLatestBatch, replaceRecoveredBatchUserPrompt, liveContentOrdinal, normalizePromptForHash, BATCH_KIND, RECOVERED_BATCH_SENTINEL, PROMPT_BATCH_ORIGIN, type PromptBatchOrigin } from '@myco/db/queries/batches.js';
import { classifyNextPromptOrigin } from '@myco/capture/prompt-kind.js';
import { AntigravityJsonlParser } from '@myco/symbionts/parsers/antigravity-jsonl.js';
import fs from 'node:fs';
import type { StatelessActivityInsert, ActivityRow } from '@myco/db/queries/activities.js';
import { insertActivityWithBatch } from '@myco/db/queries/activities.js';
import { updateSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE, assertGroveProjectId } from '@myco/grove/ids.js';
import { createBatchLineage } from '@myco/db/queries/lineage.js';
import { consumePendingInjection } from '@myco/canopy/inject/pending.js';
import { getManifestByName } from '@myco/symbionts/detect.js';
import { extractAnyPath } from '@myco/symbionts/canopy-read-tools.js';
import { getRoutedEventDedup, recordRoutedEventDedup } from '@myco/db/queries/routed-event-dedup.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max chars of tool input stored in the activity row. */
export const TOOL_INPUT_STORE_LIMIT = 4000;

/** Max chars of tool output summary stored in the activity row. */
export const TOOL_OUTPUT_STORE_LIMIT = 2000;

/** Max chars for deriving a title from the first user prompt. */
export const TITLE_PREVIEW_CHARS = 80;

/**
 * Extract a file path from tool input via the agent's manifest.
 *
 * Manifest-driven: consults `pathBearingTools` on the agent's symbiont
 * manifest — the broader sibling of `canopyReadTools` that covers
 * write-side tools (Write, Edit, MultiEdit) in addition to canopy reads.
 * Each entry declares either a structured `pathField` or a shell-arg
 * extraction with a `readCommands` allowlist (Codex's `sed -n '1,5p' x.ts`).
 *
 * Returns null when the agent has no manifest entry for the tool, the
 * input shape doesn't match, or the path field is missing. Per-event cost
 * is one memoized manifest lookup plus a small shell-quote parse.
 */
function extractToolFilePath(
  agent: string,
  toolName: string,
  toolInput: unknown,
): string | null {
  const manifest = getManifestByName(agent);
  if (!manifest) return null;
  const resolved = extractAnyPath(manifest, toolName, toolInput);
  return resolved ? resolved.filePath : null;
}

function relativizeToolPath(filePath: string, projectRoot: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Event handling helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface UserPromptOptions {
  kind?: string;
  /**
   * Provenance of the prompt. Defaults to `'human'` when omitted so callers
   * that haven't been migrated continue to behave like the legacy live path.
   * The live `/events` route and the buffer replayer both forward the
   * manifest-driven origin computed by `evaluateUserPromptRules`.
   */
  origin?: PromptBatchOrigin;
  /**
   * Source-assigned, identity-bearing event id (residency §4a). Present only for a
   * routed `/events` event the member stamped; the host dedups on it so a live
   * delivery and its drain-replay collapse to one batch. Absent for local events
   * and the buffer replayer — those keep today's (ordinal + 10 s window) behavior.
   */
  sourceEventId?: string;
  /** The originating member's `machine_id`, recorded in the dedup ledger for
   *  origin-tracing. Accompanies {@link sourceEventId}. */
  sourceMachineId?: string;
}

/**
 * Open a synthetic `kind='recovered'` batch ONLY when the session has
 * no batches at all. Activity handlers call this before insert so that
 * the FK on `activities.prompt_batch_id` is satisfied even for a session
 * whose first observed event is a tool_use (or similar) instead of a
 * user_prompt.
 *
 * Late post-turn bookkeeping events (subagent_stop, task_completed,
 * compact, stop_failure) used to fabricate a phantom row here whenever
 * the turn's INITIAL batch had already closed. They no longer do — the
 * relaxed inline subquery in `insertActivityWithBatch` falls back to the
 * just-closed batch instead, so the activity stays attached to the turn
 * it belongs to.
 */
export function ensureOpenBatch(sessionId: string): void {
  if (hasAnyBatch(sessionId)) return;
  const now = epochSeconds();
  insertBatchStateless({
    session_id: sessionId,
    user_prompt: RECOVERED_BATCH_SENTINEL,
    started_at: now,
    created_at: now,
    kind: BATCH_KIND.RECOVERED,
    parent_prompt_batch_id: null,
  });
}

/**
 * Try to claim the slot for an incoming INITIAL user prompt without
 * inserting a new row. Returns the existing batch when a sentinel
 * placeholder is sitting alone (created earlier by
 * `recordInjectionActivity` for the SessionStart cortex / spores
 * injection on single-shot symbionts), AFTER replacing its
 * `user_prompt` with the real text. Returns `null` when no
 * replaceable slot exists — caller falls back to the normal
 * insert path.
 *
 * Centralises the sentinel-detect-and-replace logic so
 * `handleUserPrompt` reads as a single "decide where this batch
 * goes" call rather than an inline if/else. Same primitive used by
 * the Antigravity transcript self-heal in `handleToolUse` and by
 * `session-reenrich.ts` at Stop — three call sites of one pattern.
 *
 * The lineage row attaches to the replaced batch's id so consumers
 * downstream see the same shape they'd get from a fresh insert.
 */
function claimInitialBatchSlot(
  sessionId: string,
  prompt: string,
  now: number,
  origin: PromptBatchOrigin = PROMPT_BATCH_ORIGIN.HUMAN,
): { batchId: number; promptNumber: number } | null {
  const latest = getLatestBatch(sessionId);
  if (!latest) return null;
  if (latest.user_prompt !== RECOVERED_BATCH_SENTINEL) return null;
  if (countBatchesBySession(sessionId) !== 1) return null;

  replaceRecoveredBatchUserPrompt(latest.id, prompt, origin);
  try {
    const lineageProjectId = latest.project_id ? assertGroveProjectId(latest.project_id) : null;
    createBatchLineage(DEFAULT_AGENT_ID, sessionId, latest.id, now, lineageProjectId);
  } catch { /* lineage best-effort */ }
  return { batchId: latest.id, promptNumber: latest.prompt_number ?? 1 };
}

const antigravityParser = new AntigravityJsonlParser();

/**
 * Best-effort recovery of an Antigravity session's user prompt(s)
 * from the transcript file, accounting for two pieces of existing
 * state the Antigravity integration already keeps:
 *
 *   - The first batch may be the {@link RECOVERED_BATCH_SENTINEL}
 *     placeholder written by {@link ensureOpenBatch}. When the IDE
 *     finally flushes its transcript, this routine REPLACES the
 *     sentinel with the real first-turn prompt via
 *     {@link replaceRecoveredBatchUserPrompt} (idempotent — bails
 *     when the row is no longer the sentinel).
 *
 *   - Injection records (cortex / spores / canopy) live in
 *     `injection-records.ts` keyed by `(sessionId, content_hash)`.
 *     This routine does NOT trigger re-injection — it only
 *     reconciles the visible prompt text. The injection step
 *     already self-deduplicates if a later code path retriggers it.
 *
 * Called on every tool_use for Antigravity. Cheap when the
 * transcript hasn't changed: a stat-and-fast-bail design would be
 * marginal — the parser cost on a real session transcript is
 * sub-millisecond, and the early-exit when no sentinel exists
 * already trims the hot path.
 */
function selfHealAntigravityPromptFromTranscript(
  sessionId: string,
  transcriptPath: string,
): void {
  // Cheap precondition: only proceed when this session still has a
  // sentinel batch sitting at the head. If it doesn't, the prompt
  // is already correct and nothing to heal.
  const earliest = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE, limit: 1 });
  if (earliest.length === 0) return;
  if (earliest[0].user_prompt !== RECOVERED_BATCH_SENTINEL) return;

  let content: string;
  try { content = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return; }

  const prompts = antigravityParser
    .parseTurns(content)
    .map((t) => t.prompt)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (prompts.length === 0) return;

  // Replace the sentinel with the first real prompt. Idempotent —
  // returns false if the row has already been healed by another
  // event (e.g. a parallel post-tool-use, or session-reenrich at
  // Stop). Either path leaves the user with the right answer.
  // Origin is derived from the manifest so a sentinel claimed by a
  // synthesized envelope is tagged correctly (Antigravity manifest
  // has no set_origin rules today, so this resolves to 'human' —
  // contract is symmetric with the live path either way).
  const origin = classifyNextPromptOrigin('antigravity', prompts[0]);
  replaceRecoveredBatchUserPrompt(earliest[0].id, prompts[0], origin);

  // If the transcript advanced beyond the sentinel turn while no
  // user_prompt hook ever fired for the tail (Antigravity does not
  // have a per-prompt hook), reuse syncTranscriptPromptBatches to
  // append the missing batches. Idempotent via its count check.
  if (prompts.length > 1) {
    try { syncTranscriptPromptBatches(sessionId, prompts); }
    catch { /* best-effort */ }
  }
}

/**
 * Invariant: every activity insert increments the linked batch's
 * `activity_count`. Pre-PR-#346 only `handleToolUse` honored it; the
 * bookkeeping handlers (subagent_*, task_completed, compact, stop_failure)
 * silently skipped the increment, so the cached column drifted from the
 * real row count on every batch they touched. Routing all callers through
 * this one helper makes the drift impossible.
 */
function recordActivity(data: StatelessActivityInsert): ActivityRow {
  const activity = insertActivityWithBatch(data);
  if (activity.prompt_batch_id !== null) {
    incrementActivityCount(activity.prompt_batch_id);
  }
  return activity;
}

/**
 * Handle a UserPromptSubmit event.
 *
 * For initial prompts: closes open batches, opens a new initial batch.
 * For steering/interrupt: nests under the open parent if one exists;
 * falls back to initial if no open parent is found.
 *
 * The parent linkage is resolved server-side via findOpenParentBatch — callers
 * should not attempt to compute or pass a parent ID themselves.
 *
 * @returns the new batch ID and prompt number
 */
export function handleUserPrompt(
  sessionId: string,
  prompt: string | undefined,
  options: UserPromptOptions = {},
): { batchId: number; promptNumber: number } {
  // Idempotent sink for routed capture (residency §4a): a re-delivery of the same
  // source event (live + drain, or a lost-ack retry) returns the batch the first
  // delivery opened — no second batch. Scoped by id PRESENCE: local events and the
  // buffer replayer pass no id and keep today's behavior. The ordinal (below) stays
  // for ORDERING, no longer the dedup mechanism for a routed event.
  const eventId = options.sourceEventId;
  if (eventId) {
    const seen = getRoutedEventDedup(eventId);
    if (seen) return { batchId: seen.prompt_batch_id ?? 0, promptNumber: 0 };
  }
  const result = handleUserPromptCore(sessionId, prompt, options);
  if (eventId) {
    recordRoutedEventDedup({
      eventId,
      machineId: options.sourceMachineId,
      kind: 'user_prompt',
      promptBatchId: result.batchId,
    });
  }
  return result;
}

function handleUserPromptCore(
  sessionId: string,
  prompt: string | undefined,
  options: UserPromptOptions = {},
): { batchId: number; promptNumber: number } {
  const now = epochSeconds();
  const incomingKind = options.kind ?? BATCH_KIND.INITIAL;

  let parentId: number | null = null;
  let effectiveKind = incomingKind;

  const incomingOrigin = options.origin ?? PROMPT_BATCH_ORIGIN.HUMAN;
  // Human-Anchored Turn: only a human prompt owns/advances "the active turn".
  // A system-origin prompt (task-notification, teammate-message, autonomous
  // loop, injected context) is a point-in-time record — it must not close the
  // open human batch and is itself born closed, so the human turn stays the
  // anchor that insertActivityWithBatch's most-recent-open lookup resolves to.
  const isSystemOrigin = incomingOrigin !== PROMPT_BATCH_ORIGIN.HUMAN;

  if (incomingKind === BATCH_KIND.STEERING || incomingKind === BATCH_KIND.INTERRUPT) {
    const openParent = findOpenParentBatch(sessionId);
    // A human prompt must not nest under a non-human open parent (a system
    // task-notification / agent_dispatch teammate-message batch) — it owns
    // its own turn. Mirrors the Stop-time miner's resolveKindParent rule so
    // the live and reconcile paths classify identically. Without it, a prompt
    // arriving while a background-event batch is open became its steering child.
    const parentIsNonHuman = openParent != null && openParent.origin !== PROMPT_BATCH_ORIGIN.HUMAN;
    if (openParent && !(incomingOrigin === PROMPT_BATCH_ORIGIN.HUMAN && parentIsNonHuman)) {
      parentId = openParent.id;
    } else {
      effectiveKind = BATCH_KIND.INITIAL;
      parentId = null;
    }
  } else if (!isSystemOrigin) {
    // Single entry point for "where does this human initial prompt go?"
    // The helper decides between sentinel-replace and fresh insert,
    // hiding the branching from the call site. System prompts skip this:
    // they neither claim the recovered sentinel nor close the human turn.
    if (effectiveKind === BATCH_KIND.INITIAL && prompt) {
      const claimed = claimInitialBatchSlot(sessionId, prompt, now, incomingOrigin);
      if (claimed) return claimed;
    }
    closeOpenBatches(sessionId, now);
  }

  const { row: batch, created } = insertBatchStateless({
    session_id: sessionId,
    user_prompt: prompt ?? null,
    ordinal: prompt != null ? liveContentOrdinal(sessionId, incomingOrigin, prompt) : undefined,
    started_at: now,
    // System batches are point-in-time records: born closed so they are never
    // the active turn. Human batches stay open (ended_at left null).
    ended_at: isSystemOrigin ? now : undefined,
    created_at: now,
    kind: effectiveKind,
    origin: incomingOrigin,
    parent_prompt_batch_id: parentId,
  });

  const promptNumber = batch.prompt_number!;

  // Skip lineage when the row was deduped — it was created (with lineage) by
  // the first insert of this turn.
  if (created) {
    try {
      const lineageProjectId = batch.project_id ? assertGroveProjectId(batch.project_id) : null;
      createBatchLineage(DEFAULT_AGENT_ID, sessionId, batch.id, now, lineageProjectId);
    } catch { /* lineage best-effort */ }
  }

  // `sessions.prompt_count` cache bump is folded into
  // `insertBatchStateless` so it's atomic with the row write —
  // see the function comment for the single-writer rationale.

  return { batchId: batch.id, promptNumber };
}

/**
 * Sync a session's prompt_batches against an ordered list of user prompts
 * mined from the agent's transcript. Inserts batches for any prompts beyond
 * the count already captured for the session; existing batches are left
 * alone. Used by symbionts (Antigravity) whose hook payloads do not carry
 * the user prompt — the transcript is the authoritative source and the
 * hook handler reads it on every fire to keep the DB in sync.
 *
 * Count-based diff means callers can POST the full prompt list every call;
 * the server only creates batches for the new tail.
 */
export function syncTranscriptPromptBatches(
  sessionId: string,
  prompts: string[],
): { createdBatchCount: number; existingBatchCount: number } {
  // countBatchesBySession is a SELECT COUNT(*); listBatchesBySession caps
  // at BATCHES_DEFAULT_LIMIT and would saturate at 200 — then re-insert
  // prompts[200..N] as duplicates on every hook fire.
  const existingBatchCount = countBatchesBySession(sessionId);
  if (existingBatchCount >= prompts.length) {
    return { createdBatchCount: 0, existingBatchCount };
  }

  // Insert the new tail in a single transaction — N user prompts at AGY
  // session cold-start could otherwise pay N fsyncs. Direct
  // insertBatchStateless skips handleUserPrompt's closeOpenBatches step,
  // which would collapse turn boundaries when N synthetic batches are
  // written in one sweep.
  const now = epochSeconds();
  let createdBatchCount = 0;

  const insertTail = getDatabase().transaction(() => {
    // content_hash ordinal = occurrence index over the FULL prompt list (origin
    // is always HUMAN here), so each prompt hashes the same on every re-POST of
    // the growing list and genuine repeats get distinct ordinals.
    const occurrenceByText = new Map<string, number>();
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const insertable = typeof prompt === 'string' && prompt.trim().length > 0;
      let ordinal = 0;
      if (insertable) {
        const key = normalizePromptForHash(prompt);
        ordinal = occurrenceByText.get(key) ?? 0;
        occurrenceByText.set(key, ordinal + 1);
      }
      // Only the new tail is inserted; earlier indices already have rows.
      if (i < existingBatchCount || !insertable) continue;
      const { row: batch, created } = insertBatchStateless({
        session_id: sessionId,
        user_prompt: prompt,
        ordinal,
        started_at: now,
        created_at: now,
        kind: BATCH_KIND.INITIAL,
        parent_prompt_batch_id: null,
      });
      if (!created) continue;
      try {
        const lineageProjectId = batch.project_id ? assertGroveProjectId(batch.project_id) : null;
        createBatchLineage(DEFAULT_AGENT_ID, sessionId, batch.id, now, lineageProjectId);
      } catch { /* lineage best-effort */ }
      // Counter bump is atomic inside insertBatchStateless.
      createdBatchCount += 1;
    }
  });
  insertTail();

  return { createdBatchCount, existingBatchCount };
}

/**
 * Handle a PostToolUse event: ensure a batch is open (opening a
 * synthetic recovery batch if necessary) and insert the activity
 * linked to it.
 */
export function handleToolUse(
  sessionId: string,
  agent: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string | undefined,
  projectRoot: string,
  transcriptPath?: string,
  sourceEventId?: string,
  sourceMachineId?: string,
): void {
  // Idempotent sink for routed capture (residency §4a): skip the activity insert
  // for a re-delivery of a source event already recorded. Id-presence-scoped, so
  // local events (no id) are unchanged. The dispatcher's other side effects (plan
  // capture, live-reconcile, Canopy rescan) sit OUTSIDE this handler and are each
  // idempotent, so they still run harmlessly on a replay.
  if (sourceEventId && getRoutedEventDedup(sourceEventId)) return;

  const now = epochSeconds();

  ensureOpenBatch(sessionId);

  // Daemon-side self-heal: when a `RECOVERED_BATCH_SENTINEL` placeholder
  // exists for this session AND the event carries a transcript path,
  // re-read the transcript and overwrite the sentinel with the real
  // user prompt. The Antigravity IDE writes its transcript file
  // asynchronously after the PreInvocation hook fires, so the initial
  // session-start sync can miss the prompt — every subsequent
  // tool_use is a chance to heal. Idempotent: bails immediately when
  // no sentinel batch exists for this session.
  if (transcriptPath && agent === 'antigravity') {
    try { selfHealAntigravityPromptFromTranscript(sessionId, transcriptPath); }
    catch { /* best-effort heal */ }
  }

  const filePath = extractToolFilePath(agent, toolName, toolInput);
  const activityFilePath = filePath ? relativizeToolPath(filePath, projectRoot) : null;

  // Canopy linkage: if a PreToolUse injection was recorded for this
  // (sessionId, file_path), capture the offered token count before INSERT
  // so it lands in the same row write — no follow-up UPDATE needed.
  // Try the relativized path first (the form PreToolUse uses for paths
  // under projectRoot) and fall back to the raw path for absolute reads
  // that didn't relativize.
  let injectionTokens: number | null = null;
  if (filePath) {
    injectionTokens =
      consumePendingInjection(sessionId, activityFilePath ?? filePath)
      ?? (activityFilePath !== filePath ? consumePendingInjection(sessionId, filePath) : null);
  }

  recordActivity({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: toolOutput?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: activityFilePath,
    timestamp: now,
    created_at: now,
    canopy_injection_tokens: injectionTokens,
  });

  if (sourceEventId) recordRoutedEventDedup({ eventId: sourceEventId, machineId: sourceMachineId, kind: 'tool_use' });

  // `sessions.tool_count` cache bump is folded into the activity
  // insert itself — see `insertActivityWithBatch`.
}

/**
 * Handle stop event: close all open batches for this session.
 *
 * Does NOT close the session — the Stop hook fires after every assistant
 * turn, not just session end. Session closure happens in /sessions/unregister
 * (SessionEnd hook).
 *
 * Fully stateless — uses `closeOpenBatches` (blind UPDATE) instead of
 * reading from an in-memory map.
 */
export function handleStopBatches(
  sessionId: string,
): void {
  closeOpenBatches(sessionId, epochSeconds());
}

/**
 * Handle a tool failure event: insert activity with success=0.
 */
export function handleToolFailure(
  sessionId: string,
  agent: string,
  toolName: string,
  toolInput: unknown,
  error: string | undefined,
  isInterrupt: boolean | undefined,
  sourceEventId?: string,
  sourceMachineId?: string,
): void {
  // Idempotent sink for routed capture (residency §4a) — see handleToolUse.
  if (sourceEventId && getRoutedEventDedup(sourceEventId)) return;

  const now = epochSeconds();
  const filePath = extractToolFilePath(agent, toolName, toolInput);

  ensureOpenBatch(sessionId);

  recordActivity({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: filePath,
    success: 0,
    error_message: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? (isInterrupt ? 'interrupted' : null),
    timestamp: now,
    created_at: now,
  });

  if (sourceEventId) recordRoutedEventDedup({ eventId: sourceEventId, machineId: sourceMachineId, kind: 'tool_failure' });
}

/**
 * Handle a subagent start event: record that a subagent was spawned.
 */
export function handleSubagentStart(
  sessionId: string,
  agentId: string | undefined,
  agentType: string | undefined,
): void {
  const now = epochSeconds();
  ensureOpenBatch(sessionId);
  recordActivity({
    session_id: sessionId,
    tool_name: 'subagent_start',
    tool_input: JSON.stringify({ agent_id: agentId, agent_type: agentType }).slice(0, TOOL_INPUT_STORE_LIMIT),
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a subagent stop event: record that a subagent completed.
 */
export function handleSubagentStop(
  sessionId: string,
  agentId: string | undefined,
  agentType: string | undefined,
  lastAssistantMessage: string | undefined,
): void {
  const now = epochSeconds();
  ensureOpenBatch(sessionId);
  recordActivity({
    session_id: sessionId,
    tool_name: 'subagent_stop',
    tool_input: JSON.stringify({ agent_id: agentId, agent_type: agentType }).slice(0, TOOL_INPUT_STORE_LIMIT),
    tool_output_summary: lastAssistantMessage?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a stop failure event: record that the stop hook encountered an error.
 */
export function handleStopFailure(
  sessionId: string,
  error: string | undefined,
  errorDetails: string | undefined,
): void {
  const now = epochSeconds();
  ensureOpenBatch(sessionId);
  recordActivity({
    session_id: sessionId,
    tool_name: 'stop_failure',
    tool_output_summary: errorDetails?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    success: 0,
    error_message: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a task completed event: record task completion as an activity.
 */
export function handleTaskCompleted(
  sessionId: string,
  taskId: string | undefined,
  taskSubject: string | undefined,
  taskDescription: string | undefined,
): void {
  const now = epochSeconds();
  ensureOpenBatch(sessionId);
  recordActivity({
    session_id: sessionId,
    tool_name: 'task_completed',
    tool_input: JSON.stringify({ task_id: taskId, task_subject: taskSubject, task_description: taskDescription }).slice(0, TOOL_INPUT_STORE_LIMIT),
    tool_output_summary: taskSubject?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a compact event (pre or post): record compaction in the activity stream.
 */
export function handleCompact(
  sessionId: string,
  phase: 'pre' | 'post',
  trigger: string | undefined,
  compactSummary: string | undefined,
): void {
  const now = epochSeconds();
  ensureOpenBatch(sessionId);
  recordActivity({
    session_id: sessionId,
    tool_name: `${phase}_compact`,
    tool_input: trigger ? JSON.stringify({ trigger }).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: compactSummary?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}
